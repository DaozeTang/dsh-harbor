/**
 * Official persistent-terminal backend for SSH: spawn wiring, screen paging,
 * send settlement, signals and the take-over handoff.
 */
import assert from "node:assert/strict";
import { HarborSshBackend, SshTerminalSession, SUBAGENT_REFUSAL, TAKEN_OVER, HARBOR_SSH_BACKEND_TYPE, SEND_TIMEOUT_MS } from "../src/host/terminal-backend.js";

function makeSession(overrides = {}) {
  return {
    id: "pty-a",
    connectionId: "c1",
    ownerSessionId: "conv-1",
    openedBy: "agent",
    tty: "/dev/pts/3",
    exited: null,
    stream: { signal(name) { this.lastSignal = name; } },
    ...overrides
  };
}

function makeService(session, rendered = "u@h:~$ ") {
  const written = [];
  const state = { rendered, written, closed: false, detached: false, attached: null };
  const service = {
    sessions: new Map([[session.id, session]]),
    connections: new Map([["c1", { id: "c1", name: "demo", host: "h", port: 22, username: "u", ttyCensus: [{ tty: "/dev/pts/3", pid: 4242 }] }]]),
    terminalOwner: () => "conv-1",
    resolveConnection: () => ({ ok: true, connectionId: "c1", connection: { id: "c1", name: "demo", host: "h", port: 22, username: "u" } }),
    liveAgentTerminal: () => undefined,
    takenOverTerminal: () => undefined,
    async openAgentTerminal() { return { session, connectionId: "c1", host: "h", reused: false }; },
    async openSession() { return { ok: true, value: { sessionId: session.id, reused: false } }; },
    terminalOutput: () => ({ read: () => ({ data: state.rendered, offset: state.rendered.length, startOffset: 0 }) }),
    renderTerminalSession: () => ({ text: state.rendered, redacted: false, truncated: false }),
    terminalSessionTail: () => state.rendered,
    writeTerminalSession(_session, text) { written.push(text); if (text.includes("\r")) state.rendered += "\r\nu@h:~$ "; return true; },
    attachTerminalBinding(binding) { state.attached = binding; },
    detachTerminalBinding() { state.detached = true; },
    async closeTerminalSession() { state.closed = true; session.exited = { code: 0, reason: "operator-close" }; }
  };
  return { service, state, session };
}

const makeBinding = (service, session, overrides = {}) => new SshTerminalSession({
  service,
  session,
  registryId: "pty-7",
  name: "demo",
  connectionId: "c1",
  ownerSessionId: "conv-1",
  motd: "root@h:~# ",
  ...overrides
});

// ── backend identity and subagent refusal ─────────────────────────────────
assert.equal(HARBOR_SSH_BACKEND_TYPE, "harbor-ssh");
{
  const backend = new HarborSshBackend({ service: null });
  assert.equal(backend.type, "harbor-ssh", "the registry type is stable");
  await assert.rejects(
    () => backend.spawn({ sessionId: "pty-1", type: "harbor-ssh", owner: { session: { header: { origin: "subagent" } } } }),
    new RegExp(SUBAGENT_REFUSAL.slice(0, 30)),
    "subagents are refused before any PTY is touched"
  );
}

// ── spawn publishes the PTY wrapper and its startup screen ────────────────
{
  const session = makeSession();
  const { service, state } = makeService(session, "Welcome\r\nu@h:~$ ");
  const backend = new HarborSshBackend({ service });
  const binding = await backend.spawn({ sessionId: "pty-7", type: "harbor-ssh", owner: { id: "agent-1", session: { header: { origin: "main" } } } });
  assert.equal(binding.registryId, "pty-7");
  assert.equal(binding.motd, "Welcome\r\nu@h:~$ ", "startup screen becomes the motd");
  assert.equal(state.attached, binding, "the service can find the wrapper by registry id");
  assert.equal(binding.pid, 4242, "the census pid is exposed when known");
}

// Two concurrent terminal_open calls must not publish two registry records on
// one PTY. The first spawn is held open until the second has queued; the second
// then sees the published binding and is refused instead of adopting the PTY.
{
  const session = makeSession();
  const { service } = makeService(session);
  let attached = null;
  let opened = 0;
  let releaseFirst;
  const firstOpened = new Promise((resolve) => { releaseFirst = resolve; });
  service.attachTerminalBinding = (binding) => { attached = binding; };
  service.liveAgentTerminal = () => (attached === null ? undefined : attached);
  service.openAgentTerminal = async () => {
    if (attached !== null) throw new Error("this conversation already has an SSH terminal");
    opened += 1;
    if (opened === 1) await firstOpened;
    return { session, connectionId: "c1", host: "h", reused: false };
  };
  const backend = new HarborSshBackend({ service });
  const owner = { id: "agent-1", session: { header: { origin: "main" } } };
  const first = backend.spawn({ sessionId: "pty-1", type: "harbor-ssh", owner });
  const second = backend.spawn({ sessionId: "pty-2", type: "harbor-ssh", owner });
  await new Promise((resolve) => setTimeout(resolve, 10));
  releaseFirst();
  const binding = await first;
  await assert.rejects(second, /already has an SSH terminal/);
  assert.equal(opened, 1, "the second spawn never opens a second PTY");
  assert.equal(binding.registryId, "pty-1");
  assert.equal(attached, binding, "only the first spawn publishes a binding");
}

// ── screen paging ─────────────────────────────────────────────────────────
{
  const session = makeSession();
  const { service } = makeService(session, "l1\nl2\nl3");
  const binding = makeBinding(service, session);
  const newest = binding.read({ offset: 0, count: 2 });
  assert.equal(newest.text, "l2\nl3", "newest-relative pages keep chronological order");
  assert.deepEqual([newest.totalLines, newest.lineBegin, newest.lineEnd], [3, 0, 2]);
  assert.equal(newest.truncated, true, "older lines remain");
  const older = binding.read({ offset: 2, count: 5 });
  assert.equal(older.text, "l1");
  assert.deepEqual([older.lineBegin, older.lineEnd], [2, 3]);
  assert.equal(older.truncated, false);
}

// ── send writes input and settles on the prompt ───────────────────────────
{
  const session = makeSession();
  const { service, state } = makeService(session);
  const binding = makeBinding(service, session);
  const send = binding.startSend({ text: "uptime", submit: true });
  const result = await send.done;
  assert.deepEqual(state.written, ["uptime\r"], "submit appends the carriage return");
  assert.equal(result.waitReason, "stdin_read", "a prompt settles the send");
  assert.equal(result.sessionStatus.kind, "running");
  assert.match(result.viewport, /u@h:~\$/, "the viewport carries the new prompt");
}

// ── take-over hands the PTY to the person ─────────────────────────────────
{
  const session = makeSession();
  const { service, state } = makeService(session);
  const binding = makeBinding(service, session);
  binding.markUserInput();
  assert.throws(() => binding.startSend({ text: "ls", submit: true }), new RegExp(TAKEN_OVER.slice(0, 20)));
  await assert.rejects(() => binding.signal("SIGINT"), new RegExp(TAKEN_OVER.slice(0, 20)));
  await binding.close("agent request");
  assert.equal(state.detached, true, "the registry entry is withdrawn");
  assert.equal(state.closed, false, "the person's shell keeps running");
}

// ── closing an agent-controlled terminal ends the shell ───────────────────
{
  const session = makeSession();
  const { service, state } = makeService(session);
  const binding = makeBinding(service, session);
  await binding.close("agent request");
  assert.equal(state.closed, true, "an agent terminal is closed for real");
  assert.equal(binding.status().kind, "exited");
}

// ── signals ───────────────────────────────────────────────────────────────
{
  const session = makeSession();
  const { service, state } = makeService(session);
  const binding = makeBinding(service, session);
  const interrupt = await binding.signal("SIGINT");
  assert.deepEqual(state.written, ["\u0003"], "SIGINT is the terminal's own interrupt byte");
  assert.deepEqual(interrupt, { delivered: true, targetPgid: 4242 });
  await binding.signal("SIGTERM");
  assert.equal(session.stream.lastSignal, "TERM", "other signals travel through the SSH channel");
}

// ── a command that never stops printing still settles at the deadline ──────
// Regression: the settle loop `continue`d on every new output offset, so the
// deadline was only evaluated while the terminal was silent. `yes` or
// `journalctl -f` therefore held one terminal_send open indefinitely.
{
  const session = makeSession();
  const { service, state } = makeService(session);
  let cursor = 0;
  // Output never stops: the journal offset advances on every poll.
  service.terminalJournal = () => ({ read: () => ({ data: "", offset: (cursor += 64), startOffset: 0 }) });
  service.renderTerminalSession = () => ({ text: `${state.rendered}${"x".repeat(cursor % 512)}`, redacted: false, truncated: false });
  const binding = makeBinding(service, session, { sendTimeoutMs: 120 });
  const began = Date.now();
  const result = await binding.startSend({ text: "yes", submit: true }).done;
  const elapsed = Date.now() - began;
  assert.equal(result.waitReason, "timeout", "a never-quiet command ends at the deadline instead of hanging");
  assert.ok(elapsed >= 100, `the wait reaches the deadline (${elapsed}ms)`);
  assert.ok(elapsed < 2000, `and is bounded by it (${elapsed}ms)`);
  assert.equal(
    new SshTerminalSession({ service, session, registryId: "r", name: "n", connectionId: "c1", ownerSessionId: "conv-1", motd: "" }).sendTimeoutMs,
    SEND_TIMEOUT_MS,
    "production keeps the 30s bound; the seam defaults to it"
  );
}

// ── an aborted tool call stops the send instead of waiting out the deadline ──
{
  const session = makeSession();
  const { service, state } = makeService(session);
  const binding = makeBinding(service, session, { sendTimeoutMs: 5000 });
  const controller = new AbortController();
  const send = binding.startSend({ text: "sleep 10", submit: true, signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  const began = Date.now();
  const result = await send.done;
  assert.equal(result.waitReason, "inferred_idle", "the abort settles the operation without a new contract value");
  assert.ok(Date.now() - began < 1000, "the wait does not run to the send deadline");
  assert.equal(state.written.at(-1), "\u0003", "the interrupt is still written to the PTY");
}

console.log("terminal backend: spawn, paging, sends, take-over, close and signals all passed");
