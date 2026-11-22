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
import { listResultSchema, openSessionResultSchema, terminalContextListResultSchema } from "../src/rpc/schemas.js";

const PROFILE_ID = "11111111-1111-1111-1111-111111111111";

function makeService() {
  const service = Object.create(HarborService.prototype);
  service.config = { maxBufferBytes: 65536, maxCaptureBytes: 65536, maxCommandOutputBytes: 65536, defaultReadTimeoutMs: 20 };
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

// ── writes land in exactly one terminal ─────────────────────────────────────
{
  const service = makeService();
  const { streams } = attach(service);
  const a = await open(service, "conv-a");
  const b = await open(service, "conv-b");

  const written = service.writeToConnection("c1", "echo mine\r", "conv-a");
  assert.equal(written.ok, true, written.error?.message);
  assert.ok(streams[0].writes.join("").includes("echo mine"), "the owner's terminal receives the input");
  assert.equal(streams[1].writes.join(""), "", "the other conversation's terminal stays untouched");

  const missing = service.writeToConnection("c1", "echo none\r", "conv-c");
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "no-terminal", "a conversation without a terminal is told, not silently broadcast");

  // A denied line never reaches the PTY, and the confirmation gate still runs.
  const blocked = service.writeToConnection("c1", "rm -rf /tmp/x\r", "conv-a");
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, "unsafe-command");
  // Keys are forwarded as they arrive (that is what makes typing feel normal),
  // so the denied line's characters are on the wire — what must never happen is
  // a submit: the gate clears the line with Ctrl-U instead of sending Enter.
  const forwarded = streams[0].writes.join("");
  assert.ok(forwarded.includes("\x15"), "the denied line is cleared with Ctrl-U");
  assert.equal(forwarded.endsWith("\r"), false, "and it is never submitted");
  assert.equal(service.sessions.get(a.value.sessionId).ownerSessionId, "conv-a");
  assert.equal(service.sessions.get(b.value.sessionId).ownerSessionId, "conv-b");
}

// ── reads are per terminal, including the "new output" cursor ───────────────
{
  const service = makeService();
  const { conn } = attach(service);
  const a = await open(service, "conv-a");
  const b = await open(service, "conv-b");
  const sessionA = service.sessions.get(a.value.sessionId);
  const sessionB = service.sessions.get(b.value.sessionId);
  service.appendSessionOutput(sessionA, "alpha output\n");
  service.appendSessionOutput(sessionB, "beta output\n");

  const readA = service.readConnectionOutput("c1", "tail", "conv-a");
  assert.match(readA.value.data, /alpha/);
  assert.doesNotMatch(readA.value.data, /beta/, "a conversation never reads another one's screen");

  const readB = service.readConnectionOutput("c1", "tail", "conv-b");
  assert.match(readB.value.data, /beta/);

  // Independent cursors: reading A twice does not consume B's pending output.
  service.readConnectionOutput("c1", "new", "conv-a");
  service.appendSessionOutput(sessionA, "alpha two\n");
  const aSecond = service.readConnectionOutput("c1", "new", "conv-a");
  assert.match(aSecond.value.data, /alpha two/);
  const bFirst = service.readConnectionOutput("c1", "new", "conv-b");
  assert.match(bFirst.value.data, /beta/, "B still has its own first read pending");
  assert.equal(conn.sessions.size, 2);

  const nobody = service.readConnectionOutput("c1", "new", "conv-zzz");
  assert.equal(nobody.value.hasSession, false);
}

// ── exec output is mirrored into the caller's terminal only ─────────────────
{
  const service = makeService();
  attach(service);
  const a = await open(service, "conv-a");
  const b = await open(service, "conv-b");
  service.resolveLoginShell = async () => "bash";
  service.collectExecOutput = async () => ({ exitCode: 0, stdout: "hello from exec\n", stderr: "", truncated: false, timedOut: false });

  const result = await service.execOnConnection("c1", "echo hi", 1000, false, undefined, "conv-a");
  assert.equal(result.ok, true, result.error?.message);
  assert.match(service.sessions.get(a.value.sessionId).buffer, /hello from exec/, "the owner sees the command it asked for");
  assert.doesNotMatch(service.sessions.get(b.value.sessionId).buffer, /hello from exec/, "the other terminal stays clean");
  assert.match(service.sessions.get(a.value.sessionId).buffer, /\$ echo hi/, "echoed with the agent marker");
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
}

// ── ssh_write's lazy open is per conversation ───────────────────────────────
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
  assert.equal(service.listTerminalContexts({ sessionId: "conv-a" }).value.sessions.length, 1);
  assert.equal(terminalContextListResultSchema.safeParse(service.listTerminalContexts({ sessionId: "conv-a" })).success, true);
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

console.log("per-session terminals: ownership, adoption, isolation, exec mirror, target, lifecycle, cap: passed");
