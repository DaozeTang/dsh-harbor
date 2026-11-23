/**
 * One status-tab error is a build mismatch, not a sampling failure.
 *
 * DSH's Typert Gateway answers a method the host half has not registered with
 * HTTP 404; the browser client folds that transport fault into a
 * `gateway/internal` RemoteError whose message names the endpoint and the
 * status. The code is therefore generic and the message is the only stable
 * signal. Retrying forever at the sampling cadence cannot succeed until the
 * host half is reloaded, so the pane slows down and explains what to do.
 *
 * @param {unknown} cause - value thrown by the Harbor client wrapper.
 * @returns {boolean} whether the host is missing the endpoint entirely.
 */
export function hostMethodMissing(cause) {
  if (cause === null || cause === undefined) return false;
  if (cause.code === "not-mounted") return true;
  if (typeof cause.code === "string" && /\/(?:definition|invocation)-unavailable$/.test(cause.code)) return true;
  const message = String(cause.message ?? cause);
  return /HTTP 404\b/.test(message)
    || /is not mounted/.test(message)
    || /(?:definition|invocation)-unavailable/.test(message);
}
