/**
 * Number and time formatting shared by the panes.
 *
 * The file list, the log list and the status tab each had their own copy of
 * "bytes in a human unit", with different rounding and different unit tables,
 * so the same size could read "1536.0 MB" in one pane and "1.5 GB" in
 * another. One module, one answer.
 *
 * Pure: no React, no host services, so the numbers a narrow sidebar prints
 * can be tested directly. A missing value always renders as an em dash, never
 * as 0: a pane must never imply a measurement it does not have.
 */

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];
const DASH = "—";

/** Bytes in the largest unit that keeps three significant digits. */
export function formatBytes(bytes, digits = 1) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return DASH;
  if (bytes < 1024) return Math.round(bytes) + " B";
  return bytesAt(bytes, unitIndex(bytes), digits);
}

/** The unit index for a value: the largest power of 1024 that fits. */
function unitIndex(bytes) {
  let index = 0;
  let value = bytes;
  while (value >= 1024 && index < UNITS.length - 1) {
    value /= 1024;
    index += 1;
  }
  return index;
}

/** Bytes rendered in one fixed unit, so a used/total pair stays comparable. */
function bytesAt(bytes, index, digits) {
  const value = bytes / 1024 ** index;
  const text = value >= 100 ? value.toFixed(0) : value.toFixed(digits);
  return text + " " + UNITS[index];
}

/** "1.8 TB / 2.0 TB": both halves in the unit of the larger value. */
export function formatBytePair(used, total, digits = 1) {
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0) return DASH;
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) return DASH;
  const index = unitIndex(total);
  return bytesAt(used, index, digits) + " / " + bytesAt(total, index, digits);
}

/**
 * A compact wall-clock stamp: "MM-DD HH:mm" inside the current year, because
 * the year is obvious there, and "YYYY-MM-DD" for anything older. An
 * unreadable value renders as an em dash rather than "Invalid Date".
 */
export function formatWhen(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return DASH;
  const pad = (part) => String(part).padStart(2, "0");
  if (date.getFullYear() !== new Date().getFullYear()) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
