/**
 * Session log reader: a long recording must scroll.
 *
 * The reader is the pane's slack-height element (`flex: 1; min-height: 0`), so
 * it has to be the scroll container itself. Without `overflow`, the text spilled
 * under the "继续加载" footer and the workbench shell (`.hb { overflow: hidden }`)
 * clipped the tail: a recording longer than the pane could not be read past the
 * fold. The capped search-hit strip above the reader has the same contract, and
 * a newly opened recording must not inherit the previous one's scroll offset.
 *
 * Source-level assertions, matching the repo's client-suite style: the defect is
 * a missing declaration, and a DOM test in jsdom could not observe scrolling.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../../../../src/client/features/logs/logs-pane.jsx", import.meta.url), "utf8");

// ── the reader owns the scroll ─────────────────────────────────────────────
const reader = source.match(/<div\s+ref=\{bodyRef\}[\s\S]{0,400}?>/)?.[0] ?? "";
assert.notEqual(reader, "", "the log text renders into the element the scroll bookkeeping points at");
assert.match(reader, /className="hb-scroll hb-mono"/, "the reader keeps the shared scrollbar styling");
assert.match(reader, /flex: 1/, "the reader takes the pane's slack height");
assert.match(reader, /minHeight: 0/, "the reader may shrink below its content");
assert.match(reader, /overflow: "auto"/, "the reader scrolls instead of spilling under the load-more footer");
assert.match(reader, /whiteSpace: "pre-wrap"/, "long lines still wrap instead of scrolling sideways");

// ── the capped hit strip scrolls too ──────────────────────────────────────
const hits = source.match(/<div className="hb-scroll" style=\{\{[^}]*maxHeight: 140[^}]*\}\}>/)?.[0] ?? "";
assert.notEqual(hits, "", "search results stay in a capped strip above the reader");
assert.match(hits, /overflow: "auto"/, "a strip capped by max-height needs its own overflow");

// ── switching recordings starts at the top; 继续加载 does not ─────────────
assert.match(source, /const bodyRef = useRef\(null\)/, "the reader is reachable from the scroll reset");
assert.match(source, /append \? previous \+ readable : readable/, "继续加载 appends instead of replacing");
assert.match(
  source,
  /if \(!append\) \{[\s\S]{0,240}bodyRef\.current\.scrollTop = 0;/,
  "a replacement recording opens at its first line, while appending keeps the offset"
);

console.log("logs scroll: the reader and the hit strip scroll, and switching logs resets the offset");
