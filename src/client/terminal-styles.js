/**
 * xterm's own stylesheet, installed once next to the kit sheet.
 *
 * The client build inlines `@xterm/xterm/css/xterm.css` as text (esbuild's
 * `.css` loader), so the plugin bundle carries xterm's stylesheet without a
 * separate build step or a checked-in generated module. The copyright header
 * is preserved inside the inlined CSS.
 */
import XTERM_CSS from "@xterm/xterm/css/xterm.css";

const ID = "dsh-harbor-xterm";

export function installXtermStyles(doc = globalThis.document) {
  if (doc === undefined || doc === null) return;
  if (doc.getElementById(ID) !== null) return;
  const tag = doc.createElement("style");
  tag.id = ID;
  tag.textContent = XTERM_CSS;
  doc.head.appendChild(tag);
}
