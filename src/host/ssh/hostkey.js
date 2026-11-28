/**
 * Host-key fingerprint TOFU helpers for dsh-harbor.
 *
 * Pure, side-effect-free functions split out of the connect path so the
 * ssh2 `hostVerifier` contract (raw host-key blob Buffer since ssh2 v1.17)
 * and the accept-new / verify / off decision matrix are unit-tested against
 * the REAL wire shape — a mock object must never hide a contract drift.
 *
 * The KnownHosts wrapper adapts a dsh-storage-domain table
 * (get/put/delete/entries) to host+port addressing so the connect path speaks
 * in servers, not in opaque storage keys.
 */
import { createHash } from "node:crypto";

/** Host-key verification modes, in the order used by the UI selector. */
export const HOST_KEY_MODES = ["accept-new", "verify", "off"];

export const DEFAULT_HOST_KEY_MODE = "accept-new";

/**
 * Extract the SSH host-key algorithm name from a raw host-key blob
 * (SSH wire format: `uint32 len` + algorithm string + key data).
 */
export function blobAlgorithm(blob) {
  if (!Buffer.isBuffer(blob) || blob.length < 4) return "";
  try {
    const len = blob.readUInt32BE(0);
    return blob.toString("utf8", 4, 4 + len);
  } catch {
    return "";
  }
}

/**
 * SHA-256 fingerprint (base64, without the `SHA256:` prefix) of an ssh2
 * host-key blob. ssh2 v1.17 `hostVerifier` receives the RAW host-key blob
 * Buffer (the SSH wire-format `string(algo) string(keydata)`); defensively
 * also accept the legacy `{ hash }` object shape.
 */
export function keyFingerprint(key) {
  const blob = Buffer.isBuffer(key) ? key : (key && key.hash);
  if (!blob) throw new Error("host key missing (hostVerifier received no key blob)");
  return createHash("sha256").update(blob).digest("base64");
}

/** Build a wire-shaped host-key blob for tests: `string(algo) + string(32 bytes)`. */
export function makeKeyBlob(algo, seed) {
  const algoBuf = Buffer.from(algo, "utf8");
  const data = Buffer.alloc(32, seed || 1);
  const blob = Buffer.alloc(4 + algoBuf.length + 4 + data.length);
  blob.writeUInt32BE(algoBuf.length, 0);
  algoBuf.copy(blob, 4);
  blob.writeUInt32BE(data.length, 4 + algoBuf.length);
  data.copy(blob, 8 + algoBuf.length);
  return blob;
}

export function knownHostKey(host, port) {
  return `${host}:${port ?? 22}`;
}

/** Oldest entry dropped first when a peer offers an implausible list of key types. */
const MAX_KNOWN_KEYS = 8;

/**
 * Normalize one stored record to the list of keys it vouches for.
 *
 * A record written before multi-algorithm support carries a single
 * `algorithm`/`fingerprint` pair; a record written now also carries `keys`, one
 * entry per host-key algorithm this server has presented. `keys` wins when it is
 * present and non-empty, so a stale top-level copy can never vouch for a key the
 * record already dropped.
 *
 * @param {object|undefined|null} record - stored record.
 * @returns {Array<{algorithm: string, fingerprint: string, firstSeenAt: string|null, lastSeenAt: string|null}>}
 */
export function knownKeys(record) {
  const valid = (entry) => entry !== null && typeof entry === "object"
    && typeof entry.fingerprint === "string" && entry.fingerprint !== "";
  const normalize = (entry) => ({
    algorithm: typeof entry.algorithm === "string" ? entry.algorithm : "",
    fingerprint: entry.fingerprint,
    firstSeenAt: typeof entry.firstSeenAt === "string" ? entry.firstSeenAt : null,
    lastSeenAt: typeof entry.lastSeenAt === "string" ? entry.lastSeenAt : null
  });
  if (Array.isArray(record?.keys)) {
    const keys = record.keys.filter(valid).map(normalize);
    if (keys.length > 0) return keys;
  }
  return valid(record) ? [normalize(record)] : [];
}

/**
 * Pure verdict for a host-key check, decoupled from ssh2 so it is unit-testable.
 *
 * `known` is either a stored record or a list of keys (see knownKeys). The
 * decision is PER KEY ALGORITHM, exactly as OpenSSH's known_hosts is: one
 * server legitimately offers several host keys, and which one the handshake
 * picks can change without the host changing (a firmware update adds ed25519,
 * an old client can only negotiate ssh-rsa). Comparing against a single stored
 * pair reported every such change as "host key CHANGED" — a false
 * man-in-the-middle alarm, and false alarms are how real ones get ignored.
 *
 * @param {object} args
 * @param {"accept-new"|"verify"|"off"} args.mode
 * @param {object|Array|undefined} args.known   stored record / known keys
 * @param {string} args.presentedFingerprint  fingerprint of the key the server presented
 * @param {string} [args.algorithm]          algorithm name of the presented key
 * @returns {{accept: boolean, reason?: string, record?: {fingerprint: string, algorithm: string}, expected?: string, got?: string}}
 */
export function decideHostKey({ mode, known, presentedFingerprint, algorithm }) {
  if (mode === "off") return { accept: true };

  const keys = Array.isArray(known) ? knownKeys({ keys: known }) : knownKeys(known);
  const matched = keys.some((key) => key.fingerprint === presentedFingerprint);
  // "" records the algorithm of a key stored before this field existed (or a
  // blob whose algorithm could not be read): it can only be matched by
  // fingerprint, but it must still count as "we know this host's key".
  const sameAlgorithm = keys.find((key) => key.algorithm === algorithm || key.algorithm === "");

  if (mode === "verify") {
    if (keys.length === 0) return { accept: false, reason: "unseen-host" };
    if (matched) return { accept: true };
    if (sameAlgorithm !== undefined) {
      return { accept: false, reason: "host-key-mismatch", expected: sameAlgorithm.fingerprint, got: presentedFingerprint };
    }
    // Strict mode trusts exactly what an operator verified: a key type this
    // store has never held is unverified even though the HOST is known.
    return { accept: false, reason: "unseen-host" };
  }

  // accept-new (default): trust on first use, reject on change, per algorithm.
  if (keys.length === 0) return { accept: true, record: { fingerprint: presentedFingerprint, algorithm } };
  if (matched) return { accept: true };
  if (sameAlgorithm !== undefined) {
    return { accept: false, reason: "host-key-mismatch", expected: sameAlgorithm.fingerprint, got: presentedFingerprint };
  }
  if (algorithm === undefined || algorithm === "") {
    // Without a readable algorithm "another key type of this host" cannot be
    // told apart from "a different key of the same type"; fail closed.
    return { accept: false, reason: "host-key-mismatch", expected: keys[0].fingerprint, got: presentedFingerprint };
  }
  return { accept: true, record: { fingerprint: presentedFingerprint, algorithm } };
}

/**
 * Adapter over a dsh-storage-domain table (get/put/delete/entries) that
 * addresses known hosts by host:port. Pure delegation plus one merge rule:
 * recording a key type ADDS it to the host's record instead of replacing the
 * record, because one host:port row has to carry every algorithm the server
 * presents and only the newest pair fits the top-level fields.
 */
export class KnownHosts {
  constructor(table) {
    this.table = table;
    /** host:port -> tail of the in-flight record() chain (see record). */
    this.writes = new Map();
  }

  get(host, port) {
    return this.table.get(knownHostKey(host, port));
  }

  async record(host, port, { fingerprint, algorithm }) {
    const key = knownHostKey(host, port);
    // The merge is a read-modify-write across an awaited storage write: two
    // handshakes to the same server (two conversations, a self-healing
    // reconnect racing a new connect) both read the row, and the later write
    // replaced the earlier one — silently dropping the key type it had just
    // learned, which then looked like a changed host key on the next connect.
    // One chain per host keeps the read and the write of one record together.
    const previous = this.writes.get(key) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(async () => {
      const now = new Date().toISOString();
      const merged = knownKeys(this.table.get(key));
      const existing = merged.find((entry) => entry.algorithm === algorithm);
      if (existing === undefined) {
        merged.push({ algorithm, fingerprint, firstSeenAt: now, lastSeenAt: now });
      } else {
        existing.fingerprint = fingerprint;
        existing.lastSeenAt = now;
        existing.firstSeenAt ??= now;
      }
      // Newest first when trimming: the keys seen least recently are the ones a
      // server has probably stopped offering.
      const kept = merged
        .sort((left, right) => String(left.lastSeenAt ?? "").localeCompare(String(right.lastSeenAt ?? "")))
        .slice(-MAX_KNOWN_KEYS);
      const latest = kept[kept.length - 1];
      await this.table.put(key, {
        host,
        port: port ?? 22,
        // Top level stays "the most recently recorded key": the panel, the
        // RPC schema and archives written by older builds all read one
        // algorithm + fingerprint per host.
        algorithm: latest.algorithm,
        fingerprint: latest.fingerprint,
        firstSeenAt: kept.map((entry) => entry.firstSeenAt).filter(Boolean).sort()[0] ?? now,
        lastSeenAt: now,
        keys: kept
      });
    });
    this.writes.set(key, run);
    try {
      await run;
    } finally {
      if (this.writes.get(key) === run) this.writes.delete(key);
    }
  }

  forget(host, port) {
    // Forgetting a host forgets every algorithm it presented: half a row would
    // leave the panel claiming a trust record that no longer exists.
    return this.table.delete(knownHostKey(host, port));
  }

  list() {
    return [...this.table.entries()].map(([key, value]) => ({ key, ...value }));
  }
}
