/**
 * Tunables and environment parsing for the Harbor host half.
 */
export const MAX_BUFFER_BYTES = 2 * 1024 * 1024;
export const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
export const READ_TIMEOUT_MS = 300;
export const MAX_SESSIONS = 64;
// One interactive terminal per conversation per connection is the ownership
// rule; the per-connection cap bounds the PTY channels one sshd transport must
// carry (sshd's own MaxSessions defaults to 10, shared with SFTP and exec).
export const MAX_SESSIONS_PER_CONNECTION = 8;
// Learning which remote tty a PTY runs on costs one exec round trip, run off
// the open path. Bounded so an unreachable exec channel cannot keep probing.
export const TTY_PROBE_MS = 4000;
export const TTY_PROBE_RETRY_DELAYS_MS = [0, 150, 500, 1200];
export const OPERATOR_APPROVAL_TTL_MS = 5 * 60 * 1000;
// A prompt the operator never answers must not suspend the tool call forever.
// The approval itself has no host-side deadline in DSH, so Harbor owns one:
// when it fires the request settles as cancelled, the DSH client card is
// withdrawn, and the model receives a definite denial instead of a hung turn.
export const OPERATOR_APPROVAL_TIMEOUT_MS = 2 * 60 * 1000;
export const SFTP_DIR_FILE_IDLE_TIMEOUT_MS = 60 * 1000;
// ssh2 disables keepalives by default; without them NATs and cloud firewalls
// silently drop idle connections and every later operation fails on a dead
// transport. Keep the mapping alive and detect a truly dead link fast.
export const KEEPALIVE_INTERVAL_MS = 20000;
export const KEEPALIVE_COUNT_MAX = 3;
// Transient connect failures (resets, timeouts, scanner-induced refusals) are
// retried with backoff; authentication failures are never retried.
export const CONNECT_RETRIES = 3;

/**
 * Key-exchange algorithms for Huawei legacy VRP (S12712 and similar switches,
 * also some old IOS/Comware builds). Such devices offer ONLY SHA-1 group14 and
 * reject every modern KEX, so the handshake dies with "no matching key
 * exchange algorithm" and the device looks simply unreachable.
 *
 * ssh2 ships `diffie-hellman-group14-sha1` in SUPPORTED_KEX but deliberately
 * leaves it out of DEFAULT_KEX (SHA-1 KEX is no longer considered secure), so
 * it must be opted into explicitly. `append` places these after every modern
 * algorithm: a modern peer still negotiates modern, and only a peer that
 * speaks nothing else lands on SHA-1. Scope is deliberately KEX-only — host
 * key and cipher policy are left at ssh2's defaults.
 */
export const LEGACY_VRP_ALGORITHMS = Object.freeze({
  kex: { append: ["diffie-hellman-group14-sha1"] }
});

/**
 * True when the handshake failed because the two sides share no KEX algorithm
 * (as opposed to a wrong password, an unreachable host, or a timeout). Only
 * this specific failure justifies retrying with legacy algorithms — matching
 * anything broader would silently weaken every failing connection.
 */
export function isKexMismatchError(error) {
  const message = String(error?.message ?? error ?? "");
  return /no matching key exchange|no matching kex|key exchange algorithm/i.test(message);
}

export const RECONNECT_BASE_DELAY_MS = 1000;
export const RECONNECT_MAX_DELAY_MS = 30000;
export const RECONNECT_WAIT_MS = 30000;
// Stream push keepalive: when the terminal is idle the generator still yields
// an empty item at this cadence, so the client can tell a live-but-quiet
// terminal from a dead WebSocket mux.
export const STREAM_HEARTBEAT_MS = 15000;
// Streaming file plane (workbench S6 patch): plain-HTTP byte routes registered
// on the DSH webserver with `auth: "required"`. The WebServer admits a request
// through the connection service's Host/Origin + browser-cookie fence
// (webserver/authorize) BEFORE the handler runs, so the handler itself carries
// no admission code. Raw bytes on the wire — no base64 envelope, and no
// whole-file buffering on either side of the ssh2 SFTP streams.
export const STREAM_ROUTE_PREFIX = "/harbor/stream";
export const STREAM_HIGH_WATER_MARK = 256 * 1024;
// Zombie-upload bound: a paused request cannot observe the client's FIN while
// unread body bytes precede it (Node reports request close only after the body
// drains), so an idle-socket timeout backstops the cancelled-upload cleanup.
export const STREAM_IDLE_TIMEOUT_MS = 30000;
// batchRun opens a full SSH connect + exec per target; an unbounded Promise.all
// would storm every selected server (and any rate-limited network path between)
// at once. Worker-pool the targets instead.
export const BATCH_MAX_CONCURRENCY = 4;
// Upper bound for one SFTP/SCP read (agent tools may lower it via max_bytes).
export const MAX_FILE_READ_BYTES = 4 * 1024 * 1024;
// Late readers can still see the exit status of the N most recently exited
// sessions (session tombstones).
export const MAX_EXIT_TOMBSTONES = 64;
// Exited terminals kept in memory for late reads; beyond this they become
// tombstones so a long-lived profile cannot exhaust MAX_SESSIONS.
export const MAX_EXITED_RETAINED = 8;

