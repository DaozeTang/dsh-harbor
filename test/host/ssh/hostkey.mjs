// Unit tests for host-key TOFU verification. Run: node test/hostkey.mjs
import assert from "node:assert/strict";
import {
  blobAlgorithm,
  keyFingerprint,
  makeKeyBlob,
  knownHostKey,
  decideHostKey,
  knownKeys,
  KnownHosts,
  HOST_KEY_MODES
} from "../../../src/host/ssh/hostkey.js";
import HarborService from "../../../src/index.js";

// ── blobAlgorithm ──────────────────────────────────────────────────────────
const ed25519 = makeKeyBlob("ssh-ed25519", 7);
assert.equal(blobAlgorithm(ed25519), "ssh-ed25519", "algorithm name extracted from wire blob");
assert.equal(blobAlgorithm(Buffer.alloc(0)), "", "empty blob yields empty algorithm");
assert.equal(blobAlgorithm(null), "", "non-buffer yields empty algorithm");

// ── keyFingerprint ──────────────────────────────────────────────────────────
const fpA = keyFingerprint(ed25519);
const fpA2 = keyFingerprint(makeKeyBlob("ssh-ed25519", 7));
const fpB = keyFingerprint(makeKeyBlob("ssh-rsa", 3));
assert.equal(typeof fpA, "string");
assert.ok(fpA.length > 0);
assert.equal(fpA, fpA2, "same key bytes → same fingerprint (stable)");
assert.notEqual(fpA, fpB, "different key bytes → different fingerprint");
assert.throws(() => keyFingerprint(null), /host key missing/, "missing blob throws");

// ── makeKeyBlob shape ───────────────────────────────────────────────────────
assert.ok(Buffer.isBuffer(makeKeyBlob("ssh-ed25519", 1)), "makeKeyBlob returns a Buffer");

// ── knownHostKey ────────────────────────────────────────────────────────────
assert.equal(knownHostKey("10.0.0.1", 22), "10.0.0.1:22");
assert.equal(knownHostKey("10.0.0.1"), "10.0.0.1:22", "default port 22");
assert.equal(knownHostKey("10.0.0.1", 2222), "10.0.0.1:2222");

// ── HOST_KEY_MODES ──────────────────────────────────────────────────────────
assert.deepEqual([...HOST_KEY_MODES].sort(), ["accept-new", "off", "verify"]);

// ── decideHostKey ───────────────────────────────────────────────────────────
// off: never blocks, never records.
assert.equal(decideHostKey({ mode: "off", known: undefined }).accept, true);
assert.equal(decideHostKey({ mode: "off", known: { fingerprint: fpB } }).accept, true, "off ignores mismatch");

// accept-new: trust on first use.
const firstSeen = decideHostKey({ mode: "accept-new", known: undefined, presentedFingerprint: fpA, algorithm: "ssh-ed25519" });
assert.equal(firstSeen.accept, true, "first-seen accepted");
assert.equal(firstSeen.record.fingerprint, fpA, "first-seen returns record to persist");

// accept-new: match → accept, no record.
const match = decideHostKey({ mode: "accept-new", known: { fingerprint: fpA }, presentedFingerprint: fpA });
assert.equal(match.accept, true);
assert.equal(match.record, undefined, "no re-record on match");

// accept-new: mismatch → reject.
const mismatch = decideHostKey({ mode: "accept-new", known: { fingerprint: fpB }, presentedFingerprint: fpA });
assert.equal(mismatch.accept, false);
assert.equal(mismatch.reason, "host-key-mismatch");
assert.equal(mismatch.expected, fpB);
assert.equal(mismatch.got, fpA);

// verify: reject unseen hosts.
const unseen = decideHostKey({ mode: "verify", known: undefined, presentedFingerprint: fpA });
assert.equal(unseen.accept, false);
assert.equal(unseen.reason, "unseen-host");

// verify: match → accept.
assert.equal(decideHostKey({ mode: "verify", known: { fingerprint: fpA }, presentedFingerprint: fpA }).accept, true);

// verify: mismatch → reject.
const verifyMismatch = decideHostKey({ mode: "verify", known: { fingerprint: fpB }, presentedFingerprint: fpA });
assert.equal(verifyMismatch.accept, false);
assert.equal(verifyMismatch.reason, "host-key-mismatch");

// ── KnownHosts (backed by an in-memory table mock matching the storage API) ─
function makeTable() {
  const map = new Map();
  return {
    get: (key) => map.get(key),
    put: async (key, value) => { map.set(key, value); },
    delete: async (key) => { const had = map.has(key); map.delete(key); return had; },
    entries: () => map.entries()
  };
}

const table = makeTable();
const kh = new KnownHosts(table);
assert.equal(kh.get("10.0.0.1", 22), undefined, "unknown host → undefined before record");

await kh.record("10.0.0.1", 22, { fingerprint: fpA, algorithm: "ssh-ed25519" });
const stored = kh.get("10.0.0.1", 22);
assert.equal(stored.fingerprint, fpA);
assert.equal(stored.algorithm, "ssh-ed25519");
assert.equal(stored.host, "10.0.0.1");
assert.equal(stored.port, 22);
assert.ok(stored.firstSeenAt, "firstSeenAt set");
assert.ok(stored.lastSeenAt, "lastSeenAt set");

// re-record keeps firstSeenAt, advances lastSeenAt.
const firstSeenAt = stored.firstSeenAt;
await new Promise((r) => setTimeout(r, 5));
await kh.record("10.0.0.1", 22, { fingerprint: fpA, algorithm: "ssh-ed25519" });
const stored2 = kh.get("10.0.0.1", 22);
assert.equal(stored2.firstSeenAt, firstSeenAt, "firstSeenAt preserved on re-record");
assert.ok(new Date(stored2.lastSeenAt) >= new Date(stored.lastSeenAt), "lastSeenAt advanced");

// forget.
const forgot = await kh.forget("10.0.0.1", 22);
assert.equal(forgot, true, "forget returns true when a key was removed");
assert.equal(kh.get("10.0.0.1", 22), undefined, "forgotten host → undefined");
assert.equal(await kh.forget("10.0.0.1", 22), false, "forget returns false when nothing to remove");

// list.
await kh.record("10.0.0.2", 2222, { fingerprint: fpB, algorithm: "ssh-rsa" });
const all = kh.list();
assert.equal(all.length, 1, "list reflects remaining entries");
assert.equal(all[0].host, "10.0.0.2");

// ── multi-algorithm records ─────────────────────────────────────────────────
// One server legitimately offers several host keys, and which one a handshake
// picks can change without the host changing (a firmware update adds ed25519,
// an old client can only negotiate ssh-rsa). Trust is per algorithm, the way
// OpenSSH's known_hosts is.
const rsaKey = makeKeyBlob("ssh-rsa", 11);
const fpRsa = keyFingerprint(rsaKey);
const multi = new KnownHosts(makeTable());
await multi.record("10.0.0.9", 22, { fingerprint: fpA, algorithm: "ssh-ed25519" });
await multi.record("10.0.0.9", 22, { fingerprint: fpRsa, algorithm: "ssh-rsa" });
const multiRow = multi.get("10.0.0.9", 22);
assert.equal(knownKeys(multiRow).length, 2, "both key types stay in one host record");
assert.equal(multiRow.algorithm, "ssh-rsa", "the top-level pair is the most recently seen key");
assert.equal(knownKeys(multiRow).find((key) => key.algorithm === "ssh-ed25519").fingerprint, fpA);

const secondAlgorithm = decideHostKey({ mode: "accept-new", known: multiRow, presentedFingerprint: fpRsa, algorithm: "ssh-rsa" });
assert.equal(secondAlgorithm.accept, true, "a known second algorithm is not a changed host key");
assert.equal(secondAlgorithm.record, undefined, "an already-recorded algorithm is not re-recorded");

const ecKey = makeKeyBlob("ecdsa-sha2-nistp256", 12);
const newAlgorithm = decideHostKey({ mode: "accept-new", known: multiRow, presentedFingerprint: keyFingerprint(ecKey), algorithm: "ecdsa-sha2-nistp256" });
assert.equal(newAlgorithm.accept, true, "a new algorithm of a trusted host is recorded, not refused");
assert.equal(newAlgorithm.record.algorithm, "ecdsa-sha2-nistp256");

const rotated = decideHostKey({ mode: "accept-new", known: multiRow, presentedFingerprint: keyFingerprint(makeKeyBlob("ssh-rsa", 99)), algorithm: "ssh-rsa" });
assert.equal(rotated.accept, false, "the same algorithm with a different key is still a change");
assert.equal(rotated.reason, "host-key-mismatch");
assert.equal(rotated.expected, fpRsa);

const strictNewAlgorithm = decideHostKey({ mode: "verify", known: multiRow, presentedFingerprint: keyFingerprint(makeKeyBlob("ecdsa-sha2-nistp256", 13)), algorithm: "ecdsa-sha2-nistp256" });
assert.equal(strictNewAlgorithm.accept, false, "verify mode never trusts a key type it has not verified");
assert.equal(strictNewAlgorithm.reason, "unseen-host");

// Records written before multi-algorithm support carry one pair and no `keys`.
const legacyRecord = { host: "10.0.0.9", port: 22, algorithm: "", fingerprint: fpA };
assert.equal(decideHostKey({ mode: "accept-new", known: legacyRecord, presentedFingerprint: fpA, algorithm: "ssh-ed25519" }).accept, true);
assert.equal(decideHostKey({ mode: "accept-new", known: legacyRecord, presentedFingerprint: fpB, algorithm: "ssh-ed25519" }).accept, false, "an unattributed record still detects a changed key");

// Two handshakes recording different algorithms at once must not lose either:
// the merge is a read-modify-write across an awaited storage write.
const slowMap = new Map();
const slow = new KnownHosts({
  get: (key) => slowMap.get(key),
  put: async (key, value) => { await new Promise((resolve) => setTimeout(resolve, 5)); slowMap.set(key, value); },
  delete: async (key) => slowMap.delete(key),
  entries: () => slowMap.entries()
});
await Promise.all([
  slow.record("10.0.0.10", 22, { fingerprint: fpA, algorithm: "ssh-ed25519" }),
  slow.record("10.0.0.10", 22, { fingerprint: fpRsa, algorithm: "ssh-rsa" })
]);
assert.equal(knownKeys(slow.get("10.0.0.10", 22)).length, 2, "concurrent records keep both algorithms");

// ── proxyJump TOFU propagation ──────────────────────────────────────────────
// A rejected jump host must retain its structured code so connectClient neither
// retries the chain nor lets scheduleReconnect treat it as a transient failure.
const service = Object.create(HarborService.prototype);
let chainCalls = 0;
service.connectChain = async () => {
  chainCalls += 1;
  const error = new Error("proxyJump hop 1: host key changed");
  error.code = "host-key-mismatch";
  throw error;
};
service.sleep = async () => { throw new Error("host-key failures must not sleep/retry"); };
const chainFailure = await service.connectClient({
  id: "test-connection",
  closing: false,
  proxyJump: [{}],
  connectConfig: { host: "target.example", port: 22 },
  username: "root"
}, 3);
assert.equal(chainCalls, 1, "host-key rejection in a jump chain is not retried");
assert.equal(chainFailure.ok, false);
assert.equal(chainFailure.error.code, "host-key-mismatch", "jump-chain error code survives for reconnect suppression");

console.log("hostkey: all tests passed");
