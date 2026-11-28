// P3 regressions: behaviour that was wrong but harmless enough to survive the
// first two rounds. Each block reproduces the old symptom and pins the fix.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import HarborService from "../src/index.js";
import { BATCH_TASK_TTL_MS } from "../src/host/service/batch.js";
import { registerTunnelTools } from "../src/host/tools/tunnel.js";
import { registerSshSessionTools } from "../src/host/tools/ssh-session.js";
import { stripCliOutput } from "../src/host/exec/network-cli.js";
import { buildCwdAwareCommand, extractExecCwd } from "../src/host/exec/cwd.js";

function makeService() {
  const service = Object.create(HarborService.prototype);
  service.config = { maxCommandOutputBytes: 4096 };
  service.batchTasks = new Map();
  return service;
}

// ── 1. tunnel_list renders a SOCKS5 forward as what it is ─────────────────
// The generic branch printed `dynamic: 127.0.0.1:1080 -> undefined:undefined`
// because a dynamic forward has no single remote endpoint.
{
  const tools = [];
  const ctx = { tools: { register: (tool) => tools.push(tool) }, on: () => {} };
  registerTunnelTools(ctx, makeService());
  const list = tools.find((tool) => tool.name === "tunnel_list");
  const text = list.output.render({}, {
    tunnels: [
      { tunnelId: "d1", kind: "dynamic", bindAddr: "127.0.0.1", bindPort: 1080, connections: 2, active: true },
      { tunnelId: "l1", kind: "local", bindAddr: "127.0.0.1", bindPort: 9000, remoteHost: "db", remotePort: 5432, active: true }
    ]
  })[0].text;
  assert.match(text, /dynamic: socks5 127\.0\.0\.1:1080 \(2 connections\) \(d1\)/, text);
  assert.doesNotMatch(text, /undefined/, "no field the tunnel does not have is printed");
  assert.match(text, /local: 127\.0\.0\.1:9000 -> db:5432 \(l1\)/);
}

// ── 2. the echoed CLI command is dropped even behind a blank line ──────────
// A device that answers with a bare CRLF first made the echo check look at the
// blank line, miss, and hand the echoed command to the model as output.
{
  const collected = "\r\nRouter# show clock\r\n12:00:00 UTC\r\nRouter#";
  const text = stripCliOutput(collected, "Router#", "show clock");
  assert.equal(text, "12:00:00 UTC", "the echo line is not output");
}

// ── 3. an unanswered batch plan expires instead of wedging batch-limit ─────
{
  const service = makeService();
  const stale = service.batchPlan({ command: "uptime" });
  assert.equal(stale.ok, true);
  service.batchTasks.get(stale.value.task.batchId).createdAt = new Date(Date.now() - BATCH_TASK_TTL_MS - 60_000).toISOString();
  const fresh = service.batchPlan({ command: "df -h" });
  assert.equal(fresh.ok, true);
  const listed = service.batchTaskList().value.tasks.map((task) => task.batchId);
  assert.deepEqual(listed, [fresh.value.task.batchId], "only the fresh plan is still pending");
  const expired = await service.batchRun({ batchId: stale.value.task.batchId, profileIds: ["p"] });
  assert.equal(expired.error.code, "batch-missing", "an expired plan cannot be run");
}

// ── 4. ssh_connect does not promise a second terminal it cannot open ───────
// openAgentTerminal refuses a second terminal for the same conversation (only
// a takeover reopens), so the description must say terminal_send/terminal_close.
{
  const tools = [];
  const ctx = { tools: { register: (tool) => tools.push(tool) }, on: () => {} };
  registerSshSessionTools(ctx, makeService());
  const connect = tools.find((tool) => tool.name === "ssh_connect");
  assert.doesNotMatch(connect.description, /second shell/, "no second-shell promise");
  assert.match(connect.description, /terminal_send/);
  assert.match(connect.description, /terminal_close/);
}

// ── 5. the cwd prologue tries the census pid before scanning all of /proc ──
// A machine with thousands of processes paid a full scan on every ssh_exec.
{
  const root = mkdtempSync(join(tmpdir(), "dsh-cwd-hint-"));
  const procRoot = join(root, "proc");
  mkdirSync(procRoot);
  const homeA = join(root, "a");
  const homeB = join(root, "b");
  mkdirSync(homeA);
  mkdirSync(homeB);
  const shellAt = (pid, directory) => {
    const dir = join(procRoot, String(pid));
    mkdirSync(join(dir, "fd"), { recursive: true });
    symlinkSync("/dev/pts/7", join(dir, "fd/0"));
    symlinkSync(directory, join(dir, "cwd"));
    writeFileSync(join(dir, "comm"), "bash\n");
    writeFileSync(join(dir, "environ"), "SSH_CONNECTION=test-hint\0");
    writeFileSync(join(dir, "cmdline"), "-bash\0");
    writeFileSync(join(dir, "stat"), `${pid} (bash) S 1 ${pid} 100 34816 ${pid} 0\n`);
  };
  shellAt(401, homeA);
  shellAt(402, homeB);
  const run = (options) => spawnSync("/bin/sh", ["-c", buildCwdAwareCommand("pwd -P", { procRoot, ...options })], {
    cwd: root,
    env: { ...process.env, SSH_CONNECTION: "test-hint" },
    encoding: "utf8"
  });
  try {
    const ambiguous = run({});
    assert.equal(extractExecCwd(ambiguous.stdout).cwd, null, "two shells on one tty stay ambiguous without a hint");
    assert.match(ambiguous.stderr, /multiple interactive shells/);

    const hinted = run({ tty: "/dev/pts/7", pid: 402 });
    assert.equal(hinted.status, 0, hinted.stderr);
    assert.ok(extractExecCwd(hinted.stdout).cwd.endsWith("b"), "the hinted pid's directory wins");

    const stale = run({ tty: "/dev/pts/7", pid: 999 });
    assert.equal(extractExecCwd(stale.stdout).cwd, null, "a stale pid falls back to the scan");
    assert.match(stale.stderr, /multiple interactive shells/);

    const noTty = run({ tty: null, pid: 401 });
    assert.equal(extractExecCwd(noTty.stdout).cwd, null, "a hint without a tty filter is ignored");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("p3 regressions: tunnel render, CLI echo, batch TTL, tool wording, cwd hint");
