/**
 * One stylesheet, installed once and kept current.
 *
 * The CSS is imported as text (esbuild `.css` loader = text) and injected as a
 * single <style> tag per id, so N mounted surfaces — a split sidebar, the
 * settings page, two dialogs — still produce exactly one sheet.
 *
 * "Installed once" must not mean "frozen at the first build". The host can
 * evaluate this module again without reloading the page (dev hot update,
 * re-apply after a failed plugin load), and then the tag already exists while
 * the CSS text is new. Returning early there left the document on the old
 * rules, so new markup rendered with missing classes — the server chip losing
 * its flex rule and falling back to the browser button face was one symptom.
 * ensureStyleTag replaces the text in place and removes duplicates, which is
 * what makes a re-apply converge instead of silently keeping stale styles.
 */
import CSS from "./styles/app.css";
import { ensureStyleTag } from "./style-tag.js";

const STYLE_ID = "dsh-harbor-styles";

export function installStyles(doc = globalThis.document) {
  return ensureStyleTag(doc, STYLE_ID, CSS);
}

/**
 * Install one surface's own rules under its own tag. Each screen owns a small
 * sheet for what the kit's shared classes cannot express (a grid template, a
 * sticky column) instead of extending the core sheet from a distance.
 */
export function installSurfaceStyles(id, css, doc = globalThis.document) {
  return ensureStyleTag(doc, `dsh-harbor-${id}`, css);
}
