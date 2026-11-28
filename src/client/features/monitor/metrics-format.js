
/**
 * Formatting for the status pane.
 *
 * Pure functions with no React and no host services, so the numbers a narrow
 * sidebar actually prints ("1.8/2.0 T", "42 天 3 小时", "—") can be tested
 * directly. A missing value always renders as an em dash, never as 0: the pane
 * must never imply a measurement it does not have.
 */
import { t } from "../../../i18n/core.js";
import { formatBytePair, formatBytes } from "../../core/format.js";

// Byte formatting is shared with the file and log panes; re-exported here so
// the status pane's own modules (and its test) keep one import path.
export { formatBytePair, formatBytes };

const DASH = "—";


/** A transfer rate, with the unit suffix the probe reports in. */
export function formatRate(bytesPerSecond) {
  if (bytesPerSecond === null || bytesPerSecond === undefined) return DASH;
  if (typeof bytesPerSecond !== "number" || !Number.isFinite(bytesPerSecond)) return DASH;
  return formatBytes(bytesPerSecond) + "/s";
}

/** A percentage, or an em dash while the first interval is still open. */
export function formatPercent(value, digits = 0) {
  if (typeof value !== "number" || !Number.isFinite(value)) return DASH;
  return value.toFixed(digits) + "%";
}

/**
 * Which tone a filled meter should carry at this level. Below the warn line
 * the meter keeps the neutral accent: a healthy disk is not "green", it is
 * simply normal.
 */
export function usageTone(percent, warn = 85, error = 95) {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return "neutral";
  if (percent >= error) return "err";
  if (percent >= warn) return "warn";
  return "neutral";
}

/** Uptime in the coarsest two units: "42 天 3 小时". */
export function formatUptime(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return DASH;
  const total = Math.floor(seconds);
  if (total < 60) return t(`${total} 秒`);
  if (total < 3600) return t(`${Math.floor(total / 60)} 分钟`);
  if (total < 86400) {
    return t(`${Math.floor(total / 3600)} 小时 ${Math.floor((total % 3600) / 60)} 分`);
  }
  return t(`${Math.floor(total / 86400)} 天 ${Math.floor((total % 86400) / 3600)} 小时`);
}

/** Wall-clock time of a sample, in the viewer's local time. */
export function formatClock(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return DASH;
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

/**
 * A readable ceiling for an auto-scaled axis: 1/2/5 x 10^k above the peak, so
 * the line does not hug the top of the box when the newest value happens to be
 * the window maximum (a filled block instead of a trend).
 */
export function niceCeiling(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  for (const step of [1, 2, 5, 10]) {
    if (value <= step * base) return step * base;
  }
  return 10 * base;
}

/**
 * SVG polyline points for a trend line. The peak is either fixed (CPU: always
 * 0-100 so the shape means something) or a readable ceiling above the window
 * maximum (network rates).
 */
export function sparklinePoints(values, width = 100, height = 24, max = null) {
  if (!Array.isArray(values) || values.length === 0) return "";
  const usable = values.map((value) => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0));
  const peak = max === null ? niceCeiling(Math.max(...usable)) : Math.max(1, max);
  const step = usable.length > 1 ? width / (usable.length - 1) : width;
  return usable
    .map((value, index) => {
      const ratio = Math.min(1, value / peak);
      const x = index * step;
      const y = height - ratio * height;
      return x.toFixed(2) + "," + y.toFixed(2);
    })
    .join(" ");
}

/** Trim a long process name for a narrow column. */
export function truncateMiddle(text, limit = 22) {
  if (typeof text !== "string") return "";
  if (text.length <= limit) return text;
  const half = Math.floor((limit - 1) / 2);
  return text.slice(0, half) + "…" + text.slice(text.length - (limit - 1 - half));
}
