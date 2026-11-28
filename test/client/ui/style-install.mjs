// Stylesheet installation: one tag per sheet id, always carrying the current
// build. A client-plugin hot update re-evaluates the module without a page
// reload; the previous build's tag is still in <head>, and the old installer
// returned on it. The chip then rendered with the browser button face (grey,
// wrapping label and Agent badge) while the new markup expected flex rules.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { ensureStyleTag } from "../../../src/client/ui/style-tag.js";

const MAIN_ID = "dsh-harbor-styles";
const stylesById = (doc, id) => Array.from(doc.querySelectorAll("style")).filter((tag) => tag.id === id);
const page = () => new JSDOM("<!doctype html><html><head></head><body></body></html>").window.document;

// ── helper contract ────────────────────────────────────────────────────────

assert.equal(ensureStyleTag(null, MAIN_ID, "a{color:red}"), null, "no document, no install");
assert.equal(ensureStyleTag(page(), MAIN_ID, undefined), null, "a missing sheet text is not a sheet");
assert.equal(ensureStyleTag(page(), "", "a{color:red}"), null, "an empty id would collide with every other sheet");
assert.equal(ensureStyleTag({ head: null }, MAIN_ID, "a{color:red}"), null, "a document without head cannot host the tag");

const direct = page();
const first = ensureStyleTag(direct, "x", "a{color:red}");
assert.equal(first.id, "x");
assert.equal(first.textContent, "a{color:red}");
assert.equal(first.parentNode, direct.head);
assert.equal(ensureStyleTag(direct, "x", "a{color:red}"), first, "the same sheet keeps the same element");
assert.equal(stylesById(direct, "x").length, 1);
first.textContent = "stale{color:gray}";
assert.equal(ensureStyleTag(direct, "x", "a{color:blue}"), first, "a stale sheet is replaced in place");
assert.equal(first.textContent, "a{color:blue}");

const duplicate = direct.createElement("style");
duplicate.id = "x";
duplicate.textContent = "old{color:gray}";
direct.head.appendChild(duplicate);
ensureStyleTag(direct, "x", "a{color:green}");
assert.equal(stylesById(direct, "x").length, 1, "a retry collapses same-id duplicates");
assert.equal(direct.getElementById("x").textContent, "a{color:green}");

// ── the shipping installers ──────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), "harbor-styles-"));
try {
  const bundle = join(dir, "styles.cjs");
  await build({
    entryPoints: ["src/client/ui/styles.js"],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    loader: { ".css": "text" },
    logLevel: "silent"
  });
  const { installStyles, installSurfaceStyles } = createRequire(import.meta.url)(bundle);

  const doc = page();
  const tag = installStyles(doc);
  assert.equal(tag.id, MAIN_ID);
  assert.equal(stylesById(doc, MAIN_ID).length, 1);
  assert.match(tag.textContent, /\.hb-server__tab\s*\{/, "the installed sheet carries the chip layout");
  assert.match(tag.textContent, /\.hb-sidebar-body\s*\{/, "the installed sheet carries the host-chrome scope");

  // A plugin reload replaces the module but not the DOM. The old build's
  // sheet must not survive the second apply().
  tag.textContent = ".hb-server__tab{display:block}";
  const again = installStyles(doc);
  assert.equal(again, tag, "re-apply updates the mounted tag instead of stacking a second one");
  assert.match(again.textContent, /\.hb-server__tab\s*\{[^}]*display:\s*inline-flex/, "the flex rule is back");
  assert.match(again.textContent, /\.hb-server__label\s*\{[^}]*text-overflow:\s*ellipsis/, "the truncation rule is back");
  assert.equal(stylesById(doc, MAIN_ID).length, 1);

  const lost = page();
  installStyles(lost);
  lost.getElementById(MAIN_ID).remove();
  installStyles(lost);
  assert.equal(stylesById(lost, MAIN_ID).length, 1, "a sheet removed with the host chrome is rebuilt on mount");

  const surface = page();
  const surfaceTag = installSurfaceStyles("files", "a{color:red}", surface);
  assert.equal(surfaceTag.id, "dsh-harbor-files");
  const updated = installSurfaceStyles("files", "a{color:blue}", surface);
  assert.equal(updated, surfaceTag, "a surface sheet updates in place too");
  assert.equal(updated.textContent, "a{color:blue}");
  assert.equal(stylesById(surface, "dsh-harbor-files").length, 1);
  assert.equal(installSurfaceStyles("files", undefined, surface), null, "a missing surface sheet is ignored");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("style install: re-applied builds replace the mounted sheet and collapse duplicates");
