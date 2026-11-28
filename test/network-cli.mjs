// #33: network-CLI execution path. Pure prompt/strip helpers, the PTY
// orchestration over a scripted device stream, the execOnConnection fallback
// routing, and the P0 guarantee that a stalled exec channel settles locally
// instead of hanging the caller forever.
import assert from "node:assert/strict";
import HarborService from "../src/index.js";
import { extractCliPrompt, promptReturned, cliPageRequested, stripCliOutput, sanitizeCliCommand, stripAnsiCodes } from "../src/host/network-cli.js";

// ── pure helpers ────────────────────────────────────────────────────────────
{
  assert.equal(stripAnsiCodes("\x1b[33mwarn\x1b[0m tail"), "warn tail");
  assert.equal(extractCliPrompt("Info: max VTY users is 10.\r\n<S12712>"), "<S12712>");
  assert.equal(extractCliPrompt("\r\n[S12712-GigabitEthernet0/0/1]"), "[S12712-GigabitEthernet0/0/1]");
  assert.equal(extractCliPrompt("Router> "), "Router>");
  assert.equal(extractCliPrompt("Router(config-if)#"), "Router(config-if)#");
  assert.equal(extractCliPrompt("display clock"), null, "plain output is not a prompt");
  assert.equal(extractCliPrompt(""), null);
  assert.equal(extractCliPrompt("noise\n\x1b[32m<S12712>\x1b[0m"), "<S12712>", "ANSI-wrapped prompt is recognised");
  assert.equal(promptReturned("<S12712>display clock\r\n2026-10-15 12:00:00\r\n<S12712>", "<S12712>"), true);
  assert.equal(promptReturned("<S12712>display clock\r\n2026-10-15 12:00:00", "<S12712>"), false, "unterminated output is not completion");
  assert.equal(cliPageRequested("  20, 30, 40:\r\n---- More ----"), true);
  assert.equal(cliPageRequested("plain output"), false);

  const full = "<S12712>display clock\r\n2026-10-15 12:00:00\r\n<S12712>";
  assert.equal(stripCliOutput(full, "<S12712>", "display clock"), "2026-10-15 12:00:00");
  const partial = stripCliOutput("<S12712>display log\r\nlong output so far", "<S12712>", "display log", { timedOut: true });
  assert.equal(partial, "long output so far", "timed-out output keeps its tail");

  assert.equal(sanitizeCliCommand("display clock").ok, true);
  assert.equal(sanitizeCliCommand("  display clock  ").value, "display clock");
  assert.equal(sanitizeCliCommand("display clock\r\nreboot").ok, false, "newline injection rejected");
  assert.equal(sanitizeCliCommand("").ok, false);
  assert.equal(sanitizeCliCommand("x".repeat(513)).ok, false);
}

// ── service stubs ───────────────────────────────────────────────────────────
function makeService() {
  const service = Object.create(HarborService.prototype);
  service.config = { maxBufferBytes: 65536, maxCommandOutputBytes: 65536 };
  service.connections = new Map();
  service.sessions = new Map();
  service.exitedSessions = new Map();
  return service;
}

/** A device stream: `script(writtenSoFar, chunk)` returns what the device emits. */
function fakeDeviceStream(script) {
  const writes = [];
  const listeners = new Map();
  return {
    writes,
    on(event, fn) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(fn); },
    removeListener(event, fn) { const list = listeners.get(event) ?? []; const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); },
    write(chunk) {
      writes.push(chunk);
      const out = script(writes.join(""), chunk);
      if (out) for (const fn of [...(listeners.get("data") ?? [])]) fn(Buffer.from(out));
    }
  };
}

function makeSession(service, bufferTail) {
  const session = { id: "s1", exited: null, stream: null, inputLine: "", inputKnown: true };
  // The prompt the device left on screen lives in the session's output journal.
  service.terminalOutput(session).append(bufferTail);
  return session;
}

function fakeConn(sessions = []) {
  const conn = { id: "c1", sessions: new Set(sessions.map((s) => s.id)), cliBusy: false };
  return conn;
}

const VRP_TAIL = "Info: The max number of VTY users is 10.\r\n<S12712>";

// ── cliExecOnSession: the happy path ────────────────────────────────────────
{
  const service = makeService();
  const stream = fakeDeviceStream((written) => {
    if (!written.includes("display clock")) return null;
    return "display clock\r\n2026-10-15 12:00:00 Wednesday\r\n<S12712>";
  });
  const session = makeSession(service, VRP_TAIL);
  session.stream = stream;
  const conn = fakeConn([session]);
  service.sessions.set(session.id, session);

  const result = await service.cliExecOnSession(conn, session, "display clock", 5000);
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.value.stdout, "2026-10-15 12:00:00 Wednesday", "echoed line and returned prompt are stripped");
  assert.equal(result.value.exitCode, null, "network CLI has no POSIX exit code");
  assert.equal(result.value.cwd, null);
  assert.equal(result.value.timedOut, false);
  assert.deepEqual(stream.writes[0], "\x15display clock\r", "the line is cleared then submitted");
  assert.equal(session.cliBusy, false, "the busy flag is released");
}


// ── paging keeps the line the marker interrupted ─────────────────────────────
// A device paints "---- More ----" at the END of the output line it interrupts,
// erases it with one backspace per character when the page advances, and then
// continues the same line. Dropping every line that mentioned the marker threw
// away one real output line per page (and left the raw \b bytes in the rest).
{
  const marker = "---- More ----";
  const interrupted = "second half of the output" + marker + "\b".repeat(marker.length) + " continues here";
  const collected = "<S12712>display log\r\nfirst line\r\n" + interrupted + "\r\n<S12712>";
  const stripped = stripCliOutput(collected, "<S12712>", "display log");
  assert.equal(stripped, "first line\nsecond half of the output continues here",
    "the data on both sides of the marker survives and rejoins on one line");
  assert.equal(stripped.includes("More"), false, "the marker itself is chrome");
  assert.equal(stripped.includes("\b"), false, "no backspace byte reaches the agent");

  // A marker the device never erased (the host's pager repaints differently,
  // or the page was the last one) still carries no data of its own.
  assert.equal(stripCliOutput("<S12712>display log\r\npage one\r\n---- More ----\r\npage two\r\n<S12712>", "<S12712>", "display log"),
    "page one\npage two");
  // A page that was never continued keeps its line; only the chrome goes.
  assert.equal(stripCliOutput("<S12712>display log\r\nkept ---- More ----", "<S12712>", "display log", { timedOut: true }),
    "kept");
}

// ── paging, end to end: the interrupted line is the one that must survive ────
{
  const service = makeService();
  const marker = "---- More ----";
  let pages = 0;
  const stream = fakeDeviceStream((_written, chunk) => {
    if (chunk === " ") {
      if (pages === 1) { pages = 2; return "\b".repeat(marker.length) + " end of the line\r\n<S12712>"; }
      return null;
    }
    if (pages !== 0) return null;
    pages = 1;
    return "display log\r\nvalue twenty thirty forty" + marker;
  });
  const session = makeSession(service, VRP_TAIL);
  session.stream = stream;
  const conn = fakeConn([session]);
  service.sessions.set(session.id, session);

  const result = await service.cliExecOnSession(conn, session, "display log", 5000);
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.value.stdout, "value twenty thirty forty end of the line",
    "the line the page break interrupted is not dropped");
  assert.equal(stream.writes.filter((w) => w === " ").length, 1, "exactly one paging space was sent");
}

// ── paging: the device stops at ---- More ----, a space advances it ─────────
{
  const service = makeService();
  let pages = 0;
  const stream = fakeDeviceStream((written, chunk) => {
    if (chunk === " ") {
      if (pages === 1) { pages = 2; return "\r\npage two\r\n<S12712>"; }
      return null;
    }
    if (!written.includes("display log")) return null;
    if (pages === 0) { pages = 1; return "display log\r\npage one\r\n---- More ----"; }
    return null;
  });
  const session = makeSession(service, VRP_TAIL);
  session.stream = stream;
  const conn = fakeConn([session]);
  service.sessions.set(session.id, session);

  const result = await service.cliExecOnSession(conn, session, "display log", 5000);
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.value.stdout, "page one\npage two");
  assert.equal(stream.writes.filter((w) => w === " ").length, 1, "exactly one paging space was sent");
}

// ── timeout: the device never returns the prompt ────────────────────────────
{
  const service = makeService();
  const stream = fakeDeviceStream((written) => (written.includes("display log") ? "display log\r\nstill scrolling" : null));
  const session = makeSession(service, VRP_TAIL);
  session.stream = stream;
  const conn = fakeConn([session]);
  service.sessions.set(session.id, session);

  const result = await service.cliExecOnSession(conn, session, "display log", 300);
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.value.timedOut, true);
  assert.match(result.value.stdout, /still scrolling/, "partial output is preserved for diagnosis");
}

// ── output cap: a flooding device cannot pour unbounded bytes at the agent ──
{
  const service = makeService();
  service.config.maxCommandOutputBytes = 1024;
  const flood = "x".repeat(64 * 1024);
  const stream = fakeDeviceStream((written) => (written.includes("display huge") ? `display huge\r\n${flood}\r\n<S12712>` : null));
  const session = makeSession(service, VRP_TAIL);
  session.stream = stream;
  const conn = fakeConn([session]);
  service.sessions.set(session.id, session);

  const result = await service.cliExecOnSession(conn, session, "display huge", 5000);
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.value.truncated, true, "dropped bytes are reported, not hidden");
  assert.ok(
    Buffer.byteLength(result.value.stdout, "utf8") <= 1024,
    `stdout stays inside maxCommandOutputBytes (saw ${Buffer.byteLength(result.value.stdout, "utf8")})`
 );
  assert.equal(stream.writes.filter((w) => w === " ").length, 0, "the retained tail still recognises the prompt: no paging loop");
}

// ── guards: busy mutex, unknown prompt, no terminal ─────────────────────────
{
  const service = makeService();
  const stream = fakeDeviceStream(() => null);
  const session = makeSession(service, VRP_TAIL);
  session.stream = stream;
  const conn = fakeConn([session]);
  service.sessions.set(session.id, session);

  // Serialization is per terminal: another conversation's query on the same
  // device must not block this one.
  session.cliBusy = true;
  const busy = await service.cliExecOnSession(conn, session, "display clock");
  assert.equal(busy.error.code, "cli-busy");
  session.cliBusy = false;

  const bare = makeSession(service, "random scrolling output\r\nnothing prompt-like");
  bare.stream = fakeDeviceStream(() => null);
  const noPrompt = await service.cliExecOnSession(conn, bare, "display clock");
  assert.equal(noPrompt.error.code, "cli-prompt-unrecognized", "refuse rather than guess (#33 expectation 4)");

  const lonely = fakeConn([]);
  const noTerminal = await service.cliExecOnConnection(lonely, "display clock");
  assert.equal(noTerminal.error.code, "cli-no-terminal");
  assert.match(noTerminal.error.message, /打开终端/, "the error tells the operator what to do (#33 P1)");
}

// ── routing: execStalled short-circuits exec; first stall falls through ─────
{
  const service = makeService();
  const conn = fakeConn([]);
  service.connections.set("c1", conn);
  service.resolveLoginShell = async () => null;

  conn.execStalled = true;
  let execTried = 0;
  service.runPreparedExec = async () => { execTried += 1; return { ok: true, value: {} }; };
  service.cliExecOnConnection = async () => ({ ok: true, value: { stdout: "via cli", timedOut: false } });
  const routed = await service.execOnConnection("c1", "display clock");
  assert.equal(routed.value.stdout, "via cli", "a stalled connection goes straight to the terminal path");
  assert.equal(execTried, 0, "the exec channel is not re-tried on a stalled connection");

  conn.execStalled = false;
  service.runPreparedExec = async () => ({ ok: true, value: { exitCode: 0, stdout: "posix output", stderr: "", cwd: "/x", commandId: "c", startedAt: "", finishedAt: "", durationMs: 1, truncated: false, timedOut: false } });
  const posix = await service.execOnConnection("c1", "ls");
  assert.equal(posix.value.stdout, "posix output", "healthy exec is untouched");
  assert.equal(conn.execStalled, false, "healthy exec does not mark the connection");

  service.runPreparedExec = async () => ({ ok: true, value: { exitCode: null, stdout: "", stderr: "", cwd: null, commandId: "c", startedAt: "", finishedAt: "", durationMs: 5000, truncated: false, timedOut: true } });
  let cliCalled = 0;
  service.cliExecOnConnection = async () => { cliCalled += 1; return { ok: true, value: { stdout: "via cli", timedOut: false } }; };
  // A device signature: the login-shell probe came back empty, so the exec
  // channel opened without ever answering.
  conn.loginShell = null;
  const fellThrough = await service.execOnConnection("c1", "display clock");
  assert.equal(fellThrough.value.timedOut, true);
  assert.equal(conn.execStalled, false);
  assert.equal(cliCalled, 0, "a dispatched command is never replayed in the terminal");

  // The SAME silent timeout on a host whose login shell answered is not a
  // device: it is a slow, quiet command (`sleep 45`, a build that prints
  // nothing), and the caller must get its honest timeout result. Reacting to
  // the timeout alone downgraded healthy connections for the rest of their
  // life — every later ssh_exec failed with "network CLI prompt unrecognised".
  conn.execStalled = false;
  conn.loginShell = "bash";
  cliCalled = 0;
  const healthy = await service.execOnConnection("c1", "sleep 45");
  assert.equal(healthy.ok, true, "the honest timeout result comes back");
  assert.equal(healthy.value.timedOut, true);
  assert.equal(cliCalled, 0, "no terminal detour on a POSIX host");
  assert.equal(conn.execStalled, false, "a healthy host is never marked as a device");

  // A stale flag does not outlive the proof that exec works: a known POSIX
  // login shell is never diverted, and the exec that settles clears the flag.
  conn.execStalled = true;
  conn.loginShell = "bash";
  service.runPreparedExec = async () => ({ ok: true, value: { exitCode: 0, stdout: "recovered", stderr: "", cwd: "/x", commandId: "c", startedAt: "", finishedAt: "", durationMs: 1, truncated: false, timedOut: false } });
  const recovered = await service.execOnConnection("c1", "echo ok");
  assert.equal(recovered.value.stdout, "recovered", "a known POSIX shell is never diverted to the terminal");
  assert.equal(conn.execStalled, false, "a successful exec clears the remembered stall");

  // The deny-list still gates the CLI path: destructive commands never type.
  service.cliExecOnConnection = async () => { throw new Error("must not be called"); };
  const blocked = await service.execOnConnection("c1", "rm -rf /tmp/x");
  assert.equal(blocked.blocked, true, "deny-list runs before any routing");
}

// ── P0: a stalled exec channel settles locally on timeout, never hangs ──────
{
  const service = makeService();
  let destroyed = false;
  const listeners = new Map();
  const stream = {
    on(event, fn) { const list = listeners.get(event) ?? []; list.push(fn); listeners.set(event, list); },
    removeListener(event, fn) { const list = listeners.get(event) ?? []; const at = list.indexOf(fn); if (at >= 0) list.splice(at, 1); },
    stderr: { on() {}, removeListener() {} },
    destroy() { destroyed = true; }
  };
  const client = { exec: (cmd, opts, cb) => cb(null, stream) };
  const state = await service.collectExecOutput(client, "echo $SHELL", 50);
  assert.equal(state.timedOut, true, "the deadline resolves the call locally (#33)");
  assert.equal(destroyed, true, "the channel is destroyed (end+close), not left half-closed");
  assert.equal(listeners.get("data")?.length, 0, "timeout detaches the data listener");
  assert.equal(listeners.get("close")?.length, 0, "timeout detaches the close listener");
  assert.equal(listeners.get("error")?.length, 0, "timeout detaches the error listener");
}

// ── the channel-open round trip is bounded too ──────────────────────────────
{
  const service = makeService();
  // The peer accepts the exec request and never calls back. ssh2 puts no timer
  // on that request, so without a deadline here every caller hung forever.
  const client = { exec() {} };
  const started = Date.now();
  const state = await service.collectExecOutput(client, "echo hi", 40);
  assert.equal(state.timedOut, true);
  assert.equal(state.openTimedOut, true, "the open timeout is distinguishable from a silent command");
  assert.ok(Date.now() - started < 1000, "the open deadline settles locally");
}

// ── a silent login-shell probe is retried, never cached as "no shell" ───────
{
  const service = makeService();
  const conn = { loginShell: undefined, execStalled: false };
  let probes = 0;
  service.collectExecOutput = async () => { probes += 1; return { timedOut: true, stdout: "", exitCode: null }; };
  assert.equal(await service.resolveLoginShell(conn), null);
  assert.equal(conn.execStalled, true, "a silent probe marks the connection as possibly CLI");
  assert.equal(conn.loginShell, undefined, "the timeout is not cached as a non-POSIX shell");
  assert.equal(await service.resolveLoginShell(conn), null, "the retry window answers without touching the wire");
  assert.equal(probes, 1, "no second probe inside the backoff window");

  conn.loginShellRetryAt = 0;
  service.collectExecOutput = async () => { probes += 1; return { timedOut: false, stdout: "/bin/bash\n", exitCode: 0 }; };
  assert.equal(await service.resolveLoginShell(conn), "bash", "the retry recovers the shell name");
  assert.equal(conn.execStalled, false);
  assert.equal(conn.loginShell, "bash");
  assert.equal(probes, 2);
}

// ── a healthy exec clears the probe backoff ─────────────────────────────────
{
  const service = makeService();
  const conn = { execStalled: true, loginShellRetryAt: Date.now() + 60000 };
  service.markExecChannelHealthy(conn);
  assert.equal(conn.execStalled, false);
  assert.equal(conn.loginShellRetryAt, undefined, "a completed exec proves the channel works");
}

console.log("network cli: prompts, stripping, paging, guards, routing, P0 settle: passed");
