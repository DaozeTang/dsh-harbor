// #32 regression net: a failed forward must cost one socket, never the host
// process. Covers the synchronous forwardOut throw ('Not connected' on a
// dead ssh2 client), unhandled socket/channel 'error' (ECONNRESET), late
// callbacks for already-destroyed sockets, and the tunnel-listener teardown
// on transport loss / explicit disconnect. Uses prototype stubs and real
// loopback net servers — no ssh2 transport involved.
import assert from "node:assert/strict";
import net from "node:net";
import { readFileSync } from "node:fs";
import HarborService from "../../../../src/index.js";

/** Real listeners started across sections; closed in the finally below. */
const openServers = [];
const services = [];

function makeService() {
  const service = Object.create(HarborService.prototype);
  service.config = { maxBufferBytes: 65536 };
  service.connections = new Map();
  service.sessions = new Map();
  service.exitedSessions = new Map();
  service.activeConnectionId = null;
  service.scheduleReconnect = () => {};
  services.push(service);
  return service;
}

function fakeConn(service, client, { dead = false, closing = false } = {}) {
  const conn = {
    id: "c1", profileId: null, client,
    name: null, host: "10.0.0.5", username: "root",
    connectConfig: { host: "10.0.0.5", port: 22 },
    sessions: new Set(), sftp: null, tunnels: new Map(),
    hops: [], dead, closing,
    reconnectTimer: null
  };
  service.connections.set("c1", conn);
  service.resolveConnection = () => ({ ok: true, connection: conn });
  return conn;
}

/** A stand-in accepted socket: destroy flag + pipe passthrough. */
function fakeSocket() {
  const socket = new net.Socket({ allowHalfOpen: false });
  // Never bound to a port: only the destroy bookkeeping is under test.
  return Object.assign(socket, { destroyed: false, _piped: [], pipe(dest) { socket._piped.push(dest); return dest; }, destroy() { socket.destroyed = true; } });
}
function fakeChannel() {
  const channel = new net.Socket();
  return Object.assign(channel, { destroyed: false, _piped: [], pipe(dest) { channel._piped.push(dest); return dest; }, destroy() { channel.destroyed = true; } });
}

async function startLocal(service, client, overrides = {}) {
  const result = await service.tunnelStartLocal({
    connectionId: "c1", bindAddr: "127.0.0.1", bindPort: 0,
    remoteHost: "10.9.9.9", remotePort: 5432, ...overrides
  });
  assert.equal(result.ok, true, result.error?.message);
  const tunnel = service.connections.get("c1").tunnels.get(result.value.tunnelId);
  openServers.push(tunnel.server);
  return result.value;
}

/** Drive the real createServer connection callback with a stand-in socket. */
function fireAccept(server, socket) {
  server.emit("connection", socket);
}

try {
// ── 1. ssh2's synchronous 'Not connected' throw must not escape the accept callback ──
{
  const service = makeService();
  let forwardCalls = 0;
  fakeConn(service, {
    forwardOut() { forwardCalls += 1; throw new Error("Not connected"); }
  });
  await startLocal(service);
  const server = service.connections.get("c1").tunnels.values().next().value.server;

  const socket = fakeSocket();
  assert.doesNotThrow(() => fireAccept(server, socket), "the synchronous throw is contained (#32 host crash)");
  assert.equal(socket.destroyed, true, "the accepted socket is destroyed");
  assert.equal(forwardCalls, 1);
}

// ── 2. a dead/closing connection refuses accepts before touching the client ──
{
  const service = makeService();
  let forwardCalls = 0;
  const conn = fakeConn(service, { forwardOut() { forwardCalls += 1; throw new Error("Not connected"); } });
  await startLocal(service);
  const server = conn.tunnels.values().next().value.server;

  for (const state of [{ dead: true }, { closing: true }]) {
    Object.assign(conn, { dead: false, closing: false }, state);
    const socket = fakeSocket();
    fireAccept(server, socket);
    assert.equal(socket.destroyed, true, `${JSON.stringify(state)} accept is refused`);
  }
  assert.equal(forwardCalls, 0, "forwardOut is never called on a dead connection");
}

// ── 3. callback error, late channel, and both error directions ──
{
  const service = makeService();
  const pending = [];
  fakeConn(service, { forwardOut(_a, _b, _c, _d, cb) { pending.push(cb); } });
  await startLocal(service);
  const server = service.connections.get("c1").tunnels.values().next().value.server;

  // Callback reports an error: socket destroyed, nothing piped.
  {
    const socket = fakeSocket();
    fireAccept(server, socket);
    pending.shift()(new Error("connect failed"));
    assert.equal(socket.destroyed, true, "callback error destroys the socket");
  }

  // A channel arriving for an already-gone socket is discarded, not piped.
  {
    const socket = fakeSocket();
    fireAccept(server, socket);
    socket.destroy();
    const channel = fakeChannel();
    pending.shift()(null, channel);
    assert.equal(channel.destroyed, true, "late channel for a dead socket is destroyed");
    assert.deepEqual(channel._piped, [], "late channel is never piped");
  }

  // Channel 'error' (SSH side reset) tears down the local socket.
  {
    const socket = fakeSocket();
    fireAccept(server, socket);
    const channel = fakeChannel();
    pending.shift()(null, channel);
    assert.deepEqual(socket._piped, [channel], "healthy path pipes both ways");
    channel.emit("error", new Error("read ECONNRESET"));
    assert.equal(socket.destroyed, true, "channel error destroys the local socket (#32)");
  }

  // Local socket 'error' (the Windows RST case) tears down the channel.
  {
    const socket = fakeSocket();
    fireAccept(server, socket);
    const channel = fakeChannel();
    pending.shift()(null, channel);
    socket.emit("error", new Error("read ECONNRESET"));
    assert.equal(channel.destroyed, true, "socket error destroys the channel (#32)");
  }
}

// ── 4. listener teardown on transport loss and explicit disconnect ──
{
  const service = makeService();
  const closed = [];
  const fakeServer = (kind) => ({
    kind,
    close(cb) { closed.push(kind); cb?.(); },
    on() {}
  });
  const client = new net.Socket();
  const conn = fakeConn(service, client);
  conn.tunnels.set("t1", { id: "t1", kind: "local", active: true, server: fakeServer("local") });
  conn.tunnels.set("t2", { id: "t2", kind: "dynamic", active: true, server: fakeServer("dynamic") });

  service.handleTransportLoss(conn, client, null);
  assert.deepEqual(closed.sort(), ["dynamic", "local"], "transport loss closes every tunnel listener");
  assert.equal(conn.tunnels.size, 0, "tunnel records are cleared");

  conn.tunnels.set("t3", { id: "t3", kind: "local", active: true, server: fakeServer("local-2") });
  const gone = await service.disconnect({ connectionId: "c1" });
  assert.equal(gone.ok, true);
  assert.deepEqual(closed, ["dynamic", "local", "local-2"], "explicit disconnect closes remaining listeners");
  assert.equal(service.connections.has("c1"), false);
}

// ── 5. dynamic SOCKS5: the wrapped forwardOut turns the synchronous throw into a SOCKS failure reply ──
async function readExactly(stream, bytes) {
  const chunks = [];
  let total = 0;
  while (total < bytes) {
    const got = await new Promise((resolve, reject) => {
      stream.once("data", resolve);
      stream.once("error", reject);
      stream.once("close", () => reject(new Error("socket closed while reading")));
    });
    chunks.push(got);
    total += got.length;
  }
  return Buffer.concat(chunks);
}

{
  const service = makeService();
  fakeConn(service, {
    forwardOut() { throw new Error("Not connected"); }
  });
  const started = await service.tunnelStartDynamic({ connectionId: "c1", bindAddr: "127.0.0.1", bindPort: 0 });
  assert.equal(started.ok, true, started.error?.message);

  const client = net.connect(started.value.bindPort, "127.0.0.1");
  await new Promise((resolve, reject) => { client.once("connect", resolve); client.once("error", reject); });
  client.write(Buffer.from([0x05, 0x01, 0x00]));
  const method = await readExactly(client, 2);
  assert.equal(method[1], 0x00, "no-auth accepted");
  const name = Buffer.from("db.internal", "utf8");
  client.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]), name, Buffer.from([0x01, 0xbb])]));
  const reply = await readExactly(client, 10);
  assert.notEqual(reply[1], 0x00, "the failed forward is reported as a SOCKS failure, not a crash");
  client.destroy();
}

// ── 6. HarborTunnels list rendering must not shadow the i18n t() (#32 't2 is not a function') ──
{
  const source = readFileSync(new URL("../../../../src/client/features/tunnels/tunnels-pane.jsx", import.meta.url), "utf8");
  assert.ok(!/\.map\(\(t\)/.test(source), "tunnel list map parameter must not be named t (shadows i18n t)");
  assert.ok(source.includes('t("动态 SOCKS5")'), "kind labels still go through the translator");
  assert.ok(source.includes("t(`活动连接 ${tunnel.connections}`)"), "connection-count labels still go through the translator");
}

// ── 7. a client RST between accept and the forwardOut callback ──
// forwardOut is a full SSH round trip. Before this net was reported, the local
// socket had no 'error' listener inside that window, so one reset connection
// threw out of the emit (DSH exits the process on an uncaught exception).
{
  const service = makeService();
  const pending = [];
  fakeConn(service, { forwardOut(_a, _b, _c, _d, cb) { pending.push(cb); } });
  await startLocal(service);
  const server = service.connections.get("c1").tunnels.values().next().value.server;

  const socket = fakeSocket();
  fireAccept(server, socket);
  assert.equal(pending.length, 1, "the forward is still in flight");

  // No listener would make this emit throw; the host would then exit.
  assert.doesNotThrow(() => socket.emit("error", new Error("read ECONNRESET")), "a mid-handshake RST costs one socket, not the process");

  // The channel that arrives afterwards is discarded, never piped.
  const channel = fakeChannel();
  pending.shift()(null, channel);
  assert.equal(channel.destroyed, true, "a channel for an already-failed socket is destroyed");
  assert.deepEqual(channel._piped, [], "a channel for an already-failed socket is never piped");
}

// ── 8. remote forward: a missing/invalid target can never become a bridge ──
// net.connect(undefined, …) throws ERR_MISSING_ARGS and 70000 throws
// ERR_SOCKET_BAD_PORT — both from inside ssh2's 'tcp connection' dispatch,
// where nothing catches, so the first forwarded connection used to end the
// process. The ports are validated before forwardIn now.
{
  const { EventEmitter } = await import("node:events");
  const service = makeService();
  const client = new EventEmitter();
  const forwards = [];
  client.forwardIn = (addr, port, cb) => { forwards.push({ addr, port }); cb(null, 5000); };
  client.unforwardIn = (_addr, _port, cb) => cb?.();
  const conn = fakeConn(service, client);

  for (const [label, request] of [
    ["missing target_port", { remoteHost: "127.0.0.1", remotePort: 0 }],
    ["target_port 0", { remoteHost: "127.0.0.1", remotePort: 0, targetPort: 0 }],
    ["target_port 70000", { remoteHost: "127.0.0.1", remotePort: 0, targetPort: 70000 }],
    ["target_port as a string", { remoteHost: "127.0.0.1", remotePort: 0, targetPort: "8080" }],
    ["empty target_host", { remoteHost: "127.0.0.1", remotePort: 0, targetHost: "   ", targetPort: 8080 }]
  ]) {
    const result = await service.tunnelStartRemote({ connectionId: "c1", ...request });
    assert.equal(result.ok, false, `${label} is refused`);
    assert.match(result.error.message, /target/, `${label} explains itself`);
    assert.equal(client.listenerCount("tcp connection"), 0, `${label} installs no bridge`);
    assert.equal(conn.tunnels.size, 0, `${label} records no tunnel`);
  }
  assert.deepEqual(forwards, [], "nothing was bound on the server for a refused target");

  const badListen = await service.tunnelStartRemote({ connectionId: "c1", remoteHost: "127.0.0.1", remotePort: 70000, targetPort: 8080 });
  assert.equal(badListen.ok, false, "an out-of-range listen port is refused too");
  assert.deepEqual(forwards, [], "an invalid listen port never reaches forwardIn");

  // A valid request still works, and its bridge never lets a throw escape.
  const started = await service.tunnelStartRemote({ connectionId: "c1", remoteHost: "127.0.0.1", remotePort: 0, targetPort: 8080 });
  assert.equal(started.ok, true, started.error?.message);
  assert.equal(started.value.remotePort, 5000, "the server-assigned port is reported");
  assert.equal(started.value.targetPort, 8080, "the validated target travels with the record");
  const bridge = conn.tunnels.get(started.value.tunnelId).bridgeInfo.bridge;
  assert.equal(client.listenerCount("tcp connection"), 1, "the bridge is installed on the client");

  // accept() failing (a destroyed channel, an exhausted ssh2 session pool)
  // is contained: the emit itself must not throw.
  assert.doesNotThrow(
    () => client.emit("tcp connection", { destIP: "127.0.0.1", destPort: 5000 }, () => { throw new Error("accept failed"); }),
    "a failing accept never escapes the ssh2 dispatch"
  );
  assert.doesNotThrow(
    () => client.emit("tcp connection", undefined, () => { throw new Error("must not be called"); }),
    "a malformed forwarded event is ignored"
  );
  // A forwarded connection for another port is not ours.
  let notOurs = 0;
  client.emit("tcp connection", { destIP: "127.0.0.1", destPort: 9999 }, () => { notOurs += 1; return fakeChannel(); });
  assert.equal(notOurs, 0, "port matching still filters foreign channels");

  const stopped = await service.tunnelStop({ connectionId: "c1", tunnelId: started.value.tunnelId });
  assert.equal(stopped.ok, true);
  assert.equal(client.listenerCount("tcp connection"), 0, "stopping removes the bridge");
  assert.equal(typeof bridge, "function");
}

// ── 9. local forward: an unusable target is refused before the listener ────
// forwardOut/net.connect threw once per accepted socket while the call had
// already reported success, so the tunnel looked started and silently failed
// every connection — with the error only in the accept callback's catch.
{
  const service = makeService();
  const client = {};
  const conn = fakeConn(service, client);

  // A free port we can watch from the outside.
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const refused = [
    ["an empty remoteHost", { remoteHost: "", remotePort: 22 }],
    ["a missing remoteHost", { remotePort: 22 }],
    ["remotePort 0", { remoteHost: "10.9.9.9", remotePort: 0 }],
    ["remotePort 70000", { remoteHost: "10.9.9.9", remotePort: 70000 }],
    ["remotePort as a string", { remoteHost: "10.9.9.9", remotePort: "5432" }]
  ];
  for (const [label, request] of refused) {
    const result = await service.tunnelStartLocal({ connectionId: "c1", bindAddr: "127.0.0.1", bindPort: port, ...request });
    assert.equal(result.ok, false, `${label} is refused`);
    assert.equal(result.error.code, "tunnel-invalid-target", `${label} has its own error code`);
    assert.match(result.error.message, /remote_(host|port)/, `${label} names the field`);
    assert.equal(conn.tunnels.size, 0, `${label} records no tunnel`);
  }
  const badListen = await service.tunnelStartLocal({ connectionId: "c1", bindAddr: "127.0.0.1", bindPort: 70000, remoteHost: "10.9.9.9", remotePort: 22 });
  assert.equal(badListen.ok, false, "an invalid listen port is refused too");
  assert.equal(badListen.error.code, "tunnel-invalid-listen-port");

  // Nothing was bound anywhere, so the port is still free.
  const attempt = net.connect(port, "127.0.0.1");
  const outcome = await new Promise((resolve) => {
    attempt.once("connect", () => resolve("connected"));
    attempt.once("error", (error) => resolve(error.code));
  });
  attempt.destroy();
  assert.equal(outcome, "ECONNREFUSED", "a refused forward never binds the listen port");

  // A valid request trims its host and reports the validated target.
  const started = await service.tunnelStartLocal({ connectionId: "c1", bindAddr: "127.0.0.1", bindPort: 0, remoteHost: "  10.9.9.9  ", remotePort: 5432 });
  assert.equal(started.ok, true, started.error?.message);
  assert.equal(started.value.remoteHost, "10.9.9.9", "the host is trimmed before it is used");
  assert.equal(started.value.remotePort, 5432);
  assert.equal(conn.tunnels.get(started.value.tunnelId).remotePort, 5432, "the validated target travels with the record");
}

// ── 10. a listener that outlives its transport is closed, not orphaned ──────
// listen() is asynchronous, and closeConnectionTunnels() runs when the
// transport dies. A tunnel registered AFTER that sweep was closed by nobody:
// the port stayed bound, forwarded nowhere, and never appeared in the list the
// operator could stop it from.
{
  const service = makeService();
  const conn = fakeConn(service, {});
  // The transport dies while listen() is in flight: ensureAlive still answers
  // true (it was alive when the call started) and the record is dead by the
  // time the listener exists.
  service.ensureAlive = async () => { conn.dead = true; return true; };
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const started = await service.tunnelStartLocal({ connectionId: "c1", bindAddr: "127.0.0.1", bindPort: port, remoteHost: "10.9.9.9", remotePort: 22 });
  assert.equal(started.ok, false, "the caller is told the forward did not start");
  assert.equal(started.error.code, "connection-lost");
  assert.equal(conn.tunnels.size, 0, "no half-registered tunnel is left behind");
  const attempt = net.connect(port, "127.0.0.1");
  const outcome = await new Promise((resolve) => {
    attempt.once("connect", () => resolve("connected"));
    attempt.once("error", (error) => resolve(error.code));
  });
  attempt.destroy();
  assert.equal(outcome, "ECONNREFUSED", "the port is released instead of staying bound invisibly");
}
} finally {
  const servers = [...openServers];
  for (const service of services) {
    for (const conn of service.connections.values()) {
      for (const tunnel of conn.tunnels.values()) tunnel.server && servers.push(tunnel.server);
    }
  }
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(() => resolve()))));
}
console.log("tunnel crash net: sync throw, RST both ways, late callbacks, teardown, SOCKS5 wrapper, list shadowing, local target validation, orphan listener: passed");
