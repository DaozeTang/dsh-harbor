/**
 * dsh-harbor host half: a Typert Remote service named harbor that manages
 * ssh2 connections and PTY shell sessions, streaming output to the browser
 * through long-poll reads. Also registers agent tools (ssh_connect, ssh_exec,
 * ...) so the main conversation can drive the same sessions the panel shows.
 *
 * The service body is composed from src/host/service/*; this entry keeps the
 * constructor and the session wiring that the service crosses with
 * recording/shell integration, and delegates the ssh2 CommonJS interop to
 * host/ssh2-client.js.
 */
import { randomUUID } from "node:crypto";
import { fail } from "./host/envelope.js";
import { noConnectionGuidance } from "./host/agent-connect.js";
import { ShellIntegrationTracker, SHELL_FAMILY_PROBE, parseShellFamilyProbe, shellIntegrationCommand } from "./host/shell-integration.js";
import { buildCwdAwareCommand, posixLoginShell } from "./host/exec-cwd.js";
import { t } from "./i18n/core.js";
import { HarborServiceCore } from "./host/service/index.js";
import { MAX_BUFFER_BYTES, MAX_COMMAND_OUTPUT_BYTES, MAX_CAPTURE_BYTES, MAX_SESSIONS, MAX_SESSIONS_PER_CONNECTION, READ_TIMEOUT_MS, STREAM_HEARTBEAT_MS, STREAM_ROUTE_PREFIX, TTY_PROBE_MS, TTY_PROBE_RETRY_DELAYS_MS } from "./host/service/constants.js";
import { anonymousSessions, indexOwner, normalizeOwner, ownerKey, ownerSessionIds, pickOwnerSession, unindexOwner } from "./host/terminal-owner.js";
import { buildCensusScript, newestUnclaimedTty, parseCensus, pickNewTty } from "./host/terminal-census.js";
import { promptFromTerminalData, tailCapped } from "./host/service/text.js";
import { markSourceRemote } from "./host/service/source-remote.js";
import { createSsh2Client } from "./host/ssh2-client.js";
import { publishHarborService, retractHarborService } from "./shared/service-hub.js";

export { LEGACY_VRP_ALGORITHMS, isKexMismatchError } from "./host/service/constants.js";
export { profileDomainSpec, credentialDomainSpec, knownHostDomainSpec, settingsDomainSpec, normalizeDefaultUsername, loadSettingsRecord } from "./host/service/models.js";
export { normalizeTerminalEol } from "./host/service/text.js";

/**
 * HarborService: one cordis service (and Typert Remote) that owns all SSH
 * connections and their PTY shell sessions for the web profile.
 */
export default class HarborService extends HarborServiceCore {
  constructor(ctx, config = {}) {
    super(ctx, "harbor");
    this.config = {
      defaultReadTimeoutMs: READ_TIMEOUT_MS,
      maxBufferBytes: MAX_BUFFER_BYTES,
      maxCommandOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
      maxCaptureBytes: MAX_CAPTURE_BYTES,
      streamHeartbeatMs: STREAM_HEARTBEAT_MS,
      // Learning each terminal's remote tty costs one exec round trip, run off
      // the open path; a host without /proc simply never learns it.
      resolveTerminalTty: true,
      // Session recording is on by default; the directory defaults to
      // ~/.dsh/harbor-logs and is resolved lazily on first use.
      sessionLogEnabled: true,
      sessionLogDir: undefined,
      // One status probe may spend most of its life on a slow or flapping
      // link; keep the bound configurable so a tailnet/latency outlier can be
      // sampled without changing the default cadence for everyone else.
      monitorProbeTimeoutMs: 4000,
      ...config
    };
    // The SSH terminal backend is mounted inside the isolated Persistent
    // terminals group and reaches this instance through the shared hub.
    publishHarborService(this);
    ctx.effect(() => () => retractHarborService(this), "harbor: service hand-off");
    // Tear down all connections when the plugin fiber unloads.
    ctx.effect(() => () => {
      for (const task of this.transferTasks.entries.values()) task.controller.abort(new Error("Plugin unloaded"));
      this.transferTasks.close();
      for (const conn of this.connections.values()) {
        conn.closing = true;
        if (conn.reconnectTimer !== null) clearTimeout(conn.reconnectTimer);
        // Unload closes tunnel listeners too: a surviving listener's late
        // accept would call forwardOut on an ended client (#32).
        this.closeConnectionTunnels(conn);
        try { conn.client?.end(); } catch {}
        for (const hop of conn.hops ?? []) { try { hop.end(); } catch {} }
      }
      this.connections.clear();
      this.sessions.clear();
      this.exitedSessions.clear();
      for (const voucher of this.operatorApprovals.values()) {
        if (voucher.timer !== undefined) clearTimeout(voucher.timer);
      }
      this.operatorApprovals.clear();
      this.activeConnectionId = null;
      this.activeConnectionByOwner?.clear();
      // Release recorded-session write streams so the fiber can unload and a
      // re-apply does not inherit half-closed file handles.
      void this.sessionLogs?.close?.().catch(() => {});
    }, "harbor: cleanup");
    // A conversation that ends must not leave a PTY behind on every server it
    // touched: the terminal belonged to that conversation, not to the server.
    ctx.effect(() => {
      const onDisposed = (session) => {
        void this.closeTerminalsForOwner?.(session?.header?.id ?? session?.id).catch(() => {});
      };
      const off = typeof ctx.on === "function" ? ctx.on("session/disposed", onDisposed) : undefined;
      return () => {
        try {
          off?.();
        } catch {}
      };
    }, "harbor: terminal ownership");
    // Streaming file routes (workbench S6 patch): reactive inject — no hard
    // activation dependency, so compositions without a webserver simply never
    // serve the byte plane. Same registration pattern the typert gateway uses
    // for the /api/remote.mux WebSocket (connection.requestRejection guard +
    // webServer.register prefix route, disposed with this fiber).
    ctx.inject(["connection", "webServer"], (hostCtx) => {
      hostCtx.effect(() => hostCtx.webServer.register({
        kind: "prefix",
        path: STREAM_ROUTE_PREFIX,
        handler: (req, res) => {
          this.handleStreamRoute(req, res, hostCtx.connection);
        }
      }), "harbor: streaming file routes");

    });
  }

  /**
   * Connections construct through this hook so the ssh2 CommonJS interop lives
   * in one place. It resolves Client through require() at call time — a stale
   * or partial capture from a plugin reload must not break this host until the
   * next restart (see host/ssh2-client.js), and tests override this hook to
   * exercise the connect paths without a transport.
   */
  newClient() {
    return createSsh2Client();
  }

  /**
   * Open one interactive terminal for a conversation.
   *
   * Ownership is resolved here, once. Each DSH conversation gets its own PTY
   * per connection: sharing one shell meant two chats' agents typed into each
   * other's terminal, read each other's output and mirrored exec results into
   * it. Re-requesting an owner's terminal returns the live one (the panel
   * re-requests on every layout change), and an owner with none may adopt the
   * connection's single anonymous terminal — that is what keeps "open a
   * terminal in the panel, then let the agent type into it" working for older
   * panel builds and for terminals opened before this change.
   */
  async openSession(request) {
    const conn = this.connections.get(request.connectionId);
    if (conn === void 0) return { ok: false, error: fail("no-connection", noConnectionGuidance(request.connectionId, this.savedResourceNameList(), this.agentAutoConnect)) };
    const ownerSessionId = normalizeOwner(request.sessionId);
    // Serialize the ownership decision with channel creation: two simultaneous
    // opens for one owner must not both conclude "no terminal yet" and create a
    // PTY each. It also keeps tty learning unambiguous — one new shell appears
    // on the transport at a time.
    const queued = Promise.resolve(conn.openQueue).then(() => this.openOwnedSession(conn, request, ownerSessionId));
    conn.openQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  /**
   * The ownership decision plus channel creation, run inside the connection's
   * open queue. Returns the existing terminal whenever one already belongs to
   * this owner, so the caller never has to know whether it was created now.
   */
  async openOwnedSession(conn, request, ownerSessionId) {
    // An agent terminal after a person took the previous one over must not
    // silently reclaim the PTY the person is now driving.
    const existing = request.forceNew === true ? undefined : pickOwnerSession(this.sessions, conn, ownerSessionId);
    if (existing !== undefined) {
      this.bindActiveConnection(request.connectionId, ownerSessionId);
      return { ok: true, value: this.sessionValue(existing, { reused: true }) };
    }
    // Adoption: a terminal that no session claims (settings page, old panel
    // build, pre-upgrade terminal) becomes this conversation's, once.
    if (request.forceNew !== true && ownerSessionId !== null && request.adopt !== false) {
      const anonymous = anonymousSessions(this.sessions, conn);
      if (anonymous.length === 1) {
        const claimed = anonymous[0];
        this.claimTerminal(conn, claimed, ownerSessionId);
        this.bindActiveConnection(request.connectionId, ownerSessionId);
        return { ok: true, value: this.sessionValue(claimed, { reused: true, adopted: true }) };
      }
    }
    if ((this.sessions?.size ?? 0) >= MAX_SESSIONS) return { ok: false, error: fail("session-limit", `too many live sessions (${MAX_SESSIONS})`) };
    if ((conn.sessions?.size ?? 0) >= MAX_SESSIONS_PER_CONNECTION) {
      return { ok: false, error: fail("terminal-limit", t("这条连接上的终端数量已达上限。服务器的单连接并发通道数有限制（sshd MaxSessions），可以在服务器端调高它，或另开一条连接到同一台机器。")) };
    }
    if (!(await this.ensureAlive(conn))) {
      return { ok: false, error: fail("connection-lost", `connection "${request.connectionId}" is down and could not be re-established`) };
    }
    const sessionId = randomUUID();
    const cols = request.cols ?? 80;
    const rows = request.rows ?? 24;
    // A saved login command replaces the resource's login shell for this
    // terminal (exec + pty, `ssh -t host bash -l` semantics): the command IS
    // the session. Resolved live from the profile table so an edit applies to
    // the next terminal without a reconnect; a lookup hiccup must not block
    // opening a plain shell, so it degrades to null. Connections without a
    // saved resource (temporary panel connects, agent connects) keep the
    // server's own login shell.
    let loginCommand = null;
    if (conn.profileId) {
      try {
        loginCommand = this.requireProfileTable().get(conn.profileId)?.loginCommand ?? null;
      } catch {}
    }
    const session = {
      id: sessionId,
      connectionId: request.connectionId,
      openedAt: new Date().toISOString(),
      openedBy: request.openedBy ?? "panel",
      cols,
      rows,
      buffer: "",
      // Browser reads drain `buffer`. Retain a separate bounded capture for
      // an explicit ssh_read without coupling it to UI polling.
      captureBuffer: "",
      captureHasDropped: false,
      // ssh_read "new" keeps a bounded raw baseline plus output received since
      // the last read. Redacting baseline + pending together preserves secrets
      // that span read boundaries, even while captureBuffer rolls over.
      lastReadRaw: undefined,
      lastReadRedacted: undefined,
      capturePendingBuffer: "",
      capturePendingTruncated: false,
      lastPrompt: null,
      waiters: [],
      streamListeners: new Set(),
      // OSC 133 markers, when the shell emits them (enableShellIntegration).
      shellIntegration: new ShellIntegrationTracker(),
      exited: null,
      stream: null,
      // The PTY receives keystrokes one at a time. Track the current command
      // locally, then allow or cancel it only when Enter is pressed.
      inputLine: "",
      inputKnown: true,
      // Which conversation owns this terminal (null = anonymous), the remote
      // tty it runs on (learned after the channel opens) and its own network
      // CLI serialization slot. All three used to live on the connection,
      // which is exactly what made two conversations interfere.
      ownerSessionId,
      tty: null,
      cliBusy: false
    };
    // Prototype-stub service instances (tests) never ran the class field
    // initializers; the maps are created on first use rather than assumed.
    this.sessions ??= new Map();
    this.exitedSessions ??= new Map();
    this.sessions.set(sessionId, session);
    this.exitedSessions.delete(sessionId);
    conn.sessions.add(sessionId);
    indexOwner(conn, sessionId, ownerSessionId);
    try {
      const stream = await new Promise((resolve, reject) => {
        const opened = (error, s) => {
          if (error) reject(error);
          else resolve(s);
        };
        // ssh2 carries agent forwarding and window resize on the exec+pty
        // channel exactly as on a shell channel (global connectConfig flag;
        // session.stream.setWindow), so the two paths converge below.
        if (loginCommand) conn.client.exec(loginCommand, { pty: { term: "xterm-256color", cols, rows } }, opened);
        else conn.client.shell({ term: "xterm-256color", cols, rows }, opened);
      });
      session.stream = stream;
      stream.on("data", (chunk) => {
        this.appendSessionOutput(session, chunk.toString("utf8"));
      });
      let remoteExit;
      stream.on("exit", (code, signal) => {
        if (Number.isInteger(code)) remoteExit = { code, reason: "remote-exit" };
        else if (signal) remoteExit = { code: 1, reason: "remote-signal" };
      });
      stream.on("close", () => {
        this.recordExit(session, remoteExit ?? { code: 1, reason: "channel-closed" });
      });
      stream.on("error", () => {
        this.recordExit(session, { code: 1, reason: "channel-error" });
      });
      // The panel opens this session immediately after a successful manual
      // connection. Remember it for THIS conversation, so agent tools can act
      // on the same server without making the model discover an opaque
      // connection id first — and without retargeting another chat's agent.
      this.bindActiveConnection(request.connectionId, ownerSessionId);
      // A terminal an agent opened on its own (ssh_write's lazy open) must
      // surface in the right-side panel too, for the conversation it belongs
      // to: the reveal request carries the owner so another chat's pane never
      // pops a tab it cannot show.
      if (session.openedBy === "agent") {
        conn.agentRevealId = randomUUID();
        if (ownerSessionId !== null) conn.agentRevealOwnerSessionId = ownerSessionId;
        else delete conn.agentRevealOwnerSessionId;
      }
      // Learn the terminal's remote tty off the open path: ssh_exec inherits
      // this terminal's directory through it (see exec-cwd.js).
      // Fire-and-forget, but never an unhandled rejection: a probe failure must
      // not surface as a process-level error on a host without /proc.
      void this.learnSessionTty(conn, session).catch(() => {});
      {
        const conn = this.connections.get(request.connectionId);
        // Recording starts with the session's FIRST output, not with the
        // session: a shell that produces nothing (an accidental tab, a probe)
        // must not leave an empty log behind.
        session.logMeta = {
          sessionId, connectionId: request.connectionId,
          name: conn?.name ?? null, host: conn?.connectConfig?.host ?? conn?.username ?? null,
          port: conn?.connectConfig?.port ?? null, openedBy: session.openedBy,
          startedAt: session.openedAt
        };
      }
    } catch (error) {
      this.sessions.delete(sessionId);
      conn.sessions.delete(sessionId);
      unindexOwner(conn, sessionId, ownerSessionId);
      return { ok: false, error: fail("shell-failed", `could not open shell on connection "${request.connectionId}"${loginCommand ? ` (login command: ${loginCommand})` : ""}: ${error.message}`) };
    }
    return { ok: true, value: this.sessionValue(session, { reused: false }) };
  }

  /**
   * Wire value for one terminal. `ownerSessionId: null` is the anonymous state
   * (a terminal no conversation claims). The RPC gateway rejects `undefined`
   * as a JSON value, so every optional field here is always present.
   */
  sessionValue(session, extra = {}) {
    return {
      sessionId: session.id,
      connectionId: session.connectionId,
      cols: session.cols,
      rows: session.rows,
      alive: session.exited === null && session.stream !== null,
      ownerSessionId: session.ownerSessionId ?? null,
      ...extra
    };
  }

  /**
   * Give an anonymous terminal to the first conversation that asks for it.
   * One-way and atomic (it runs inside the connection's open queue): a claimed
   * terminal must never be stealable later, or two chats would share it again.
   * `openedBy` is deliberately not rewritten — the log keeps saying who
   * actually opened the PTY.
   */
  claimTerminal(conn, session, ownerSessionId) {
    const previousOwner = session.ownerSessionId ?? null;
    if (ownerKey(previousOwner) === ownerKey(ownerSessionId)) return session;
    unindexOwner(conn, session.id, previousOwner);
    session.ownerSessionId = ownerSessionId;
    indexOwner(conn, session.id, ownerSessionId);
    this.log(`SSH terminal adopted: connection=${conn.id}, session=${session.id}, owner=${ownerSessionId}`);
    return session;
  }

  /**
   * Learn which remote tty this PTY runs on, off the open path.
   *
   * `ssh_exec` inherits the calling terminal's directory through the /proc
   * resolver, and that resolver used to insist on "the one foreground shell on
   * this transport" — a rule that breaks as soon as a connection carries more
   * than one terminal, which is now the normal case. Naming the tty makes the
   * target exact instead of ambiguous.
   *
   * The census is retried because a just-opened shell may not have exec'd yet,
   * and abandoned for good after two timeouts: a network-CLI device answers no
   * exec channel at all, and probing it forever would be pointless.
   */
  async learnSessionTty(conn, session) {
    // Opt-in through the service config: the constructor sets it, so a
    // prototype-stub instance (tests) never probes a fake transport.
    if (this.config?.resolveTerminalTty !== true) return;
    if (conn.ttyProbeUnsupported === true) return;
    if (conn.loginShell !== undefined && !posixLoginShell(conn.loginShell)) return;
    const before = conn.ttyCensus ?? [];
    for (const delay of TTY_PROBE_RETRY_DELAYS_MS) {
      if (delay > 0) await this.sleep(delay);
      if (session.exited !== null || session.stream === null) return;
      if (conn.closing || conn.dead || this.connections.get(conn.id) !== conn) return;
      if (conn.ttyProbeUnsupported === true) return;
      let state;
      try {
        state = await this.collectExecOutput(conn.client, buildCensusScript(), TTY_PROBE_MS);
      } catch {
        return;
      }
      if (state.timedOut && state.stdout === "") {
        conn.ttyProbeFailures = (conn.ttyProbeFailures ?? 0) + 1;
        if (conn.ttyProbeFailures >= 2) conn.ttyProbeUnsupported = true;
        return;
      }
      const rows = parseCensus(state.stdout);
      conn.ttyCensus = rows;
      if (rows.length === 0) continue;
      const candidate = pickNewTty(before, rows) ?? newestUnclaimedTty(rows, this.takenTtys(conn, session));
      if (candidate === null) continue;
      this.assignTtys(conn, rows, session, candidate);
      return;
    }
  }

  /** ttys already recorded for other live terminals of this connection. */
  takenTtys(conn, except) {
    const taken = new Set();
    for (const sessionId of conn.sessions ?? []) {
      const other = this.sessions.get(sessionId);
      if (other === undefined || other === except) continue;
      if (typeof other.tty === "string" && other.tty !== "") taken.add(other.tty);
    }
    return taken;
  }

  /**
   * Record the new terminal's tty and backfill terminals that never learned
   * their own (opened before this change, or while the census was failing).
   * The oldest unclaimed shell goes to the oldest terminal: after the fact that
   * is the only order-preserving match available.
   */
  assignTtys(conn, rows, target, tty) {
    if (target.tty === null || target.tty === undefined) target.tty = tty;
    const taken = this.takenTtys(conn, undefined);
    const pending = [];
    for (const sessionId of conn.sessions ?? []) {
      const other = this.sessions.get(sessionId);
      if (other === undefined || other.exited !== null) continue;
      if (other.tty === null || other.tty === undefined) pending.push(other);
    }
    if (pending.length === 0) return;
    pending.sort((left, right) => String(left.openedAt).localeCompare(String(right.openedAt)));
    const unclaimed = rows.slice().sort((left, right) => left.startTime - right.startTime || left.pid - right.pid);
    for (const session of pending) {
      const row = unclaimed.find((candidate) => !taken.has(candidate.tty));
      if (row === undefined) break;
      taken.add(row.tty);
      session.tty = row.tty;
    }
  }

  /**
   * Whether the cwd prologue can target this terminal exactly. A learned tty
   * makes the match exact no matter how many terminals the connection carries;
   * without one, the pre-0.3.0 rule (a single interactive shell) still holds.
   */
  cwdProbeReady(conn, session) {
    if (typeof session?.tty === "string" && session.tty !== "") return true;
    let live = 0;
    for (const sessionId of conn?.sessions ?? []) {
      const other = this.sessions.get(sessionId);
      if (other !== undefined && other.exited === null && other.stream !== null) live += 1;
    }
    return live === 1;
  }

  /**
   * Close every terminal one conversation owns, on every connection. Called
   * when DSH disposes that session: the PTY belonged to the conversation, so
   * it must not outlive it.
   */
  async closeTerminalsForOwner(ownerSessionId) {
    const owner = normalizeOwner(ownerSessionId);
    if (owner === null) return { ok: true, value: { closed: 0 } };
    this.activeConnectionByOwner?.delete(owner);
    let closed = 0;
    for (const conn of [...this.connections.values()]) {
      for (const sessionId of ownerSessionIds(conn, owner)) {
        const session = this.sessions.get(sessionId);
        if (session === undefined) {
          unindexOwner(conn, sessionId, owner);
          conn.sessions?.delete(sessionId);
          continue;
        }
        if (session.exited === null && session.stream !== null) {
          this.recordExit(session, { code: 0, reason: "session-closed" });
          try { session.stream.end(); } catch {}
        }
        this.sessions.delete(sessionId);
        unindexOwner(conn, sessionId, owner);
        conn.sessions?.delete(sessionId);
        this.rememberExit(sessionId, session.exited ?? { code: 0 });
        closed += 1;
      }
    }
    return { ok: true, value: { closed } };
  }

  async enableShellIntegration(request) {
    const session = this.sessions.get(request.sessionId);
    const conn = session && this.connections.get(session.connectionId);
    const ready = () => session && conn && this.sessions.get(request.sessionId) === session
      && !conn.dead && !conn.closing && session.exited === null && session.stream
      && session.inputKnown === true && session.inputLine === ""
      && this.cwdProbeReady(conn, session);
    if (!ready()) return { ok: false, error: fail("terminal-not-ready", t("请先结束前台程序、清空未提交输入，并确认该终端的可定位状态")) };
    try {
      if (!posixLoginShell(await this.resolveLoginShell(conn))) {
        return { ok: false, error: fail("unsupported-shell", t("无法确认此 shell 的空闲状态，请在终端手动启用")) };
      }
      const client = conn.client;
      const probe = await this.collectExecOutput(client, buildCwdAwareCommand(":", { tty: session.tty ?? null }), 5000);
      if (probe.exitCode !== 0) {
        return { ok: false, error: fail("terminal-busy", t("未确认空闲交互 shell，请结束前台程序后重试")) };
      }
      if (!ready() || client !== conn.client) {
        return { ok: false, error: fail("terminal-changed", t("终端状态已变化，请重试")) };
      }
      // Which flavour of snippet fits is the shell's own answer: a single line
      // is parsed whole, so handing zsh syntax to sh (or the reverse) would
      // abort it silently on a pipe.
      const family = await this.collectExecOutput(client, buildCwdAwareCommand(SHELL_FAMILY_PROBE, { tty: session.tty ?? null }), 5000)
 .then((result) => (result.exitCode === 0 ? parseShellFamilyProbe(result.stdout) : ""))
 .catch(() => "");
      if (!this.writeTerminalSession(session, `${shellIntegrationCommand(family)}\r`)) {
        return { ok: false, error: fail("write-failed", t("终端已停止写入")) };
      }
      return { ok: true, value: { sessionId: session.id, enabled: true } };
    } catch (error) {
      return { ok: false, error: fail("shell-integration-failed", error.message) };
    }
  }

  readTerminalContext(request) {
    const session = this.sessions.get(request.sessionId);
    if (!session) return { ok: false, error: fail("no-session", `session "${request.sessionId}" does not exist`) };
    const maxBytes = request.maxBytes ?? 24 * 1024;
    const history = this.terminalContextHistory(session);
    const relativeAfter = request.after === undefined ? undefined : request.after - history.start;
    const window = history.journal.readWindow(relativeAfter, maxBytes);
    return { ok: true, value: { sessionId: session.id, ...window, historyStart: history.start, historyEnd: history.end, offset: history.start + window.offset, nextOffset: history.start + window.nextOffset, alive: session.exited === null && session.stream !== null, exit: session.exited, redacted: history.redacted, shell: session.shellIntegration?.snapshot() ?? null } };
  }

  /** Append transport data and retain a bounded, explicit-read capture. */
  appendSessionOutput(session, text, { capture = true, observePrompt = true } = {}) {
    this.terminalOutput(session).append(text);
    // Recording must never influence the session: a broken log is swallowed.
    try {
      const store = this.sessionLogStore();
      if (store !== null && session.logMeta !== undefined) {
        if (!store.has(session.id)) void store.begin(session.logMeta).catch(() => {});
        store.append(session.id, text);
      }
    } catch { /* keep the session alive */ }
    try { session.shellIntegration?.feed(text); } catch { /* tracking is decoration */ }
    // Legacy poll readers retain their independent destructive buffer.
    session.buffer = tailCapped((session.buffer ?? "") + text, this.config.maxBufferBytes);
    if (capture) {
      const captured = session.captureBuffer ?? "";
      if (Buffer.byteLength(captured, "utf8") + Buffer.byteLength(text, "utf8") > this.config.maxCaptureBytes) {
        session.captureHasDropped = true;
      }
      session.captureBuffer = tailCapped(captured + text, this.config.maxCaptureBytes);
      const pending = session.capturePendingBuffer ?? "";
      if (Buffer.byteLength(pending, "utf8") + Buffer.byteLength(text, "utf8") > this.config.maxCaptureBytes) {
        session.capturePendingTruncated = true;
      }
      session.capturePendingBuffer = tailCapped(pending + text, this.config.maxCaptureBytes);
    }
    if (observePrompt) {
      const prompt = promptFromTerminalData(text);
      if (prompt !== null) session.lastPrompt = prompt;
    }
    this.wakeWaiters(session, null);
    this.notifyStreamListeners(session, text);
  }

  recordExit(session, exit) {
    if (session.exited !== null) return;
    session.exited = exit;
    if (exit?.reason) this.log(`SSH terminal ended: connection=${session.connectionId}, session=${session.id}, reason=${exit.reason}, code=${exit.code}`);
    try {
      const store = this.sessionLogStore();
      if (store !== null) void store.end(session.id, { exitCode: exit?.code ?? null, reason: exit?.reason }).then(() => store.prune()).catch(() => {});
    } catch { /* best-effort */ }
    // A naturally-exited shell must no longer count as an open terminal:
    // drop it from the connection's live-session set so list() reports only
    // live PTYs and the panel can offer to open a fresh one on that tab.
    if (session.connectionId !== undefined) {
      const conn = this.connections.get(session.connectionId);
      if (conn !== undefined) conn.sessions.delete(session.id);
    }
    this.wakeWaiters(session, exit);
    this.notifyStreamListeners(session, "");
    this.pruneExitedSessions?.();
  }
}

// DSH's typert loader imports `./typert` once per process and caches it by
// package name. A live plugin update (HMR) can therefore replace this class
// while the Gateway still holds the previous manifest, which made the status
// endpoint added in 0.4.0 answer HTTP 404 until DSH restarted. The source-mode
// Remote marker keeps that endpoint claimable through the Gateway's documented
// fallback; a fresh boot still dispatches through the generated strict
// manifest, so this only widens compatibility.
markSourceRemote(HarborService.prototype, "systemStats");
