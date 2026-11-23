
/**
 * System monitor service: cadence, single-flight, cache, backoff and the
 * honest error envelopes.
 *
 * The transport is faked at the ssh2 boundary (the same shape test/batch.mjs
 * uses), so what is asserted here is the scheduling behaviour an operator
 * feels: one probe at a time per server, ten seconds between mount-table
 * reads, a retry delay after a failure, and no channel at all when the link is
 * already known to be down.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { remoteMethods } from "@deepseek-ai/dsh-typert-protocol";
import HarborService from "../src/index.js";
import { renderStatusText } from "../src/host/tools/status.js";

/**
 * A probe payload whose counters advance per call, so the sampler sees real
 * deltas: 450 jiffies total and 250 idle per second, i.e. 44.4% busy.
 */
function probeText(step = 0) {
  const busy = 500 + step * 200;
  const idle = 9000 + step * 250;
  return [
    "#meta", "sysname=Linux", "kernel=6.8.0-45-generic", "arch=x86_64", "host=box", "cores=8",
    "#cpu", "cpu  " + busy + " 0 " + busy + " " + idle + " 0 0 0 0",
    "#mem", "MemTotal: 1000 kB", "MemAvailable: 500 kB",
    "#load", "0.10 0.20 0.30 2/120 900",
    "#uptime", "3600",
    "#net", "  eth0: " + (1000 + step * 2000) + " 0 0 0 0 0 0 0 " + (2000 + step * 2000) + " 0 0 0 0 0 0 0",
    "#gpu",
    "#procs", "  1 10.0 1.0 init",
    "#df", "Filesystem 1024-blocks Used Available Capacity Mounted on", "/dev/sda1 100000 40000 60000 40% /",
    "#diskstats", "8 0 sda " + (1000 + step * 100) + " 0 " + (2000 + step * 200) + " 10 20 0 " + (300 + step * 10) + " 5 0 0 0",
    "#end"
  ].join("\n") + "\n";
}

/** A fake ssh2 client that answers exec with a canned (or generated) payload. */
function fakeClient(source, options = {}) {
  const calls = [];
  return {
    calls,
    exec(command, execOptions, callback) {
      const index = calls.length;
      calls.push({ command, execOptions });
      if (options.error !== undefined) { setImmediate(() => callback(options.error)); return undefined; }
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      stream.close = () => {};
      callback(null, stream);
      const payload = typeof source === "function" ? source(index) : source;
      setTimeout(() => {
        if (options.silent !== true) stream.emit("data", Buffer.from(payload));
        stream.emit("close", options.exit ?? 0);
      }, options.delay ?? 0);
      return stream;
    }
  };
}

function serviceWith(client, connectionPatch = {}) {
  const service = Object.create(HarborService.prototype);
  service.config = { maxCommandOutputBytes: 64 * 1024 };
  service.agentAutoConnect = false;
  service.connections = new Map([["c1", {
    id: "c1", host: "10.0.0.5", port: 22, username: "root", client, dead: false, closing: false,
    ...connectionPatch
  }]]);
  return service;
}

/** Freeze the clock so the cadence can be exercised without waiting. */
function fakeClock() {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  return {
    advance(ms) { offset += ms; },
    restore() { Date.now = realNow; }
  };
}

// ── cadence: slow first, fast afterwards, slow again after 10s ──────────────
{
  const clock = fakeClock();
  try {
    const client = fakeClient(probeText);
    const service = serviceWith(client);

    const first = await service.systemStats({ connectionId: "c1" });
    assert.equal(first.ok, true);
    assert.equal(first.value.warmingUp, true, "the first sample has no interval yet");
    assert.equal(first.value.supported, true);
    assert.equal(client.calls.length, 1);
    assert.ok(client.calls[0].command.includes("#df"), "the first probe carries the mount table");
    assert.ok(client.calls[0].command.includes("#meta"), "and the machine identity");
    assert.match(client.calls[0].command, /^sh -c '/, "the command is the fixed quoted script");
    assert.equal(client.calls[0].execOptions.pty, false, "no PTY: this is a data channel, not a shell");
    assert.equal(first.value.disks.length, 1);

    clock.advance(2000);
    const second = await service.systemStats({ connectionId: "c1" });
    assert.equal(second.ok, true);
    assert.equal(client.calls.length, 2);
    assert.equal(client.calls[1].command.includes("#df"), false, "the fast tick skips the mount table");
    assert.ok(client.calls[1].command.includes("#end"), "but still terminates the script");
    assert.equal(second.value.disks.length, 1, "the carried mount table is still reported");
    assert.equal(second.value.cpu.usagePercent, 61.5, "650 jiffies total with 250 idle means 61.5% busy");
    const rxRate = second.value.network[0].rxBytesPerSec;
    assert.ok(rxRate > 900 && rxRate < 1100, "2000 bytes over roughly 2s lands near 1000 B/s, got " + rxRate);

    clock.advance(10500);
    await service.systemStats({ connectionId: "c1" });
    assert.equal(client.calls.length, 3);
    assert.ok(client.calls[2].command.includes("#df"), "after ten seconds the mount table is read again");
  } finally {
    clock.restore();
  }
}

// ── cache: a second pane on the same server does not pay twice ─────────────
{
  const clock = fakeClock();
  try {
    const client = fakeClient(probeText);
    const service = serviceWith(client);
    await service.systemStats({ connectionId: "c1" });
    clock.advance(300);
    const again = await service.systemStats({ connectionId: "c1" });
    assert.equal(again.ok, true);
    assert.equal(client.calls.length, 1, "a second request inside one second reuses the sample");

    const refreshed = await service.systemStats({ connectionId: "c1", refresh: true });
    assert.equal(refreshed.ok, true);
    assert.equal(client.calls.length, 2, "refresh bypasses the cache");
    assert.ok(client.calls[1].command.includes("#df"), "refresh re-reads the slow sections");
  } finally {
    clock.restore();
  }
}

// ── single flight: concurrent callers share one probe ──────────────────────
{
  const client = fakeClient(probeText, { delay: 30 });
  const service = serviceWith(client);
  const [a, b] = await Promise.all([
    service.systemStats({ connectionId: "c1" }),
    service.systemStats({ connectionId: "c1" })
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(client.calls.length, 1, "two panes polling the same server open one channel");
}

// ── failures: reported once, then backed off ───────────────────────────────
{
  const client = fakeClient(probeText, { error: new Error("channel open failed") });
  const service = serviceWith(client);
  const failed = await service.systemStats({ connectionId: "c1" });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, "probe-failed");
  assert.equal(client.calls.length, 1);

  const backedOff = await service.systemStats({ connectionId: "c1" });
  assert.equal(backedOff.ok, false);
  assert.equal(backedOff.error.code, "probe-backoff");
  assert.match(backedOff.error.message, /秒后自动重试/);
  assert.equal(client.calls.length, 1, "a failing server is not hammered every two seconds");
}

// ── a host without /proc is asked once a minute, not twice a second ────────
{
  const clock = fakeClock();
  try {
    const macPayload = "#meta\nsysname=Darwin\nkernel=24.1.0\narch=arm64\n#cpu\n#mem\n#net\n#gpu\n#procs\n#df\n#diskstats\n#end\n";
    const client = fakeClient(macPayload);
    const service = serviceWith(client);
    const first = await service.systemStats({ connectionId: "c1" });
    assert.equal(first.ok, true, "an unsupported host is a normal result, not an error");
    assert.equal(first.value.supported, false);
    assert.equal(first.value.reason, "no-procfs");
    assert.equal(first.value.platformName, "Darwin");

    clock.advance(5000);
    const second = await service.systemStats({ connectionId: "c1" });
    assert.equal(second.value.supported, false);
    assert.equal(client.calls.length, 1, "the unsupported verdict is remembered for a minute");
  } finally {
    clock.restore();
  }
}

// ── a dead transport is reported without opening a channel ────────────────
{
  const client = fakeClient(probeText);
  const service = serviceWith(client, { dead: true });
  const result = await service.systemStats({ connectionId: "c1" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "connection-lost");
  assert.equal(client.calls.length, 0, "no probe is attempted on a known-dead link");
}

// ── an unknown connection is the standard no-connection guidance ───────────
{
  const service = serviceWith(fakeClient(probeText));
  const result = await service.systemStats({ connectionId: "nope" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "no-connection");
}

// ── a hung probe times out and closes the channel ──────────────────────────
{
  const client = fakeClient(probeText, { silent: true, delay: 5000 });
  const service = serviceWith(client);
  service.config.monitorProbeTimeoutMs = 60;
  const started = Date.now();
  const result = await service.systemStats({ connectionId: "c1" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "probe-failed");
  assert.match(result.error.message, /超时/);
  assert.ok(Date.now() - started < 1000, "the timeout wins over a silent channel");
}

// ── probe state is dropped with its connection ─────────────────────────────
{
  const service = serviceWith(fakeClient(probeText));
  await service.systemStats({ connectionId: "c1" });
  assert.equal(service.monitorStates.size, 1);
  service.connections.delete("c1");
  service.pruneMonitorStates();
  assert.equal(service.monitorStates.size, 0, "a closed connection leaves no sampler behind");
}

// ── the agent-facing summary ───────────────────────────────────────────────
{
  const service = serviceWith(fakeClient(probeText));
  const value = (await service.systemStats({ connectionId: "c1" })).value;
  const text = renderStatusText(value);
  assert.match(text, /^box · /, "the summary leads with the machine, not a JSON blob");
  assert.match(text, /cpu: /, "cpu is reported");
  assert.match(text, /memory: /, "memory is reported");
  assert.match(text, /disks: \/ /, "the mount table is reported");
  assert.match(text, /sampled /, "and the sample time, so a stale reading is obvious");

  const unsupported = renderStatusText({ supported: false, reason: "no-procfs" });
  assert.match(unsupported, /no \/proc/, "an unsupported host is explained in words");
  assert.equal(renderStatusText({ supported: false, reason: "no-posix-shell" }).includes("POSIX shell"), true);
}

// ── a live plugin reload keeps the new endpoint claimable ───────────────────
{
  const markers = remoteMethods(Object.create(HarborService.prototype));
  assert.ok(
    markers.some((marker) => marker.method === "systemStats"),
    "systemStats carries a source-mode Remote marker for the Gateway's stale-manifest fallback"
  );
  const source = Function.prototype.toString.call(HarborService.prototype.systemStats);
  const header = source.slice(0, source.indexOf("{"));
  assert.match(header, /^async systemStats\(request\)\s*$/, "the marked method keeps a plain parameter list");
  assert.doesNotMatch(header, /[=[\]{}]/, "DSH's source-mode parser rejects defaults, destructuring and rest parameters");
}

// ── a reconnect mid-probe is retried immediately, not backed off ───────────
{
  const oldClient = fakeClient(probeText, { delay: 40 });
  const service = serviceWith(oldClient);
  const live = service.connections.get("c1");
  setTimeout(() => { live.client = fakeClient(probeText); }, 10);
  const result = await service.systemStats({ connectionId: "c1" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "connection-lost");
  assert.equal(service.monitorState("c1").retryAt, 0, "a transport replacement does not arm the failure backoff");
}

// ── an omitted request object still samples the single connection ──────────
{
  const client = fakeClient(probeText);
  const service = serviceWith(client);
  const result = await service.systemStats();
  assert.equal(result.ok, true, "the source-mode signature accepts an omitted request");
  assert.equal(client.calls.length, 1);
}

console.log("monitor service: cadence, cache, single-flight, backoff, unsupported memo and dead links: passed");
