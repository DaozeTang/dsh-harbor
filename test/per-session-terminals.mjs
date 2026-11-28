/**
 * Per-conversation terminals: the isolation contract.
 *
 * Two chats (and their agents) work against one SSH connection. Everything
 * they share is transport; everything they act through — the PTY, the reading
 * cursor, the exec mirror, the agent's target connection, the network-CLI
 * mutex, the operator's execution tier — belongs to one conversation. These
 * cases pin that separation down at the service seam, plus the migration rules
 * (adoption of an anonymous terminal) and the wire schemas the panel reads.
 */
import assert from "node:assert/strict";
import HarborService from "../src/index.js";
import { listResultSchema, openSessionResultSchema } from "../src/rpc/schemas.js";

const PROFILE_ID = "11111111-1111-1111-1111-111111111111";

function makeService() {
  const service = Object.create(HarborService.prototype);
  service.config = { maxBufferBytes: 65536, maxCommandOutputBytes: 65536, defaultReadTimeoutMs: 20 };
  service.connections = new Map();
  service.sessions = new Map();
  service.exitedSessions = new Map();
  service.operatorApprovals = new Map();
  service.activeConnectionId = null;
  service.activeConnectionByOwner = new Map();
  service.agentAutoConnect = false;
  return service;
}

/** A PTY channel whose writes and emitted output the test can inspect. */
function fakeStream() {
  const listeners = new Map();
  const stream = {
    writes: [],
    ended: false,
    on(event, fn) {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
      return stream;
    },
    removeListener() {},
    write(chunk) { stream.writes.push(chunk); },
    end() { stream.ended = true; },
    setWindow() {},
    emit(event, ...args) { for (const fn of listeners.get(event) ?? []) fn(...args); }
  };
  return stream;
}

function attach(service, connectionId = "c1") {
  const streams = [];
  const conn = {
    id: connectionId,
    host: "192.0.2.10",
    port: 22,
    username: "root",
    sessions: new Set(),
    ownerIndex: new Map(),
    openQueue: Promise.resolve(),
    execPolicyOverrides: new Map(),
    dead: false,
    closing: false,
    connecting: false,
    connectConfig: { host: "192.0.2.10", port: 22 },
    client: {
      shell(_opts, callback) {
        const stream = fakeStream();
        streams.push(stream);
        queueMicrotask(() => callback(null, stream));
        return stream;
      },
      // tty learning is opt-in through config; a stub transport must never be
      // probed (resolveTerminalTty stays unset here).
      exec() { throw new Error("the census must not run on this fixture"); }
    }
  };
  service.connections.set(connectionId, conn);
  return { conn, streams };
}

const open = (service, sessionId, extra = {}) => service.openSession({ connectionId: "c1", sessionId, ...extra });

// ── one terminal per conversation, reused on every later request ────────────
{
  const service = makeService();
  const { conn, streams } = attach(service);

  const a = await open(service, "conv-a");
  assert.equal(a.ok, true, a.error?.message);
  const b = await open(service, "conv-b");
  assert.equal(b.ok, true, b.error?.message);
  assert.notEqual(a.value.sessionId, b.value.sessionId, "each conversation gets its own PTY");
  assert.equal(conn.sessions.size, 2);
  assert.equal(streams.length, 2, "two channels were opened, not one shared");
  assert.equal(service.sessions.get(a.value.sessionId).ownerSessionId, "conv-a");
  assert.equal(service.sessions.get(b.value.sessionId).ownerSessionId, "conv-b");

  const again = await open(service, "conv-a");
  assert.equal(again.value.sessionId, a.value.sessionId, "re-requesting returns the live terminal");
  assert.equal(again.value.reused, true);
  assert.equal(streams.length, 2, "and never opens a second channel");

  // Wire shape: the panel reads ownerSessionId/reused, so it must round-trip.
  assert.equal(openSessionResultSchema.safeParse(a).success, true);
  assert.equal(openSessionResultSchema.safeParse(again).success, true);
}

// ── an anonymous terminal is adopted exactly once ───────────────────────────
{
  const service = makeService();
  const { streams } = attach(service);
  const anonymous = await open(service, undefined);
  assert.equal(anonymous.ok, true, anonymous.error?.message);
  assert.equal(anonymous.value.ownerSessionId, null, "no session id means an unowned terminal");

  const claimed = await open(service, "conv-a");
  assert.equal(claimed.value.sessionId, anonymous.value.sessionId, "the first conversation adopts it");
  assert.equal(claimed.value.adopted, true);
  assert.equal(streams.length, 1, "adoption never opens another PTY");

  const second = await open(service, "conv-b");
  assert.notEqual(second.value.sessionId, anonymous.value.sessionId, "the adopted terminal cannot be taken again");
  assert.equal(second.value.ownerSessionId, "conv-b");
}

// ── exec output is mirrored into the caller's terminal only ─────────────────
{
  const service = makeService();
  attach(service);
  const a = await open(service, "conv-a");
  const b = await open(service, "conv-b");
  service.resolveLoginShell = async () => "bash";
  service.collectExecOutput = async () => ({ exitCode: 0, stdout: "hello from exec\n", stderr: "", truncated: false, timedOut: false });

  const result = await service.execOnConnection("c1", "echo hi", 1000, undefined, "conv-a");
  assert.equal(result.ok, true, result.error?.message);
  const seenByA = service.terminalOutput(service.sessions.get(a.value.sessionId)).read().data;
  const seenByB = service.terminalOutput(service.sessions.get(b.value.sessionId)).read().data;
  assert.match(seenByA, /hello from exec/, "the owner sees the command it asked for");
  assert.doesNotMatch(seenByB, /hello from exec/, "the other terminal stays clean");
  assert.match(seenByA, /\$ echo hi/, "echoed with the agent marker");
}

// ── agent target and selection are per conversation ─────────────────────────
{
  const service = makeService();
  attach(service, "c1");
  const second = attach(service, "c2");
  await open(service, "conv-a");              // conv-a's terminal lives on c1
  const bodyB = await service.openSession({ connectionId: "c2", sessionId: "conv-b" });
  assert.equal(bodyB.ok, true, bodyB.error?.message);

  const selected = await service.selectConnection({ connectionId: "c2", sessionId: "conv-b" });
  assert.equal(selected.ok, true);
  assert.equal(selected.value.activeConnectionId, "c2");
  assert.equal(service.activeConnectionId, null, "a session-scoped click never writes the shared pointer");

  const forB = service.resolveConnection(undefined, "conv-b");
  assert.equal(forB.connectionId, "c2");
  const forA = service.resolveConnection(undefined, "conv-a");
  assert.equal(forA.connectionId, "c1", "conv-a is found through its own terminal, not through B's click");

  const listedA = await service.list({ sessionId: "conv-a" });
  assert.equal(listedA.value.activeConnectionId, "c1");
  const listedB = await service.list({ sessionId: "conv-b" });
  assert.equal(listedB.value.activeConnectionId, "c2");
  assert.equal(listResultSchema.safeParse(listedB).success, true, "list() satisfies the strict wire schema");

  const terminalsC1 = listedA.value.connections.find((entry) => entry.connectionId === "c1").terminals;
  assert.deepEqual(terminalsC1.map((terminal) => [terminal.ownerSessionId, terminal.mine]), [["conv-a", true]]);
  const terminalsC2 = listedB.value.connections.find((entry) => entry.connectionId === "c2").terminals;
  assert.deepEqual(terminalsC2.map((terminal) => [terminal.ownerSessionId, terminal.mine]), [["conv-b", true]]);
  assert.ok(second.conn.sessions.size >= 1);

  // A transport loss must not retarget the chat. c2 is dead-but-reconnecting
  // (the record survives, the self-healing reconnect reuses it) while conv-a
  // still has a terminal on c1. Dropping the binding on "dead" is what used to
  // hand conv-b's next tool call to c1 — a command on a machine nobody asked
  // for — and then re-bind the conversation there for good.
  second.conn.dead = true;
  assert.equal(service.activeConnectionFor("conv-b"), "c2", "a reconnecting connection keeps its binding");
  const whileDead = service.resolveConnection(undefined, "conv-b");
  assert.equal(whileDead.ok, true);
  assert.equal(whileDead.connectionId, "c2", "a dead bound record is still the target, never another server");
  assert.equal(service.activeConnectionByOwner.get("conv-b"), "c2", "the binding outlives the transport loss");

  // Only a record that is really gone (explicit disconnect) releases it.
  service.connections.delete("c2");
  assert.equal(service.activeConnectionFor("conv-b"), null, "a removed connection releases the binding");
  assert.equal(service.activeConnectionByOwner.has("conv-b"), false, "a removed connection releases it");
}

// ── ssh_exec's lazy terminal open is per conversation ───────────────────────
{
  const service = makeService();
  const { streams } = attach(service);
  const a = await open(service, "conv-a");
  const before = streams.length;
  const ensured = await service.ensureSessionForWrite("c1", "conv-a");
  assert.equal(ensured.ok, true);
  assert.equal(streams.length, before, "an existing terminal is reused");
  assert.equal(ensured.connectionId, "c1");

  const opened = await service.ensureSessionForWrite("c1", "conv-b");
  assert.equal(opened.ok, true);
  assert.equal(streams.length, before + 1, "a conversation without one gets its own");
  assert.equal(service.sessions.get(a.value.sessionId).ownerSessionId, "conv-a");
}

// ── a conversation's terminal closes with it, and only its own ──────────────
{
  const service = makeService();
  const { conn, streams } = attach(service);
  const a = await open(service, "conv-a");
  const b = await open(service, "conv-b");

  const closed = await service.closeTerminalsForOwner("conv-a");
  assert.equal(closed.ok, true);
  assert.equal(closed.value.closed, 1);
  assert.equal(service.sessions.has(a.value.sessionId), false);
  assert.equal(service.sessions.has(b.value.sessionId), true, "the surviving conversation keeps its terminal");
  assert.equal(conn.sessions.size, 1);
  assert.equal(streams[0].ended, true);
  assert.equal(streams[1].ended, false);
}

// ── per-connection cap reports the sshd channel limit, not a mystery ────────
{
  const service = makeService();
  attach(service);
  for (let index = 0; index < 8; index += 1) {
    const opened = await open(service, `conv-${index}`);
    assert.equal(opened.ok, true, opened.error?.message);
  }
  const ninth = await open(service, "conv-overflow");
  assert.equal(ninth.ok, false);
  assert.equal(ninth.error.code, "terminal-limit");
  assert.match(ninth.error.message, /MaxSessions/, "the operator is told what to raise");
}

// ── two conversations connecting the same saved resource see their own PTY ──
{
  const service = makeService();
  const { conn, streams } = attach(service);
  service.agentAutoConnect = true;
  service.profileTable = {
    get: (id) => (id === PROFILE_ID ? { name: "dev", host: "192.0.2.10", port: 22, username: "root" } : undefined),
    entries: () => [[PROFILE_ID, { name: "dev" }]]
  };
  service.requireProfileTable = () => service.profileTable;
  service.profileConnect = async () => ({ ok: true, value: { connectionId: "c1", host: "192.0.2.10", port: 22, username: "root" } });

  const first = await service.agentConnectProfile({ resource: "dev", sessionId: "conv-a" });
  assert.equal(first.ok, true, first.error?.message);
  assert.equal(first.value.terminalOpened, true);
  const second = await service.agentConnectProfile({ resource: "dev", sessionId: "conv-b" });
  assert.equal(second.ok, true, second.error?.message);
  assert.equal(second.value.terminalOpened, true, "the second conversation is not told it reused the first one's PTY");
  assert.equal(conn.sessions.size, 2);
  assert.equal(streams.length, 2);

  const owners = [...conn.sessions].map((id) => service.sessions.get(id).ownerSessionId).sort();
  assert.deepEqual(owners, ["conv-a", "conv-b"]);
  assert.equal(conn.agentRevealOwnerSessionId, "conv-b", "the reveal targets the asking conversation");
  const listed = await service.list({ sessionId: "conv-a" });
  assert.equal(listed.value.connections[0].agentSessionMine, true);
}

// ── terminal_open adopts the panel PTY that ssh_connect opened ─────────────
{
  const service = makeService();
  const { streams } = attach(service);
  const raw = await open(service, "conv-a");
  assert.equal(raw.ok, true, raw.error?.message);
  service.waitForTerminalReady = async () => {};
  const prepared = await service.openAgentTerminal({ owner: { id: "conv-a" } });
  assert.equal(prepared.session.id, raw.value.sessionId, "terminal_open reuses the same panel PTY");
  assert.equal(prepared.reused, true);
  assert.equal(streams.length, 1, "no second shell is opened");
}

// ── a panel PTY the person typed into is never reused ──────────────────────
{
  const service = makeService();
  const { streams } = attach(service);
  const raw = await open(service, "conv-a");
  service.sessions.get(raw.value.sessionId).userOwned = true;
  service.waitForTerminalReady = async () => {};
  const prepared = await service.openAgentTerminal({ owner: { id: "conv-a" } });
  assert.notEqual(prepared.session.id, raw.value.sessionId, "terminal_open opens a fresh shell after a takeover");
  assert.equal(prepared.reused, false);
  assert.equal(streams.length, 2, "the person's shell is left alone");
}

console.log("per-session terminals: ownership, adoption, isolation, exec mirror, target, lifecycle, cap: passed");
