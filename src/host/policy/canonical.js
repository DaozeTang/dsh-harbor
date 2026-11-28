// Canonical spelling of a shell line, used by the deny-list scan only.
//
// Split out of safety.js: this is a self-contained lexer with no policy
// knowledge, and the part most likely to need its own unit tests.

/**
 * One canonical spelling for shell quoting and escaping, for the deny-list scan
 * only. The gate still executes the operator's exact text, and the trash
 * rewrite keeps its own stricter literal parser (trash.js).
 *
 * Matching the raw text is trivially evaded by re-spelling the same command:
 * `\rm`, `'rm'`, `r''m`, `r"m"`, `$'\x72m'` and `sh -c "rm ..."` all run the
 * same deletion, yet none of them contains the byte sequence " rm". This
 * collapses those spellings to what the shell would actually run: single
 * quotes verbatim, double quotes with only their four escapes, `$'...'`
 * ANSI-C escapes decoded, backslash escapes resolved, a trailing backslash-newline
 * continuation dropped. Anything it cannot resolve stays as written — the raw
 * spelling is scanned next to the canonical one, so a match in either blocks.
 *
 * @param {unknown} command - one shell command line.
 * @returns {string} the canonical spelling to scan.
 */
export function canonicalCommandText(command) {
  const text = String(command ?? "");
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) { out += text.slice(i); break; }
      out += text.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const c = text[j];
        if (c === "\\") {
          const next = text[j + 1];
          if (next === undefined) { j = n; break; }
          // A backslash-newline is a line continuation and the shell DELETES
          // both bytes, inside double quotes as well as outside. Leaving them
          // in made r"\<newline>m" canonicalize to a string that contains no
          // "rm" at all, so the same deletion ran unblocked.
          if (next === "\n") { j += 2; continue; }
          // Inside double quotes only these four escapes are consumed; any
          // other backslash is a literal byte the shell passes through.
          if (next === '"' || next === "\\" || next === "$" || next === "`") { out += next; j += 2; continue; }
          out += `\\${next}`;
          j += 2;
          continue;
        }
        if (c === '"') { closed = true; j += 1; break; }
        out += c;
        j += 1;
      }
      i = j;
      if (!closed) break;
      continue;
    }
    if (ch === "$" && text[i + 1] === "'") {
      // ANSI-C quoting ($'...'): bash-level escapes, so \x72 / \162 are "r".
      let j = i + 2;
      let body = "";
      let closed = false;
      while (j < n) {
        const c = text[j];
        if (c === "\\") { body += c + (text[j + 1] ?? ""); j += 2; continue; }
        if (c === "'") { closed = true; j += 1; break; }
        body += c;
        j += 1;
      }
      if (!closed) { out += text.slice(i); break; }
      out += decodeAnsiCString(body);
      i = j;
      continue;
    }
    if (ch === "\\") {
      const next = text[i + 1];
      if (next === undefined) { out += ch; i += 1; continue; }
      if (next === "\n") { i += 2; continue; } // line continuation
      out += next;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const ANSI_C_SIMPLE_ESCAPES = new Map([
  ["a", "\x07"], ["b", "\b"], ["e", "\x1b"], ["E", "\x1b"], ["f", "\f"],
  ["n", "\n"], ["r", "\r"], ["t", "\t"], ["v", "\v"],
  ["\\", "\\"], ["'", "'"], ['"', '"'], ["?", "?"]
]);

/** Decode the body of one `$'...'` literal; unrecognised escapes keep their backslash. */
function decodeAnsiCString(body) {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") { out += ch; continue; }
    const next = body[i + 1];
    if (next === undefined) { out += ch; break; }
    const simple = ANSI_C_SIMPLE_ESCAPES.get(next);
    if (simple !== undefined) { out += simple; i += 1; continue; }
    if (next === "x") {
      const hex = /^[0-9a-fA-F]{1,2}/.exec(body.slice(i + 2));
      if (hex !== null) { out += String.fromCharCode(Number.parseInt(hex[0], 16)); i += 1 + hex[0].length; continue; }
    }
    // uHHHH / UHHHHHHHH (bash >= 4.2). Missing these left the ANSI-C spelling
    // of "rm" completely undecoded, so the canonical text contained no "rm"
    // and the deletion ran with neither approval nor the reversible rewrite.
    if (next === "u" || next === "U") {
      const hex = new RegExp(`^[0-9a-fA-F]{1,${next === "u" ? 4 : 8}}`).exec(body.slice(i + 2));
      if (hex !== null) {
        const code = Number.parseInt(hex[0], 16);
        if (code <= 0x10ffff) { out += String.fromCodePoint(code); i += 1 + hex[0].length; continue; }
      }
    }
    if (next >= "0" && next <= "7") {
      const octal = /^[0-7]{1,3}/.exec(body.slice(i + 1));
      if (octal !== null) { out += String.fromCharCode(Number.parseInt(octal[0], 8) & 0xff); i += octal[0].length; continue; }
    }
    if (next === "c" && body[i + 2] !== undefined) {
      out += String.fromCharCode(body[i + 2].toUpperCase().charCodeAt(0) & 0x1f);
      i += 2;
      continue;
    }
    out += `\\${next}`;
    i += 1;
  }
  return out;
}
