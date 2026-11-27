// P1 regression net: the defects found in the 0.5.2 review that are not
// security-critical but change behaviour on an ordinary path. Each block names
// the failure it would have caught, so a future refactor cannot quietly undo it.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import HarborService from "../src/index.js";
import { SessionLogStore } from "../src/host/session-log.js";
import { createAuthTracker } from "../src/host/ssh-auth.js";
import { registerTunnelTools } from "../src/host/tools/tunnel.js";
import { resolvePaneTerminal } from "../src/client/session-terminals.js";

/** Prototype stub: never runs the constructor, so tests wire what they use. */
function makeService(extra = {}) {
  const service = Object.create(HarborService.prototype);
  service.config = { maxBufferBytes: 65536, maxCaptureBytes: 65536, maxCommandOutputBytes: 65536 };
  service.connections = new Map();
  service.sessions = new Map();
  service.exitedSessions = new Map();
  service.log = () => {};
  service.sleep = async () => {};
  service.knownHosts = null;
  return Object.assign(service, extra);
}

function fakeConnection(overrides = {}) {
  return {
    id: "c1", host: "10.0.0.5", username: "root", dead: false, closing: false,
    sessions: new Set(), tunnels: new Map(), hops: [], sftp: null,
    connectConfig: { host: "10.0.0.5", port: 22, username: "root" },
    ...overrides
  };
}

// ── 1. exec output: a UTF-8 character split across packets ──────────────────
// Decoding each chunk with chunk.toString("utf8") turned both halves of a
// multi-byte character into U+FFFD.
{
  const service = makeService();
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  const client = { exec(_command, _options, callback) { callback(null, stream); } };
  const pending = service.collectExecOutput(client, "printf 中文", 1000);
  // collectExecOutput attaches its listeners after the exec callback resolves.
  await new Promise((resolve) => setImmediate(resolve));
  const bytes = Buffer.from("中文", "utf8");
  stream.emit("data", bytes.subarray(0, 1));
  stream.emit("data", bytes.subarray(1, 4));
  stream.stderr.emit("data", Buffer.from("é", "utf8").subarray(0, 1));
  stream.stderr.emit("data", Buffer.from("é", "utf8").subarray(1));
  stream.emit("data", bytes.subarray(4));
  stream.emit("close", 0);
  const state = await pending;
  assert.equal(state.stdout, "中文", "a character split across packets survives");
  assert.equal(state.stderr, "é");
}

// ── 2. SCP upload releases its channel ────────────────────────────────────
// \`scp -t\` waits for stdin EOF; without end() the remote process and its
// channel slot live until the transport drops (sshd MaxSessions is 10).
{
  const service = makeService();
  const connection = fakeConnection();
  service.resolveConnection = () => ({ ok: true, connectionId: "c1", connection });
  const channel = new EventEmitter();
  channel.stderr = new EventEmitter();
  let ended = false;
  let writes = 0;
  channel.end = () => { ended = true; };
  channel.write = () => {
    writes += 1;
    if (writes === 1 || writes === 3) queueMicrotask(() => channel.emit("data", Buffer.from([0])));
    return true;
  };
  service.openScpChannel = async () => {
    // The ready ACK must land after scpUpload has attached its reader, so it
    // goes on the macrotask queue, not the microtask queue.
    setTimeout(() => channel.emit("data", Buffer.from([0])), 0);
    return channel;
  };
  const result = await service.scpWriteFile({ connectionId: "c1", path: "/tmp/x", data: Buffer.from("hello").toString("base64") });
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.value.bytes, 5);
  assert.equal(ended, true, "the upload channel is closed so the remote scp exits");
}

// ── 3. a dead SFTP subsystem must leave the cache ─────────────────────────
{
  const service = makeService();
  const connection = fakeConnection();
  service.resolveConnection = () => ({ ok: true, connectionId: "c1", connection });
  const wrapper = Object.assign(new EventEmitter(), {
    readdir(_path, callback) { callback(null, []); }
  });
  let opened = 0;
  connection.client = { sftp(callback) { opened += 1; callback(null, wrapper); } };

  const first = await service.requireSftp(connection);
  assert.equal(first.ok, true);
  assert.equal(connection.sftp, wrapper);
  wrapper.emit("close");
  assert.equal(connection.sftp, null, "a closed subsystem is dropped instead of reused forever");
  const second = await service.requireSftp(connection);
  assert.equal(second.ok, true);
  assert.equal(opened, 2, "the next request re-opens the subsystem");

  // A server that never answers must not hang the RPC forever.
  service.config.sftpOperationTimeoutMs = 10;
  wrapper.readdir = () => { /* never answers */ };
  const listed = await service.sftpList({ connectionId: "c1", path: "/" });
  assert.equal(listed.ok, false);
  assert.match(listed.error.message, /timed out/);
}

// ── 4. rename refuses to overwrite an existing destination ────────────────
{
  const service = makeService();
  let renamed = null;
  const attributes = { size: 10, mtime: 5, mode: 0o100644 };
  const sftp = {
    lstat(path, callback) {
      if (path === "/a") return callback(null, attributes);
      if (path === "/b") return callback(null, { size: 99, mtime: 7, mode: 0o100644 });
      if (path === "/File") return callback(null, attributes);
      return callback(Object.assign(new Error("No such file"), { code: 2 }));
    },
    rename(from, to, callback) { renamed = { from, to }; callback(null); }
  };
  service.resolveConnection = () => ({ ok: true, connectionId: "c1", connection: fakeConnection() });
  service.requireSftp = async () => ({ ok: true, sftp });

  const refused = await service.sftpRename({ connectionId: "c1", from: "/a", to: "/b" });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "target-exists", "an implicit overwrite is refused");
  assert.equal(renamed, null, "nothing is renamed when the target exists");

  const caseOnly = await service.sftpRename({ connectionId: "c1", from: "/a", to: "/File" });
  assert.equal(caseOnly.ok, true, "a case-only rename of the same entry still works");
  assert.deepEqual(renamed, { from: "/a", to: "/File" });
}

// ── 5. session log: begin/end in the same tick ────────────────────────────
// The stream used to be created after begin() awaited the directory, so an end
// that arrived first wrote the final sidecar and begin() then overwrote it and
// left an open write stream nobody could close or prune.
{
  const dir = mkdtempSync(join(tmpdir(), "dsh-log-race-"));
  try {
    const store = new SessionLogStore({ dir });
    const beginning = store.begin({ sessionId: "s1" });
    const ending = store.end("s1", { exitCode: 0, reason: "channel-closed" });
    await beginning;
    await ending;
    assert.equal(store.streams.size, 0, "no write stream is left behind");
    assert.equal(store.entries.size, 0, "the ended session leaves no live entry");
    const listed = await store.list();
    assert.equal(listed.length, 1);
    assert.ok(listed[0].endedAt !== null, "the final sidecar wins over the open one");
    const names = readdirSync(dir);
    assert.equal(names.filter((name) => name.endsWith(".tmp")).length, 0, "no temporary sidecar is left");
    const meta = names.filter((name) => name.endsWith(".json"));
    assert.equal(meta.length, 1);
    const parsed = JSON.parse(readFileSync(join(dir, meta[0]), "utf8"));
    assert.equal(parsed.sessionId, "s1", "the sidecar is always one complete document");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 6. tty allocation follows open order, not "newest shell wins" ─────────
{
  const service = makeService();
  const connection = { id: "c1", sessions: new Set(["a", "b"]), tunnels: new Map() };
  service.sessions = new Map([
    ["a", { id: "a", tty: null, exited: null, openedAt: "2026-01-01T00:00:00.001Z" }],
    ["b", { id: "b", tty: null, exited: null, openedAt: "2026-01-01T00:00:00.002Z" }]
  ]);
  service.assignTtys(connection, [
    { tty: "/dev/pts/2", pid: 22, startTime: 200 },
    { tty: "/dev/pts/1", pid: 11, startTime: 100 }
  ]);
  assert.equal(service.sessions.get("a").tty, "/dev/pts/1", "the older terminal keeps the older shell");
  assert.equal(service.sessions.get("b").tty, "/dev/pts/2", "the newer terminal gets the newer shell");

  // A tty already recorded for a live terminal is never handed out twice.
  service.sessions.set("c", { id: "c", tty: null, exited: null, openedAt: "2026-01-01T00:00:00.003Z" });
  connection.sessions.add("c");
  service.assignTtys(connection, [
    { tty: "/dev/pts/1", pid: 11, startTime: 100 },
    { tty: "/dev/pts/2", pid: 22, startTime: 200 },
    { tty: "/dev/pts/3", pid: 33, startTime: 300 }
  ]);
  assert.equal(service.sessions.get("c").tty, "/dev/pts/3");
}

// ── 7. per-attempt auth state and a cancel that lands mid-handshake ───────
{
  const service = makeService();
  const record = {
    id: "c1", closing: false, dead: true, connecting: true, hops: [], inflight: new Set(),
    connectConfig: { host: "10.0.0.5", port: 22, username: "root" },
    proxyJump: [], bannerRepair: false, legacyAlgorithms: false, allowLegacyDowngrade: false,
    kbdFallbackTried: true,
    authTracker: Object.assign(createAuthTracker(), { kbdSeen: true, attempts: ["none", "password"] })
  };
  service.newClient = () => {
    const client = new EventEmitter();
    client.connect = () => { queueMicrotask(() => client.emit("error", new Error("connect ECONNREFUSED 10.0.0.5:22"))); };
    client.end = () => {};
    return client;
  };
  const result = await service.connectClient(record, 0);
  assert.equal(result.ok, false);
  assert.equal(record.kbdFallbackTried, false, "the one-shot keyboard fallback is re-armed per connect attempt");
  assert.deepEqual(record.authTracker.attempts, [], "auth telemetry is not inherited from the previous handshake");
  assert.equal(record.authTracker.kbdSeen, false);
}

{
  const service = makeService();
  let clientEnded = false;
  const record = {
    id: "c1", closing: false, dead: true, connecting: true, hops: [], inflight: new Set(),
    connectConfig: { host: "10.0.0.5", port: 22, username: "root" },
    proxyJump: [], bannerRepair: false, legacyAlgorithms: false, allowLegacyDowngrade: false,
    kbdFallbackTried: false, authTracker: createAuthTracker()
  };
  service.newClient = () => {
    const client = new EventEmitter();
    // The operator's cancel lands while the handshake is in flight, then the
    // server completes it: the record must not keep a live transport.
    client.connect = () => { record.closing = true; queueMicrotask(() => client.emit("ready")); };
    client.end = () => { clientEnded = true; };
    return client;
  };
  const result = await service.connectClient(record, 0);
  assert.equal(result.ok, false, "a cancelled connect never reports success");
  assert.equal(result.error.code, "connect-cancelled");
  assert.equal(clientEnded, true, "the finished transport is closed instead of leaking");
  assert.equal(record.dead, true);
}

{
  const service = makeService();
  let tornDown = 0;
  const record = { id: "c1", profileId: "p1", connecting: true, closing: false, hops: [], client: null, inflight: new Set([() => { tornDown += 1; }]) };
  service.connections = new Map([["c1", record]]);
  const result = await service.cancelProfileConnect({ profileId: "p1" });
  assert.equal(result.value.cancelled, 1);
  assert.equal(tornDown, 1, "cancel reaches the handles a jump chain / banner repair left in flight");
  assert.equal(record.closing, true);
}

// ── 8. tunnel tool output keeps up with the service ───────────────────────
{
  const tools = [];
  const ctx = { tools: { register: (tool) => tools.push(tool) }, on: () => {} };
  registerTunnelTools(ctx, makeService());
  const start = tools.find((tool) => tool.name === "tunnel_start");
  assert.notEqual(start.output.schema.properties.remoteHost.required, true, "a SOCKS5 proxy has no single remote endpoint");
  assert.notEqual(start.output.schema.properties.remotePort.required, true);
  const list = tools.find((tool) => tool.name === "tunnel_list");
  assert.ok(list.output.schema.properties.tunnels.items.properties.connections, "the live connection count is declared");
}

{
  const service = makeService();
  const connection = {
    id: "c1", tunnels: new Map([
      ["t1", { id: "t1", kind: "dynamic", bindAddr: "127.0.0.1", bindPort: 1080, active: true, connections: 2 }],
      ["t2", { id: "t2", kind: "local", bindAddr: "127.0.0.1", bindPort: 9000, remoteHost: "db", remotePort: 5432, active: true }]
    ])
  };
  service.resolveConnection = () => ({ ok: true, connectionId: "c1", connection });
  const listed = await service.tunnelList({ connectionId: "c1" });
  const dynamic = listed.value.tunnels.find((tunnel) => tunnel.tunnelId === "t1");
  assert.equal("remoteHost" in dynamic, false, "an absent field is omitted, not sent as undefined");
  assert.equal(dynamic.connections, 2);
  const local = listed.value.tunnels.find((tunnel) => tunnel.tunnelId === "t2");
  assert.equal(local.remoteHost, "db");
}

// ── 9. snippets address the PTY, not the conversation ────────────────────
{
  const connection = {
    sessions: ["pty-9"],
    terminals: [{ sessionId: "pty-9", ownerSessionId: "conv-1", alive: true, mine: true }]
  };
  assert.equal(resolvePaneTerminal(connection, "conv-1").sessionId, "pty-9", "the conversation id is translated to its PTY");
  const source = readFileSync(new URL("../src/client/features/snippets/snippets-view.jsx", import.meta.url), "utf8");
  assert.match(source, /resolvePaneTerminal\(active, sessionId\)/, "the snippet palette resolves the PTY id");
  assert.doesNotMatch(source, /sessionId \?\? active\?\.sessions/, "the conversation id is never used as a PTY id");

  const terminalView = readFileSync(new URL("../src/client/features/terminal/xterm-view.jsx", import.meta.url), "utf8");
  assert.match(terminalView, /api\.read\(sessionId, 300, entry\.offset \?\? 0\)/, "the poll fallback always sends a cursor");
}

console.log("p1 regressions: exec decoding, scp/sftp lifecycle, rename guard, log race, tty order, auth state, tunnel contract, client ids: passed");
