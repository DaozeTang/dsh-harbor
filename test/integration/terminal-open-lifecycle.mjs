/**
 * terminal_open lifecycle contracts that are invisible when everything works:
 *
 * 1. A failed or cancelled open may only clean up the PTY it created. A reused
 *    PTY is the person's panel shell (or an earlier call's); closing it because
 *    this call was slow or cancelled kills their running command.
 * 2. A human keystroke owns a PTY even before terminal_open mints a registry
 *    binding. ssh_connect, ssh_exec and the panel itself open raw PTYs, so the
 *    binding cannot be the only record of the takeover.
 */
import assert from "node:assert/strict";
import HarborService from "../../src/index.js";

function makeService(sessionId, reused) {
  const service = Object.create(HarborService.prototype);
  service.config = {};
  service.connections = new Map();
  service.sessions = new Map([[sessionId, { id: sessionId, exited: null }]]);
  service.terminalOwner = () => "conv-a";
  service.resolveConnection = () => ({ ok: true, connectionId: "c1", connection: { name: "dev", host: "192.0.2.10" } });
  service.liveAgentTerminal = () => undefined;
  service.takenOverTerminal = () => undefined;
  service.openSession = async () => ({ ok: true, value: { sessionId, reused } });
  service.waitForTerminalReady = async () => { throw new Error("startup was cancelled"); };
  service.closed = [];
  service.closeTerminalSession = async (session) => {
    service.closed.push(session.id);
    session.exited = { code: 0, reason: "operator-close" };
  };
  return service;
}

// ── a cancelled open never closes a reused panel terminal ───────────────────
{
  const service = makeService("pty-reused", true);
  await assert.rejects(() => service.openAgentTerminal({ owner: {}, signal: AbortSignal.abort() }), /startup was cancelled/);
  assert.deepEqual(service.closed, [], "the reused panel PTY survives a cancelled open");
}

// ── a PTY this call opened is still cleaned up ──────────────────────────────
{
  const service = makeService("pty-fresh", false);
  await assert.rejects(() => service.openAgentTerminal({ owner: {}, signal: AbortSignal.abort() }), /startup was cancelled/);
  assert.deepEqual(service.closed, ["pty-fresh"], "the PTY created for this call is closed");
}

// ── a panel keystroke owns a raw PTY before any registry binding exists ─────
{
  const service = Object.create(HarborService.prototype);
  const writes = [];
  const session = {
    id: "pty-raw",
    connectionId: "c1",
    ownerSessionId: "conv-a",
    exited: null,
    stream: { write(text) { writes.push(text); } }
  };
  service.sessions = new Map([[session.id, session]]);
  service.connections = new Map([["c1", { id: "c1" }]]);
  const result = await service.write({ sessionId: session.id, data: Buffer.from("l").toString("base64") });
  assert.equal(result.ok, true, result.error?.message);
  assert.deepEqual(writes, ["l"], "the keystroke still reaches the PTY");
  assert.equal(session.userOwned, true, "the raw PTY records the takeover without a registry binding");
  assert.notEqual(service.takenOverTerminal("conv-a", "c1"), undefined, "the next agent open sees the terminal as taken");
}

// ── an anonymous PTY typed into by the person is not adopted ────────────────
{
  const service = Object.create(HarborService.prototype);
  const user = { id: "pty-user", connectionId: "c1", ownerSessionId: null, userOwned: true, exited: null };
  const idle = { id: "pty-idle", connectionId: "c1", ownerSessionId: null, exited: null };
  service.sessions = new Map([[user.id, user], [idle.id, idle]]);
  assert.equal(service.takenOverTerminal("conv-a", "c1")?.sessionId, "pty-user", "a typed-into anonymous PTY is taken");
  service.sessions.delete(user.id);
  assert.equal(service.takenOverTerminal("conv-a", "c1"), undefined, "an untouched anonymous PTY can still be adopted");
}

console.log("terminal open lifecycle: reused PTYs survive, fresh ones are cleaned up, raw keystrokes take ownership: passed");
