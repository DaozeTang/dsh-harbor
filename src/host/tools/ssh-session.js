/**
 * Agent tools for the SSH transport lifecycle: list, connect, exec, disconnect.
 * They drive the same connections the right-side panel shows; interactive
 * terminals are the host's persistent-terminal tools (backend type
 * `harbor-ssh`), so this file no longer defines read/write tools.
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { assessShellCommand, CATEGORY_DELETE_FILES } from "../safety.js";
import { parseSimpleDeleteCommand } from "../trash.js";
import { t } from "../../i18n/core.js";
import { OPERATOR_APPROVAL_TIMEOUT_MS } from "../service/constants.js";
import { processTerminalInput } from "../terminal-input.js";

/** Human name for an execution-policy tier, for agent-facing notices. */
export function execPolicyLabel(mode) {
  if (mode === "custom") return t("自定义放行");
  if (mode === "allowAll") return t("全部放行");
  return t("标准");
}

/** Whole seconds a prompt waits before Harbor withdraws it, for operator-facing copy. */
export function approvalTimeoutSeconds(timeoutMs) {
  const value = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : OPERATOR_APPROVAL_TIMEOUT_MS;
  return Math.max(1, Math.round(value / 1000));
}

/**
 * Assess one terminal_send against the command that will actually be
 * submitted, not only the fragment in this call.
 *
 * The official terminal tool writes text into the PTY; an agent can split a
 * command across calls (type "r", then "m -rf ...", then Enter). Screening only
 * the current text would let the completed line bypass the deny-list. The
 * session's input mirror already tracks the operator/agent line, so simulate
 * this text against a clone of that mirror and decide every Enter it contains.
 * A text without Enter is allowed to type (it cannot execute yet); the later
 * submit call re-checks the accumulated line.
 *
 * @param {object|undefined} binding - Harbor's terminal binding for the registry session.
 * @param {string} text - this terminal_send call's text.
 * @param {object} policy - the resolved Harbor/DSH policy.
 * An unknown mirror is reported as `unverified`, never as a blank line: this
 * Enter would submit a line nobody can name, so the caller must deny instead of
 * asking the operator to approve " ".
 *
 * @returns {{ok: boolean, reason?: string, category?: string, line?: string|null, unverified?: boolean}}
 */
export function assessTerminalSend(binding, text, policy) {
  const session = binding?.session;
  if (session === undefined || typeof text !== "string") return assessShellCommand(text, policy);
  const simulated = {
    inputLine: typeof session.inputLine === "string" ? session.inputLine : "",
    inputKnown: session.inputKnown !== false
  };
  let blocked = null;
  const { blockedReason } = processTerminalInput(simulated, text, (line) => {
    const decision = assessShellCommand(line, policy);
    if (!decision.ok && blocked === null) blocked = { ...decision, line };
    return decision;
  });
  if (blocked !== null) return blocked;
  if (blockedReason !== null) return { ok: false, reason: blockedReason, line: null, unverified: true };
  return { ok: true };
}

/**
 * Ask the operator through the host's approval channel. Returns the raw
 * outcome ("allowed-once" | "rejected" | "cancelled" | "unavailable") plus
 * whether Harbor's own deadline ended the wait, and degrades to "unavailable"
 * whenever the host composes no approval service, exposes none to plugins, or
 * the call has no agent to route the prompt to — fail-closed in every
 * direction.
 *
 * DSH deliberately gives approvals no TTL: the request waits until an answerer
 * decides or the caller's signal aborts. A tool call must not inherit that
 * unbounded wait, so this seam owns a deadline. It aborts the request signal,
 * which makes the approval service settle "cancelled" and makes the DSH
 * Gateway withdraw the browser card; a late "allowed-once" that races the
 * deadline is still reported as a timeout and never grants the command.
 *
 * @param ctx - host context carrying the optional approval service.
 * @param execution - the tool execution being gated.
 * @param reason - operator-facing explanation of the command.
 * @param timeoutMs - deadline in milliseconds; defaults to the shared constant.
 * @returns the outcome and whether the deadline (not an answer) ended the ask.
 */
export async function askOperatorApproval(ctx, execution, reason, timeoutMs = OPERATOR_APPROVAL_TIMEOUT_MS) {
  let approval;
  try { approval = ctx.get("approval"); } catch { approval = undefined; }
  if (approval === undefined || execution?.agent === undefined || execution?.callId === undefined) {
    return { outcome: "unavailable", timedOut: false };
  }
  if (execution.signal?.aborted) return { outcome: "cancelled", timedOut: false };
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : OPERATOR_APPROVAL_TIMEOUT_MS;
  const deadline = new AbortController();
  const signal = execution.signal === undefined
    ? deadline.signal
    : AbortSignal.any([execution.signal, deadline.signal]);
  // The race is the guarantee, not just the signal: a deployment whose
  // approval answerer never settles on abort must not suspend the tool call.
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => {
      deadline.abort(new Error("approval prompt timed out"));
      resolve({ outcome: "cancelled", timedOut: true });
    }, limit);
  });
  const answer = Promise.resolve()
    .then(() => approval.request({
      agent: execution.agent,
      toolName: execution.name,
      callId: execution.callId,
      reason,
      signal
    }))
    .then(
      (outcome) => ({ outcome: typeof outcome === "string" ? outcome : "unavailable", timedOut: false }),
      () => ({ outcome: "unavailable", timedOut: false })
    );
  try {
    const settled = await Promise.race([answer, expired]);
    // A timer that fired while the answer was landing still wins the security
    // decision: a grant that arrives at the deadline must not run the command.
    return deadline.signal.aborted
      ? { outcome: "cancelled", timedOut: true }
      : settled;
  } finally {
    clearTimeout(timer);
  }
}

export function registerSshSessionTools(ctx, service) {
  // Dangerous-command gate for every agent path that types on a remote host:
  // ssh_exec, and the host's terminal_send when it targets a Harbor SSH
  // terminal. The tools/pre-execute waterfall evaluates the exact policy the
  // exec path enforces and, when the command is deny-listed, suspends the whole
  // call on the host's approval channel — the agent cannot act, retry, or route
  // around while the operator decides. ssh_exec on "allow" records a one-shot
  // voucher (callId -> connection + command) that its body consumes past the
  // inner gate; terminal_send needs none because the write itself is the call.
  // No approval channel at all degrades to deny, never to execute.
  if (typeof ctx.on === "function") ctx.on("tools/pre-execute", (execution, next) => {
    const name = execution?.name;
    if (name !== "ssh_exec" && name !== "terminal_send") return typeof next === "function" ? next() : undefined;
    return (async () => {
      const command = typeof execution.arguments?.command === "string"
        ? execution.arguments.command
        : typeof execution.arguments?.text === "string" ? execution.arguments.text : "";
      // The gate must evaluate the tier in force for THIS conversation: the
      // operator's per-connection switch is keyed by conversation now, so a
      // relaxed gate in one chat cannot pre-approve another chat's command.
      const ownerSessionId = service.terminalOwner?.(execution.agent);
      let target;
      if (name === "terminal_send") {
        // Only Harbor's own registry sessions are gated here; local shells and
        // unknown ids stay with whatever gate the host's terminal plugin has.
        const binding = service.bindingForTerminal?.(execution.arguments?.sessionId);
        if (binding === undefined) return typeof next === "function" ? next() : undefined;
        target = { connectionId: binding.connectionId, connection: service.connections?.get(binding.connectionId), binding };
      } else {
        target = service.resolveConnection(execution.arguments?.connection_id, ownerSessionId);
        if (!target.ok) return typeof next === "function" ? next() : undefined; // no target: let the tool report the honest error
      }
      const policy = service.resolveExecPolicy(target.connectionId, ownerSessionId);
      // A terminal_send may be only a fragment of a line the agent has already
      // typed. Assess the accumulated input line that this call will submit,
      // not just the fragment, or split sends could bypass the deny-list.
      const sentText = name === "terminal_send" && execution.arguments?.submit !== false
        ? `${command}\r`
        : command;
      const decision = target.binding !== undefined
        ? assessTerminalSend(target.binding, sentText, policy)
        : assessShellCommand(command, policy);
      const assessedCommand = decision.line ?? command;
      if (decision.ok) return typeof next === "function" ? next() : undefined;
      // The mirror cannot say what this Enter submits (history navigation,
      // completion, an editing key). There is nothing to show the operator, and
      // an "allow" would submit the hidden line — so this fails closed instead
      // of asking. Ctrl-C resets the shell's line and the mirror with it.
      if (decision.unverified === true) {
        return {
          kind: "deny",
          reason: t("终端当前行无法验证（此前出现过方向键、补全或行编辑键），无法判断这次回车会提交什么，命令未执行。可先向该终端发送 Ctrl-C（^C）清空当前行，或让操作者在终端里回车后重试。")
        };
      }
      // The DSH session mode can be read-only, or its approval policy can be
      // "never". Neither leaves a channel to ask: return the reason directly
      // instead of calling approval.request() just to receive an immediate
      // "rejected" that looks like a human refusal.
      if (policy.approval === "never") {
        return {
          kind: "deny",
          reason: policy.dsh?.ceiling === "readOnly"
            ? t("本次对话处于 DSH 只读模式，危险命令未执行。请勿重试或绕行；如确需执行，请让操作者在 DSH 权限选择器中切换模式。")
            : t("本次对话的 DSH 审批策略已关闭（never），无法请求授权，危险命令未执行。请勿重试；如确需执行，请让操作者在 DSH 权限选择器中切换模式，或直接在终端执行。")
        };
      }
      let trashNote = "";
      if (decision.category === CATEGORY_DELETE_FILES && parseSimpleDeleteCommand(assessedCommand)) {
        trashNote = t("（批准后实际执行的是移入回收站的可逆操作，不会真删）");
      }
      const host = target.connection?.host ?? "";
      const timeoutMs = service.config?.approvalPromptTimeoutMs ?? OPERATOR_APPROVAL_TIMEOUT_MS;
      const seconds = approvalTimeoutSeconds(timeoutMs);
      const reason = t(`AI 请求在 ${host} 上执行危险命令，已被执行策略（${execPolicyLabel(policy.mode)}）拦截：\n${assessedCommand}\n风险类别：${t(decision.category ?? decision.reason)}${trashNote}\n批准=本次执行；拒绝=命令不会运行。`) + "\n\n" + t(`本次确认等待 ${seconds} 秒；超时未选择将自动拒绝，命令不会执行。`);
      const { outcome, timedOut } = await askOperatorApproval(ctx, execution, reason, timeoutMs);
      if (timedOut) {
        return {
          kind: "deny",
          reason: t(`审批等待超过 ${seconds} 秒，危险命令未执行。请勿自动重试；如仍需执行，请让操作者在提示出现时选择，或直接在终端执行。`)
        };
      }
      if (outcome === "allowed-once") {
        if (name === "ssh_exec") service.recordOperatorApproval(execution.callId, target.connectionId, command);
        return typeof next === "function" ? next() : undefined;
      }
      if (outcome === "rejected") {
        return { kind: "deny", reason: t(`操作者拒绝了该危险命令（${assessedCommand}）。请勿重试或换写法绕行；如确需执行，请让操作者自行在终端运行，或请其调整右侧面板的执行策略。`) };
      }
      if (outcome === "cancelled") {
        return { kind: "deny", reason: t("危险命令的确认被取消，命令未执行。请勿重试；如确需执行请与操作者确认。") };
      }
      return { kind: "deny", reason: t(`该命令属于危险操作（${t(decision.category ?? decision.reason)}），必须由操作者确认，但当前宿主没有可用的审批通道，命令未执行。请勿重试或绕行；请操作者直接在终端手动执行。`) };
    })();
  });


  ctx.tools.register(defineTool({
    name: "ssh_list",
    description: "List currently open SSH connections and identify the active server. This reports only live connection metadata (name, host, port, username and active state); it never returns credentials. When the operator enabled AI auto-connect in Harbor's settings, the result also lists the operator's saved SSH resources (name, host, username, whether already connected) — connect one with ssh_connect_profile. Use this tool when the user asks which server is connected or which saved servers exist. For an interactive shell call terminal_open with type \"harbor-ssh\" (and terminal_list for open sessions); for one-shot commands ssh_exec targets the active connection automatically.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          activeConnectionId: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
          connections: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                connectionId: { type: "string", required: true },
                name: { type: "string" },
                host: { type: "string", required: true },
                port: { type: "integer", required: true },
                username: { type: "string", required: true },
                connected: { type: "boolean", required: true },
                sessions: { type: "array", required: true, items: { type: "string" } },
                terminals: {
                  type: "array",
                  required: true,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      sessionId: { type: "string", required: true },
                      ownerSessionId: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
                      openedBy: { type: "string", enum: ["panel", "agent"], required: true },
                      alive: { type: "boolean", required: true },
                      mine: { type: "boolean", required: true }
                    }
                  }
                },
                agentSession: { type: "boolean" },
                agentSessionMine: { type: "boolean" },
                agentRevealId: { type: "string" },
                agentRevealOwnerSessionId: { type: "string" },
                agentActive: { type: "boolean" },
                agentLastActivityAt: { type: "string" },
                agentActivityKind: { type: "string" }
              }
            }
          },
          resources: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                profileId: { type: "string", required: true },
                name: { type: "string", required: true },
                host: { type: "string", required: true },
                port: { type: "integer", required: true },
                username: { type: "string", required: true },
                connected: { type: "boolean", required: true }
              }
            }
          }
        }
      },
      render(_args, value) {
        const lines = [];
        // "terminal open" means THIS conversation's terminal: another chat's
        // live shell on the same server is reported separately, because the
        // agent can neither read nor write it.
        const mine = (connection) => (connection.terminals ?? []).filter((terminal) => terminal.mine && terminal.alive);
        const otherCount = (connection) => (connection.terminals ?? []).filter((terminal) => !terminal.mine && terminal.alive).length;
        if (value.connections.length === 0) lines.push("No SSH connection is currently open.");
        else lines.push(...value.connections.map((connection) => {
          const others = otherCount(connection);
          const own = mine(connection);
          // Naming the session id saves the agent a terminal_list round trip
          // and makes "the terminal already exists" explicit after ssh_connect.
          const terminalNote = own.length > 0 ? ` (your terminal open: ${own[0].sessionId}${own.length > 1 ? ` +${own.length - 1}` : ""})` : "";
          return `${connection.connectionId === value.activeConnectionId ? "* " : "- "}${connection.name ?? connection.host}: ${connection.username}@${connection.host}:${connection.port}${terminalNote}${others ? ` (+${others} terminal${others === 1 ? "" : "s"} in other conversations)` : ""}`;
        }));
        if (value.resources !== undefined) {
          lines.push("");
          lines.push(value.resources.length === 0
            ? t("Saved SSH resources: none saved yet — the operator can add servers in 设置 → SSH 资源.")
 : `Saved SSH resources (connectable via ssh_connect_profile): ${value.resources.map((resource) => `${resource.name} → ${resource.username}@${resource.host}:${resource.port}${resource.connected ? " [connected]" : ""}`).join("; ")}`);
        }
        return [{ type: "text", text: lines.join("\n") }];
      }
    },
    async execute(_args, exec) {
      const result = await service.list({ sessionId: service.terminalOwner?.(exec?.agent) ?? undefined });
      if (!result.ok) throw new Error(`ssh_list failed: ${result.error.message}`);
      return result.value;
    }
  }));

  ctx.tools.register(defineTool({
    name: "ssh_connect",
    description: "Connect to a remote server over SSH, open it in Harbor's side panel, and make it the current connection for later SSH tools. This also opens THIS conversation's terminal on the new connection, so ssh_exec output is visible in the panel; use terminal_list to get its session id and terminal_send/read to type in it. Do not call terminal_open just to regain this terminal unless the user took it over or you need a second shell.",
    parameters: {
      host: { type: "string", required: true, description: "Remote hostname or IP address." },
      port: { type: "integer", description: "SSH port, defaults to 22." },
      username: { type: "string", required: true, description: "SSH username." },
      auth: {
        type: "object",
        required: true,
        additionalProperties: false,
        description: "Authentication. Either {kind: 'password', password} or {kind: 'key', privateKey, passphrase?}.",
        properties: {
          kind: { type: "string", enum: ["password", "key"], required: true },
          password: { type: "string" },
          privateKey: { type: "string" },
          passphrase: { type: "string" }
        }
      },
      legacy: { type: "boolean", description: "Only for old network devices (Huawei legacy VRP e.g. S12712, some old IOS/Comware) that offer no modern SSH key exchange. Omit it and the plugin retries automatically once if the handshake fails on key-exchange selection, returning legacyFallback. Pass true to use the legacy algorithm set immediately, or false to forbid the automatic retry." },
      name: { type: "string", description: "Optional display name for this connection." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          connectionId: { type: "string", required: true },
          name: { type: "string" },
          host: { type: "string", required: true },
          port: { type: "integer", required: true },
          username: { type: "string", required: true },
          legacyFallback: { type: "boolean" },
          bannerRepair: { type: "boolean" },
          terminalOpened: { type: "boolean" },
          terminalSessionId: { type: "string" },
          terminalWarning: { type: "string" },
          warning: { type: "string" }
        }
      },
      render(args, value) {
        const conn = value ?? {};
        const base = `Connected ${args.username}@${args.host} (id: ${conn.connectionId ?? "?"})`;
        // Anything unusual about the handshake must be visible in the tool
        // result, not only in the host log — a weakened transport or a rewritten
        // banner is something the operator has to know about to act on it.
        const terminal = conn.terminalSessionId
          ? `\nHarbor is showing this conversation's terminal (${conn.terminalSessionId}); use terminal_send/terminal_read with that id.`
          : conn.terminalOpened === false && conn.terminalWarning
            ? `\nThe connection is open, but the side-panel terminal could not be opened: ${conn.terminalWarning}`
            : "";
        const warning = conn.warning ? `\n⚠️ ${conn.warning}` : "";
        return [{ type: "text", text: base + terminal + warning }];
      }
    },
    async execute(args, exec) {
      const ownerSessionId = service.terminalOwner?.(exec?.agent) ?? undefined;
      const result = await service.connect({
        host: args.host,
        port: args.port,
        username: args.username,
        auth: args.auth,
        legacy: args.legacy,
        name: args.name,
        sessionId: ownerSessionId
      });
      if (!result.ok) throw new Error(`ssh_connect failed: ${result.error.message}`);
      // A raw connect used to leave the sidebar blind: no terminal, no reveal.
      // Open the conversation's terminal and let the panel show the machine.
      const visibility = await service.touchAgentTarget?.({
        connectionId: result.value.connectionId,
        ownerSessionId,
        kind: "connect",
        ensureTerminal: true
      });
      const value = { ...result.value };
      if (visibility?.ok === true) {
        const sessionId = visibility.value?.terminalSessionId;
        value.terminalOpened = sessionId !== undefined;
        if (sessionId !== undefined) value.terminalSessionId = sessionId;
        if (visibility.value?.warning !== undefined) value.terminalWarning = visibility.value.warning;
      } else {
        value.terminalOpened = false;
        if (visibility?.error?.message !== undefined) value.terminalWarning = visibility.error.message;
      }
      return value;
    }
  }));

  ctx.tools.register(defineTool({
    name: "ssh_connect_profile",
    description: "Connect to one of the operator's saved SSH resources by name (Settings → Harbor) and make it the active connection: later ssh_exec and terminal tools without connection_id target it for THIS conversation, and a terminal owned by this conversation opens in the right-side panel so the operator can see which machine you are on. Use terminal_list to get that terminal's session id and terminal_send/terminal_read to work in it; do not call terminal_open just to regain it. Only works when the operator enabled AI auto-connect in Harbor's settings; with the switch off the call fails — then ask the operator to connect the server, and NEVER fall back to ssh_connect with credentials you gathered from conversation. Reuses an already-open connection for the same resource instead of connecting twice.",
    parameters: {
      resource: { type: "string", required: true, description: "The saved resource's name as shown by ssh_list (e.g. 'dev', 'prod'), or its profile id. A unique partial name is accepted; unknown or ambiguous names fail with the list of available resources." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          connectionId: { type: "string", required: true },
          profileId: { type: "string", required: true },
          name: { type: "string", required: true },
          host: { type: "string", required: true },
          port: { type: "integer", required: true },
          username: { type: "string", required: true },
          reused: { type: "boolean", required: true },
          terminalOpened: { type: "boolean", required: true },
          warning: { type: "string" }
        }
      },
      render(_args, value) {
        const base = t(`已连接保存的服务器「${value.name}」（${value.username}@${value.host}:${value.port}，id: ${value.connectionId}），并已设为当前 SSH 连接，后续 ssh_exec 等工具默认作用于这台机器。${value.reused ? t("复用了该服务器已有的连接。") : ""}${value.terminalOpened ? t("已为它打开终端会话（可在右侧 SSH 面板查看该机器）。") : ""}`);
        return [{ type: "text", text: value.warning ? `${base}\n⚠️ ${value.warning}` : base }];
      }
    },
    async execute(args, exec) {
      const result = await service.agentConnectProfile({ resource: args.resource, sessionId: service.terminalOwner?.(exec?.agent) ?? undefined });
      if (!result.ok) throw new Error(`ssh_connect_profile failed: ${result.error.message}`);
      return result.value;
    }
  }));

  ctx.tools.register(defineTool({
    name: "ssh_exec",
    description: "Run a normal SSH command on the server currently open in the right-side SSH terminal and return its output. This runs one non-interactive command and returns when it finishes; command output is mirrored into YOUR conversation's terminal, not into other chats'. If this conversation has no terminal on the target, one is opened automatically so the operator can see the command and its output in Harbor. Tasks that need terminal interaction — switching users (sudo -i / su), entering a container (docker exec -it), or connecting onward to another machine (ssh) — do not fit here; use terminal_send in the conversation's terminal instead. Omit connection_id when the user means the current server; do not call ssh_list first. On Linux/POSIX hosts the dedicated exec channel starts in YOUR conversation's terminal's verified current directory. A busy or ambiguous terminal falls back to the login directory (the result's first line reports the cwd actually used); a terminal whose directory cannot be read rejects the command instead of guessing. SSH configuration, package changes, service reloads, and config edits are allowed and remain subject to DSH permissions. Explicitly destructive or irreversible commands follow the conversation's DSH permission mode: a Harbor approval prompt waits 120 seconds and then refuses; under Auto review or full access the session's own gate applies; read-only refuses them. Never retry or route around a refusal. The command and output are also shown in the terminal panel.",
    parameters: {
      connection_id: { type: "string", description: "Optional. Omit to target the current right-side SSH connection." },
      command: { type: "string", required: true, description: "The shell command to execute." },
      timeout_ms: { type: "integer", description: "Timeout in milliseconds, defaults to 30000." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          connectionId: { type: "string", required: true },
          host: { type: "string", required: true },
          exitCode: { oneOf: [{ type: "integer" }, { type: "null" }], required: true },
          stdout: { type: "string", required: true },
          stderr: { type: "string", required: true },
          cwd: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
          commandId: { type: "string", required: true },
          startedAt: { type: "string", required: true },
          finishedAt: { type: "string", required: true },
          durationMs: { type: "integer", required: true },
          truncated: { type: "boolean", required: true },
          timedOut: { type: "boolean", required: true },
          redacted: { type: "boolean", required: true },
          blocked: { type: "boolean" },
          reason: { type: "string" },
          command: { type: "string" },
          policy: { type: "string" },
          policySource: { type: "string" },
          policyBasis: { type: "string" },
          // Set when the connection is visible but its terminal could not be
          // opened; the exec itself still succeeded.
          warning: { type: "string" },
          // Present when an approved delete ran through the reversible trash
          // rewrite: one entry per target with its outcome.
          trashed: { type: "array", items: { type: "object", additionalProperties: true } }
        }
      },
      render(args, value) {
        if (value.blocked) {
          const tierNote = value.policy
            ? "\n" + t(`当前连接执行策略：${execPolicyLabel(value.policy)}${value.policySource === "session" ? t("（操作者本次会话内切换）") : ""}。若操作者希望放开此类命令，请其自行在右侧面板的策略开关中调整；请勿重试。`)
 : "";
          return [{ type: "text", text: t(`⚠️ 已拦截：${value.reason ?? ""}\n命令未执行。危险命令必须由操作者确认，本次调用没有获得批准（操作者拒绝，或宿主没有可用的审批通道）。\n\`\`\`bash\n${value.command ?? ""}\n\`\`\`\n请勿重试或换写法绕行；把命令交给操作者自行执行，或请其调整执行策略。`) + tierNote }];
        }
        const out = value.stdout ?? "";
        const err = value.stderr ?? "";
        let body = out;
        if (err.length > 0) {
          if (body.length > 0 && !body.endsWith("\n")) body += "\n";
          body += `[stderr]\n${err}`;
        }
        if (body.length === 0) body = "(no output)";
        if (value.exitCode !== null && value.exitCode !== 0) body += `\n[exit code: ${value.exitCode}]`;
        if (value.timedOut) body += "\n[command timed out]";
        if (value.truncated) body += "\n[output truncated for safe model context]";
        if (value.redacted) body += "\n[sensitive values redacted]";
        if (value.warning) body += `\n[side-panel terminal unavailable] ${value.warning}`;
        if (Array.isArray(value.trashed) && value.trashed.length > 0) {
          const lines = value.trashed.map((entry) => entry.status === "moved"
            ? t(`${entry.original} → 回收站 ${entry.trashPath ?? ""}`)
            : t(`${entry.original} → 未处理（${entry.status}）`));
          body += `\n[trash]\n${lines.join("\n")}`;
        }
        // Where the command ran. First line, so relative-path output always
        // has its context above it; null spells out the home fallback.
        const cwdNote = value.cwd
          ? `[cwd: ${value.cwd}]`
 : "[cwd: login directory — no interactive shell directory detected]";
        return [{ type: "text", text: `${cwdNote}\n${body}` }];
      }
    },
    async execute(args, exec) {
      const ownerSessionId = service.terminalOwner?.(exec?.agent) ?? undefined;
      // Visibility first: bind the connection, stamp activity, and open THIS
      // conversation's terminal if it has none, so runPreparedExec has a place
      // to mirror the command and output. A refused PTY must not fail the exec.
      const visibility = await service.touchAgentTarget?.({
        connectionId: args.connection_id,
        ownerSessionId,
        kind: "exec",
        ensureTerminal: true
      });
      if (visibility?.ok === false) throw new Error(`ssh_exec failed: ${visibility.error.message}`);
      const connectionId = visibility?.value?.connectionId ?? args.connection_id;
      const result = await service.executeCommand({
        // Use the connection the visibility step resolved, so a second
        // connection cannot appear between resolution and the exec.
        connectionId,
        command: args.command,
        timeoutMs: args.timeout_ms ?? 30000,
        sessionId: ownerSessionId,
        // The pre-execute gate records its voucher under the execution id;
        // the inner gate consumes it so an operator-approved command runs.
        approvalToken: exec?.callId
      });
      if (!result.ok) throw new Error(`ssh_exec failed: ${result.error.message}`);
      const value = result.value;
      if (visibility?.value?.warning !== undefined) value.warning = visibility.value.warning;
      return value;
    }
  }));



  ctx.tools.register(defineTool({
    name: "ssh_disconnect",
    description: "Close the current SSH connection and any open shell sessions on it. Omit connection_id for the current right-side SSH server.",
    parameters: {
      connection_id: { type: "string", description: "Optional. Omit to target the current right-side SSH connection." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          disconnected: { type: "boolean", required: true }
        }
      },
      render(args, value) {
        return [{ type: "text", text: value.disconnected ? "Disconnected." : "Connection not found." }];
      }
    },
    async execute(args, exec) {
      const result = await service.disconnectCurrentConnection({ connectionId: args.connection_id, sessionId: service.terminalOwner?.(exec?.agent) ?? undefined });
      if (!result.ok) throw new Error(`ssh_disconnect failed: ${result.error.message}`);
      return result.value;
    }
  }));
}
