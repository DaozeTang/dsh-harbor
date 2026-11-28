// Agent operations must be visible in the side panel, not only in the tool
// result. Every agent path funnels through touchAgentTarget: it binds the
// connection to the calling conversation, stamps activity, queues a reveal,
// and (when asked) opens this conversation's terminal so ssh_exec can mirror
// into it. These cases pin that contract at the service/tool seam.
import assert from "node:assert/strict";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import HarborService from "../../src/index.js";
import { registerSshSessionTools } from "../../src/host/tools/ssh-session.js";
import { registerSftpTools } from "../../src/host/tools/sftp.js";
import { registerStatusTools } from "../../src/host/tools/status.js";
import { listResultSchema } from "../../src/rpc/schemas.js";

function makeService() {
  const service = Object.create(HarborService.prototype);
  service.config = { maxBufferBytes: 65536, maxCommandOutputBytes: 65536, defaultReadTimeoutMs: 20 };
  service.connections = new Map();
  service.sessions = new Map();
  service.exitedSessions = new Map();
  service.operatorApprovals = new Map();
  service.activeConnectionId = null;
  service.activeConnectionByOwner = new Map();
  service.agentAutoConnect = false;
  return service;
}

function fakeStream() {
  const listeners = new Map();
  const stream = {
    writes: [],
    ended: false,
    on(event, fn) {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
      return stream;
    },
    removeListener() {},
    write(chunk) { stream.writes.push(chunk); },
    end() { stream.ended = true; },
    setWindow() {},
    emit(event, ...args) { for (const fn of listeners.get(event) ?? []) fn(...args); }
  };
  return stream;
}

function attach(service) {
  const streams = [];
  const conn = {
    id: "c1",
    host: "192.0.2.10",
    port: 22,
    username: "root",
    sessions: new Set(),
    ownerIndex: new Map(),
    agentActivityByOwner: new Map(),
    openQueue: Promise.resolve(),
    execPolicyOverrides: new Map(),
    dead: false,
    closing: false,
    connecting: false,
    connectConfig: { host: "192.0.2.10", port: 22 },
    client: {
      shell(_opts, callback) {
        const stream = fakeStream();
        streams.push(stream);
        queueMicrotask(() => callback(null, stream));
        return stream;
      }
    }
  };
  service.connections.set("c1", conn);
  return { conn, streams };
}

const execution = { agent: { id: "conv-a", session: { header: { id: "conv-a" } } } };

function toolsFor(register, service) {
  const tools = [];
  register({ tools: { register: (tool) => tools.push(tool) } }, service);
  return tools;
}

function execValue(overrides = {}) {
  return {
    connectionId: "c1",
    host: "192.0.2.10",
    exitCode: 0,
    stdout: "ok\n",
    stderr: "",
    cwd: "/home/tangdz",
    commandId: "cmd-1",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 1,
    truncated: false,
    timedOut: false,
    redacted: false,
    ...overrides
  };
}

// ── the visibility contract itself ─────────────────────────────────────────
{
  const service = makeService();
  const { conn, streams } = attach(service);
  const first = await service.touchAgentTarget({ connectionId: "c1", ownerSessionId: "conv-a", kind: "connect", ensureTerminal: true });
  assert.equal(first.ok, true, first.error?.message);
  assert.equal(typeof first.value.panelTerminalId, "string", "the conversation gets a panel terminal");
  assert.equal(conn.sessions.size, 1);
  assert.equal(streams.length, 1);
  assert.equal(conn.agentRevealOwnerSessionId, "conv-a", "the reveal is scoped to the caller");
  assert.equal(typeof conn.agentRevealId, "string");
  assert.equal(conn.agentActivityByOwner.get("conv-a").kind, "connect");

  const listed = await service.list({ sessionId: "conv-a" });
  assert.equal(listed.ok, true);
  assert.equal(listed.value.connections[0].agentActive, true, "the panel can show agent activity");
  assert.equal(listed.value.connections[0].agentActivityKind, "connect");
  assert.match(listed.value.connections[0].agentLastActivityAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(listResultSchema.safeParse(listed).success, true, "the activity fields satisfy the strict wire schema");

  const reveal = conn.agentRevealId;
  const second = await service.touchAgentTarget({ connectionId: "c1", ownerSessionId: "conv-a", kind: "exec", ensureTerminal: true });
  assert.equal(second.ok, true);
  assert.equal(conn.sessions.size, 1, "a second operation reuses the terminal");
  assert.equal(conn.agentRevealId, reveal, "one conversation is revealed once, not on every poll");

  const foreign = await service.touchAgentTarget({ connectionId: "c1", ownerSessionId: "conv-b", kind: "sftp", ensureTerminal: false });
  assert.equal(foreign.ok, true);
  assert.equal(conn.agentRevealOwnerSessionId, "conv-b", "a second conversation gets its own reveal");
  assert.notEqual(conn.agentRevealId, reveal);
  assert.equal(conn.sessions.size, 1, "a reveal-only operation does not force a terminal");
}

// ── ssh_connect opens the terminal and promises it in the result ───────────
{
  const service = makeService();
  const { conn, streams } = attach(service);
  service.connect = async (request) => {
    assert.equal(request.sessionId, "conv-a", "the connection is bound to the caller");
    return { ok: true, value: { connectionId: "c1", host: "192.0.2.10", port: 22, username: "root" } };
  };
  const tools = toolsFor(registerSshSessionTools, service);
  const tool = tools.find((entry) => entry.name === "ssh_connect");
  const value = await tool.execute({ host: "192.0.2.10", port: 22, username: "root", auth: { kind: "password", password: "x" } }, execution);
  assert.equal(value.terminalOpened, true, "ssh_connect opens a panel terminal for visibility");
  assert.equal("terminalSessionId" in value, false, "the raw panel id is not exposed as a terminal_send target");
  assert.equal(conn.sessions.size, 1);
  assert.equal(streams.length, 1);
  assert.equal(conn.agentRevealOwnerSessionId, "conv-a");
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value, "value"), [], "the new terminal fields satisfy the tool output schema");
}

// ── ssh_exec ensures a terminal and mirrors through the resolved target ────
{
  const service = makeService();
  const { streams } = attach(service);
  const calls = [];
  service.executeCommand = async (request) => {
    calls.push(request);
    return { ok: true, value: execValue() };
  };
  const tools = toolsFor(registerSshSessionTools, service);
  const tool = tools.find((entry) => entry.name === "ssh_exec");
  const first = await tool.execute({ command: "echo hi" }, execution);
  assert.equal(first.exitCode, 0);
  assert.equal(streams.length, 1, "the first exec opened this conversation's terminal");
  assert.equal(calls[0].connectionId, "c1");
  assert.equal(calls[0].sessionId, "conv-a");
  const second = await tool.execute({ command: "echo again" }, execution);
  assert.equal(second.exitCode, 0);
  assert.equal(streams.length, 1, "the second exec reuses the terminal");
  assert.equal(calls.length, 2);
}

// ── a refused PTY warns but does not fail the command ──────────────────────
{
  const service = makeService();
  attach(service);
  service.ensureSessionForWrite = async () => ({ ok: false, error: { code: "terminal-limit", message: "sshd MaxSessions reached" } });
  let ran = false;
  service.executeCommand = async () => { ran = true; return { ok: true, value: execValue() }; };
  const tools = toolsFor(registerSshSessionTools, service);
  const tool = tools.find((entry) => entry.name === "ssh_exec");
  const value = await tool.execute({ command: "echo hi" }, execution);
  assert.equal(ran, true, "the exec still runs when the terminal cannot open");
  assert.match(value.warning, /MaxSessions/, "the operator-facing warning names the reason");
}

// ── file and status operations reveal the server without forcing a PTY ────
{
  const service = makeService();
  const { conn, streams } = attach(service);
  service.resolveRemoteToolPath = async () => ({ connectionId: "c1", path: "/tmp" });
  service.sftpList = async () => ({ ok: true, value: { path: "/tmp", entries: [] } });
  const sftp = toolsFor(registerSftpTools, service).find((entry) => entry.name === "sftp_list");
  await sftp.execute({ path: "/tmp" }, execution);
  assert.equal(conn.agentRevealOwnerSessionId, "conv-a", "sftp_list reveals the server");
  assert.equal(conn.sessions.size, 0, "sftp_list does not force a terminal");
  assert.equal(streams.length, 0);
  assert.equal(conn.agentActivityByOwner.get("conv-a").kind, "sftp");

  service.systemStats = async () => ({ ok: true, value: {} });
  const status = toolsFor(registerStatusTools, service).find((entry) => entry.name === "ssh_status");
  await status.execute({}, execution);
  assert.equal(conn.agentActivityByOwner.get("conv-a").kind, "status");
  assert.equal(conn.sessions.size, 0, "status is reveal-only too");
}

console.log("agent visibility: connect/exec/sftp/status reach the panel; exec has a mirror terminal");
