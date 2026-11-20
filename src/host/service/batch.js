/**
 * Operator-approved batch command runs across saved resources.
 */
import { randomUUID } from "node:crypto";
import { assessShellCommand } from "../safety.js";
import { fail } from "../envelope.js";
import { t } from "../../i18n/core.js";
import { BATCH_MAX_CONCURRENCY } from "./constants.js";

export const withBatch = (Base) => class extends Base {
  batchPlan(request) {
    // Deliberately tier-blind: the multi-server path always marks destructive
    // commands for operator confirmation regardless of any execution policy —
    // fanning out to many machines is a different risk dimension from a
    // single-connection release, and the operator's click stays the gate.
    const decision = assessShellCommand(request.command);
    // Clamp here, not just in the RPC schema: the ssh_batch tool calls this
    // method directly and bypasses zod, so an agent-supplied timeout_ms must
    // still land inside the 1s–120s window.
    const timeoutMs = Math.min(120000, Math.max(1000, request.timeoutMs ?? 30000));
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
          if (!r.ok) results[index] = { profileId, name: "", host: "", ok: false, exitCode: null, stdout: "", stderr: "", error: r.error.message };
          else results[index] = { profileId, name: r.value.name, host: r.value.host, ok: true, exitCode: r.value.exitCode, stdout: r.value.stdout, stderr: r.value.stderr, error: null };
        } catch (error) {
          results[index] = { profileId, name: "", host: "", ok: false, exitCode: null, stdout: "", stderr: "", error: error.message };
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
