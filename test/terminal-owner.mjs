/**
 * Ownership rules for per-conversation terminals.
 *
 * These are the pure helpers the service builds on: which session owns a PTY,
 * which conversation a subagent's terminal belongs to, and — the one rule that
 * must never silently fail — how a terminal without an index is derived
 * instead of being reported as ownerless.
 */
import assert from "node:assert/strict";
import {
  ANONYMOUS_OWNER,
  anonymousSessions,
  conversationOwner,
  delegationDepth,
  indexOwner,
  isLiveSession,
  isOwnedBy,
  normalizeOwner,
  ownerKey,
  ownerSessionIds,
  pickOwnerSession,
  resolveTerminalOwner,
  unindexOwner
} from "../src/host/terminal-owner.js";

// ── owner ids ────────────────────────────────────────────────────────────────
{
  assert.equal(normalizeOwner("conv-a"), "conv-a");
  assert.equal(normalizeOwner(""), null, "an empty id is not an owner");
  assert.equal(normalizeOwner("   "), "   ", "ids are opaque; they are not trimmed or rewritten");
  assert.equal(normalizeOwner("x".repeat(129)), null, "absurd ids are refused, not truncated");
  assert.equal(normalizeOwner("a\u0000b"), null, "control characters are refused");
  assert.equal(normalizeOwner(42), null);
  assert.equal(normalizeOwner(undefined), null);
  assert.equal(ownerKey(undefined), ANONYMOUS_OWNER, "no session collapses onto the anonymous bucket");
  assert.equal(ownerKey("conv-a"), "conv-a");
}

// ── index maintenance ───────────────────────────────────────────────────────
{
  const conn = { sessions: new Set(["s1", "s2"]) };
  indexOwner(conn, "s1", "conv-a");
  indexOwner(conn, "s2", "conv-a");
  assert.deepEqual(ownerSessionIds(conn, "conv-a"), ["s1", "s2"]);
  unindexOwner(conn, "s1", "conv-a");
  assert.deepEqual(ownerSessionIds(conn, "conv-a"), ["s2"]);
  unindexOwner(conn, "s2", "conv-a");
  assert.equal(conn.ownerIndex.has("conv-a"), false, "an emptied bucket is deleted, not left behind");
}

// ── liveness and picking ────────────────────────────────────────────────────
{
  const live = { id: "s2", ownerSessionId: "conv-a", exited: null, stream: {} };
  const dead = { id: "s1", ownerSessionId: "conv-a", exited: { code: 0 }, stream: null };
  const sessions = new Map([["s1", dead], ["s2", live]]);
  const conn = { sessions: new Set(["s1", "s2"]) };
  indexOwner(conn, "s1", "conv-a");
  indexOwner(conn, "s2", "conv-a");
  assert.equal(isLiveSession(dead), false);
  assert.equal(isLiveSession(live), true);
  assert.equal(pickOwnerSession(sessions, conn, "conv-a"), live, "a tombstone never answers for its owner");
  assert.equal(pickOwnerSession(sessions, conn, "conv-b"), undefined);

  // Newest first: a conversation that reopened after an exit gets the new one.
  const newer = { id: "s3", ownerSessionId: "conv-a", exited: null, stream: {} };
  sessions.set("s3", newer);
  indexOwner(conn, "s3", "conv-a");
  assert.equal(pickOwnerSession(sessions, conn, "conv-a"), newer);
}

// ── anonymous bucket and derivation fallback ────────────────────────────────
{
  const anon = { id: "s0", exited: null, stream: {} };
  const sessions = new Map([["s0", anon]]);
  const conn = { sessions: new Set(["s0"]) };
  indexOwner(conn, "s0", null);
  assert.deepEqual(anonymousSessions(sessions, conn), [anon]);
  assert.equal(isOwnedBy(anon, null), true);
  assert.equal(isOwnedBy(anon, "conv-a"), false);

  // A connection restored without an index (older shape, or a test double):
  // the answer is derived from the sessions, never a silent "no terminal".
  const bare = { sessions: new Set(["x1"]) };
  const owned = { id: "x1", ownerSessionId: "conv-a", exited: null, stream: {} };
  const bareSessions = new Map([["x1", owned]]);
  assert.deepEqual(ownerSessionIds(bare, "conv-a", bareSessions), ["x1"]);
  assert.equal(pickOwnerSession(bareSessions, bare, "conv-a"), owned);
  assert.deepEqual(anonymousSessions(bareSessions, bare), [], "an owned terminal is not anonymous");
}

// ── subagent lineage ────────────────────────────────────────────────────────
{
  assert.equal(delegationDepth({ header: {} }), 0);
  assert.equal(delegationDepth({ header: { delegationDepth: 2 } }), 2);
  assert.equal(delegationDepth({ header: { origin: "subagent" } }), 1, "the coarse marker means at least one level deep");
  assert.equal(delegationDepth({ header: { parentSession: "root" } }), 0, "a fork is NOT a delegation: it gets its own terminal");

  const root = { id: "root", header: {} };
  const child = { id: "child", header: { parentSession: "root", delegationDepth: 1 } };
  const grandchild = { id: "grand", header: { parentSession: "child", delegationDepth: 2 } };
  const agents = new Map([["root", { session: root }], ["child", { session: child }], ["grand", { session: grandchild }]]);
  const getAgent = (id) => agents.get(id);

  assert.equal(conversationOwner("child", child, getAgent), "root", "a subagent works in its conversation's terminal");
  assert.equal(conversationOwner("grand", grandchild, getAgent), "root", "the walk reaches the top-level conversation");
  assert.equal(conversationOwner("root", root, getAgent), "root");

  // A parent that is no longer live still names the owner: falling back to the
  // child would split one conversation across two terminals.
  assert.equal(conversationOwner("child", child, () => undefined), "root");
  // Missing header: keep the caller's own id rather than guessing a parent.
  assert.equal(conversationOwner("kid", { header: {} }, getAgent), "kid");
  // Depth without a parent id cannot walk; it must terminate, not loop.
  const orphan = { id: "orphan", header: { delegationDepth: 3 } };
  assert.equal(conversationOwner("orphan", orphan, getAgent), "orphan");

  // A cycle must not hang the resolver.
  const a = { id: "a", header: { parentSession: "b", delegationDepth: 1 } };
  const b = { id: "b", header: { parentSession: "a", delegationDepth: 1 } };
  const cyc = new Map([["a", { session: a }], ["b", { session: b }]]);
  assert.equal(typeof conversationOwner("a", a, (id) => cyc.get(id)), "string");

  assert.equal(resolveTerminalOwner({ sessionId: "child", session: child, scope: "conversation", getAgent }), "root");
  assert.equal(resolveTerminalOwner({ sessionId: "child", session: child, scope: "agent", getAgent }), "child", "agent scope keeps every subagent separate");
  assert.equal(resolveTerminalOwner({ sessionId: undefined, session: undefined, scope: "conversation", getAgent }), null);
}

console.log("terminal owner: ids, index, liveness, adoption bucket, subagent lineage: passed");
