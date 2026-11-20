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

export function tailCapped(text, maxBytes) {
  const bytes = Buffer.from(text, "utf8");
  return bytes.length <= maxBytes ? text : bytes.subarray(bytes.length - maxBytes).toString("utf8");
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