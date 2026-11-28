// P2 regression net: defects that only appear in a narrow window — a cancel
// that lands one step too late, a channel that arrives after its terminal was
// closed, two callers opening the same SFTP subsystem, a page boundary inside
// a character. Each block names the failure it prevents.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import HarborService from "../src/index.js";
import { SessionLogStore } from "../src/host/terminal/session-log.js";
import { TransferTasks } from "../src/host/files/transfer-tasks.js";
import { SshTerminalSession } from "../src/host/terminal/backend.js";
import { MAX_CONNECTIONS } from "../src/host/service/constants.js";

/** Prototype stub: never runs the constructor, so tests wire what they use. */
function makeService(extra = {}) {
  const service = Object.create(HarborService.prototype);
  service.config = { maxBufferBytes: 65536, maxCommandOutputBytes: 65536 };
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
    sessions: new Set(), tunnels: new Map(), hops: [], sftp: null, sftpPending: null,
    ownerIndex: new Map(), agentActivityByOwner: new Map(), execPolicyOverrides: new Map(),
    inflight: new Set(), reconnectWaiters: [], reconnectTimer: null, reconnectStopped: false,
    connecting: false, openQueue: Promise.resolve(), ttyQueue: Promise.resolve(),
    connectConfig: { host: "10.0.0.5", port: 22, username: "root" },
    ...overrides
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

// ── 1. the number of open transports is bounded ───────────────────────────
// Nothing capped connection count: a runaway agent loop (or one forgotten tab
// per server) kept allocating sockets, keepalive timers and jump chains with no
// way for the product to reclaim them.
{
  const service = makeService();
  let dialed = 0;
  service.newClient = () => { dialed += 1; throw new Error("no transport in this test"); };
  for (let index = 0; index < MAX_CONNECTIONS; index += 1) {
    service.connections.set("c" + index, fakeConnection({ id: "c" + index }));
  }
  const refused = await service.connectInternal({ host: "h", username: "u", auth: {} });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "connection-limit", "the ceiling is reported as its own error");
  assert.ok(refused.error.message.includes(String(MAX_CONNECTIONS)), "the message says what the limit is");
  assert.equal(dialed, 0, "no socket is opened past the ceiling");
  // A record that is on its way out does not hold a slot.
  service.connections.get("c0").closing = true;
  const attempted = await service.connectInternal({ host: "h", username: "u", auth: {} });
  assert.equal(attempted.error.code, "connect-failed", "a closing record frees its slot");
  assert.equal(dialed, 1);
}

// ── 2. disconnect wakes waiters and breaks an in-flight handshake ─────────
// The panel shows a row as soon as the attempt starts, so an operator can
// disconnect while `ensureAlive` callers are parked and the handshake still
// owns a socket. Both used to run to their own timeouts.
{
  const service = makeService();
  const conn = fakeConnection({ id: "c1", dead: true, connecting: true });
  service.connections.set("c1", conn);
  let tornDown = 0;
  conn.inflight.add(() => { tornDown += 1; });
  const seen = [];
  conn.reconnectWaiters.push((alive) => seen.push(alive));
  const parked = service.ensureAlive(conn, 60000);
  const result = await service.disconnect({ connectionId: "c1" });
  assert.equal(result.ok, true);
  assert.deepEqual(seen, [false], "a parked waiter is answered immediately");
  assert.equal(await parked, false);
  assert.equal(tornDown, 1, "the in-flight handshake is torn down instead of waiting out readyTimeout");
}

// ── 3. a failed banner read does not leak its socket ──────────────────────
// The repaired-banner path owns the byte stream before ssh2 does; when the
// read timed out or the peer closed, the socket was left open and detached.
{
  const service = makeService();
  const sock = new EventEmitter();
  sock.destroyed = false;
  sock.pause = () => {};
  sock.resume = () => {};
  sock.destroy = () => { sock.destroyed = true; };
  const pending = service.openRepairedSock({ connectConfig: { host: "h", port: 22, readyTimeout: 5000 } }, sock);
  await flush();
  sock.emit("close");
  await assert.rejects(() => pending, /横幅/);
  assert.equal(sock.destroyed, true, "the socket is destroyed when the banner cannot be read");
}

// ── 4. every jump-chain failure exit closes every hop ─────────────────────
// A hop client is only in `record.hops` after the WHOLE chain succeeds, and
// ssh2 throws out of forwardOut synchronously on a closed client. Either shape
// used to leave a live SSH transport (socket + keepalive timer) forever.
{
  const service = makeService();
  const created = [];
  const makeClient = (behaviour) => {
    const client = new EventEmitter();
    client.ended = false;
    client.end = () => { client.ended = true; };
    client.connect = () => setImmediate(behaviour.onConnect(client));
    client.forwardOut = behaviour.forwardOut;
    created.push(client);
    return client;
  };
  const hop = [{ host: "jump", username: "u", auth: {} }];

  service.newClient = () => makeClient({
    onConnect: (client) => client.emit("ready"),
    forwardOut: () => { throw new Error("Not connected"); }
  });
  await assert.rejects(() => service.connectChain(hop, "target", 22, null), /Not connected/);
  assert.equal(created.length, 1);
  assert.equal(created[0].ended, true, "a forwardOut that throws synchronously still tears its hop down");

  created.length = 0;
  service.newClient = () => makeClient({
    onConnect: (client) => client.emit("error", new Error("auth failed")),
    forwardOut: () => { throw new Error("never reached"); }
  });
  await assert.rejects(() => service.connectChain(hop, "target", 22, null), /proxyJump hop 1/);
  assert.equal(created[0].ended, true, "a hop whose own handshake failed is closed too");
}

// ── 5. one SFTP subsystem per connection, however many callers ────────────
// Each caller used to see `sftp === null` and open its own channel; only the
// last one was cached, so the rest leaked against sshd's MaxSessions.
{
  const service = makeService();
  let opens = 0;
  const wrapper = new EventEmitter();
  const connection = fakeConnection({
    client: { sftp(callback) { opens += 1; setImmediate(() => callback(null, wrapper)); } }
  });
  const [first, second] = await Promise.all([service.requireSftp(connection), service.requireSftp(connection)]);
  assert.equal(opens, 1, "two callers share one subsystem channel");
  assert.equal(first.sftp, wrapper);
  assert.equal(second.sftp, wrapper);
  assert.equal(connection.sftp, wrapper);
  assert.equal(connection.sftpPending, null, "the in-flight promise is cleared after it settles");

  const failing = fakeConnection({
    client: { sftp(callback) { opens += 1; setImmediate(() => callback(new Error("subsystem refused"))); } }
  });
  const [deniedA, deniedB] = await Promise.all([service.requireSftp(failing), service.requireSftp(failing)]);
  assert.equal(deniedA.ok, false);
  assert.equal(deniedB.ok, false);
  assert.match(deniedA.error.message, /subsystem refused/);
  assert.equal(failing.sftpPending, null);
  assert.equal((await service.requireSftp(failing)).ok, false);
  assert.equal(opens, 3, "the failure is shared now and retried by a later caller");

  // A transport that dies while the channel opens must not be cached: nothing
  // would ever invalidate that wrapper and every later call would hang.
  const dying = fakeConnection({
    client: { sftp(callback) { setImmediate(() => { dying.dead = true; callback(null, new EventEmitter()); }); } }
  });
  const lost = await service.requireSftp(dying);
  assert.equal(lost.ok, false);
  assert.equal(lost.error.code, "connection-lost");
  assert.equal(dying.sftp, null, "a wrapper opened across a transport loss is not cached");
}

// ── 6. deleting a symlink removes the LINK, not its target's type ─────────
// stat() follows the link, so a symlink to a directory was sent to rmdir (and
// a broken symlink could not be deleted at all).
{
  const service = makeService();
  service.resolveConnection = () => ({ ok: true, connectionId: "c1", connection: fakeConnection() });
  const calls = [];
  const sftp = {
    lstat(path, callback) { calls.push(["lstat", path]); callback(null, { mode: 0o120000 }); },
    stat() { throw new Error("stat must not decide how an entry is removed"); },
    unlink(path, callback) { calls.push(["unlink", path]); callback(null); },
    rmdir(path, callback) { calls.push(["rmdir", path]); callback(null); }
  };
  service.requireSftp = async () => ({ ok: true, sftp });
  const deleted = await service.sftpDelete({ connectionId: "c1", path: "/d/link" });
  assert.equal(deleted.ok, true);
  assert.equal(deleted.value.isDirectory, false);
  assert.deepEqual(calls, [["lstat", "/d/link"], ["unlink", "/d/link"]], "a symlink is unlinked as a link");
}

// ── 7. a PTY that arrives after its terminal was closed is given back ─────
// The session record is published before the channel opens, so closeSession()
// found it, deleted it and saw `stream === null`. The channel then arrived and
// was adopted by a record nobody could reach: no close path, one sshd slot.
{
  const service = makeService();
  service.ensureAlive = async () => true;
  let openChannel = null;
  const conn = fakeConnection({
    id: "c1",
    client: { shell(_options, callback) { openChannel = callback; } }
  });
  service.connections.set("c1", conn);
  const opening = service.openSession({ connectionId: "c1", cols: 80, rows: 24, openedBy: "panel" });
  await flush();
  const sessionId = [...service.sessions.keys()][0];
  assert.ok(sessionId, "the record exists before the shell appears");
  await service.closeSession({ sessionId });
  const stream = new EventEmitter();
  stream.ended = false;
  stream.end = () => { stream.ended = true; };
  openChannel(null, stream);
  const result = await opening;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "session-closed");
  assert.equal(stream.ended, true, "the orphan channel is closed instead of adopted");
  assert.equal(service.sessions.size, 0);
}

// ── 8. a settled terminal_send is not cancelled ───────────────────────────
// cancel() wrote ^C even after the send had finished: a late abort (or the
// registry's own cleanup) then interrupted whatever the person had started.
{
  const written = [];
  const session = { id: "s1", exited: null, userOwned: false, tty: null };
  const service = {
    writeTerminalSession(_session, text) { written.push(text); return true; },
    renderTerminalSession() { return { text: "ready$", redacted: false, truncated: false }; },
    terminalSessionTail() { return "ready$"; },
    terminalJournal() { return { read: () => ({ offset: 0, data: "" }) }; },
    detachTerminalBinding() {},
    closeTerminalSession: async () => {}
  };
  const backend = new SshTerminalSession({ service, session, registryId: "r1", name: "n", connectionId: "c1", ownerSessionId: "o1" });
  backend.atPrompt = () => true;

  const settledOp = backend.startSend({ text: "ls", submit: true });
  const settled = await settledOp.done;
  assert.equal(settled.waitReason, "stdin_read");
  assert.equal(settledOp.cancel(), false, "a settled send cannot be cancelled");
  assert.deepEqual(written, ["ls\r"], "no ^C is typed into a terminal the call no longer owns");

  const runningOp = backend.startSend({ text: "cat", submit: true });
  assert.equal(runningOp.cancel(), true, "a running send is still interruptible");
  assert.equal(written[written.length - 1], "\u0003");
  await runningOp.done;
}

// ── 9. an upload that is committing can no longer be cancelled ────────────
// The commit is a rename: aborting it cannot undo that, and reporting
// "cancelled" for an upload that lands is what makes the caller offer to
// discard a partial file that no longer exists.
{
  const tasks = new TransferTasks({ journalPath: null });
  const base = { connectionId: "c1", identity: "i", source: "/local", total: 10, digest: "d", checkpoint: 0 };
  const running = tasks.start({ ...base, target: "/remote", partial: "/remote.dsh-upload-a.tmp" });
  assert.equal(tasks.cancel(running.id, "c1"), true, "a running transfer is cancellable");
  assert.equal(running.controller.signal.aborted, true);

  const committing = tasks.start({ ...base, target: "/remote2", partial: "/remote2.dsh-upload-b.tmp" });
  committing.committing = true;
  assert.equal(tasks.cancel(committing.id, "c1"), false, "a committing upload cannot be reported as cancelled");
  assert.equal(committing.controller.signal.aborted, false, "its commit is not aborted");
}

// ── 10. session-log pages never split a character ─────────────────────────
// A page boundary inside a multi-byte character decoded as U+FFFD and the
// reader stepped past the real bytes: the panel showed a replacement glyph and
// the text could not be recovered by scrolling.
{
  const dir = mkdtempSync(join(tmpdir(), "dsh-log-pages-"));
  try {
    const store = new SessionLogStore({ dir });
    await store.begin({ sessionId: "s1" });
    const text = "中文".repeat(50);
    store.append("s1", text);
    await store.flush("s1");
    await store.end("s1");
    let offset = 0;
    let collected = "";
    let pages = 0;
    for (;;) {
      const page = await store.read("s1", { offset, maxBytes: 8 });
      assert.ok(!page.data.includes("\uFFFD"), "page at " + offset + " decodes no partial character");
      assert.ok(page.nextOffset > offset || page.eof, "a page always advances");
      collected += page.data;
      offset = page.nextOffset;
      pages += 1;
      if (page.eof) break;
      assert.ok(pages < 100, "paging terminates");
    }
    assert.equal(collected, text, "paging reproduces the log byte for byte");
    assert.ok(pages > 1, "the page size really did cut characters");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("p2 regressions: connection ceiling, teardown, sftp single-flight, delete, pty race, cancel guards and log paging: passed");
