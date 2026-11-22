/**
 * Agent-facing actions over the active connection and saved resources.
 *
 * Every verb here is scoped to the CALLING CONVERSATION: its own connection
 * binding, its own terminal, its own reading cursor. Sharing those was what
 * made two chats on one server type into each other's shell (see
 * terminal-owner.js for the ownership model).
 */
import { randomUUID } from "node:crypto";
import { redactForModel } from "../redact.js";
import { fail } from "../envelope.js";
import { resolveProfileRef, noConnectionGuidance, AUTO_CONNECT_DISABLED_MESSAGE } from "../agent-connect.js";
import { t } from "../../i18n/core.js";
import { isLiveSession, normalizeOwner, ownerKey, pickOwnerSession } from "../terminal-owner.js";

export const withAgentActions = (Base) => class extends Base {
  // ── Remote methods ─────────────────────────────────────────────────────────

  /**
   * Live connections plus, per connection, every terminal with its owner.
   *
   * `sessions` (ids only) is kept for older panels and tests; `terminals` is
   * what the current panel reads, because it must be able to tell its own
   * terminal from another conversation's on the same server. `mine` is
   * computed against the caller's session, and `activeConnectionId` is that
   * session's binding — two chats no longer see one shared pointer.
   */
  async list(request = {}) {
    const ownerSessionId = normalizeOwner(request.sessionId);
    const connections = [];
    for (const [connectionId, c] of this.connections) {
      const terminals = [];
      for (const sessionId of c.sessions ?? []) {
        const session = this.sessions?.get?.(sessionId);
        if (session === undefined) continue;
        terminals.push({
          sessionId,
          ownerSessionId: session.ownerSessionId ?? null,
          openedBy: session.openedBy ?? "panel",
          alive: isLiveSession(session),
          mine: ownerKey(session.ownerSessionId) === ownerKey(ownerSessionId)
        });
      }
      const connection = {
        connectionId,
        host: c.host,
        port: c.port,
        username: c.username,
        connected: !c.dead && !c.closing,
        sessions: [...c.sessions],
        terminals
      };
      // Strict Typert results must be JSON-safe: optional fields must be
      // absent, rather than present with an `undefined` value.
      if (c.name !== undefined) connection.name = c.name;
      // The browser reveals agent-opened terminals. `agentSession` is the
      // connection-level hint the background poll uses; `agentSessionMine`
      // is the per-conversation one the panel acts on.
      const agentOpened = terminals.some((terminal) => terminal.alive && terminal.openedBy === "agent");
      const agentOpenedMine = terminals.some((terminal) => terminal.alive && terminal.openedBy === "agent" && terminal.mine);
      if (agentOpened) connection.agentSession = true;
      if (agentOpenedMine) connection.agentSessionMine = true;
      if (c.agentRevealId !== undefined) connection.agentRevealId = c.agentRevealId;
      if (c.agentRevealOwnerSessionId !== undefined) connection.agentRevealOwnerSessionId = c.agentRevealOwnerSessionId;
      connections.push(connection);
    }
    const value = { connections, activeConnectionId: this.activeConnectionFor(ownerSessionId) };
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
   * Point the agent at one connection, for ONE conversation. Split panes are
   * independent, so the operator's click decides which server that chat's tools
   * target: a click in chat B must not move chat A's agent.
   *
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
    this.bindActiveConnection(request.connectionId, request.sessionId);
    return { ok: true, value: { activeConnectionId: this.activeConnectionFor(request.sessionId) } };
  }

  /**
   * Connect a saved SSH resource by name/id at the agent's request. The
   * operator's switch gates the whole verb (the risk is waking a machine, not
   * switching between live ones). A live connection for the same profile is
   * reused, the result becomes THIS conversation's active connection so later
   * ssh_exec calls land on it, and a terminal is opened for this conversation
   * so the operator can always see which machine the agent moved to.
   */
  async agentConnectProfile(request) {
    if (!this.agentAutoConnect) {
      return { ok: false, error: fail("auto-connect-disabled", t(AUTO_CONNECT_DISABLED_MESSAGE)) };
    }
    const ownerSessionId = normalizeOwner(request.sessionId);
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
    const previousActiveConnectionId = this.activeConnectionFor(ownerSessionId);
    const connected = await this.profileConnect({ profileId: resolved.profileId, reuseExisting: true, sessionId: ownerSessionId ?? undefined });
    if (!connected.ok) return connected;
    const connectionId = connected.value.connectionId;
    const reused = knownConnectionIds.has(connectionId);
    const rollback = async (error, openedSessionId = null) => {
      if (!reused) await this.disconnect({ connectionId }).catch(() => {});
      else if (openedSessionId !== null) await this.closeSession({ sessionId: openedSessionId }).catch(() => {});
      this.bindActiveConnection(previousActiveConnectionId, ownerSessionId);
      return { ok: false, error };
    };
    let terminalOpened = false;
    const connection = this.connections.get(connectionId);
    if (connection === undefined) return rollback(fail("no-connection", `connection "${connectionId}" disappeared before its terminal opened`));
    // Visibility is the safeguard: the agent's target machine must appear in
    // the right-side panel, not just exist as an invisible transport. The
    // terminal belongs to this conversation, so another chat's terminal on the
    // same server is neither reused nor revealed here.
    let openedSessionId = null;
    if (pickOwnerSession(this.sessions, connection, ownerSessionId) === undefined) {
      const opened = await this.openSession({ connectionId, sessionId: ownerSessionId ?? undefined, openedBy: "agent" });
      if (!opened.ok) return rollback(opened.error);
      if (opened.value.reused !== true) {
        openedSessionId = opened.value.sessionId;
        terminalOpened = true;
      }
    }
    const selected = await this.selectConnection({ connectionId, sessionId: ownerSessionId ?? undefined });
    if (!selected.ok) return rollback(selected.error, openedSessionId);
    // A new token on every request lets the browser re-open a reused server
    // after its pane was closed, even when its existing PTY was human-opened.
    connection.agentRevealId = randomUUID();
    if (ownerSessionId !== null) connection.agentRevealOwnerSessionId = ownerSessionId;
    else delete connection.agentRevealOwnerSessionId;
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
   * Select the connection the caller works through.
   *
   * The ladder is deliberately "mine first": a conversation bound by a click
   * or a connect wins, then the one connection where this conversation already
   * has a terminal ("my terminal is where I am"), then the compatibility
   * pointer an older panel writes, then the only-open-connection case. That
   * ordering is what stops a chat from silently targeting another chat's
   * machine.
   */
  resolveConnection(connectionId, ownerSessionId) {
    const resourceNames = this.savedResourceNameList();
    const owner = normalizeOwner(ownerSessionId);
    if (connectionId !== undefined) {
      const connection = this.connections.get(connectionId);
      if (connection !== undefined) return { ok: true, connectionId, connection };
      return { ok: false, error: fail("no-connection", noConnectionGuidance(connectionId, resourceNames, this.agentAutoConnect)) };
    }
    const bound = this.activeConnectionFor(owner);
    if (bound !== null && bound !== undefined) {
      const connection = this.connections.get(bound);
      if (connection !== undefined && !connection.dead && !connection.closing) {
        return { ok: true, connectionId: bound, connection };
      }
    }
    const withOwnTerminal = [];
    for (const [resolvedId, connection] of this.connections) {
      if (connection.dead || connection.closing) continue;
      if (pickOwnerSession(this.sessions ?? new Map(), connection, owner) !== undefined) withOwnTerminal.push([resolvedId, connection]);
    }
    if (withOwnTerminal.length === 1) return { ok: true, connectionId: withOwnTerminal[0][0], connection: withOwnTerminal[0][1] };
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
    const selected = this.resolveConnection(request.connectionId, request.sessionId);
    if (!selected.ok) return selected;
    const result = await this.execOnConnection(selected.connectionId, request.command, request.timeoutMs, false, request.approvalToken, request.sessionId);
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

  /** Read terminal output from the caller's terminal on the explicit or current connection. */
  readCurrentConnection(request) {
    const selected = this.resolveConnection(request.connectionId, request.sessionId);
    if (!selected.ok) return selected;
    const result = this.readConnectionOutput(selected.connectionId, request.mode, request.sessionId);
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
   * Make sure the caller has a live terminal so agent input can actually be
   * submitted: its own, the connection's single adoptable anonymous one, or a
   * newly opened shell. With no terminal, a plain write would otherwise drop
   * the input (0 bytes written).
   */
  async ensureSessionForWrite(connectionId, ownerSessionId) {
    const selected = this.resolveConnection(connectionId, ownerSessionId);
    if (!selected.ok) return selected;
    if (this.ownerTerminalFor(selected.connectionId, ownerSessionId) !== undefined) {
      return { ok: true, connectionId: selected.connectionId };
    }
    const opened = await this.openSession({
      connectionId: selected.connectionId,
      cols: 100,
      rows: 30,
      openedBy: "agent",
      sessionId: normalizeOwner(ownerSessionId) ?? undefined
    });
    if (!opened.ok) return opened;
    return { ok: true, connectionId: selected.connectionId };
  }

  /** Send tool input to the caller's terminal on the explicit or current connection. */
  writeCurrentConnection(request) {
    const selected = this.resolveConnection(request.connectionId, request.sessionId);
    if (!selected.ok) return selected;
    return this.writeToConnection(selected.connectionId, request.input, request.sessionId);
  }

  /** Disconnect the explicit or current SSH connection. */
  async disconnectCurrentConnection(request) {
    const selected = this.resolveConnection(request.connectionId, request.sessionId);
    if (!selected.ok) return selected;
    return this.disconnect({ connectionId: selected.connectionId });
  }
};
