/**
 * Durable terminal session recordings.
 */
import { homedir } from "node:os";
import { join as joinPath } from "node:path";
import { SessionLogStore } from "../session-log.js";
import { fail } from "../envelope.js";
import { t } from "../../i18n/core.js";

export const withSessionLogs = (Base) => class extends Base {
  // ── session logs ───────────────────────────────────────────────────────────

  async sessionLogList() {
    const store = this.sessionLogStore();
    if (store === null) return { ok: true, value: { enabled: false, logs: [] } };
    return { ok: true, value: { enabled: true, logs: await store.list() } };
  }

  /** Internal agent-only byte snapshot; the panel continues to use raw paging. */
  async sessionLogSnapshot(sessionId, maxBytes) {
    const store = this.sessionLogStore();
    if (store === null) return { ok: false, error: fail("session-log-disabled", "Session recording is disabled") };
    const result = await store.snapshot(sessionId, maxBytes);
    if (!result.ok) return { ok: false, error: fail("session-log-read-failed", `Cannot safely read session log: ${result.reason}`) };
    return { ok: true, value: result.data };
  }

  async sessionLogRead(request) {
    const store = this.sessionLogStore();
    if (store === null) {
      return { ok: false, error: fail("session-log-disabled", t("会话录制已关闭（config.sessionLogEnabled = false）")) };
    }
    const result = await store.read(request.sessionId, { offset: request.offset, maxBytes: request.maxBytes });
    if (result.ok !== true) {
      return { ok: false, error: fail("no-session-log", t(`会话日志不存在：${request.sessionId}`)) };
    }
    return {
      ok: true,
      value: {
        sessionId: request.sessionId, data: result.data,
        startOffset: result.startOffset, nextOffset: result.nextOffset, eof: result.eof, size: result.size
      }
    };
  }

  async sessionLogSearch(request) {
    const store = this.sessionLogStore();
    if (store === null) {
      return { ok: false, error: fail("session-log-disabled", t("会话录制已关闭（config.sessionLogEnabled = false）")) };
    }
    const result = await store.search(request.sessionId, { query: request.query, maxHits: request.maxHits });
    if (result.ok !== true) {
      return { ok: false, error: fail("no-session-log", t(`会话日志不存在：${request.sessionId}`)) };
    }
    return {
      ok: true,
      value: { sessionId: request.sessionId, hits: result.hits, scannedBytes: result.scannedBytes, stoppedEarly: result.stoppedEarly }
    };
  }

  async sessionLogDelete(request) {
    const store = this.sessionLogStore();
    if (store === null) return { ok: true, value: { deleted: 0, remaining: 0 } };
    const deleted = request.sessionId === undefined
      ? (await store.removeAll()).deleted
 : ((await store.remove(request.sessionId)), 1);
    return { ok: true, value: { deleted, remaining: (await store.list()).length } };
  }

  /**
   * The session-log store, created on first use. Returns null when recording
   * is switched off in config; every call site treats null as "not recording".
   */
  sessionLogStore() {
    if (this.config.sessionLogEnabled === false) return null;
    if (this.sessionLogs === undefined || this.sessionLogs === null) {
      const dir = this.config.sessionLogDir ?? joinPath(homedir(), ".dsh", "harbor-logs");
      this.sessionLogs = new SessionLogStore({ dir });
      // Enforce the total budget the store documents, including files written
      // by a previous run; firing this once per process is enough.
      if (this.sessionLogPruned !== true) {
        this.sessionLogPruned = true;
        void this.sessionLogs.prune().catch(() => {});
      }
    }
    return this.sessionLogs;
  }
};