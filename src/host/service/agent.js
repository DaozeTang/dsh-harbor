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

/** How long an agent tool call keeps a connection's activity indicator lit. */
const AGENT_ACTIVE_WINDOW_MS = 30_000;

export const withAgentActions = (Base) => class extends Base {
  /**
   * Record that one conversation's agent is operating on a connection.
   *
   * The panel used to infer "the agent is here" from a live terminal only, so
   * ssh_connect / ssh_exec / sftp / tunnel / status calls were invisible. The
   * activity stamp is deliberately per conversation: two chats on one server
   * must not light each other's indicator.
   *
   * @param {object} connection - live connection record.
   * @param {unknown} ownerSessionId - the calling DSH conversation.
   * @param {string} kind - short activity label ("connect", "exec", "sftp").
   */
  noteAgentActivity(connection, ownerSessionId, kind = "tool") {
    if (connection === undefined || connection === null) return;
    connection.agentActivityByOwner ??= new Map();
    connection.agentActivityByOwner.set(ownerKey(ownerSessionId), { at: Date.now(), kind });
  }

  /**
   * Make one agent operation visible in the right-side panel.
   *
   * This is the single visibility contract every agent tool goes through:
   * bind the connection to the calling conversation, stamp activity, mint a
   * reveal token for that conversation (once — the browser focuses/opens the
   * Harbor tab), and optionally open this conversation's terminal so exec
   * output has a surface to mirror into.
   *
   * @param {{connectionId?: string, ownerSessionId?: string|null, kind?: string, ensureTerminal?: boolean}} request
   * @returns {Promise<{ok: true, value: {connectionId: string, panelTerminalId?: string, panelTerminalReused?: boolean, warning?: string}}|{ok: false, error: object}>}
   */
  async touchAgentTarget({ connectionId, ownerSessionId, kind = "tool", ensureTerminal = false } = {}) {
    const owner = normalizeOwner(ownerSessionId);
    const selected = this.resolveConnection(connectionId, owner);
    if (!selected.ok) return selected;
    const id = selected.connectionId;
    const connection = selected.connection;
    this.bindActiveConnection(id, owner);
    this.noteAgentActivity(connection, owner, kind);
    // A terminal is optional for file/status/tunnel work, but required for
    // ssh_exec to have somewhere to mirror its command and output.
    let terminal = null;
    if (ensureTerminal) terminal = await this.ensureSessionForWrite(id, owner);
    // The terminal open records its own "terminal" activity; restore the
    // caller's operation label so the panel can say what the agent is doing.
    this.noteAgentActivity(connection, owner, kind);
    // One reveal per (connection, conversation) is enough: the browser only
    // needs to add/focus the server tab once. A later terminal_open mints a
    // fresh token itself (see openOwnedSession).
    if (connection.agentRevealId === undefined || normalizeOwner(connection.agentRevealOwnerSessionId) !== owner) {
      connection.agentRevealId = randomUUID();
      if (owner !== null) connection.agentRevealOwnerSessionId = owner;
      else delete connection.agentRevealOwnerSessionId;
    }
    const value = { connectionId: id };
    if (terminal !== null && terminal.ok) {
      // This is Harbor's panel PTY id, not a persistent-terminal registry id:
      // the registry id is minted by terminal_open, which reuses this PTY.
      if (terminal.value?.sessionId !== undefined) value.panelTerminalId = terminal.value.sessionId;
      if (terminal.value?.reused !== undefined) value.panelTerminalReused = terminal.value.reused;
    } else if (terminal !== null && terminal.ok === false) {
      // The connection is visible even when sshd refuses another PTY; the
      // tool still runs and the operator can open a terminal manually.
      value.warning = terminal.error?.message ?? "could not open this conversation's terminal";
    }
    return { ok: true, value };
  }
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
      // Agent activity is scoped to the listing conversation: the panel uses
      // it for the "Agent is working" pulse, independent of terminal liveness.
      const activity = c.agentActivityByOwner?.get?.(ownerKey(ownerSessionId));
      if (activity !== undefined) {
        connection.agentActive = Date.now() - activity.at < AGENT_ACTIVE_WINDOW_MS;
        connection.agentLastActivityAt = new Date(activity.at).toISOString();
        if (activity.kind !== undefined) connection.agentActivityKind = activity.kind;
      }
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
    this.noteAgentActivity(connection, ownerSessionId, "connect");
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
      // The bound record wins even while its transport is down and reconnecting.
      // Falling through on "dead" is exactly how a chat used to end up running a
      // command on a different server; the tool's ensureAlive now owns the
      // decision and reports connection-lost when self-healing gives up.
      if (connection !== undefined) return { ok: true, connectionId: bound, connection };
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
    const result = await this.execOnConnection(selected.connectionId, request.command, request.timeoutMs, request.approvalToken, request.sessionId);
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
    const { exitCode, stdout, stderr, cwd, commandId, startedAt, finishedAt, durationMs, truncated, timedOut, trashed } = result.value;
    const safeStdout = redactForModel(stdout);
    const safeStderr = redactForModel(stderr);
    const value = {
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
    };
    // An approved delete runs the reversible trash move, whose script always
    // exits 0: the per-target outcome is the ONLY evidence that something was
    // actually moved. Rebuilding the result field by field used to drop it, so
    // "moved", "missing" and "failed" all reached the model as exit 0 with no
    // output — a silent success report for a delete that did not happen.
    if (Array.isArray(trashed) && trashed.length > 0) value.trashed = trashed;
    return { ok: true, value };
  }

  /**
   * Make sure the caller has a live terminal: its own, the connection's single
   * adoptable anonymous one, or a newly opened shell.
   *
   * Used by ssh_exec before the exec channel opens, so its command and output
   * have a terminal to mirror into.
   *
   * @returns {{ok: true, connectionId: string, value: {sessionId: string, reused: boolean}}|{ok: false, error: object}}
   */
  async ensureSessionForWrite(connectionId, ownerSessionId) {
    const selected = this.resolveConnection(connectionId, ownerSessionId);
    if (!selected.ok) return selected;
    const existing = this.ownerTerminalFor(selected.connectionId, ownerSessionId);
    if (existing !== undefined) {
      return { ok: true, connectionId: selected.connectionId, value: { sessionId: existing.id, reused: true } };
    }
    const opened = await this.openSession({
      connectionId: selected.connectionId,
      cols: 100,
      rows: 30,
      openedBy: "agent",
      sessionId: normalizeOwner(ownerSessionId) ?? undefined
    });
    if (!opened.ok) return opened;
    return { ok: true, connectionId: selected.connectionId, value: { sessionId: opened.value.sessionId, reused: opened.value.reused === true } };
  }

  /** Disconnect the explicit or current SSH connection. */
  async disconnectCurrentConnection(request) {
    const selected = this.resolveConnection(request.connectionId, request.sessionId);
    if (!selected.ok) return selected;
    return this.disconnect({ connectionId: selected.connectionId });
  }
};
