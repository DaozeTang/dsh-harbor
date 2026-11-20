/**
 * dsh-harbor host half: a Typert Remote service named harbor that manages
 * ssh2 connections and PTY shell sessions, streaming output to the browser
 * through long-poll reads. Also registers agent tools (ssh_connect, ssh_exec,
 * ...) so the main conversation can drive the same sessions the panel shows.
 *
 * The service body is composed from src/host/service/*; this entry keeps the
 * constructor, the ssh2 CommonJS interop and the session wiring that the
 * service crosses with recording/shell integration.
 */
import ssh2 from "ssh2";
import { randomUUID } from "node:crypto";
import { fail } from "./host/envelope.js";
import { noConnectionGuidance } from "./host/agent-connect.js";
import { ShellIntegrationTracker, SHELL_FAMILY_PROBE, parseShellFamilyProbe, shellIntegrationCommand } from "./host/shell-integration.js";
import { buildCwdAwareCommand, posixLoginShell } from "./host/exec-cwd.js";
import { t } from "./i18n/core.js";
import { HarborServiceCore } from "./host/service/index.js";
import { MAX_BUFFER_BYTES, MAX_COMMAND_OUTPUT_BYTES, MAX_CAPTURE_BYTES, MAX_SESSIONS, READ_TIMEOUT_MS, STREAM_HEARTBEAT_MS, STREAM_ROUTE_PREFIX } from "./host/service/constants.js";
import { encodeData, promptFromTerminalData, tailCapped } from "./host/service/text.js";

export { LEGACY_VRP_ALGORITHMS, isKexMismatchError } from "./host/service/constants.js";
export { profileDomainSpec, credentialDomainSpec, knownHostDomainSpec, settingsDomainSpec, normalizeDefaultUsername, loadSettingsRecord } from "./host/service/models.js";
export { normalizeTerminalEol } from "./host/service/text.js";

const { Client } = ssh2;

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
      // Session recording is on by default; the directory defaults to
      // ~/.dsh/harbor-logs and is resolved lazily on first use.
      sessionLogEnabled: true,
      sessionLogDir: undefined,
      ...config
    };
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
      // Release recorded-session write streams so the fiber can unload and a
      // re-apply does not inherit half-closed file handles.
      void this.sessionLogs?.close?.().catch(() => {});
    }, "harbor: cleanup");
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
   * ssh2 is CommonJS: its default export is the only interop shape that
   * exposes Client. Connections construct through this hook so the interop
   * stays in the entry that owns the import.
   */
  newClient() {
    return new Client();
  }

  async openSession(request) {
    const conn = this.connections.get(request.connectionId);
    if (conn === void 0) return { ok: false, error: fail("no-connection", noConnectionGuidance(request.connectionId, this.savedResourceNameList(), this.agentAutoConnect)) };
    if (this.sessions.size >= MAX_SESSIONS) return { ok: false, error: fail("session-limit", `too many live sessions (${MAX_SESSIONS})`) };
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
      inputKnown: true
    };
    this.sessions.set(sessionId, session);
    this.exitedSessions.delete(sessionId);
    conn.sessions.add(sessionId);
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
      // connection. Remember it so agent tools can act on the same server
      // without making the model discover an opaque connection id first.
      this.activeConnectionId = request.connectionId;
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
      return { ok: false, error: fail("shell-failed", `could not open shell on connection "${request.connectionId}"${loginCommand ? ` (login command: ${loginCommand})` : ""}: ${error.message}`) };
    }
    return {
      ok: true,
      value: {
        sessionId,
        connectionId: request.connectionId,
        cols,
        rows,
        alive: true
      }
    };
  }

  async enableShellIntegration(request) {
    const session = this.sessions.get(request.sessionId);
    const conn = session && this.connections.get(session.connectionId);
    const ready = () => session && conn && this.sessions.get(request.sessionId) === session
      && !conn.dead && !conn.closing && session.exited === null && session.stream
      && session.inputKnown === true && session.inputLine === ""
      && conn.sessions.size === 1;
    if (!ready()) return { ok: false, error: fail("terminal-not-ready", t("请先结束前台程序、清空未提交输入，并仅保留一个交互终端")) };
    try {
      if (!posixLoginShell(await this.resolveLoginShell(conn))) {
        return { ok: false, error: fail("unsupported-shell", t("无法确认此 shell 的空闲状态，请在终端手动启用")) };
      }
      const client = conn.client;
      const probe = await this.collectExecOutput(client, buildCwdAwareCommand(":"), 5000);
      if (probe.exitCode !== 0) {
        return { ok: false, error: fail("terminal-busy", t("未确认空闲交互 shell，请结束前台程序后重试")) };
      }
      if (!ready() || client !== conn.client) {
        return { ok: false, error: fail("terminal-changed", t("终端状态已变化，请重试")) };
      }
      // Which flavour of snippet fits is the shell's own answer: a single line
      // is parsed whole, so handing zsh syntax to sh (or the reverse) would
      // abort it silently on a pipe.
      const family = await this.collectExecOutput(client, buildCwdAwareCommand(SHELL_FAMILY_PROBE), 5000)
 .then((result) => (result.exitCode === 0 ? parseShellFamilyProbe(result.stdout) : ""))
 .catch(() => "");
      const written = await this.write({ sessionId: session.id, data: encodeData(`${shellIntegrationCommand(family)}\r`) });
      if (!written.ok) return written;
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