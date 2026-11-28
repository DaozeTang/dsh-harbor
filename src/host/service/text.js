/**
 * Wire/base64 and terminal-text helpers shared by sessions, exec and file
 * streaming. Kept free of service state so any module can reuse them.
 */

/**
 * The wire's base64 is canonical base64 (the client uses btoa), so anything
 * else is a malformed request, not data to guess at. `Buffer.from(text,
 * "base64")` never throws: it silently skips unknown characters and stops at
 * the first pad, so a corrupted payload would be typed into a live shell or
 * written over a remote file as garbage. Validating here is what makes the
 * callers' "bad-data" branch reachable.
 *
 * Padding is required: `btoa`/`Buffer#toString("base64")` always emit it, and
 * accepting the unpadded form would decode two different strings to the same
 * bytes (a signature/collision surface for anything that hashes the payload).
 */
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Base64-decode a wire payload into bytes.
 * @param {unknown} data - the wire field.
 * @returns {Buffer} the decoded bytes.
 * @throws when the value is not canonical base64.
 */
export function decodeBase64Bytes(data) {
  if (typeof data !== "string" || data.length % 4 !== 0 || !CANONICAL_BASE64.test(data)) {
    throw new Error("input is not valid base64");
  }
  return Buffer.from(data, "base64");
}

/** Base64-decode a wire payload to a UTF-8 string. */
export function decodeData(data) {
  return decodeBase64Bytes(data).toString("utf8");
}

/** Base64-encode a UTF-8 string for the wire. */
export function encodeData(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

export function appendCapped(current, next, maxBytes) {
  const existing = Buffer.byteLength(current, "utf8");
  const incoming = Buffer.from(next, "utf8");
  if (existing >= maxBytes) return { text: current, truncated: incoming.length > 0 };
  const remaining = maxBytes - existing;
  if (incoming.length <= remaining) return { text: current + next, truncated: false };
  // Never end the retained head inside a multi-byte sequence: the stray lead
  // byte decodes as U+FFFD on every later read, which is exactly the bug the
  // streaming decoders in exec.js/index.js were fixed for. Same rule as
  // tailUtf8 below, applied to the cut instead of the start.
  let end = remaining;
  while (end > 0 && (incoming[end] & 0xc0) === 0x80) end -= 1;
  return { text: current + incoming.subarray(0, end).toString("utf8"), truncated: true };
}

/** Keep the newest UTF-8 bytes of a string without splitting a code point. */
export function tailUtf8(text, maxBytes) {
  const value = String(text ?? "");
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return { text: value, truncated: false };
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return { text: bytes.subarray(start).toString("utf8"), truncated: true };
}

/** The text half of tailUtf8, for callers that only need the string. */
export function tailCapped(text, maxBytes) {
  return tailUtf8(text, maxBytes).text;
}

/**
 * The rendered counterpart of promptFromTerminalData: is the END of an
 * already-rendered screen a prompt?
 *
 * A prompt is pinned to exactly `[#$]` followed by a space (the captured text
 * is printed back into the terminal verbatim), while this boolean question can
 * accept the wider REPL set (`%`, `>`, `❯`): a wrong "yes" here only changes
 * the reported wait reason, and it must not let promptFromTerminalData capture
 * a `>` out of ordinary output. Both rules live in this one module so the two
 * readers cannot drift apart unnoticed.
 *
 * @param {string} rendered - readable text (ANSI already stripped).
 * @returns {boolean} whether the last line looks like a shell/REPL prompt.
 */
export function endsWithPrompt(rendered) {
  const value = String(rendered ?? "").trimEnd();
  if (value.length === 0) return false;
  return /(?:^|\n)[^\n]{0,100}[%$#>\u276f]\s*$/.test(value.slice(-160));
}

/** The prompt line at the end of one raw PTY chunk, or null (strict shape). */
export function promptFromTerminalData(text) {
  const visible = String(text)
 .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
 .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const match = visible.match(/(?:^|[\r\n])([^\r\n]*[#$] )$/);
  return match?.[1] ?? null;
}

/**
 * ssh2 exec channels return LF-delimited text. xterm keeps the current column
 * on a bare LF, which makes multi-line agent output drift diagonally. Agent
 * output is synthetic terminal data, so normalize it to the terminal CRLF.
 */
export function normalizeTerminalEol(text) {
  return String(text ?? "").replace(/\r\n|\r|\n/g, "\r\n");
}