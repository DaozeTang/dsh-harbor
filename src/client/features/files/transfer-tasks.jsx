/**
 * The three transfer sections above the listing: the agent's upload tasks, the
 * browser's own transfers and the unfinished (resumable) downloads.
 *
 * Presentational: the registries live in hooks/useTransfers.js and
 * hooks/useDownloads.js; this file only renders what they report.
 */
import * as React from "react";
import { Badge, Button, IconButton, ProgressBar, Section } from "../../ui/kit.jsx";
import { formatBytes } from "../../core/format.js";
import { t } from "../../../i18n/core.js";

const { Fragment } = React;

/** One wording for a transfer's state, shared by the local and agent lists. */
function taskStatus(task) {
  if (task.status === "done") return t("已完成");
  if (task.status === "cancelled") return t("已取消");
  if (task.status === "failed") return t("失败");
  if (task.resuming) return t("正在验证并续传…");
  if (task.verifying) return t("正在计算远端校验值…");
  if (task.writing) return t("远端写入中");
  return t("进行中");
}

export function TransferTasks({
  agentTasks, canDiscardAgentTasks, onCancelAgentTask, onDiscardAgentTask,
  tasks, onCancelTask, onClearFinished,
  checkpoints, onResumeCheckpoint, onDiscardCheckpoint
}) {
  return (
    <Fragment>
      {agentTasks.length > 0 && (
        <div className="hb-files__section">
          <Section title={t("AI 上传任务")}>
            <div className="hb-files__tasks">
              {agentTasks.map((task) => (
                <div key={task.id} className="hb-files__task" role="status">
                  <div className="hb-files__taskline">
                    <span className="hb-truncate" title={task.id}>{task.source.split(/[\\/]/).pop()} → {task.target}</span>
                    <span className="hb-spacer" />
                    {task.status === "running" && (
                      <IconButton
                        icon="stop-fill"
                        size="sm"
                        label={t("取消")}
                        onClick={() => onCancelAgentTask(task)}
                      />
                    )}
                    {(task.status === "failed" || task.status === "cancelled") && canDiscardAgentTasks && (
                      <IconButton
                        icon="trash-outline"
                        size="sm"
                        danger
                        label={t("清理残留")}
                        onClick={() => onDiscardAgentTask(task)}
                      />
                    )}
                  </div>
                  <div className="hb-quiet">
                    {task.status === "running" ? t("进行中") : task.status === "done" ? t("已完成") : task.status === "cancelled" ? t("已取消") : t("失败")}
                    {task.error ? ` · ${task.error}` : ""}
                  </div>
                  {task.status === "running" && (
                    <ProgressBar value={task.sent ?? 0} max={Math.max(task.total ?? 1, 1)} label={task.id} />
                  )}
                  {(task.status === "failed" || task.status === "cancelled") && (
                    <div className="hb-quiet">{t("可使用任务 ID 续传")}：{task.id}</div>
                  )}
                </div>
              ))}
            </div>
          </Section>
        </div>
      )}

      {tasks.length > 0 && (
        <div className="hb-files__section">
          <Section
            title={t("传输任务")}
            action={
              <Button variant="ghost" size="sm" onClick={onClearFinished}>
                {t("清除已结束")}
              </Button>
            }
          >
            <div className="hb-files__tasks">
              {tasks.map((task) => (
                <div key={task.id} className="hb-files__task" role="status">
                  <div className="hb-files__taskline">
                    <Badge tone={task.status === "failed" ? "err" : task.status === "done" ? "ok" : "neutral"}>
                      {task.kind === "upload" ? t("上传") : t("下载")}
                    </Badge>
                    <span className="hb-truncate" title={task.name}>{task.name}</span>
                    <span className="hb-spacer" />
                    {task.status === "running" && task.cancellable === true && (
                      <IconButton icon="stop-fill" size="sm" label={t("取消")} onClick={() => onCancelTask(task.id)} />
                    )}
                  </div>
                  <div className="hb-quiet">
                    {taskStatus(task)}
                    {task.skipped > 0 ? ` · ${t(`已跳过 ${task.skipped} 个文件`)}` : ""}
                    {task.error ? ` · ${task.error}` : ""}
                  </div>
                  {task.status === "running" && !task.verifying && !task.resuming && task.kind === "download" && task.speed > 0 && (
                    <div className="hb-quiet hb-numeric">
                      {formatBytes(task.sent)}
                      {task.total !== null && task.total !== undefined ? ` / ${formatBytes(task.total)}` : ""}
                      {` · ${formatBytes(task.speed)}/s`}
                      {task.total !== null && task.total !== undefined && task.sent < task.total
                        ? ` · ${t("剩余约")} ${Math.ceil((task.total - task.sent) / task.speed)}s`
                        : ""}
                    </div>
                  )}
                  {task.status === "running" && (task.verifying || task.resuming ? (
                    <Fragment>
                      <ProgressBar
                        value={task.verification?.total > 0 ? Math.min(task.verification.bytes, task.verification.total) : 0}
                        max={task.verification?.total || 1}
                        label={t("正在计算远端校验值…")}
                      />
                      {task.verification !== undefined && task.verification !== null && (
                        <div className="hb-quiet hb-numeric">{formatBytes(task.verification.bytes)} / {formatBytes(task.verification.total)}</div>
                      )}
                    </Fragment>
                  ) : task.total !== null && task.total !== undefined ? (
                    <ProgressBar value={task.sent ?? 0} max={Math.max(task.total, 1)} label={task.name} />
                  ) : null)}
                </div>
              ))}
            </div>
          </Section>
        </div>
      )}

      {/* Unfinished downloads live next to the transfer list: they are a
        * transfer state, not a property of the listing. */}
      {checkpoints.length > 0 && (
        <div className="hb-files__section">
          <Section title={t("未完成的下载")}>
            <div className="hb-files__tasks">
              {checkpoints.map((checkpoint) => (
                <div key={checkpoint.id} className="hb-files__task">
                  <div className="hb-files__taskline">
                    <span className="hb-files__grow hb-mono hb-truncate" title={checkpoint.path}>{checkpoint.path}</span>
                    <span className="hb-quiet hb-numeric">{formatBytes(checkpoint.offset)} / {formatBytes(checkpoint.total)}</span>
                    <IconButton icon="play-outline" size="sm" label={t("续传")} onClick={() => { void onResumeCheckpoint(checkpoint); }} />
                    <IconButton
                      icon="trash-outline"
                      size="sm"
                      danger
                      label={t("清理")}
                      onClick={() => { void onDiscardCheckpoint(checkpoint); }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </Section>
        </div>
      )}
    </Fragment>
  );
}
