/**
 * Agent-facing actions over the active connection and saved resources.
 */
import { randomUUID } from "node:crypto";
import { redactForModel } from "../redact.js";
import { fail } from "../envelope.js";
import { resolveProfileRef, noConnectionGuidance, AUTO_CONNECT_DISABLED_MESSAGE } from "../agent-connect.js";
import { t } from "../../i18n/core.js";

export const withAgentActions = (Base) => class extends Base {
  // ── Remote methods ─────────────────────────────────────────────────────────

  async list() {
    const connections = [];
    for (const [connectionId, c] of this.connections) {
      const connection = {
        connectionId,
        host: c.host,
        port: c.port,
        username: c.username,
        connected: !c.dead && !c.closing,
        sessions: [...c.sessions]
      };
      // Strict Typert results must be JSON-safe: optional fields must be
      // absent, rather than present with an `undefined` value.
      if (c.name !== undefined) connection.name = c.name;
      // The browser reveals agent-opened sessions, and a new request token
      // also reveals reused connections whose existing PTY was human-opened.
      if ([...c.sessions].some((sessionId) => this.sessions?.get(sessionId)?.openedBy === "agent")) connection.agentSession = true;
      if (c.agentRevealId !== undefined) connection.agentRevealId = c.agentRevealId;
      connections.push(connection);
    }
    const value = { connections, activeConnectionId: this.activeConnectionId };
    // Saved resources reach the agent only after the operator opted in
    //; with the switch off, ssh_list keeps today's strict
    // live-connections-only stance.
    if (this.agentAutoConnect) {
      try {
        value.resources = this.savedResourceSummaries();
      } catch {}
    }
    return { ok: true, value };
  }

  /**
   * Saved SSH resources as the agent may see them: coordinates only. The
   * caller gates on `agentAutoConnect`; a storage failure must not take
   * `list()` down, so callers wrap this in try/catch.
   */
  savedResourceSummaries() {
    const connectedProfileIds = new Set(
      [...this.connections.values()].map((connection) => connection.profileId).filter(Boolean)
 );
    return [...this.requireProfileTable().entries()]
 .map(([profileId, record]) => ({
        profileId,
        name: record.name,
        host: record.host,
        port: record.port,
        username: record.username,
        connected: connectedProfileIds.has(profileId)
      }))
 .sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN"));
  }

  /** Saved resource names for error guidance; failures degrade to an empty list. */
  savedResourceNameList() {
    if (!this.agentAutoConnect) return [];
    try {
      return [...this.requireProfileTable().values()]
 .map((record) => record.name)
 .sort((left, right) => left.localeCompare(right, "zh-Hans-CN"));
    } catch {
      return [];
    }
  }

  /**
   * Point the agent at one connection. Split panes are independent, so the
   * operator's click is what decides which of them an agent tool call targets:
   * tools that omit `connection_id` resolve `activeConnectionId` at call time.
   * A refused switch leaves the previous binding intact — clearing it would
   * strand the agent with no target while the panel still shows one.
   */
  async selectConnection(request) {
    const connection = this.connections.get(request.connectionId);
    if (connection === void 0) {
      return { ok: false, error: fail("no-connection", noConnectionGuidance(request.connectionId, this.savedResourceNameList(), this.agentAutoConnect)) };
    }
    if (connection.dead || connection.closing) {
      return { ok: false, error: fail("connection-lost", `connection "${request.connectionId}" is not usable`) };
    }
    this.activeConnectionId = request.connectionId;
    return { ok: true, value: { activeConnectionId: this.activeConnectionId } };
  }

  /**
   * Connect a saved SSH resource by name/id at the agent's request. The
   * operator's switch gates the whole verb (the risk is waking a machine, not
   * switching between live ones). A live connection for the same profile is
   * reused, the result becomes the active connection so later ssh_exec calls
   * land on it, and a terminal is opened so the operator can always see which
   * machine the agent moved to in the right-side panel.
   */
  async agentConnectProfile(request) {
    if (!this.agentAutoConnect) {
      return { ok: false, error: fail("auto-connect-disabled", t(AUTO_CONNECT_DISABLED_MESSAGE)) };
    }
    let resolved;
    try {
      resolved = resolveProfileRef(
        [...this.requireProfileTable().entries()].map(([profileId, record]) => ({ profileId, name: record.name })),
        request.resource
 );
    } catch (error) {
      return { ok: false, error: fail("profile-list-failed", error.message) };
    }
    if (!resolved.ok) return { ok: false, error: fail(resolved.code, resolved.message) };
    const knownConnectionIds = new Set(this.connections.keys());
    const previousActiveConnectionId = this.activeConnectionId;
    const connected = await this.profileConnect({ profileId: resolved.profileId, reuseExisting: true });
    if (!connected.ok) return connected;
    const connectionId = connected.value.connectionId;
    const reused = knownConnectionIds.has(connectionId);
    const rollback = async (error, openedSessionId = null) => {
      if (!reused) await this.disconnect({ connectionId }).catch(() => {});
      else if (openedSessionId !== null) await this.closeSession({ sessionId: openedSessionId }).catch(() => {});
      this.activeConnectionId = previousActiveConnectionId;
      return { ok: false, error };
    };
    let terminalOpened = false;
    const connection = this.connections.get(connectionId);
    if (connection === undefined) return rollback(fail("no-connection", `connection "${connectionId}" disappeared before its terminal opened`));
    // Visibility is the safeguard: the agent's target machine must appear in
    // the right-side panel, not just exist as an invisible transport.
    let openedSessionId = null;
    if (connection.sessions.size === 0) {
      const opened = await this.openSession({ connectionId, openedBy: "agent" });
      if (!opened.ok) return rollback(opened.error);
      openedSessionId = opened.value.sessionId;
      terminalOpened = true;
    }
    const selected = await this.selectConnection({ connectionId });
    if (!selected.ok) return rollback(selected.error, openedSessionId);
    // A new token on every request lets the browser re-open a reused server
    // after its pane was closed, even when its existing PTY was human-opened.
    connection.agentRevealId = randomUUID();
    return {
      ok: true,
      value: {
        connectionId,
        profileId: resolved.profileId,
        name: resolved.name,
        host: connected.value.host,
        port: connected.value.port,
        username: connected.value.username,
        reused,
        terminalOpened,
 ...(connected.value.warning !== undefined ? { warning: connected.value.warning } : {})
      }
    };
  }

  /**
   * Select the connection represented by the right-side terminal. For a
   * single connection, fall back to it so a normal conversational request
   * never has to expose an implementation-only UUID to the user.
   */
  resolveConnection(connectionId) {
    const resourceNames = this.savedResourceNameList();
    if (connectionId !== undefined) {
      const connection = this.connections.get(connectionId);
      if (connection !== undefined) return { ok: true, connectionId, connection };
      return { ok: false, error: fail("no-connection", noConnectionGuidance(connectionId, resourceNames, this.agentAutoConnect)) };
    }
    if (this.activeConnectionId !== null) {
      const connection = this.connections.get(this.activeConnectionId);
      if (connection !== undefined) {
        return { ok: true, connectionId: this.activeConnectionId, connection };
      }
      this.activeConnectionId = null;
    }
    if (this.connections.size === 1) {
      const [resolvedId, connection] = this.connections.entries().next().value;
      return { ok: true, connectionId: resolvedId, connection };
    }
    if (this.connections.size === 0) {
      return { ok: false, error: fail("no-connection", noConnectionGuidance(undefined, resourceNames, this.agentAutoConnect)) };
    }
    return { ok: false, error: fail("connection-selection-required", "multiple SSH connections are open; select a server in the SSH panel or provide connection_id") };
  }

  /** Execute a command on the explicit or current SSH connection. */
  async executeCommand(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const result = await this.execOnConnection(selected.connectionId, request.command, request.timeoutMs, false, request.approvalToken);
    if (result.blocked) {
      return {
        ok: true,
        value: {
          connectionId: selected.connectionId,
          host: selected.connection.host,
 ...result.value,
          redacted: false
        }
      };
    }
    if (!result.ok) return result;
    const { exitCode, stdout, stderr, cwd, commandId, startedAt, finishedAt, durationMs, truncated, timedOut } = result.value;
    const safeStdout = redactForModel(stdout);
    const safeStderr = redactForModel(stderr);
    return {
      ok: true,
      value: {
        connectionId: selected.connectionId,
        host: selected.connection.host,
        exitCode,
        stdout: safeStdout.text,
        stderr: safeStderr.text,
        cwd,
        commandId,
        startedAt,
        finishedAt,
        durationMs,
        truncated,
        timedOut,
        redacted: safeStdout.redacted || safeStderr.redacted
      }
    };
  }

  /** Read terminal output from the explicit or current SSH connection. */
  readCurrentConnection(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const result = this.readConnectionOutput(selected.connectionId, request.mode);
    if (!result.ok) return result;
    return {
      ok: true,
      value: {
        connectionId: selected.connectionId,
        host: selected.connection.host,
 ...result.value
      }
    };
  }

  /**
   * Make sure the target connection has a live PTY session so agent input can
   * actually be submitted. With multiple open connections and no terminal open
   * on the target yet, a plain write would otherwise drop the input (0 bytes
   * written). Resolves the connection by id or the active one, then opens a
   * session lazily when none is live.
   */
  async ensureSessionForWrite(connectionId) {
    const selected = this.resolveConnection(connectionId);
    if (!selected.ok) return selected;
    const live = [...selected.connection.sessions].some((sessionId) => {
      const session = this.sessions.get(sessionId);
      return session !== void 0 && session.exited === null && session.stream !== null;
    });
    if (live) return { ok: true, connectionId: selected.connectionId };
    const opened = await this.openSession({ connectionId: selected.connectionId, cols: 100, rows: 30, openedBy: "agent" });
    if (!opened.ok) return opened;
    return { ok: true, connectionId: selected.connectionId };
  }

  /** Send tool input to the explicit or current SSH connection. */
  writeCurrentConnection(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    return this.writeToConnection(selected.connectionId, request.input);
  }

  /** Disconnect the explicit or current SSH connection. */
  async disconnectCurrentConnection(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    return this.disconnect({ connectionId: selected.connectionId });
  }
};
