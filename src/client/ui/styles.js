/**
 * One stylesheet, installed once.
 *
 * The CSS is imported as text (esbuild `.css` loader = text) and injected as a
 * single <style> tag guarded by a module flag, so N mounted surfaces — a split
 * sidebar, the settings page, two dialogs — still produce exactly one sheet.
 * The tag carries a data attribute so a hot reload or a second page can find
 * and replace it instead of stacking duplicates.
 */
import CSS from "./styles/app.css";

const STYLE_ID = "dsh-harbor-styles";

export function installStyles(doc = globalThis.document) {
  if (doc === undefined || doc === null) return;
  if (doc.getElementById(STYLE_ID) !== null) return;
  const tag = doc.createElement("style");
  tag.id = STYLE_ID;
  tag.textContent = CSS;
  doc.head.appendChild(tag);
}
/**
 * Install one surface's own rules under its own tag. Each screen owns a small
 * sheet for what the kit's shared classes cannot express (a grid template, a
 * sticky column) instead of extending the core sheet from a distance.
 */
export function installSurfaceStyles(id, css, doc = globalThis.document) {
  if (doc === undefined || doc === null || typeof css !== "string") return;
  const tagId = `dsh-harbor-${id}`;
  if (doc.getElementById(tagId) !== null) return;
  const tag = doc.createElement("style");
  tag.id = tagId;
  tag.textContent = css;
  doc.head.appendChild(tag);
}
