/**
 * Host-token extraction shared by the preview builder and the snapshot script.
 *
 * DeepSeek Harness declares its design tokens in two sheets
 * (`design-platform.css` and `base.css`) as plain custom properties, split
 * across:
 *
 *   :root                                  base variables (font, motion, radius)
 *   body                                   light palette (statics + aliases)
 *   body[data-ds-dark-theme]               dark palette overrides
 *   html[data-platform='darwin'] body      platform font overrides
 *
 * The earlier preview build flattened declarations and kept only the text
 * before the *first* dark selector. That first dark block carries the static
 * palette, so every semantic alias (`--dsw-alias-*`) ended up scoped to dark
 * mode and the light preview rendered from hard-coded fallbacks. Keeping the
 * rule selectors intact makes both themes resolve exactly as they do in the
 * app.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Remove comments so a `}` inside prose can never split a rule. */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Re-emit only custom-property declarations, preserving each rule's selector.
 * Source-order is preserved so dark overrides still win over light ones.
 */
export function tokenRules(css) {
  const clean = stripComments(css);
  const rules = [];
  let index = 0;
  while (index < clean.length) {
    const open = clean.indexOf("{", index);
    if (open === -1) break;
    const close = clean.indexOf("}", open);
    if (close === -1) break;
    const selector = clean.slice(index, open).trim();
    const body = clean.slice(open + 1, close);
    // At-rules are skipped rather than mis-scoped; the token sheets use none.
    if (selector !== "" && !selector.startsWith("@")) {
      const declarations = [];
      for (const match of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
        declarations.push(`${match[1]}:${match[2].trim()}`);
      }
      if (declarations.length > 0) rules.push(`${selector}{${declarations.join(";")}}`);
    }
    index = close + 1;
  }
  // One rule per line keeps the generated snapshot reviewable in a diff.
  return rules.join("\n");
}

/** The two sheets that carry every token; both must exist. */
export function themeSheets(dir) {
  const files = ["base.css", "design-platform.css"].map((name) => join(dir, name));
  for (const file of files) {
    if (!existsSync(file)) throw new Error(`theme: missing ${file}`);
  }
  return files;
}

/**
 * Read a DSH theme directory into one token-only stylesheet.
 * @param {string} dir directory containing base.css and design-platform.css
 */
export function readThemeTokens(dir) {
  return themeSheets(dir).map((file) => tokenRules(readFileSync(file, "utf8"))).join("");
}

/** Parse a token sheet into { selector -> Map(token -> value) } for checks.
 *  Later rules with the same selector merge into (and override) earlier ones,
 *  which is how the host composes its palette in two `body` blocks. */
export function parseTokenRules(css) {
  const out = new Map();
  const clean = stripComments(css);
  let index = 0;
  while (index < clean.length) {
    const open = clean.indexOf("{", index);
    if (open === -1) break;
    const close = clean.indexOf("}", open);
    if (close === -1) break;
    const selector = clean.slice(index, open).trim();
    let tokens = out.get(selector);
    const before = tokens?.size ?? 0;
    if (tokens === undefined) {
      tokens = new Map();
      out.set(selector, tokens);
    }
    for (const match of clean.slice(open + 1, close).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
      tokens.set(match[1], match[2].trim());
    }
    if (tokens.size === before && before === 0) out.delete(selector);
    index = close + 1;
  }
  return out;
}
