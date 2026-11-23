
/**
 * Read-only system status for one connection.
 *
 * Why this does not reuse execOnConnection(): that path mirrors the command
 * and its output into the operator's terminal and runs the AI execution
 * policy. A sensor that fires every two seconds must do neither — the terminal
 * would fill with probe noise, and a read-only /proc read is not an "agent
 * command" the operator should be asked to approve. The command here is a
 * constant from probe-script.js; the only caller input is which connection to
 * look at, so there is nothing to inject and nothing to gate.
 *
 * Cost control is the hard part, not the parsing:
 * - one probe in flight per connection (a slow link must not stack channels);
 * - 1s result reuse, so two split panes on one server share one probe;
 * - #df/#diskstats/#meta on a 10s/5min cadence, carried between fast runs;
 * - a 60s "unsupported" memo (a macOS or switch host is asked once, not twice
 *   a second);
 * - failure backoff 2/4/8/30s, reported to the panel as an honest retry time.
 */
import { fail } from "../envelope.js";
import { buildProbeCommand } from "../monitor/probe-script.js";
import { parseProbe } from "../monitor/parse.js";
import { buildSample } from "../monitor/sample.js";
import { t } from "../../i18n/core.js";

const PROBE_TIMEOUT_MS = 4000;
const RESULT_CACHE_MS = 1000;
const SLOW_TTL_MS = 10000;
const UNSUPPORTED_TTL_MS = 60000;
const RETRY_DELAYS_MS = [2000, 4000, 8000, 30000];

export const withMonitor = (Base) => class extends Base {
  /** connectionId -> probe state; created lazily and pruned with connections. */
  monitorStates = new Map();

  /**
   * The probe state for one connection. Kept on the service rather than on the
   * connection record so a reconnect (new ssh2 client, same id) keeps its
   * baseline: the counters are remote-side and do not reset with the transport.
   */
  monitorState(connectionId) {
    if (!(this.monitorStates instanceof Map)) this.monitorStates = new Map();
    let state = this.monitorStates.get(connectionId);
    if (state === undefined) {
      state = {
        prev: null,
        meta: null,
        df: null,
        diskIo: null,
        diskBaseline: null,
        last: null,
        lastAt: 0,
        slowAt: 0,
        unsupportedAt: 0,
        failures: 0,
        retryAt: 0,
        inFlight: null
      };
      this.monitorStates.set(connectionId, state);
    }
    return state;
  }

  /** Drop probe state for connections that are gone (no timers involved). */
  pruneMonitorStates() {
    if (!(this.monitorStates instanceof Map)) return;
    for (const id of this.monitorStates.keys()) {
      if (!this.connections.has(id)) this.monitorStates.delete(id);
    }
  }

  /**
   * Sample one connection.
   * @param {{connectionId?: string, refresh?: boolean}} request
   * @returns {Promise<{ok: true, value: object} | {ok: false, error: {code: string, message: string}}>}
   */
  async systemStats(request = {}) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return { ok: false, error: selected.error };
    const { connectionId, connection } = selected;
    this.pruneMonitorStates();
    const state = this.monitorState(connectionId);
    const now = Date.now();
    const refresh = request.refresh === true;

    if (connection.dead === true || connection.closing === true) {
      return { ok: false, error: fail("connection-lost", t("连接已断开，正在等待重连；链路恢复后状态会自动继续。")) };
    }
    if (refresh) {
      state.retryAt = 0;
      state.unsupportedAt = 0;
    }
    if (state.inFlight !== null) return state.inFlight;
    if (state.retryAt > now) {
      const seconds = Math.max(1, Math.ceil((state.retryAt - now) / 1000));
      return { ok: false, error: fail("probe-backoff", t(`采样暂停，${seconds} 秒后自动重试`)) };
    }
    // A host without /proc is asked once a minute, not twice a second, and a
    // transient failure (a host mid-reboot, say) still gets re-checked.
    if (!refresh && state.unsupportedAt > 0 && state.last !== null && now - state.unsupportedAt < UNSUPPORTED_TTL_MS) {
      return { ok: true, value: state.last };
    }
    if (!refresh && state.last !== null && now - state.lastAt < RESULT_CACHE_MS) {
      return { ok: true, value: state.last };
    }

    const probe = this.runMonitorProbe(connectionId, connection, state, refresh);
    state.inFlight = probe;
    try {
      return await probe;
    } finally {
      state.inFlight = null;
    }
  }

  /**
   * One round trip. Never throws: every failure is turned into the envelope
   * shape the panel already understands, and arms the backoff.
   */
  async runMonitorProbe(connectionId, connection, state, refresh) {
    const now = Date.now();
    const slow = refresh || state.meta === null || state.df === null || now - state.slowAt >= SLOW_TTL_MS;
    const command = buildProbeCommand({ slow });
    const startedAt = Date.now();
    let exec;
    try {
      exec = await this.collectExecOutput(connection.client, command, this.config?.monitorProbeTimeoutMs ?? PROBE_TIMEOUT_MS);
    } catch (error) {
      return this.monitorFailure(state, t(`状态采样失败：${error?.message ?? String(error)}`));
    }
    if (connection.dead === true || connection.closing === true || connection.client === undefined) {
      return { ok: false, error: fail("connection-lost", t("采样过程中连接断开，请稍后重试。")) };
    }
    if (exec.timedOut === true) {
      return this.monitorFailure(state, t("状态采样超时（4 秒），这台服务器可能没有响应；稍后会自动重试。"));
    }

    // Parsing is defensive, but a malformed page must still not reject the
    // RPC: a sensor reports "could not sample", it never crashes the panel.
    let raw;
    let built;
    try {
      raw = parseProbe(exec.stdout);
      built = buildSample(raw, state.prev, {
        now: startedAt,
        durationMs: Date.now() - startedAt,
        carry: { meta: state.meta, df: state.df, diskIo: state.diskIo },
        diskBaseline: state.diskBaseline
      });
    } catch (error) {
      return this.monitorFailure(state, t(`状态采样结果无法解析：${error?.message ?? String(error)}`));
    }

    // Commit the probe state only after a run that produced something: a
    // garbled output must not wipe the last good slow data.
    if (raw.meta !== null) state.meta = raw.meta;
    if (raw.df !== null) state.df = raw.df;
    if (raw.diskstats !== null) state.diskBaseline = { stats: raw.diskstats, at: startedAt };
    if (slow) state.slowAt = Date.now();
    // Keep the baseline whenever it carries anything a rate can be computed
    // from: a host whose /proc/stat is unreadable can still report network
    // throughput, and dropping its snapshot would leave every rate null.
    if (built.next.cpuTotal !== null || built.next.cpuPerCore !== null || built.next.net.size > 0) state.prev = built.next;
    if (built.value.diskIo !== null) state.diskIo = built.value.diskIo;
    if (exec.truncated === true) built.value.warnings.push("truncated-output");

    state.last = built.value;
    state.lastAt = Date.now();
    state.unsupportedAt = built.supported ? 0 : Date.now();
    state.failures = 0;
    state.retryAt = 0;
    return { ok: true, value: built.value };
  }

  /** Arm the backoff and report the reason the panel should show. */
  monitorFailure(state, message) {
    state.failures += 1;
    const delay = RETRY_DELAYS_MS[Math.min(state.failures - 1, RETRY_DELAYS_MS.length - 1)];
    state.retryAt = Date.now() + delay;
    return { ok: false, error: fail("probe-failed", message) };
  }
};
