/**
 * Registry wrappers must not outlive their PTY.
 *
 * SshTerminalSession.close() releases its binding, but the host also destroys
 * PTYs on natural exit, operator close, owner disposal and transport loss.
 * Those paths used to leave the wrapper (and the session record + output
 * journal it pins) in the service map for the life of the process, and
 * bindingForTerminal kept returning a dead input mirror to the terminal_send
 * gate. These cases pin every delete path.
 */
import assert from "node:assert/strict";
import HarborService from "../src/index.js";

function fakeService() {
  const service = Object.create(HarborService.prototype);
  service.config = { maxBufferBytes: 1024 * 1024 };
  service.connections = new Map();
  service.sessions = new Map();
  service.exitedSessions = new Map();
  service._terminalBindings = new Map();
  service.activeConnectionByOwner = new Map();
  service.log = () => {};
  service.sessionLogStore = () => null;
  service.wakeWaiters = () => {};
  service.notifyStreamListeners = () => {};
  return service;
}

function addConnection(service) {
  const conn = {
    id: "c1",
    sessions: new Set(),
    ownerIndex: new Map(),
    tunnels: new Map(),
    closing: false,
    client: { end() {} },
    hops: []
  };
  service.connections.set(conn.id, conn);
  return conn;
}

function addSession(service, conn, id, { exited = null, owner = "conv-1" } = {}) {
  const binding = { registryId: `reg-${id}`, sessionId: id };
  const session = {
    id,
    connectionId: conn.id,
    ownerSessionId: owner,
    exited,
    stream: exited === null ? { end() {} } : null,
    waiters: [],
    streamListeners: new Set(),
    terminalBinding: binding
  };
  service.sessions.set(id, session);
  service._terminalBindings.set(binding.registryId, binding);
  conn.sessions.add(id);
  return session;
}

function assertDetached(service, session) {
  assert.equal(session.terminalBinding, undefined, "the PTY no longer points at a registry wrapper");
  assert.equal(service._terminalBindings.has(`reg-${session.id}`), false, "the wrapper is out of the service map");
}

// ── natural exit (remote shell gone) ───────────────────────────────────────
{
  const service = fakeService();
  const conn = addConnection(service);
  const session = addSession(service, conn, "s1");
  service.recordExit(session, { code: 0, reason: "remote-exit" });
  assertDetached(service, session);
}

// ── operator close from the panel ──────────────────────────────────────────
{
  const service = fakeService();
  const conn = addConnection(service);
  const session = addSession(service, conn, "s1");
  const result = await service.closeSession({ sessionId: "s1" });
  assert.equal(result.ok, true);
  assertDetached(service, session);
}

// ── the conversation ends: every terminal it owns is closed ────────────────
{
  const service = fakeService();
  const conn = addConnection(service);
  const first = addSession(service, conn, "s1");
  const second = addSession(service, conn, "s2");
  conn.ownerIndex.set("conv-1", new Set(["s1", "s2"]));
  const result = await service.closeTerminalsForOwner("conv-1");
  assert.equal(result.value.closed, 2);
  assertDetached(service, first);
  assertDetached(service, second);
}

// ── exited-terminal pruning (retention cap) ────────────────────────────────
{
  const service = fakeService();
  const conn = addConnection(service);
  const sessions = Array.from({ length: 10 }, (_, index) => addSession(service, conn, `s${index}`, { exited: { code: 0 } }));
  service.pruneExitedSessions();
  assert.equal(service.sessions.size, 8, "only the newest eight exited terminals stay");
  assertDetached(service, sessions[0]);
  assertDetached(service, sessions[1]);
  assert.equal(service._terminalBindings.size, 8, "the retained terminals keep their wrappers");
}

// ── explicit disconnect, including an already-exited record ────────────────
{
  const service = fakeService();
  const conn = addConnection(service);
  const live = addSession(service, conn, "s1");
  const exited = addSession(service, conn, "s2", { exited: { code: 0 } });
  const result = await service.disconnect({ connectionId: "c1" });
  assert.equal(result.ok, true);
  assertDetached(service, live);
  assertDetached(service, exited);
  assert.equal(service._terminalBindings.size, 0);
}

console.log("binding lifecycle: natural exit, close, owner disposal, prune and disconnect release wrappers: passed");
