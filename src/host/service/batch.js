/**
 * Operator-approved batch command runs across saved resources.
 */
import { randomUUID } from "node:crypto";
import { assessShellCommand } from "../safety.js";
import { fail } from "../envelope.js";
import { t } from "../../i18n/core.js";
import { BATCH_MAX_CONCURRENCY, BATCH_TASK_LIMIT } from "./constants.js";

/** How long a plan nobody answered stays pending before it is forgotten. */
export const BATCH_TASK_TTL_MS = 30 * 60 * 1000;

/**
 * The name/host of one saved resource, for a result row that has no host to ask.
 * `runCommandOnProfile` reports them only on success, and a failed row still has
 * to say which server it failed on. An unknown id (deleted mid-run) degrades to
 * empty strings, which is the shape the RPC schema and the dialog expect.
 *
 * @param {object} service - the composed Harbor service.
 * @param {string} profileId - one batch target.
 * @returns {{name: string, host: string}}
 */
function profileIdentity(service, profileId) {
  try {
    const record = service.requireProfileTable().get(profileId);
    return { name: record?.name ?? "", host: record?.host ?? "" };
  } catch {
    return { name: "", host: "" };
  }
}

export const withBatch = (Base) => class extends Base {
  /**
   * Forget plans nobody answered within the TTL.
   *
   * `batchPlan` stops accepting work at BATCH_TASK_LIMIT, and an agent that
   * keeps calling ssh_batch used to sit at that ceiling for good: the only way
   * back was running or cancelling every stale plan by hand.
   */
  pruneBatchTasks(now = Date.now()) {
    for (const [id, task] of this.batchTasks) {
      const created = Date.parse(task.createdAt ?? "");
      if (Number.isFinite(created) && now - created > BATCH_TASK_TTL_MS) this.batchTasks.delete(id);
    }
  }

  batchPlan(request) {
    this.pruneBatchTasks();
    // Deliberately tier-blind: the multi-server path always marks destructive
    // commands for operator confirmation regardless of any execution policy —
    // fanning out to many machines is a different risk dimension from a
    // single-connection release, and the operator's click stays the gate.
    const decision = assessShellCommand(request.command);
    // Clamp here, not just in the RPC schema: the ssh_batch tool calls this
    // method directly and bypasses zod, so an agent-supplied timeout_ms must
    // still land inside the 1s–120s window.
    const timeoutMs = Math.min(120000, Math.max(1000, request.timeoutMs ?? 30000));
    if (this.batchTasks.size >= BATCH_TASK_LIMIT) {
      return { ok: false, error: fail("batch-limit", t(`待处理的批量任务过多（上限 ${BATCH_TASK_LIMIT} 个），请先执行或取消已有任务`)) };
    }
    const task = {
      batchId: randomUUID(),
      command: request.command.trim(),
      timeoutMs,
      dangerous: !decision.ok,
      reason: decision.ok ? null : (decision.category ?? decision.reason),
      createdAt: new Date().toISOString()
    };
    this.batchTasks.set(task.batchId, task);
    return { ok: true, value: { task } };
  }

  batchTaskList() {
    this.pruneBatchTasks();
    return { ok: true, value: { tasks: [...this.batchTasks.values()] } };
  }

  async batchRun(request) {
    const task = this.batchTasks.get(request.batchId);
    if (!task) return { ok: false, error: fail("batch-missing", t(`批量任务 "${request.batchId}" 不存在或已执行`)) };
    if (request.profileIds.length === 0) return { ok: false, error: fail("batch-no-targets", t("未选择任何服务器")) };
    this.batchTasks.delete(request.batchId);
    // Fixed worker pool over the target list; results keep the requested order
    // via index-addressed slots.
    const targets = request.profileIds;
    const results = new Array(targets.length);
    let next = 0;
    const worker = async () => {
      while (next < targets.length) {
        const index = next++;
        const profileId = targets[index];
        try {
          const r = await this.runCommandOnProfile(profileId, task.command, task.timeoutMs);
          if (!r.ok) {
            // A row that failed before the command ran used to lose its name and
            // host, so the result table showed an empty label against the one
            // target whose failure the operator most needs to identify. The
            // saved resource still knows both.
            results[index] = { profileId, ...profileIdentity(this, profileId), ok: false, exitCode: null, stdout: "", stderr: "", error: r.error.message, timedOut: false, truncated: false };
          } else {
            // A command killed by the per-host deadline did NOT succeed: the
            // exit status is unknown and the output is only what arrived before
            // the deadline. Both facts travel with the row — the result schema
            // used to drop timedOut/truncated, so the panel drew a green check
            // for a host whose command was killed and whose tail was cut.
            const timedOut = r.value.timedOut === true;
            results[index] = {
              profileId,
              name: r.value.name,
              host: r.value.host,
              ok: !timedOut,
              exitCode: r.value.exitCode,
              stdout: r.value.stdout,
              stderr: r.value.stderr,
              error: timedOut
                ? t(`命令在 ${Math.round(task.timeoutMs / 1000)} 秒内没有结束，已终止；上面是终止前收到的输出`)
                : null,
              timedOut,
              truncated: r.value.truncated === true
            };
          }
        } catch (error) {
          results[index] = { profileId, ...profileIdentity(this, profileId), ok: false, exitCode: null, stdout: "", stderr: "", error: error.message, timedOut: false, truncated: false };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(BATCH_MAX_CONCURRENCY, targets.length) }, () => worker()));
    return { ok: true, value: { results } };
  }

  batchCancel(request) {
    const cancelled = this.batchTasks.delete(request.batchId);
    return { ok: true, value: { cancelled } };
  }

  /** Connect a saved profile, run one command, then disconnect. Batch channel only. */
  async runCommandOnProfile(profileId, command, timeoutMs = 30000) {
    const record = this.requireProfileTable().get(profileId);
    if (record === undefined) return { ok: false, error: fail("no-profile", `SSH resource "${profileId}" does not exist`) };
    // Ephemeral: never let a batch target become the panel/agent's active
    // connection (it is disconnected as soon as the command finishes).
    const connect = await this.profileConnect({ profileId, activate: false });
    if (!connect.ok) return connect;
    const connectionId = connect.value.connectionId;
    try {
      const raw = await this.execRawOnClient(this.connections.get(connectionId).client, command, timeoutMs);
      if (!raw.ok) return raw;
      return { ok: true, value: { ...raw.value, profileId, name: record.name, host: record.host } };
    } catch (error) {
      return { ok: false, error: fail("exec-failed", error.message) };
    } finally {
      await this.disconnect({ connectionId }).catch(() => {});
    }
  }
};
