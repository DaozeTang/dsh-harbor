import assert from "node:assert/strict";
import HarborService from "../src/index.js";
import { registerSshSessionTools } from "../src/host/tools/ssh-session.js";
import { registerSftpTools } from "../src/host/tools/sftp.js";

// ask 替换确认卡片（v0.4.0）：tools/pre-execute 钩子经宿主审批通道就危险命令
// 请示操作者——allowed-once 记一次性凭证放行、rejected/cancelled/unavailable
// 一律 deny（fail-closed），工具体经 exec.callId 消费凭证过内层闸。

function makeHarness({ approval } = {}) {
  const service = Object.create(HarborService.prototype);
  service.resolveConnection = (id) => ({ ok: true, connectionId: id ?? "conn1", connection: { host: "192.0.2.10", username: "root" } });
  service.resolveExecPolicy = () => ({ mode: "standard", source: "global", allow: [] });
  service.connections = new Map();
  const gates = [];
  const ctx = {
    tools: { register: () => {} },
    on: (event, handler) => { if (event === "tools/pre-execute") gates.push(handler); },
    get: (name) => (name === "approval" ? approval : undefined)
  };
  registerSshSessionTools(ctx, service);
  const sshGate = gates[0];
  gates.length = 0;
  registerSftpTools(ctx, service);
  const sftpGate = gates[0];
  assert.equal(typeof sshGate, "function", "ssh_exec gate hook is registered");
  assert.equal(typeof sftpGate, "function", "sftp_delete gate hook is registered");
  return { service, sshGate, sftpGate };
}

const NEXT = { kind: "next-called" };
const next = () => NEXT;
const execFor = (overrides = {}) => ({
  name: "ssh_exec",
  arguments: { command: "free -h" },
  agent: { id: "agent-1" },
  callId: "call-1",
  signal: undefined,
 ...overrides
});

// ── ssh_exec gate ────────────────────────────────────────────────────────────
{
  // Safe command: no ask, straight through.
  const { service, sshGate } = makeHarness({ approval: { request: async () => { throw new Error("must not ask for safe commands"); } } });
  assert.equal(await sshGate(execFor({ arguments: { command: "free -h" } }), next), NEXT);

  // Dangerous + operator allows: voucher recorded, inner gate consumes it, and
  // the approved command runs (as the reversible trash move for literal rm).
  const executed = [];
  service.runPreparedExec = async (connectionId, prepared, displayCommand) => {
    executed.push({ connectionId, prepared, displayCommand });
    return { ok: true, value: { exitCode: 0, stdout: "moved", stderr: "", cwd: null, commandId: "x", startedAt: "t", finishedAt: "t", durationMs: 0, truncated: false, timedOut: false, redacted: false } };
  };
  let asked = null;
  const { sshGate: allowGate, service: allowService } = makeHarness({
    approval: { request: async (req) => { asked = req; return "allowed-once"; } }
  });
  allowService.runPreparedExec = service.runPreparedExec;
  const gate = await allowGate(execFor({ callId: "call-ok", arguments: { command: "rm -rf /tmp/x" } }), next);
  assert.equal(gate, NEXT, "an approved dangerous command proceeds");
  assert.equal(asked.toolName, "ssh_exec");
  assert.equal(asked.callId, "call-ok");
  assert.match(asked.reason, /AI 请求在 192\.0\.2\.10 上执行危险命令/);
  assert.match(asked.reason, /移入回收站/);
  const run = await allowService.executeCommand({ command: "rm -rf /tmp/x", approvalToken: "call-ok" });
  assert.equal(run.value.exitCode, 0);
  assert.ok(executed[0].prepared.includes(".dsh-trash"), "the reversible trash move is what runs");
  assert.equal(executed[0].displayCommand, "rm -rf /tmp/x");
  assert.equal(allowService.operatorApprovals.size, 0, "voucher consumed exactly once");

  // Dangerous + operator rejects: deny with guidance, nothing executes.
  const { sshGate: rejectGate } = makeHarness({ approval: { request: async () => "rejected" } });
  const rejected = await rejectGate(execFor({ arguments: { command: "reboot" } }), next);
  assert.equal(rejected.kind, "deny");
  assert.match(rejected.reason, /操作者拒绝/);

  // Cancelled: deny.
  const { sshGate: cancelGate } = makeHarness({ approval: { request: async () => "cancelled" } });
  const cancelled = await cancelGate(execFor({ arguments: { command: "reboot" } }), next);
  assert.equal(cancelled.kind, "deny");
  assert.match(cancelled.reason, /取消/);

  // No approval channel on the host: fail closed, never execute.
  const { sshGate: bareGate } = makeHarness({});
  const unavailable = await bareGate(execFor({ arguments: { command: "reboot" } }), next);
  assert.equal(unavailable.kind, "deny");
  assert.match(unavailable.reason, /没有可用的审批通道/);
}

// A prompt nobody answers must not suspend the tool call until the outer
// run_code/turn deadline. Harbor owns a deadline, the request signal is
// aborted, and a grant that lands afterwards is discarded.
{
  const { service, sshGate } = makeHarness({ approval: { request: () => new Promise(() => {}) } });
  service.config = { approvalPromptTimeoutMs: 25 };
  const started = Date.now();
  const result = await sshGate(execFor({ arguments: { command: "reboot" } }), next);
  assert.equal(result.kind, "deny");
  assert.match(result.reason, /审批等待超过/);
  assert.ok(Date.now() - started < 1000, "the gate returns at its own deadline");
  assert.equal(service.operatorApprovals?.size ?? 0, 0, "a timed-out ask records no voucher");
}
{
  let answer;
  const { service, sshGate } = makeHarness({ approval: { request: () => new Promise((resolve) => { answer = resolve; }) } });
  service.config = { approvalPromptTimeoutMs: 25 };
  const pending = sshGate(execFor({ arguments: { command: "reboot" } }), next);
  await new Promise((resolve) => setTimeout(resolve, 50));
  answer("allowed-once");
  const result = await pending;
  assert.equal(result.kind, "deny", "a late allow does not run the command");
  assert.match(result.reason, /审批等待超过/);
  assert.equal(service.operatorApprovals?.size ?? 0, 0);
}
{
  let seen;
  const { service, sshGate } = makeHarness({ approval: { request: (request) => { seen = request.signal; return new Promise(() => {}); } } });
  service.config = { approvalPromptTimeoutMs: 25 };
  await sshGate(execFor({ arguments: { command: "reboot" } }), next);
  assert.ok(seen?.aborted, "the approval request carries an aborted signal after the deadline");
}
{
  let asked = 0;
  const { service, sshGate } = makeHarness({ approval: { request: async () => { asked += 1; return "rejected"; } } });
  service.resolveExecPolicy = () => ({ mode: "allowAll", source: "global", allow: [], approval: "never", dsh: { ceiling: "allowAll", source: "dsh-full-access" } });
  const result = await sshGate(execFor({ arguments: { command: "reboot" } }), next);
  assert.equal(result, NEXT, "full access stands down");
  assert.equal(asked, 0, "full access does not prompt");
}
{
  let asked = 0;
  const { service, sshGate } = makeHarness({ approval: { request: async () => { asked += 1; return "allowed-once"; } } });
  service.resolveExecPolicy = () => ({ mode: "standard", source: "session", allow: [], approval: "never", dsh: { ceiling: "readOnly", source: "dsh-read-only" } });
  const result = await sshGate(execFor({ arguments: { command: "reboot" } }), next);
  assert.equal(result.kind, "deny", "read-only refuses instead of prompting");
  assert.match(result.reason, /只读模式/);
  assert.equal(asked, 0);
}

// terminal_send can split a command across calls. The gate must assess the
// completed input line on the call that submits it, not only that call's text.
{
  let asked = null;
  const { service, sshGate } = makeHarness({ approval: { request: async (request) => { asked = request; return "rejected"; } } });
  service.bindingForTerminal = (id) => id === "pty-1"
    ? { connectionId: "conn1", session: { inputLine: "r", inputKnown: true } }
    : undefined;
  const result = await sshGate(execFor({
    name: "terminal_send",
    callId: "call-split",
    arguments: { sessionId: "pty-1", text: "m -rf /tmp/x", submit: true }
  }), next);
  assert.equal(result.kind, "deny");
  assert.ok(asked !== null, "the completed line is assessed");
  assert.match(asked.reason, /rm -rf \/tmp\/x/);
}
{
  let asked = 0;
  const { service, sshGate } = makeHarness({ approval: { request: async () => { asked += 1; return "allowed-once"; } } });
  service.bindingForTerminal = (id) => id === "pty-1"
    ? { connectionId: "conn1", session: { inputLine: "rm -rf /tmp/x", inputKnown: true } }
    : undefined;
  const result = await sshGate(execFor({
    name: "terminal_send",
    callId: "call-submit",
    arguments: { sessionId: "pty-1", text: "", submit: true }
  }), next);
  assert.equal(asked, 1, "an empty submit re-checks the accumulated line");
  assert.equal(result, NEXT);
}
{
  // The mirror is unknown (history navigation, completion, an editing key):
  // there is no line to show the operator, and "allow" would submit a line the
  // gate never saw. It used to ask with the blank submit text and then run.
  let asked = 0;
  const { service, sshGate } = makeHarness({ approval: { request: async () => { asked += 1; return "allowed-once"; } } });
  service.bindingForTerminal = (id) => id === "pty-1"
    ? { connectionId: "conn1", session: { inputLine: "", inputKnown: false } }
    : undefined;
  const result = await sshGate(execFor({
    name: "terminal_send",
    callId: "call-blind",
    arguments: { sessionId: "pty-1", text: "reboot", submit: true }
  }), next);
  assert.equal(result.kind, "deny", "an unverifiable line is refused, never approved blind");
  assert.equal(asked, 0, "nothing is asked when there is no line to name");
  assert.match(result.reason, /无法验证/);
  assert.match(result.reason, /Ctrl-C/, "the reason says how to recover the shell's line");
}

// ── sftp_delete gate ─────────────────────────────────────────────────────────
{
  const { service, sftpGate } = makeHarness({ approval: { request: async (req) => { askedSftp = req; return "allowed-once"; } } });
  let askedSftp = null;
  service.connections = new Map([["conn1", { host: "192.0.2.10", username: "root" }]]);
  service.resolveRemoteToolPath = ({ connectionId, path }) => ({ connectionId: connectionId ?? "conn1", path });
  let deleted = null;
  service.runPreparedExec = async (connectionId, prepared) => {
    deleted = { connectionId, prepared };
    return { ok: true, value: { exitCode: 0, stdout: "moved", stderr: "", cwd: null, commandId: "x", startedAt: "t", finishedAt: "t", durationMs: 0, truncated: false, timedOut: false, redacted: false } };
  };
  const gate = await sftpGate(
    execFor({ name: "sftp_delete", callId: "call-sftp", arguments: { path: "/tmp/foo" } }),
    next
 );
  assert.equal(gate, NEXT, "an approved deletion proceeds");
  assert.match(askedSftp.reason, /AI 请求删除 192\.0\.2\.10 上的：/);
  assert.match(askedSftp.reason, /\/tmp\/foo/);
  assert.equal(service.operatorApprovals.get("call-sftp").command, "rm -rf '/tmp/foo'", "the voucher binds the exact quoted command");
  void deleted; // the body only deletes after its own consume; covered via safety.mjs
}

// sftp_delete follows the same DSH ceiling and deadline as ssh_exec.
{
  let asked = 0;
  const { service, sftpGate } = makeHarness({ approval: { request: async () => { asked += 1; return "rejected"; } } });
  service.resolveRemoteToolPath = ({ connectionId, path }) => ({ connectionId: connectionId ?? "conn1", path });
  service.resolveExecPolicy = () => ({ mode: "allowAll", source: "global", allow: [], approval: "never", dsh: { ceiling: "allowAll", source: "dsh-full-access" } });
  let recorded = null;
  service.recordOperatorApproval = (callId, connectionId, command) => { recorded = { callId, connectionId, command }; };
  const result = await sftpGate(execFor({ name: "sftp_delete", callId: "call-auto", arguments: { path: "/tmp/foo" } }), next);
  assert.equal(result, NEXT, "full access does not prompt before a delete");
  assert.equal(asked, 0);
  assert.equal(recorded.command, "rm -rf '/tmp/foo'", "the automatic grant still binds the exact command");
}
{
  let asked = 0;
  const { service, sftpGate } = makeHarness({ approval: { request: async () => { asked += 1; return "allowed-once"; } } });
  service.resolveRemoteToolPath = ({ connectionId, path }) => ({ connectionId: connectionId ?? "conn1", path });
  service.resolveExecPolicy = () => ({ mode: "standard", source: "session", allow: [], approval: "never", dsh: { ceiling: "readOnly", source: "dsh-read-only" } });
  const result = await sftpGate(execFor({ name: "sftp_delete", callId: "call-ro", arguments: { path: "/tmp/foo" } }), next);
  assert.equal(result.kind, "deny", "read-only refuses a delete instead of prompting");
  assert.match(result.reason, /只读模式/);
  assert.equal(asked, 0);
}
{
  const { service, sftpGate } = makeHarness({ approval: { request: () => new Promise(() => {}) } });
  service.config = { approvalPromptTimeoutMs: 25 };
  service.resolveRemoteToolPath = ({ connectionId, path }) => ({ connectionId: connectionId ?? "conn1", path });
  const result = await sftpGate(execFor({ name: "sftp_delete", callId: "call-timeout", arguments: { path: "/tmp/foo" } }), next);
  assert.equal(result.kind, "deny");
  assert.match(result.reason, /审批等待超过/);
}

console.log("ask-gate ok");
