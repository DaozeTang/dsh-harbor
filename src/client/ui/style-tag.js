/**
 * One <style> element per sheet id, always carrying the current build.
 *
 * A client plugin is evaluated again without a full page reload when the
 * operator hot-updates it (dev install, `dsh plugin` reload, HMR). The old
 * installer treated "a tag with this id exists" as "the sheet is installed"
 * and returned, so the document kept the previous build's rules while the
 * new markup mounted against them. That mismatch is visible: a server tab
 * whose `.hb-server__tab` rule is missing falls back to the browser button
 * face, wraps its label and Agent badge, and overflows the 28px chip.
 *
 * Replacing the text in place converges on the current sheet, and collapsing
 * same-id style elements keeps a retry from stacking duplicates. The tag is
 * updated only when the text differs, so a normal mount is one string
 * comparison and no style recalculation.
 */

/**
 * Ensure exactly one style element carries `css` under `id`.
 * @param {Document | null | undefined} doc - document that owns the sheet.
 * @param {string} id - stable style element id.
 * @param {string} css - complete sheet text for this build.
 * @returns {HTMLStyleElement | null} the tag now carrying `css`, or null when it cannot be installed.
 */
export function ensureStyleTag(doc, id, css) {
  if (doc === undefined || doc === null) return null;
  if (typeof id !== "string" || id === "" || typeof css !== "string") return null;
  const head = doc.head ?? null;
  if (head === null) return null;

  const tags = Array.from(doc.querySelectorAll("style")).filter((tag) => tag.id === id);
  let tag = tags.length === 0 ? null : tags[0];
  // A retry after a partial teardown can leave a second tag behind; keep one.
  for (const duplicate of tags.slice(1)) duplicate.remove();

  if (tag === null) {
    tag = doc.createElement("style");
    tag.id = id;
    head.appendChild(tag);
  }
  // A hot update reaches apply() again with a new sheet; the mounted DOM is
  // already the new markup, so the sheet must follow it in place.
  if (tag.textContent !== css) tag.textContent = css;
  return tag;
}
