/** Bounded terminal history with UTF-16 offsets, shared by independent readers. */
export function createTerminalOutput(initial = '', maxBytes = 1024 * 1024) {
  let text = '';
  let end = 0;
  let bytes = 0;
  const limit = Number.isFinite(maxBytes) ? Math.max(0, maxBytes) : 1024 * 1024;
  /** UTF-8 width of one code point, without allocating a Buffer per character. */
  const width = (codePoint) => (codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4);
  const journal = {
    append(chunk) {
      end += chunk.length;
      if (limit === 0) { text = ''; bytes = 0; return; }
      text += chunk;
      bytes += Buffer.byteLength(chunk, 'utf8');
      const excess = bytes - limit;
      if (excess <= 0) return;
      // Drop whole code points from the front until at least `excess` bytes
      // are gone. Scanning only the oldest characters keeps each append O(chunk)
      // — re-encoding the whole journal here was O(n²) at the 2 MB cap.
      let index = 0;
      let dropped = 0;
      while (index < text.length && dropped < excess) {
        const codePoint = text.codePointAt(index);
        dropped += width(codePoint);
        index += codePoint > 0xffff ? 2 : 1;
      }
      text = text.slice(index);
      bytes -= dropped;
    },
    /** The newest `chars` characters, for prompt detection and echo checks. */
    tail(chars) {
      return Number.isFinite(chars) && chars > 0 ? text.slice(-chars) : '';
    },
    read(after) {
      const start = end - text.length;
      let from = Number.isSafeInteger(after) ? Math.min(end, Math.max(start, after)) : start;
      // A caller cannot start in the middle of a surrogate pair.
      const code = text.charCodeAt(from - start);
      if (code >= 0xdc00 && code <= 0xdfff) from++;
      return { data: text.slice(from - start), startOffset: from, offset: end };
    },
  };
  journal.append(initial);
  return journal;
}
