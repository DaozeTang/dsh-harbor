import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import HarborService from "../src/index.js";
import { RECONNECT_MAX_ATTEMPTS } from "../src/host/service/constants.js";

function fixture(connectClient) {
  const service = Object.create(HarborService.prototype);
  service.connectClient = connectClient;
  service.attachTransportHandlers = () => {};
  service.log = () => {};
  const conn = { dead: true, closing: false, reconnectAttempts: 0, reconnectStopped: false, reconnectTimer: null,
    reconnectWaiters: [], tunnels: new Map(), hops: [], client: { end() {} } };
  return { service, conn };
}

/** Let the async reconnect callback finish after a mocked timer fires. */
async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

test("connection list distinguishes a lost transport from a live one", async () => {
  const { service, conn } = fixture(async () => ({ ok: true }));
  Object.assign(conn, { host: "example", port: 22, username: "user", sessions: new Set() });
  service.connections = new Map([["c1", conn]]);
  service.activeConnectionId = null;
  service.agentAutoConnect = false;
  assert.equal((await service.list()).value.connections[0].connected, false);
  conn.dead = false;
  assert.equal((await service.list()).value.connections[0].connected, true);
});

test("an unexpected initial connection failure leaves no phantom connection", async () => {
  const service = Object.create(HarborService.prototype);
  service.connections = new Map();
  service.connectClient = async () => { throw new TypeError("Client is not a constructor"); };
  const result = await service.connectInternal({ host: "example", port: 22, username: "user", auth: { password: "test" }, retries: 0 });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /Client is not a constructor/);
  assert.equal(service.connections.size, 0);
});

test("unexpected reconnect rejection is contained, stops retrying and wakes waiters", async () => {
  let calls = 0;
  let ended = 0;
  const { service, conn } = fixture(async () => { calls += 1; throw new RangeError("proxy recursion"); });
  conn.client.end = () => { ended += 1; };
  const waiting = service.ensureAlive(conn, 3000);
  service.scheduleReconnect(conn);
  assert.equal(await waiting, false);
  assert.equal(conn.dead, true);
  assert.equal(conn.reconnectTimer, null);
  assert.equal(conn.reconnectWaiters.length, 0);
  assert.equal(calls, 1);
  assert.equal(ended, 1);
});

test("host-key rejection stops reconnect and wakes waiters without accepting the key", async () => {
  const { service, conn } = fixture(async () => ({ ok: false, error: { code: "host-key-mismatch" } }));
  const waiting = service.ensureAlive(conn, 3000);
  service.scheduleReconnect(conn);
  assert.equal(await waiting, false);
  assert.equal(conn.dead, true);
  assert.equal(conn.reconnectTimer, null);
});

test("a permanent failure (rejected login) stops the loop instead of dialing forever", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const { service, conn } = fixture(async () => {
    calls += 1;
    return { ok: false, retriable: false, error: { code: "connect-failed" } };
  });
  const waiting = service.ensureAlive(conn, 60 * 60 * 1000);
  service.scheduleReconnect(conn);
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(await waiting, false, "the waiter hears the verdict instead of waiting out its timeout");
  assert.equal(calls, 1, "a refused login is never retried");
  assert.equal(conn.reconnectStopped, true);
  assert.equal(conn.reconnectTimer, null);
  assert.equal(conn.reconnectWaiters.length, 0);
  const again = service.ensureAlive(conn, 60 * 60 * 1000);
  assert.equal(await again, false, "later callers fail fast instead of waiting for a retry that will not happen");
});

test("even transient failures stop at the attempt cap", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const { service, conn } = fixture(async () => {
    calls += 1;
    return { ok: false, retriable: true, error: { code: "connect-failed" } };
  });
  const waiting = service.ensureAlive(conn, 24 * 60 * 60 * 1000);
  service.scheduleReconnect(conn);
  for (let tick = 0; tick < RECONNECT_MAX_ATTEMPTS + 4; tick += 1) {
    t.mock.timers.tick(30000);
    await settle();
  }
  assert.equal(calls, RECONNECT_MAX_ATTEMPTS, "the loop is bounded, so a down server is not dialed forever");
  assert.equal(conn.reconnectStopped, true);
  assert.equal(conn.reconnectTimer, null);
  assert.equal(await waiting, false);
});

test("successful reconnect wakes waiters; timed-out waiters are removed", async () => {
  const { service, conn } = fixture(async () => { conn.dead = false; return { ok: true }; });
  assert.equal(await service.ensureAlive(conn, 5), false);
  assert.equal(conn.reconnectWaiters.length, 0);
  const waiting = service.ensureAlive(conn, 3000);
  service.scheduleReconnect(conn);
  assert.equal(await waiting, true);
  assert.equal(conn.reconnectWaiters.length, 0);
});

test("a transport that dies while the first host key is being stored is observed", async () => {
  const { EventEmitter } = await import("node:events");
  const service = Object.create(HarborService.prototype);
  const client = new EventEmitter();
  client.end = () => {};
  client.connect = () => { setImmediate(() => client.emit("ready")); };
  service.newClient = () => client;
  service.knownHosts = null;
  service.sessions = new Map();
  service.log = () => {};
  let lost = 0;
  service.handleTransportLoss = () => { lost += 1; };
  // The window under test: the handshake is done, the TOFU record is still
  // being written, and the peer closes. Before the handlers moved here this
  // close had no listener, so the record stayed "connected" forever.
  service.persistFirstSeenHostKey = async () => { client.emit("close"); };
  const record = {
    id: "c1", host: "192.0.2.10", port: 22, username: "root",
    connectConfig: { host: "192.0.2.10", port: 22, username: "root" },
    proxyJump: [], hops: [], dead: true, closing: false, reconnectAttempts: 0,
    reconnectStopped: false, reconnectWaiters: [], legacyAlgorithms: false
  };
  const result = await service.connectClient(record, 0);
  assert.equal(result.ok, true);
  assert.equal(lost, 1, "the close event is delivered to the loss handler, not dropped");
});

test("SSH client is resolved when a connection is built, not at module load", () => {
  // ssh2 is CommonJS; capturing Client from a static import left the host
  // permanently broken after a plugin reload (see test/ssh2-interop.mjs).
  const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  assert.match(source, /newClient\(\) \{\n {4}return createSsh2Client\(\);/);
  assert.doesNotMatch(source, /import\s+ssh2\s+from\s+["']ssh2["']/);
});

test("transport loss finalizes the terminal log and delivers the reason to reattached streams", async () => {
  const { service, conn } = fixture(async () => ({ ok: true }));
  conn.id = "c1";
  conn.dead = false;
  conn.sessions = new Set(["s1"]);
  service.sessions = new Map([["s1", { id: "s1", connectionId: "c1", exited: null, waiters: [], streamListeners: new Set() }]]);
  service.connections = new Map([["c1", conn]]);
  service.exitedSessions = new Map();
  service.scheduleReconnect = () => {};
  service.log = () => {};
  let logEnd;
  service.sessionLogStore = () => ({ async end(id, details) { logEnd = { id, ...details }; } });
  service.handleTransportLoss(conn, conn.client, Object.assign(new Error("socket lost"), { code: "ECONNRESET" }));
  assert.deepEqual(logEnd, { id: "s1", exitCode: 1, reason: "transport-lost" });
  const item = await service.terminalStream({ sessionId: "s1" }).next();
  assert.deepEqual(item.value.value.exit, { code: 1, reason: "transport-lost" });
});
