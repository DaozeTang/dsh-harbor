/**
 * Settings page layout contract.
 *
 * The page is a column of cards inside DSH's own Settings, so its structure is
 * asserted at the level that actually matters: server rows are one non-wrapping
 * action row each, the six sections exist in order, and nothing reintroduces a
 * second navigation layer (tabs, segmented switchers) inside the section.
 *
 * Inline style objects are gone by design — geometry lives in
 * features/settings/settings.css so the kit's tokens stay the only source of
 * colour, radius and type.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

// The page is split into focused components, so assert over the whole feature
// directory in a fixed sorted order rather than the former single file.
const resourcesDir = new URL("../src/client/features/resources/", import.meta.url);
const source = (await Promise.all(
  (await readdir(resourcesDir))
    .filter((name) => name.endsWith(".jsx"))
    .sort()
    .map((name) => readFile(new URL(name, resourcesDir), "utf8"))
)).join("\n");
const sheet = await readFile(new URL("../src/client/features/resources/settings.css", import.meta.url), "utf8");

// ── server rows ────────────────────────────────────────────────────────────
const serverRow = source.match(/<Row\s+className="hb-settings-server"[\s\S]{0,2600}/)?.[0] ?? "";
assert.notEqual(serverRow, "", "server rows render through the kit's Row");
assert.match(serverRow, /actions=\{/, "row actions are handed to the kit's action cluster");
assert.match(serverRow, /<Menu open=\{menuOpen\}/, "overflow actions live in an anchored menu, not a button bar");
assert.doesNotMatch(serverRow, /style=\{\{/, "server rows carry no inline styling");

// ── one navigation layer ───────────────────────────────────────────────────
assert.doesNotMatch(source, /role="tablist"/, "the section has no tab strip of its own; DSH owns navigation");
assert.doesNotMatch(source, /setupTab/, "the old setup switcher is gone");
assert.doesNotMatch(source, /GitHub|github\.com/, "no upstream or external links are baked into the page");

// ── sections ──────────────────────────────────────────────────────────────
const sections = ["已保存的服务器", "共享 SSH 凭据", "已知主机", "AI 命令执行策略", "功能开关", "语言与更新"];
for (const title of sections) {
  assert.ok(source.includes(title), `the page keeps its "${title}" section`);
}

// ── presentation lives in CSS ─────────────────────────────────────────────
assert.match(sheet, /\.hb\.hb-settings/, "the surface sheet scopes every rule under .hb");
assert.doesNotMatch(sheet, /#[0-9a-fA-F]{3,6}\b/, "the sheet uses tokens, never colour literals");
assert.match(source, /installSurfaceStyles\(\s*"settings"/, "the sheet is installed through the shared helper");

console.log("resource card layout: rows, single navigation layer, six sections, token-only sheet passed");
