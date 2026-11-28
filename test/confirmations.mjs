/**
 * Confirmations are product surface.
 *
 * Native `window.confirm` blocks the page, ignores the host theme and looks
 * like a browser alert at exactly the dangerous moments. The plugin routes every
 * decision through one themed dialog hosted by the workbench and by Settings;
 * this spec keeps a stray native call (or a dropped host mount) from shipping.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const root = new URL("../src/client/", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

// Walk every client source file.
const sources = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
    if (entry.isDirectory()) await walk(path);
    else if (/\.(js|jsx)$/.test(entry.name)) sources.push([entry.name, await readFile(path, "utf8")]);
  }
}
await walk(root);

const native = sources.filter(([, text]) => /(?:window|globalThis)\.confirm\s*\(/.test(text)).map(([name]) => name);
assert.deepEqual(native, [], "no surface calls window.confirm; decisions use confirmAction");

const kit = await read("ui/kit/overlays.jsx");
assert.match(kit, /export function confirmAction/, "the kit exposes one prompt primitive");
assert.match(kit, /export function ConfirmHost/, "the kit exposes one mount point");
assert.match(kit, /width="sm"/, "decisions render as a compact dialog");
assert.match(kit, /data-modal-autofocus/, "Cancel takes focus, so Enter never confirms a deletion");

for (const file of ["shell/HarborPanel.jsx", "features/resources/HarborResources.jsx"]) {
  const text = await read(file);
  assert.ok(text.includes("<ConfirmHost />"), `${file} mounts the confirm host`);
}

for (const file of [
  "features/files/HarborFiles.jsx",
  "features/resources/HarborResources.jsx",
  "features/logs/logs-pane.jsx",
  "features/snippets/snippets-view.jsx",
  "features/terminal-display/ui/TerminalDisplaySettings.jsx"
]) {
  const text = await read(file);
  assert.ok(text.includes("confirmAction"), `${file} routes its decisions through confirmAction`);
}

console.log("confirmations: themed dialog only, hosted by workbench and settings");
