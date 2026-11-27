/**
 * The one error-envelope vocabulary for the whole plugin. Host Remote methods
 * and agent tools share the same shapes:
 * - fail(code, message)     → the bare { code, message } carried inside a result envelope
 */

export function fail(code, message) {
  return { code, message };
}

