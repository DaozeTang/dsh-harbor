/**
 * Agent tools for SSH port forwarding.
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { t } from "../../i18n/core.js";
import { OPERATOR_APPROVAL_TIMEOUT_MS } from "../service/constants.js";
import { normalizeBindAddress } from "../service/tunnels.js";
import { askOperatorApproval, approvalTimeoutSeconds } from "./ssh-session.js";

/**
 * Loopback spellings a bind address can arrive as. An empty value means "not
 * given" and resolves to 127.0.0.1 — through the SAME normalizer the service
 * applies before listen(), so the address this gate judges is the address that
 * will actually be bound.
 *
 * @param {unknown} value - bind_addr as the model sent it.
 * @returns {boolean} whether the address is reachable only from this host.
 */
export function isLoopbackBindAddress(value) {
  const raw = normalizeBindAddress(value).toLowerCase();
  const host = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1" || host === "::ffff:127.0.0.1") return true;
  const v4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return v4 !== null && v4.slice(1).every((part) => Number(part) <= 255);
}

/**
 * What a forward request exposes, or null when it stays inside the loopback
 * pair.
 *
 * `ssh -L`/`-D` bound to 127.0.0.1 is reachable only from the DSH host
 * itself, so the model gains no reach the person did not already grant. Any
 * other bind address puts a listener on the network, and a remote forward
 * inverts the direction entirely: the SERVER — and whatever can reach it — gets
 * a port that leads back into this host. Those are the operator's decision, so
 * the tool suspends on the approval channel before any socket exists.
 *
 * @param {object} args - tunnel_start arguments.
 * @returns {null|{kind: string, listen: string, target?: string}}
 */
export function assessTunnelExposure(args) {
  const kind = args?.kind === "remote" || args?.kind === "dynamic" ? args.kind : "local";
  if (kind === "remote") {
    const listen = normalizeBindAddress(args?.remote_host ?? args?.bind_addr);
    const targetHost = normalizeBindAddress(args?.target_host);
    return { kind, listen, target: `${targetHost}:${args?.target_port ?? "?"}` };
  }
  const address = normalizeBindAddress(args?.bind_addr);
  if (isLoopbackBindAddress(address)) return null;
  return { kind, listen: address };
}

export function registerTunnelTools(ctx, service) {
  /**
   * Resolve the target for the calling conversation and surface it in the
   * side panel. Tunnels need no terminal, but the operator must see which
   * server the agent is opening a listener on.
   */
  const connectionFor = (args, exec) => {
    const selected = service.resolveConnection(args.connection_id, service.terminalOwner?.(exec?.agent) ?? undefined);
    if (selected.ok) {
      try {
        Promise.resolve(service.touchAgentTarget?.({
          connectionId: selected.connectionId,
          ownerSessionId: service.terminalOwner?.(exec?.agent) ?? undefined,
          kind: "tunnel",
          ensureTerminal: false
        })).catch(() => {});
      } catch {}
    }
    return selected;
  };

  /**
   * Ask the operator before a listener becomes reachable from somewhere other
   * than this host. The call suspends on the host's approval channel and every
   * outcome except "allowed-once" refuses before a socket is opened — the same
   * fail-closed contract as the dangerous-command gate, because a forward the
   * model opened by itself is a network exposure the person never saw.
   */
  const requireExposureApproval = async (exec, selected, args) => {
    const exposure = assessTunnelExposure(args);
    if (exposure === null) return;
    const ownerSessionId = service.terminalOwner?.(exec?.agent) ?? undefined;
    const policy = service.resolveExecPolicy?.(selected.connectionId, ownerSessionId) ?? { mode: "standard", approval: "ask" };
    // DSH Auto review / full access already carries this conversation's
    // authority: the person approved the mode, not this one forward.
    if (policy.mode === "allowAll") return;
    if (policy.approval === "never") {
      const why = policy.dsh?.ceiling === "readOnly"
        ? t("本次对话处于 DSH 只读模式，端口转发未开启。请勿重试或绕行。")
        : t("本次对话的 DSH 审批策略已关闭（never），对外暴露的端口转发未开启。请勿重试；如确需开启，请让操作者在 DSH 权限选择器中切换模式，或自行在面板中开启。");
      throw new Error(`tunnel_start failed: ${why}`);
    }
    const host = selected.connection?.host ?? selected.connectionId;
    const describe = exposure.kind === "remote"
      ? t(`服务器监听 ${exposure.listen}，回连本机 ${exposure.target}`)
      : t(`本机监听 ${exposure.listen}`);
    const limit = service.config?.approvalPromptTimeoutMs ?? OPERATOR_APPROVAL_TIMEOUT_MS;
    const seconds = approvalTimeoutSeconds(limit);
    const reason = [
      t(`AI 请求在 ${host} 上开启一个对外暴露的端口转发：${describe}。`),
      t("批准=本次开启；拒绝=不会开启任何监听。"),
      "",
      t(`本次确认等待 ${seconds} 秒；超时未选择将自动拒绝，不会开启监听。`)
    ].join("\n");
    const approvalExecution = { ...exec, name: exec?.name ?? "tunnel_start", callId: exec?.callId, agent: exec?.agent, signal: exec?.signal };
    const { outcome, timedOut } = await askOperatorApproval(ctx, approvalExecution, reason, limit);
    if (timedOut) {
      throw new Error(`tunnel_start failed: ${t(`端口转发的确认等待超过 ${seconds} 秒，未开启任何监听。请勿自动重试；如确需开启，请让操作者在提示出现时选择。`)}`);
    }
    if (outcome === "allowed-once") return;
    if (outcome === "rejected") {
      throw new Error(`tunnel_start failed: ${t(`操作者拒绝了对外的端口转发（${describe}）。请勿重试或改用其他地址绕行；如确需开启，请让操作者自行在面板中处理。`)}`);
    }
    if (outcome === "cancelled") {
      throw new Error(`tunnel_start failed: ${t("端口转发的确认被取消，未开启任何监听。请勿重试；如确需开启请与操作者确认。")}`);
    }
    throw new Error(`tunnel_start failed: ${t("该端口转发会对外暴露监听，必须由操作者确认，但当前宿主没有可用的审批通道，未开启任何监听。请让操作者自行处理。")}`);
  };

  ctx.tools.register(defineTool({
    name: "tunnel_start",
    description: "Start a port forward through a connected server. kind='local' (default): the DSH host listens on bind_addr:bind_port and forwards to remote_host:remote_port on the server — use to reach services only the server can see. kind='remote': the server listens on remote_host:remote_port and forwards back to target_host:target_port on this machine. kind='dynamic': a SOCKS5 proxy on bind_addr:bind_port (the ssh -D equivalent) — clients pick the destination per connection and every one of them is reached from the server. Returns a tunnel_id for tunnel_stop. A non-loopback bind_addr and every remote forward are shown to the operator for approval before any listener opens.",
    parameters: {
      connection_id: { type: "string", description: "Connection id from ssh_connect; omit to use the current server." },
      kind: { type: "string", enum: ["local", "remote", "dynamic"], description: "Forward direction: 'local' (default), 'remote', or 'dynamic' (SOCKS5 proxy)." },
      bind_addr: { type: "string", description: "Local bind address (local kind), defaults to 127.0.0.1." },
      bind_port: { type: "integer", description: "Local bind port (local kind); 0 picks a free port." },
      remote_host: { type: "string", description: "The remote host to reach (local kind) or to listen on (remote kind); not used by dynamic." },
      remote_port: { type: "integer", description: "The remote port to reach (local kind) or to listen on (remote kind); not used by dynamic." },
      target_host: { type: "string", description: "Local target host for remote kind, defaults to 127.0.0.1." },
      target_port: { type: "integer", description: "Local target port for remote kind (required when kind='remote')." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          tunnelId: { type: "string", required: true },
          kind: { type: "string", required: true },
          bindAddr: { type: "string", required: true },
          bindPort: { type: "number", required: true },
          // Not required: a dynamic (SOCKS5) forward has no single remote
          // endpoint, and demanding them made every tunnel_start kind=dynamic
          // fail the host's output validation AFTER the listener was up.
          remoteHost: { type: "string" },
          remotePort: { type: "number" },
          targetHost: { type: "string" },
          targetPort: { type: "number" }
        }
      },
      render(args, value) {
        const text = value.kind === "dynamic"
          ? `SOCKS5 proxy started on ${value.bindAddr}:${value.bindPort} (id: ${value.tunnelId})`
 : value.kind === "local"
            ? `Tunnel started: ${value.bindAddr}:${value.bindPort} -> ${value.remoteHost}:${value.remotePort} (id: ${value.tunnelId})`
 : `Remote forward started: server ${value.bindAddr}:${value.bindPort} -> local ${value.targetHost}:${value.targetPort} (id: ${value.tunnelId})`;
        return [{ type: "text", text }];
      }
    },
    async execute(args, exec) {
      const selected = connectionFor(args, exec);
      if (!selected.ok) throw new Error(`tunnel_start failed: ${selected.error.message}`);
      const connectionId = selected.connectionId;
      // A listener other machines can reach (or a remote forward leading back
      // into this host) is the operator's decision, taken before any socket.
      await requireExposureApproval(exec, selected, args);
      let result;
      if (args.kind === "dynamic") {
        result = await service.tunnelStartDynamic({ connectionId, bindAddr: args.bind_addr, bindPort: args.bind_port });
      } else if (args.kind === "remote") {
        result = await service.tunnelStartRemote({ connectionId, bindAddr: args.bind_addr, bindPort: args.bind_port, remoteHost: args.remote_host, remotePort: args.remote_port, targetHost: args.target_host ?? "127.0.0.1", targetPort: args.target_port });
      } else {
        if (args.remote_host === undefined || args.remote_port === undefined) {
          throw new Error("tunnel_start failed: remote_host and remote_port are required for the local kind");
        }
        result = await service.tunnelStartLocal({ connectionId, bindAddr: args.bind_addr, bindPort: args.bind_port, remoteHost: args.remote_host, remotePort: args.remote_port });
      }
      if (!result.ok) throw new Error(`tunnel_start failed: ${result.error.message}`);
      return result.value;
    }
  }));

  ctx.tools.register(defineTool({
    name: "tunnel_list",
    description: "List active port forwards on a connected server. Omit connection_id for the current server.",
    parameters: {
      connection_id: { type: "string", description: "Connection id from ssh_connect; omit to use the current server." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          tunnels: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: {
            tunnelId: { type: "string", required: true },
            kind: { type: "string", required: true },
            bindAddr: { type: "string", required: true },
            bindPort: { type: "number", required: true },
            remoteHost: { type: "string" },
            remotePort: { type: "number" },
            targetHost: { type: "string" },
            targetPort: { type: "number" },
            // Live SOCKS5 client count; a declared property, because
            // additionalProperties is false and an undeclared field made
            // tunnel_list fail validation whenever a dynamic forward existed.
            connections: { type: "number" },
            active: { type: "boolean", required: true }
          } } }
        }
      },
      render(args, value) {
        if (!value.tunnels.length) return [{ type: "text", text: "(no active tunnels)" }];
        // A dynamic forward is a SOCKS5 listener: it has no single remote
        // endpoint, so the generic branch printed `-> undefined:undefined`.
        return [{ type: "text", text: value.tunnels.map((t) => t.kind === "remote"
          ? `remote: server ${t.bindAddr}:${t.bindPort} -> local ${t.targetHost}:${t.targetPort} (${t.tunnelId})`
          : t.kind === "dynamic"
            ? `dynamic: socks5 ${t.bindAddr}:${t.bindPort} (${t.connections ?? 0} connections) (${t.tunnelId})`
            : `local: ${t.bindAddr}:${t.bindPort} -> ${t.remoteHost}:${t.remotePort} (${t.tunnelId})`).join("\n") }];
      }
    },
    async execute(args, exec) {
      const selected = connectionFor(args, exec);
      if (!selected.ok) throw new Error(`tunnel_list failed: ${selected.error.message}`);
      const result = await service.tunnelList({ connectionId: selected.connectionId });
      if (!result.ok) throw new Error(`tunnel_list failed: ${result.error.message}`);
      return result.value;
    }
  }));

  ctx.tools.register(defineTool({
    name: "tunnel_stop",
    description: "Stop an active port forward by tunnel_id (see tunnel_list / tunnel_start).",
    parameters: {
      connection_id: { type: "string", description: "Connection id from ssh_connect; omit to use the current server." },
      tunnel_id: { type: "string", required: true, description: "The tunnel id returned by tunnel_start." }
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { tunnelId: { type: "string", required: true }, stopped: { type: "boolean", required: true } } },
      render(args, value) { return [{ type: "text", text: `Stopped tunnel ${value.tunnelId}` }]; }
    },
    async execute(args, exec) {
      const selected = connectionFor(args, exec);
      if (!selected.ok) throw new Error(`tunnel_stop failed: ${selected.error.message}`);
      const result = await service.tunnelStop({ connectionId: selected.connectionId, tunnelId: args.tunnel_id });
      if (!result.ok) throw new Error(`tunnel_stop failed: ${result.error.message}`);
      return result.value;
    }
  }));
}
