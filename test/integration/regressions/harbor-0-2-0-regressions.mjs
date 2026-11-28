// Regressions found in the 0.2.0 review: wire-envelope drift on a rare RPC,
// exited terminals holding the session cap, and remote-forward semantics that
// listened on the wrong endpoint (and could never be stopped by the UI).
import assert from "node:assert/strict";
import net from "node:net";
import { PassThrough } from "node:stream";
import HarborService from "../../../src/index.js";
import { cancelProfileConnectResultSchema } from "../../../src/rpc/schemas.js";

// ── 1. cancelProfileConnect returns the same envelope as every other method ──
assert.equal(
  cancelProfileConnectResultSchema.safeParse({ ok: true, value: { cancelled: 2 } }).success,
  true,
  "a successful cancellation parses through its own result codec"
);
assert.equal(
  cancelProfileConnectResultSchema.safeParse({ ok: false, error: { code: "x", message: "y" } }).success,
  true,
  "the error branch keeps the shared envelope shape"
);
assert.equal(
  cancelProfileConnectResultSchema.safeParse({ cancelled: 2 }).success,
  false,
  "the bare value is not a valid wire result"
);

// ── 2. exited terminals are bounded and tombstoned ──────────────────────────
{
  const service = Object.create(HarborService.prototype);
  service.sessions = new Map();
  service.exitedSessions = new Map();
  service.connections = new Map();
  const conn = { id: "c1", sessions: new Set() };
  service.connections.set("c1", conn);
  for (let index = 0; index < 12; index += 1) {
    const id = `s${index}`;
    service.sessions.set(id, { id, connectionId: "c1", exited: { code: 0 } });
    conn.sessions.add(id);
  }
  service.pruneExitedSessions(8);
  assert.equal(service.sessions.size, 8, "only the newest exited terminals stay in memory");
  assert.equal(conn.sessions.size, 8, "the connection's live set is pruned with it");
  assert.equal(service.exitedSessions.size, 4, "the evicted terminals become tombstones for late readers");
  assert.deepEqual(service.exitedSessions.get("s0"), { code: 0 });
  const { readResultSchema } = await import("../../../src/rpc/schemas.js");
  const late = await service.read({ sessionId: "s0" });
  assert.equal(late.ok, true, "a late read of an evicted terminal still succeeds");
  readResultSchema.parse(late);
  assert.deepEqual(late.value.exit, { code: 0 });
}

// ── 3. remote forwards listen on the endpoint the caller names ──────────────
{
  const service = Object.create(HarborService.prototype);
  service.connections = new Map();
  const calls = { forwardIn: [], unforwardIn: [] };
  const client = new net.Socket();
  client.forwardIn = (addr, port, cb) => {
    calls.forwardIn.push([addr, port]);
    cb(null, 40222);
  };
  client.unforwardIn = (addr, port, cb) => {
    calls.unforwardIn.push([addr, port]);
    cb?.();
  };
  const conn = {
    id: "c1", client, tunnels: new Map(),
    dead: false, closing: false, sessions: new Set(), hops: []
  };
  service.connections.set("c1", conn);
  service.resolveConnection = () => ({ ok: true, connection: conn });
  service.ensureAlive = async () => true;

  const started = await service.tunnelStartRemote({
    connectionId: "c1",
    remoteHost: "0.0.0.0",
    remotePort: 0,
    targetHost: "127.0.0.1",
    targetPort: 18080
  });
  assert.equal(started.ok, true, started.error?.message);
  assert.deepEqual(calls.forwardIn, [["0.0.0.0", 0]], "forwardIn receives the server-side listen endpoint");
  assert.equal(started.value.bindAddr, "0.0.0.0");
  assert.equal(started.value.bindPort, 40222, "the server-assigned port is what the result reports");
  assert.equal(started.value.targetPort, 18080);

  // The bridge must match the assigned port, not the requested 0.
  const tunnel = conn.tunnels.get(started.value.tunnelId);
  const originalConnect = net.connect;
  let connectedTo = null;
  net.connect = (port, host) => {
    connectedTo = [host, port];
    return new PassThrough();
  };
  try {
    let accepted = 0;
    tunnel.bridgeInfo.bridge({ destIP: "0.0.0.0", destPort: 0 }, () => { accepted += 1; return new PassThrough(); });
    assert.equal(accepted, 0, "a channel for the requested port 0 is not the assigned listener");
    tunnel.bridgeInfo.bridge({ destIP: "10.0.0.5", destPort: 40222 }, () => { accepted += 1; return new PassThrough(); });
    assert.equal(accepted, 1, "a wildcard bind accepts the address sshd actually reports");
    assert.deepEqual(connectedTo, ["127.0.0.1", 18080], "the bridge dials the local target");
  } finally {
    net.connect = originalConnect;
  }

  const stopped = await service.tunnelStop({ connectionId: "c1", tunnelId: started.value.tunnelId });
  assert.equal(stopped.ok, true, stopped.error?.message);
  assert.deepEqual(calls.unforwardIn, [["0.0.0.0", 40222]], "stop releases the assigned listen port");
  assert.equal(conn.tunnels.size, 0);
  client.destroy();
}

// ── 4. stopping a local tunnel does not wait for its clients to disconnect ──
{
  const service = Object.create(HarborService.prototype);
  service.connections = new Map();
  const client = {
    forwardOut(_addr, _port, _host, _targetPort, cb) { cb(null, new PassThrough()); }
  };
  const conn = { id: "c1", client, tunnels: new Map(), dead: false, closing: false, sessions: new Set(), hops: [] };
  service.connections.set("c1", conn);
  service.resolveConnection = () => ({ ok: true, connection: conn });
  service.ensureAlive = async () => true;

  const started = await service.tunnelStartLocal({
    connectionId: "c1", bindAddr: "127.0.0.1", bindPort: 0, remoteHost: "127.0.0.1", remotePort: 18081
  });
  assert.equal(started.ok, true, started.error?.message);
  const live = net.connect(started.value.bindPort, "127.0.0.1");
  await new Promise((resolve, reject) => { live.once("connect", resolve); live.once("error", reject); });
  let watchdog;
  try {
    const result = await Promise.race([
      service.tunnelStop({ connectionId: "c1", tunnelId: started.value.tunnelId }),
      new Promise((resolve) => { watchdog = setTimeout(() => resolve("timeout"), 3000); })
    ]);
    assert.notEqual(result, "timeout", "tunnelStop closes live accepted sockets instead of waiting on them");
    assert.equal(result.ok, true, result.error?.message);
  } finally {
    clearTimeout(watchdog);
    live.destroy();
  }
}

console.log("harbor 0.2.0 regressions: cancel envelope, exited-session cap, remote forward endpoint, stop with live clients: passed");
