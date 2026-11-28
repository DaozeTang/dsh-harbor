// SFTP panel additions: the editor's byte policy (size cap, binary refusal,
// BOM handling), the favorites store, the listing filter — plus a source-level
// contract for the JSX wiring (no DOM in this suite, matching the repo style).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import {
  BINARY_PROBE_BYTES,
  MAX_EDITABLE_BYTES,
  changedLineRegions,
  decodeEditableText,
  encodeEditableText,
  filterEntries,
  looksBinary
} from "../../../../src/client/features/files/file-editor.js";
import { favoritesKey, readFavorites, toggleFavorite, writeFavorites } from "../../../../src/client/features/files/sftp-favorites.js";

const utf8 = (text) => new TextEncoder().encode(text);

assert.deepEqual(changedLineRegions("same\nold\nend", "same\nnew\nend"), {
  left: { before: "same", changed: "old", after: "end" },
  right: { before: "same", changed: "new", after: "end" }
});
assert.equal(changedLineRegions("a\nb", "a\nx\nb").right.changed, "x");
assert.equal(changedLineRegions("a\nx\nb", "a\nb").left.changed, "x");

// ── editor byte policy ──────────────────────────────────────────────────────
assert.equal(MAX_EDITABLE_BYTES, 10 * 1024 * 1024);

{
  const text = "server { listen 80; }\n";
  const decoded = decodeEditableText(utf8(text));
  assert.deepEqual(decoded, { ok: true, text, replaced: false });
  assert.deepEqual([...encodeEditableText(decoded.text)], [...utf8(text)], "text survives the round trip byte for byte");

  const bom = decodeEditableText(Uint8Array.from([0xEF, 0xBB, 0xBF, ...utf8("配置")]));
  assert.equal(bom.ok, true);
  assert.equal(bom.text, "配置", "a UTF-8 BOM is stripped, not shown as content");
  assert.equal(bom.replaced, false);

  const binary = decodeEditableText(Uint8Array.from([0x7F, 0x45, 0x4C, 0x46, 0x00, 0x01]));
  assert.equal(binary.ok, false);
  assert.match(binary.reason, /二进制/);

  const invalid = decodeEditableText(Uint8Array.from([0x41, 0xC3, 0x28, 0x42]));
  assert.equal(invalid.ok, true);
  assert.equal(invalid.replaced, true, "invalid UTF-8 is flagged so the UI can warn about a rewrite");

  const empty = decodeEditableText(new Uint8Array(0));
  assert.deepEqual(empty, { ok: true, text: "", replaced: false });

  const big = decodeEditableText(new Uint8Array(MAX_EDITABLE_BYTES + 1));
  assert.equal(big.ok, false);
  assert.match(big.reason, /编辑上限/);

  const beyondWindow = new Uint8Array(BINARY_PROBE_BYTES + 10).fill(0x41);
  beyondWindow[BINARY_PROBE_BYTES + 5] = 0;
  assert.equal(looksBinary(beyondWindow), false, "a NUL beyond the probe window is not inspected");
  assert.equal(looksBinary(Uint8Array.from([0, ...new Uint8Array(BINARY_PROBE_BYTES)])), true);
}

// ── listing filter ──────────────────────────────────────────────────────────
{
  const entries = [{ name: "nginx.conf" }, { name: "NGINX.d" }, { name: "app.log" }];
  assert.equal(filterEntries(entries, "").length, 3);
  assert.equal(filterEntries(entries, "   ").length, 3);
  assert.deepEqual(filterEntries(entries, "nginx").map((e) => e.name), ["nginx.conf", "NGINX.d"]);
  assert.deepEqual(filterEntries(entries, ".log").map((e) => e.name), ["app.log"]);
  assert.deepEqual(filterEntries(entries, "missing"), []);
}

// ── favorites store ─────────────────────────────────────────────────────────
{
  assert.equal(favoritesKey({ host: "10.0.0.1", port: 22, username: "ops" }), "dsh-harbor:sftp-favorites:ops@10.0.0.1:22");
  assert.equal(favoritesKey({ host: "10.0.0.1", port: 2222 }), "dsh-harbor:sftp-favorites:-@10.0.0.1:2222");
  assert.equal(favoritesKey({ port: 22 }), null, "a connection without a host has no stable key");
  assert.equal(favoritesKey(undefined), null);

  const store = new Map();
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, value); }
  };
  const key = "k";

  assert.deepEqual(readFavorites(storage, key), []);
  writeFavorites(storage, key, ["/etc/nginx", "/var/log"]);
  assert.deepEqual(readFavorites(storage, key), ["/etc/nginx", "/var/log"]);

  storage.setItem(key, "{not json");
  assert.deepEqual(readFavorites(storage, key), [], "corrupt storage reads as no favorites");
  storage.setItem(key, JSON.stringify(["/a", "/a", "relative", 42, "/b", ""]));
  assert.deepEqual(readFavorites(storage, key), ["/a", "/b"], "duplicates, non-strings and relative entries are dropped");

  const throwing = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("quota"); }
  };
  assert.deepEqual(readFavorites(throwing, key), []);
  assert.doesNotThrow(() => writeFavorites(throwing, key, ["/x"]), "a full/blocked storage must not break the panel");
  assert.doesNotThrow(() => writeFavorites(storage, null, ["/x"]));
  assert.deepEqual(readFavorites(storage, null), []);

  assert.deepEqual(toggleFavorite(["/a"], "/b"), { paths: ["/a", "/b"], added: true });
  assert.deepEqual(toggleFavorite(["/a", "/b"], "/a"), { paths: ["/b"], added: false });
  assert.deepEqual(toggleFavorite(["/a"], "  "), { paths: ["/a"], added: false });
  assert.deepEqual(toggleFavorite(["/a"], "/a"), { paths: [], added: false });
}

// ── JSX contract: the panel wires exactly these behaviours ──────────────────
{
  const files = await readFile(new URL("../../../../src/client/features/files/HarborFiles.jsx", import.meta.url), "utf8");
  const editorHook = await readFile(new URL("../../../../src/client/features/files/hooks/useEditor.js", import.meta.url), "utf8");
  const rowMenu = await readFile(new URL("../../../../src/client/features/files/file-row-menu.jsx", import.meta.url), "utf8");
  const toolbar = await readFile(new URL("../../../../src/client/features/files/file-toolbar.jsx", import.meta.url), "utf8");
  const checks = [
    [/from "\.\/file-editor\.js"/, "the editor policy module is imported", files],
    [/from "\.\/sftp-favorites\.js"/, "the favorites module is imported", files],
    [/onDragOver=\{.*setDragActive\(true\)/, "dragging over the list highlights the drop zone", files],
    [/onDrop=\{[\s\S]{0,260}upload\(files\)/, "dropping files uploads them through the existing path", files],
    [/visibleEntries = entries === null \? null : filterEntries\(entries, filter\)/, "the filter narrows the rendered listing", files],
    [/openEditor\(entry\)/, "file rows offer the editor", rowMenu],
    [/api\.sftpReadFile\(connectionId, path, MAX_EDITABLE_BYTES \+ 1\)/, "the editor reads with the size cap as its bound", editorHook],
    [/encodeEditableText\(editing\.text\)/, "saving writes the editor text as UTF-8 bytes", editorHook],
    [/sftpEditorSave\(connectionId, editing\.path, editing\.originalBytes, replacement\)/, "saving checks the original bytes", editorHook],
    [/toggleFavorite\(favorites, cwd\)/, "the star pins the current directory", files],
    [/writeFavorites\(globalThis\.localStorage, favoritesStorageKey, next\)/, "favorites persist per server key", files],
    [/readFavorites\(globalThis\.localStorage, favoritesStorageKey\)/, "favorites load from the connection's stable key", files],
    [/favorites\.map\(\(path\) => \(/, "pinned paths render as chips", toolbar]
  ];
  for (const [pattern, label, source] of checks) {
    assert.match(source, pattern, `file browser: ${label}`);
  }
  assert.doesNotMatch(files, /lastSave|restoreBackup|dsh-backup|恢复备份|恢复上一个版本/,
    "HarborFiles.jsx: online editing never creates or offers a backup/version of the remote file");

  const panel = await readFile(new URL("../../../../src/client/shell/HarborPanel.jsx", import.meta.url), "utf8");
  assert.match(
    panel,
    /<HarborFiles\s+key=\{active\.connectionId\}/,
    "HarborPanel.jsx: the file pane is remounted per connection, so listing/selection state cannot leak across servers"
  );
}

console.log("sftp files ui: editor policy, favorites store, filter and JSX wiring all passed");

// Exercise the real file input and conflict buttons with a saved remote folder.
{
  const temp = mkdtempSync(join(process.cwd(), "node_modules", ".sftp-upload-test-"));
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let root;
  try {
    const bundle = join(temp, "files.cjs");
    await build({ entryPoints: ["src/client/features/files/HarborFiles.jsx"], outfile: bundle, bundle: true, platform: "node", format: "cjs", external: ["react"], logLevel: "silent" });
    const { HarborFiles } = createRequire(import.meta.url)(bundle);
    const { createRoot } = await import("react-dom/client");
    const uploaded = [];
    const existingNames = ["a.txt", "b.txt", "existing-only.txt"];
    const api = {
      list: async () => ({ connections: [] }),
      sftpList: async (_id, path) => ({
        path,
        entries: path === "/"
          ? [{ name: "docs", isDirectory: true, mode: 0o040755 }]
 : existingNames.map((name) => ({ name, mode: 0o100644, size: 1, mtime: 0 }))
      }),
      sftpUploadFile: async (_id, path, _file, _progress, _signal, options) => { uploaded.push([path, options.overwrite]); }
    };
    await act(async () => {
      root = createRoot(document.getElementById("root"));
      root.render(React.createElement(HarborFiles, { api, connectionId: "test" }));
    });
    const input = document.querySelector("input[webkitdirectory]");
    Object.defineProperty(input, "files", { value: ["a.txt", "b.txt", "new.txt"].map((name) => ({
      name, size: 1, webkitRelativePath: `docs/${name}`
    })) });
    await act(async () => input.dispatchEvent(new window.Event("change", { bubbles: true })));
    assert.deepEqual(uploaded, []);
    assert.match(document.querySelector('[role="dialog"]').textContent, /\/docs\/a\.txt/);
    await act(async () => document.querySelector('[role="dialog"] input').click());
    await act(async () => [...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent === "保留两份").click());
    assert.deepEqual(uploaded, [["/docs/a (1).txt", false], ["/docs/b (1).txt", false], ["/docs/new.txt", false]]);
    assert.equal(document.querySelector('[role="dialog"]'), null);
  } finally {
    if (root) await act(async () => root.unmount());
    dom.window.close();
    rmSync(temp, { recursive: true, force: true });
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
    else delete globalThis.navigator;
  }
}
