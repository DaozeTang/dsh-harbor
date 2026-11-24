/**
 * PTY sessions: buffers, reads, cursor streams and terminal context history.
 */
import { createTerminalOutput } from "../terminal-output.js";
import { isOwnedBy, normalizeOwner, unindexOwner } from "../terminal-owner.js";
import { redactForModel } from "../redact.js";
import { noteTerminalInput } from "../ssh-upload-scheduling.js";
import { buildCwdAwareCommand, extractExecCwd, posixLoginShell } from "../exec-cwd.js";
import { fail } from "../envelope.js";
import { t } from "../../i18n/core.js";
import { decodeData, encodeData } from "./text.js";
import { MAX_EXITED_RETAINED, MAX_EXIT_TOMBSTONES } from "./constants.js";

export const withSessions = (Base) => class extends Base {
  async write(request) {
    const session = this.sessions.get(request.sessionId);
    if (session === void 0) return { ok: false, error: fail("no-session", `session "${request.sessionId}" does not exist`) };
    if (session.exited !== null || session.stream === null) return { ok: false, error: fail("exited", `session "${request.sessionId}" has already exited`) };
    let text;
    try {
      text = decodeData(request.data);
    } catch {
      return { ok: false, error: fail("bad-data", "input is not valid base64") };
    }
    try {
      if (text) {
        // This path is interactive operator input and stays unguarded. The
        // standing boundary is that a human's own keystrokes are never
        // policed; agent calls go through the persistent-terminal backend.
        // The first keystroke also hands an agent terminal to the person,
        // which is what stops terminal_send from typing over them.
        this.notePanelInput(session.id);
        noteTerminalInput(this.connections?.get(session.connectionId));
        session.stream.write(text);
        this.updateInputMirror(session, text);
      }
    } catch (error) {
      return { ok: false, error: fail("write-failed", error.message) };
    }
    return { ok: true, value: { written: text.length } };
  }

  /** Explicit UI action: refuse drafts, foreground jobs, and ambiguous PTYs. */
  async changeDirectory(request) {
    if (typeof request.path !== "string" || !request.path.startsWith("/") || /[\x00-\x1f\x7f]/.test(request.path)) {
      return { ok: false, error: fail("bad-path", t("目录必须是绝对路径，且不能包含控制字符")) };
    }
    const session = this.sessions.get(request.sessionId);
    const conn = session && this.connections.get(session.connectionId);
    const ready = () => session && conn && this.sessions.get(request.sessionId) === session
      && !conn.dead && !conn.closing && session.exited === null && session.stream
      && session.inputKnown === true && session.inputLine === ""
      && this.cwdProbeReady(conn, session);
    if (!ready()) return { ok: false, error: fail("terminal-not-ready", t("请先结束前台程序、清空未提交输入，并确认该终端的可定位状态")) };
    const revision = session.inputRevision ?? 0;
    const client = conn.client;
    try {
      if (!posixLoginShell(await this.resolveLoginShell(conn))) {
        return { ok: false, error: fail("unsupported-shell", t("无法确认此 shell 的空闲状态，请在终端手动切换目录")) };
      }
      const probe = await this.collectExecOutput(client, buildCwdAwareCommand(":", { tty: session.tty ?? null }), 5000);
      if (probe.exitCode !== 0 || extractExecCwd(probe.stdout).cwd === null) {
        return { ok: false, error: fail("terminal-busy", t("未确认空闲交互 shell，请结束前台程序后重试或手动 cd")) };
      }
      if (!ready() || client !== conn.client || revision !== (session.inputRevision ?? 0)) {
        return { ok: false, error: fail("terminal-changed", t("终端输入已变化，请检查后重试")) };
      }
      const quoted = "'" + request.path.replace(/'/g, "'\\''") + "'";
      if (!this.writeTerminalSession(session, `cd -- ${quoted}\r`)) {
        return { ok: false, error: fail("write-failed", t("终端已停止写入")) };
      }
      return { ok: true, value: { written: 0 } };
    } catch (error) {
      return { ok: false, error: fail("cd-failed", error.message) };
    }
  }

  async read(request) {
    const session = this.sessions.get(request.sessionId);
    if (session === void 0) {
      const exit = this.exitedSessions.get(request.sessionId);
      if (exit !== void 0) return { ok: true, value: { data: "", exit } };
      return { ok: false, error: fail("no-session", `session "${request.sessionId}" does not exist`) };
    }
    // Cursor readers share the append-only journal. This keeps stream-to-poll
    // fallback exact and lets multiple panes observe the same bytes without
    // competing for a destructive buffer.
    if (request.after !== undefined) {
      const journal = this.terminalOutput(session);
      const available = journal.read(request.after);
      if (available.data !== "" || session.exited !== null) {
        return { ok: true, value: { ...available, data: encodeData(available.data), exit: session.exited } };
      }
      const timeoutMs = request.timeoutMs ?? this.config.defaultReadTimeoutMs;
      return new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const index = session.waiters.indexOf(waiter);
          if (index >= 0) session.waiters.splice(index, 1);
          const item = journal.read(request.after);
          resolve({ ok: true, value: { ...item, data: encodeData(item.data), exit: session.exited } });
        };
        const timer = setTimeout(finish, timeoutMs);
        const waiter = { resolve: finish, timer, cursor: true };
        session.waiters.push(waiter);
      });
    }
    if (session.exited !== null) {
      return { ok: true, value: { data: this.drain(session), exit: session.exited } };
    }
    const pending = this.drain(session);
    if (pending !== "") {
      return { ok: true, value: { data: pending, exit: null } };
    }
    const timeoutMs = request.timeoutMs ?? this.config.defaultReadTimeoutMs;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const index = session.waiters.indexOf(waiter);
        if (index >= 0) session.waiters.splice(index, 1);
        resolve(value);
      };
      const timer = setTimeout(() => {
        finish({ ok: true, value: { data: this.drain(session), exit: null } });
      }, timeoutMs);
      const waiter = { resolve: finish, timer };
      session.waiters.push(waiter);
    });
  }

  listTerminalContexts(request = {}) {
    // The caller's own terminals are what it usually wants, and the panel needs
    // to tell "my terminal" from "another conversation's" for the same server.
    const ownerSessionId = normalizeOwner(request.sessionId);
    const sessions = [];
    for (const session of this.sessions.values()) {
      const connection = this.connections.get(session.connectionId);
      if (!connection) continue;
      const history = this.terminalContextHistory(session);
      const item = { sessionId: session.id, connectionId: session.connectionId, host: connection.host, port: connection.port, openedAt: session.openedAt, openedBy: session.openedBy ?? "panel", alive: session.exited === null && session.stream !== null, historyStart: history.start, historyEnd: history.end, ownerSessionId: session.ownerSessionId ?? null, mine: isOwnedBy(session, ownerSessionId) };
      if (connection.name !== undefined) item.name = connection.name;
      sessions.push(item);
    }
    return { ok: true, value: { sessions } };
  }

  /**
   * Stream-push terminal output (typert mode:'stream', WebSocket mux carrier).
   * Each yielded item reuses the read() envelope so the client render path is
   * identical to polling; items are validated by the gateway against the
   * descriptor's strict result codec. Ends when the session exits or the
   * caller's AbortSignal fires — the client falls back to 300ms polling if the
   * stream can't be opened or breaks.
   */
  async *terminalStream(request, signal) {
    const session = this.sessions.get(request.sessionId);
    if (session === void 0) {
      const exit = this.exitedSessions?.get(request.sessionId);
      yield exit ? { ok: true, value: { data: "", exit } } : { ok: false, error: fail("no-session", `session "${request.sessionId}" does not exist`) };
      return;
    }
    const journal = this.terminalOutput(session);
    const listener = { wake: null, timer: null };
    session.streamListeners ??= new Set();
    session.streamListeners.add(listener);
    let cursor = request.after;
    const abort = () => listener.wake?.();
    signal?.addEventListener("abort", abort);
    try {
      let heartbeatFired = false;
      while (!signal?.aborted) {
        const item = journal.read(cursor);
        const exit = session.exited;
        if (item.data !== "" || exit !== null || heartbeatFired) {
          cursor = item.offset;
          yield { ok: true, value: { ...item, data: encodeData(item.data), exit } };
        }
        if (exit !== null || signal?.aborted) return;
        // Output can arrive while suspended at yield. Do not sleep over it.
        if (journal.read(cursor).data !== "") continue;
        heartbeatFired = false;
        await new Promise((resolve) => {
          listener.wake = resolve;
          listener.timer = setTimeout(() => {
            heartbeatFired = true;
            resolve();
          }, this.config.streamHeartbeatMs);
        });
        listener.wake = null;
        clearTimeout(listener.timer);
        listener.timer = null;
      }
    } finally {
      clearTimeout(listener.timer);
      session.streamListeners.delete(listener);
      signal?.removeEventListener("abort", abort);
      // History belongs to the session, not its readers. No per-reader
      // copyback: simultaneous cancellations cannot duplicate output.
    }
  }

  terminalContextHistory(session) {
    const raw = this.terminalOutput(session).read();
    const safe = redactForModel(raw.data);
    const journal = createTerminalOutput(safe.text, Number.MAX_SAFE_INTEGER);
    return { journal, start: raw.startOffset, end: raw.startOffset + safe.text.length, redacted: safe.redacted };
  }

  terminalOutput(session) {
    session.outputJournal ??= createTerminalOutput(session.buffer ?? "", this.config.maxBufferBytes);
    return session.outputJournal;
  }

  async resize(request) {
    const session = this.sessions.get(request.sessionId);
    if (session === void 0) return { ok: false, error: fail("no-session", `session "${request.sessionId}" does not exist`) };
    if (session.stream === null || session.exited !== null) return { ok: false, error: fail("exited", `session "${request.sessionId}" is not alive`) };
    try {
      session.stream.setWindow(request.rows, request.cols);
    } catch (error) {
      return { ok: false, error: fail("resize-failed", error.message) };
    }
    session.cols = request.cols;
    session.rows = request.rows;
    return { ok: true, value: { cols: request.cols, rows: request.rows } };
  }

  async closeSession(request) {
    const session = this.sessions.get(request.sessionId);
    if (session === void 0) return { ok: false, error: fail("no-session", `session "${request.sessionId}" does not exist`) };
    this.sessions.delete(request.sessionId);
    const conn = this.connections.get(session.connectionId);
    if (conn) {
      conn.sessions.delete(request.sessionId);
      unindexOwner(conn, session.id, session.ownerSessionId);
    }
    if (session.exited === null && session.stream !== null) {
      this.recordExit(session, { code: 0, reason: "operator-close" });
      try { session.stream.end(); } catch {}
    }
    this.rememberExit(request.sessionId, session.exited ?? { code: 0 });
    return { ok: true, value: { closed: true } };
  }

  fallbackPrompt(connection) {
    return `${connection.username}@${connection.host}:~${connection.username === "root" ? "#" : "$"} `;
  }

  rememberExit(id, exit) {
    if (this.exitedSessions.size >= MAX_EXIT_TOMBSTONES) {
      const oldest = this.exitedSessions.keys().next().value;
      if (oldest !== void 0) this.exitedSessions.delete(oldest);
    }
    this.exitedSessions.set(id, exit);
  }

  /**
   * Keep only the newest N exited terminals. A naturally exited shell is not
   * deleted by anyone (the browser may still ask for its final output), but it
   * must not hold a slot against MAX_SESSIONS forever: a long-lived web profile
   * would eventually refuse every new terminal. The oldest exited records are
   * tombstoned so late readers still receive their exit status.
   */
  pruneExitedSessions(keep = MAX_EXITED_RETAINED) {
    const exited = [...this.sessions.entries()].filter(([, session]) => session.exited !== null);
    for (let index = 0; index < exited.length - keep; index += 1) {
      const [sessionId, session] = exited[index];
      this.rememberExit(sessionId, session.exited);
      this.sessions.delete(sessionId);
      const conn = this.connections.get(session.connectionId);
      if (conn !== undefined) {
        conn.sessions.delete(sessionId);
        unindexOwner(conn, sessionId, session.ownerSessionId);
      }
    }
  }

  wakeWaiters(session, exit) {
    if (session.waiters.length === 0) return;
    const cursorWaiters = session.waiters.filter((waiter) => waiter.cursor);
    session.waiters = session.waiters.filter((waiter) => !waiter.cursor);
    for (const waiter of cursorWaiters) waiter.resolve();
    if (session.waiters.length === 0) return;
    session.waiters.shift().resolve({
      ok: true,
      value: { data: this.drain(session), exit }
    });
    if (exit !== null) {
      for (const rest of session.waiters.splice(0)) {
        rest.resolve({ ok: true, value: { data: "", exit } });
      }
    }
  }

  /** Feed appended output to stream-push consumers; every listener sees every item. */
  notifyStreamListeners(session, _text) {
    if (session.streamListeners === undefined) return;
    for (const listener of session.streamListeners) {
      listener.wake?.();
    }
  }

  drain(session) {
    const pending = session.buffer;
    session.buffer = "";
    return encodeData(pending);
  }
};