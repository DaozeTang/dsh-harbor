/**
 * tunnel_start exposure gate: a listener other machines can reach — or a
 * remote forward that leads back into this host — is the operator's decision,
 * taken before any socket exists. Loopback forwards stay prompt-free.
 */
import assert from "node:assert/strict";
import HarborService from "../../src/index.js";
import { assessTunnelExposure, isLoopbackBindAddress, registerTunnelTools } from "../../src/host/tools/tunnel.js";
import { normalizeBindAddress } from "../../src/host/service/tunnels.js";

const EXEC = { name: "tunnel_start", callId: "call-1", agent: { id: "agent-1" } };

function harness({ approval, policy = { mode: "standard", approval: "ask" }, config = {} } = {}) {
  const started = [];
  const service = {
    config,
    terminalOwner: () => "conv-1",
    resolveConnection: (id) => ({ ok: true, connectionId: id ?? "c1", connection: { id: "c1", host: "192.0.2.10" } }),
    resolveExecPolicy: () => policy,
    touchAgentTarget: () => undefined,
    async tunnelStartLocal(request) {
      started.push({ kind: "local", ...request });
      return { ok: true, value: { tunnelId: "tun-1", kind: "local", bindAddr: request.bindAddr ?? "127.0.0.1", bindPort: 8080, remoteHost: request.remoteHost, remotePort: request.remotePort } };
    },
    async tunnelStartRemote(request) {
      started.push({ kind: "remote", ...request });
      return { ok: true, value: { tunnelId: "tun-2", kind: "remote", bindAddr: request.remoteHost, bindPort: request.remotePort, remoteHost: request.remoteHost, remotePort: request.remotePort, targetHost: request.targetHost, targetPort: request.targetPort } };
    },
    async tunnelStartDynamic(request) {
      started.push({ kind: "dynamic", ...request });
      return { ok: true, value: { tunnelId: "tun-3", kind: "dynamic", bindAddr: request.bindAddr ?? "127.0.0.1", bindPort: request.bindPort ?? 1080 } };
    }
  };
  const tools = new Map();
  const ctx = {
    tools: { register: (tool) => tools.set(tool.name, tool) },
    get: (name) => (name === "approval" ? approval : undefined)
  };
  registerTunnelTools(ctx, service);
  assert.equal(typeof tools.get("tunnel_start")?.execute, "function", "tunnel_start is registered");
  return { started, execute: (args) => tools.get("tunnel_start").execute(args, { ...EXEC }) };
}

const LOCAL = { connection_id: "c1", kind: "local", bind_port: 0, remote_host: "db.internal", remote_port: 5432 };

// ── loopback forwards never ask ────────────────────────────────────────────
{
  const { started, execute } = harness({ approval: { request: async () => { throw new Error("a loopback forward must not ask"); } } });
  const value = await execute(LOCAL);
  assert.equal(value.kind, "local");
  assert.equal(started.length, 1, "the loopback forward starts");

  const dynamic = await execute({ connection_id: "c1", kind: "dynamic", bind_port: 0 });
  assert.equal(dynamic.kind, "dynamic", "a loopback SOCKS5 listener also starts without an ask");
  assert.equal(started.length, 2);
}

// ── a network-reachable bind address asks, and starts only on "allow" ──────
{
  let asked = null;
  const { started, execute } = harness({ approval: { request: async (request) => { asked = request; return "allowed-once"; } } });
  const value = await execute({ ...LOCAL, bind_addr: "0.0.0.0", bind_port: 8080 });
  assert.equal(value.kind, "local");
  assert.equal(asked?.toolName, "tunnel_start", "the prompt is attributed to tunnel_start");
  assert.match(asked.reason, /0\.0\.0\.0/, "the operator sees the address that becomes reachable");
  assert.match(asked.reason, /192\.0\.2\.10/, "and the server the listener belongs to");
  assert.match(asked.reason, /超时未选择将自动拒绝/, "the deadline is stated");
  assert.equal(started[0].bindAddr, "0.0.0.0", "the approved address is what the service receives");
}

// ── a remote forward inverts the direction: always the operator's call ─────
{
  let asked = null;
  const { started, execute } = harness({ approval: { request: async (request) => { asked = request; return "rejected"; } } });
  await assert.rejects(
    () => execute({ connection_id: "c1", kind: "remote", remote_host: "127.0.0.1", remote_port: 0, target_host: "127.0.0.1", target_port: 8080 }),
    /操作者拒绝/
  );
  assert.match(asked.reason, /服务器监听 127\.0\.0\.1/, "the server-side listener is what the operator approves");
  assert.equal(started.length, 0, "a rejected forward opens no socket");
}

// ── every other outcome refuses before a socket exists ─────────────────────
{
  const { started, execute } = harness({ approval: { request: () => new Promise(() => {}) }, config: { approvalPromptTimeoutMs: 25 } });
  const began = Date.now();
  await assert.rejects(() => execute({ ...LOCAL, bind_addr: "0.0.0.0" }), /端口转发的确认等待超过/);
  assert.ok(Date.now() - began < 1000, "the gate owns its deadline");
  assert.equal(started.length, 0, "a timed-out ask opens no socket");
}
{
  const { started, execute } = harness({});
  await assert.rejects(() => execute({ ...LOCAL, bind_addr: "0.0.0.0" }), /没有可用的审批通道/);
  assert.equal(started.length, 0, "a host without an approval channel fails closed");
}
{
  let asked = 0;
  const { started, execute } = harness({
    approval: { request: async () => { asked += 1; return "allowed-once"; } },
    policy: { mode: "standard", approval: "never", dsh: { ceiling: "readOnly" } }
  });
  await assert.rejects(() => execute({ ...LOCAL, bind_addr: "0.0.0.0" }), /只读模式/);
  assert.equal(asked, 0, "a closed approval channel is never asked");
  assert.equal(started.length, 0);
}

// ── DSH full access already carries this conversation's authority ──────────
{
  const { started, execute } = harness({ approval: { request: async () => { throw new Error("allowAll must not ask"); } }, policy: { mode: "allowAll", approval: "ask" } });
  await execute({ ...LOCAL, bind_addr: "0.0.0.0" });
  assert.equal(started.length, 1, "the pre-approved mode skips the prompt");
}

// ── "not given" must never reach listen() as the wildcard ──────────────────
// net.Server#listen(port, "") binds every interface, so an empty bind_addr
// used to turn a loopback forward into a network-reachable listener with no
// approval at all. The gate and the service now share one normalizer.
{
  for (const value of [undefined, null, "", "   ", "\t"]) {
    assert.equal(normalizeBindAddress(value), "127.0.0.1", `${JSON.stringify(value)} resolves to loopback`);
  }
  assert.equal(normalizeBindAddress(" 0.0.0.0 "), "0.0.0.0", "a real address is trimmed, not replaced");
  assert.equal(normalizeBindAddress("::"), "::");

  // The band the bug actually lived in: the real service, a real listener.
  const service = Object.create(HarborService.prototype);
  const conn = {
    id: "c1",
    host: "192.0.2.10",
    dead: false,
    closing: false,
    tunnels: new Map(),
    client: {
      forwardOut() { throw new Error("no forward in this test"); },
      forwardIn(address, _port, callback) { conn.forwardedIn = address; callback(null, 2222); },
      unforwardIn(_address, _port, callback) { callback(); },
      prependListener() {},
      removeListener() {}
    }
  };
  service.resolveConnection = () => ({ ok: true, connectionId: "c1", connection: conn });
  service.ensureAlive = async () => true;

  for (const [start, stopArgs, label] of [
    ["tunnelStartLocal", { remoteHost: "db.internal", remotePort: 5432 }, "local"],
    ["tunnelStartDynamic", {}, "dynamic"]
  ]) {
    const started = await service[start]({ connectionId: "c1", bindAddr: "", bindPort: 0, ...stopArgs });
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(started.value.bindAddr, "127.0.0.1", `an empty bind_addr must not widen a ${label} forward`);
    const record = conn.tunnels.get(started.value.tunnelId);
    assert.equal(record.server.address().address, "127.0.0.1", `the ${label} listener is bound to loopback`);
    await service.tunnelStop({ connectionId: "c1", tunnelId: started.value.tunnelId });
  }

  const remote = await service.tunnelStartRemote({ connectionId: "c1", remoteHost: "", remotePort: 0, targetPort: 8080 });
  assert.equal(remote.ok, true, JSON.stringify(remote));
  assert.equal(conn.forwardedIn, "127.0.0.1", "the ssh -R listen address falls back to loopback too");
  await service.tunnelStop({ connectionId: "c1", tunnelId: remote.value.tunnelId });
}

// ── the pure predicate the gate decides on ─────────────────────────────────
{
  for (const value of [undefined, "", "127.0.0.1", "127.0.0.5", "::1", "[::1]", "localhost", " LOCALHOST "]) {
    assert.equal(isLoopbackBindAddress(value), true, `${JSON.stringify(value)} is loopback`);
    assert.equal(assessTunnelExposure({ kind: "local", bind_addr: value }), null);
  }
  for (const value of ["0.0.0.0", "::", "192.168.1.5", "example.com", "10.0.0.1"]) {
    assert.equal(isLoopbackBindAddress(value), false, `${JSON.stringify(value)} is reachable from the network`);
    assert.notEqual(assessTunnelExposure({ kind: "local", bind_addr: value }), null);
  }
  const remote = assessTunnelExposure({ kind: "remote", remote_host: "127.0.0.1", target_port: 80 });
  assert.equal(remote.kind, "remote", "a remote forward is exposed even on a loopback listen address");
  assert.equal(remote.target, "127.0.0.1:80");
}

console.log("tunnel gate: loopback is free, exposed listeners and remote forwards ask, every non-allow outcome refuses");
