/**
 * Wire/base64 and terminal-text helpers shared by sessions, exec and file
 * streaming. Kept free of service state so any module can reuse them.
 */

/** Base64-decode a wire payload to a UTF-8 string. */
export function decodeData(data) {
  return Buffer.from(data, "base64").toString("utf8");
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
  return { text: current + incoming.subarray(0, remaining).toString("utf8"), truncated: true };
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