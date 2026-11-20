/**
 * xterm's own stylesheet, installed once next to the kit sheet.
 *
 * The generated module ships xterm's CSS as a string so the plugin bundle
 * carries it (the Web shell only serves the plugin's single JS resource).
 */
import { XTERM_CSS } from "./xterm-css.js";

const ID = "dsh-harbor-xterm";

export function installXtermStyles(doc = globalThis.document) {
  if (doc === undefined || doc === null) return;
  if (doc.getElementById(ID) !== null) return;
  const tag = doc.createElement("style");
  tag.id = ID;
  tag.textContent = XTERM_CSS;
  doc.head.appendChild(tag);
}
