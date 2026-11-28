/**
 * The committed offline token snapshot must describe both palettes.
 *
 * The preview build once flattened the host sheets and split on the first dark
 * selector. Because the host declares its static palette in a dark block before
 * the light aliases, that bug put every semantic alias in dark scope only: the
 * light preview silently rendered from hard-coded fallbacks, and design review
 * was judging colours the app never uses. This spec pins the shape.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTokenRules } from "../../scripts/theme-tokens.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../");
const css = readFileSync(join(root, "preview", "theme-fallback.css"), "utf8");

// A missing semicolon merges two declarations and silently drops one token.
assert.ok(!/[^;{}\s]\s*--[a-z0-9-]+\s*:/i.test(css), "token declarations are semicolon-separated");

const rules = parseTokenRules(css);
const light = rules.get("body");
const dark = rules.get("body[data-ds-dark-theme]");
assert.ok(light !== undefined && light.size > 150, `the light body palette is complete (${light?.size ?? 0} tokens)`);
assert.ok(dark !== undefined && dark.size > 150, `the dark body palette is complete (${dark?.size ?? 0} tokens)`);

// Tokens every surface depends on, in both modes.
for (const token of [
  "--dsw-alias-bg-base",
  "--dsw-alias-bg-layer-2",
  "--dsw-alias-label-primary",
  "--dsw-alias-label-secondary",
  "--dsw-alias-border-l2",
  "--dsw-alias-button-primary-fill",
  "--dsw-alias-brand-primary",
  "--dsw-menu-surface-fill",
  "--dsw-alias-switch-thumb"
]) {
  assert.ok(light.has(token), `light palette declares ${token}`);
  assert.ok(dark.has(token), `dark palette declares ${token}`);
}

// The two palettes must actually differ, or the split is still wrong.
assert.notEqual(light.get("--dsw-alias-bg-base"), dark.get("--dsw-alias-bg-base"), "light and dark resolve different surfaces");

// Every host token the source references exists in the snapshot. A rename in
// the host theme otherwise degrades to the CSS fallback with no signal.
const used = new Map();
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      walk(path);
      continue;
    }
    if (!/\.(css|js|jsx)$/.test(entry)) continue;
    const text = readFileSync(path, "utf8");
    for (const match of text.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
      const name = match[1];
      if (name.startsWith("--hb-") || name.startsWith("--dsh-harbor-")) continue;
      if (!used.has(name)) used.set(name, []);
      used.get(name).push(relative(root, path));
    }
  }
}
walk(join(root, "src"));
const declaredAnywhere = new Set();
for (const tokens of rules.values()) for (const name of tokens.keys()) declaredAnywhere.add(name);
// Semantic/static palette tokens must be in the light body scope; base tokens
// (radius, motion, fonts) live on :root and only need to exist somewhere.
const missing = [...used].filter(([name]) => {
  const needsLight = name.startsWith("--dsw-alias-") || name.startsWith("--dsw-static-");
  return needsLight ? !light.has(name) : !declaredAnywhere.has(name);
}).map(([name, files]) => `${name} (${files[0]})`);
assert.deepEqual(missing, [], "every host token referenced by the plugin exists in the snapshot");

console.log(`theme snapshot: ${light.size} light tokens, ${dark.size} dark tokens, ${used.size} host tokens referenced`);
