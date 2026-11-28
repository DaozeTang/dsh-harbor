/**
 * The pane's view of its own terminal, and the RPC shapes that carry the
 * conversation id.
 *
 * The host resolves ownership; the browser must still pick the right terminal
 * and must never render another conversation's shell by accident ("the first
 * session on this connection" is exactly what it used to do).
 */
import assert from "node:assert/strict";
import { closeTabAction, hasOwnTerminal, resolvePaneTerminal } from "../src/client/state/session-terminals.js";
import { HarborApi } from "../src/client/core/api.js";

const connection = (terminals, sessions = terminals.map((terminal) => terminal.sessionId)) => ({
  connectionId: "c1",
  host: "192.0.2.10",
  port: 22,
  username: "root",
  connected: true,
  sessions,
  terminals
});

// ── my terminal, when I have one ────────────────────────────────────────────
{
  const info = connection([
    { sessionId: "s1", ownerSessionId: "conv-a", openedBy: "panel", alive: true, mine: true },
    { sessionId: "s2", ownerSessionId: "conv-b", openedBy: "agent", alive: true, mine: false }
  ]);
  const view = resolvePaneTerminal(info, "conv-a");
  assert.equal(view.sessionId, "s1");
  assert.equal(view.total, 2);
  assert.deepEqual(view.others.map((terminal) => terminal.sessionId), ["s2"]);
  assert.equal(hasOwnTerminal(info, "conv-a"), true);
}

// ── another conversation's terminal is counted, never shown ─────────────────
{
  const info = connection([
    { sessionId: "s2", ownerSessionId: "conv-b", openedBy: "panel", alive: true, mine: false }
  ]);
  const view = resolvePaneTerminal(info, "conv-a");
  assert.equal(view.sessionId, null, "the pane must not fall back to somebody else's shell");
  assert.equal(view.total, 1);
  assert.equal(view.others.length, 1);
  assert.equal(hasOwnTerminal(info, "conv-a"), false);
}

// ── dead terminals do not count as "mine" ──────────────────────────────────
{
  const info = connection([
    { sessionId: "s1", ownerSessionId: "conv-a", openedBy: "panel", alive: false, mine: true },
    { sessionId: "s2", ownerSessionId: "conv-b", openedBy: "panel", alive: true, mine: false }
  ]);
  const view = resolvePaneTerminal(info, "conv-a");
  assert.equal(view.sessionId, null);
  assert.equal(view.total, 1, "an exited shell is not offered as a live terminal");
  assert.equal(view.others.length, 1);
}

// ── an older host has no terminals array: its first session is "the terminal" ─
{
  const legacy = { connectionId: "c1", host: "h", port: 22, username: "u", connected: true, sessions: ["s9"] };
  assert.equal(resolvePaneTerminal(legacy, "conv-a").sessionId, "s9");
  assert.equal(hasOwnTerminal(legacy, "conv-a"), true);
  assert.equal(resolvePaneTerminal({ ...legacy, sessions: [] }, "conv-a").sessionId, null);
  assert.deepEqual(resolvePaneTerminal(undefined, "conv-a"), { sessionId: null, own: null, others: [], total: 0 });
}

// ── the host's mine flag is trusted; ownerSessionId is the fallback ─────────
{
  const withoutFlag = connection([{ sessionId: "s1", ownerSessionId: "conv-a", openedBy: "panel", alive: true }]);
  assert.equal(resolvePaneTerminal(withoutFlag, "conv-a").sessionId, "s1");
  assert.equal(resolvePaneTerminal(withoutFlag, "conv-b").sessionId, null);
}

// ── closing a tab never disconnects a server another chat still uses ───────
{
  const shared = connection([
    { sessionId: "s1", ownerSessionId: "conv-a", openedBy: "panel", alive: true, mine: true },
    { sessionId: "s2", ownerSessionId: "conv-b", openedBy: "panel", alive: true, mine: false }
  ]);
  assert.equal(closeTabAction(shared, "conv-a"), "close-terminal", "my terminal ends, the transport stays for the other chat");

  const mineOnly = connection([
    { sessionId: "s1", ownerSessionId: "conv-a", openedBy: "panel", alive: true, mine: true }
  ]);
  assert.equal(closeTabAction(mineOnly, "conv-a"), "disconnect", "nobody else is on it, so the transport goes too");

  const theirsOnly = connection([
    { sessionId: "s2", ownerSessionId: "conv-b", openedBy: "panel", alive: true, mine: false }
  ]);
  assert.equal(closeTabAction(theirsOnly, "conv-a"), "none", "a tab with no terminal of mine leaves everything alone");

  const legacy = { connectionId: "c1", host: "h", port: 22, username: "u", connected: true, sessions: ["s9"] };
  assert.equal(closeTabAction(legacy, "conv-a"), "disconnect", "an older host's single terminal is still the whole connection");
}

// ── HarborApi: the conversation id rides on the request ────────────────────
{
  const calls = [];
  const api = new HarborApi(() => ({
    list: async (request) => { calls.push(["list", request]); return { ok: true, value: { ok: true, value: { connections: [], activeConnectionId: null } } }; },
    openSession: async (request) => { calls.push(["openSession", request]); return { ok: true, value: { ok: true, value: { sessionId: "s1", connectionId: "c1", cols: 100, rows: 30, alive: true, ownerSessionId: "conv-a", reused: false } } }; },
    selectConnection: async (request) => { calls.push(["selectConnection", request]); return { ok: true, value: { ok: true, value: { activeConnectionId: "c1" } } }; },
    execPolicyGet: async (request) => { calls.push(["execPolicyGet", request]); return { ok: true, value: { ok: true, value: { effective: "standard", source: "global", allow: [], global: { policy: "standard", allow: [] }, profileOverride: null } } }; },
    execPolicySet: async (request) => { calls.push(["execPolicySet", request]); return { ok: true, value: { ok: true, value: { effective: request.policy, source: "session", allow: [], global: { policy: "standard", allow: [] }, profileOverride: null } } }; }
  }));

  await api.list();
  await api.list("conv-a");
  await api.openSession("c1", 100, 30, { sessionId: "conv-a", adopt: true, openedBy: "panel" });
  await api.openSession("c1", 100, 30);
  await api.selectConnection("c1", "conv-a");
  await api.execPolicyGet("c1", "conv-a");
  await api.execPolicySet("c1", "allowAll", "conv-a");

  assert.deepEqual(calls, [
    ["list", {}],
    ["list", { sessionId: "conv-a" }],
    ["openSession", { connectionId: "c1", cols: 100, rows: 30, sessionId: "conv-a", openedBy: "panel", adopt: true }],
    ["openSession", { connectionId: "c1", cols: 100, rows: 30 }],
    ["selectConnection", { connectionId: "c1", sessionId: "conv-a" }],
    ["execPolicyGet", { connectionId: "c1", sessionId: "conv-a" }],
    ["execPolicySet", { connectionId: "c1", policy: "allowAll", sessionId: "conv-a" }]
  ]);
}

console.log("pane terminals: own/others selection, legacy host fallback, RPC session scoping: passed");
