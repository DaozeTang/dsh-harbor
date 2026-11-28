/**
 * The batch-run confirmation.
 *
 * Multi-host execution is the one place where a single mistake reaches every
 * machine, so the targets are always chosen by the operator here — the agent
 * proposes a command and a plan, never a target list. The dialog shows the
 * exact command text it will run, flags a plan the host already judged
 * dangerous, and keeps the per-host outcome on screen afterwards.
 */
import * as React from "react";
import { useEffect, useState } from "react";
import { Badge, Button, Checkbox, Dialog, ErrorNote, Icon } from "../../ui/kit.jsx";
import { t } from "../../../i18n/core.js";

export function BatchDialog({ api, task, onClose }) {
  const [profiles, setProfiles] = useState([]);
  const [selected, setSelected] = useState({});
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.profileList().then((value) => setProfiles(value.profiles ?? [])).catch(() => {});
  }, [api]);

  const chosen = Object.keys(selected).filter((id) => selected[id]);
  const allSelected = profiles.length > 0 && chosen.length === profiles.length;

  const run = async () => {
    if (chosen.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const response = await api.batchRun(task.batchId, chosen);
      setResults(response.results ?? []);
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={busy ? () => {} : onClose}
      title={t("批量执行")}
      description={t("目标由你勾选；确认后每台服务器各自建连执行，结果分节展示。")}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={() => { api.batchCancel(task.batchId).catch(() => {}); onClose(); }}>{t("取消")}</Button>
          <span className="hb-spacer" />
          <Button
            variant="primary"
            disabled={busy || results !== null || chosen.length === 0}
            busy={busy}
            onClick={run}
          >
            {results !== null ? t("已完成") : t(`执行（${chosen.length} 台）`)}
          </Button>
        </>
      }
    >
      <div className="hb-stack">
        {task.dangerous === true && (
          <ErrorNote>{t(`危险命令：${task.reason}。确认将对勾选的全部服务器执行。`)}</ErrorNote>
 )}
        <pre className="hb-mono hb-scroll" style={{ margin: 0, padding: "10px 12px", borderRadius: 8, background: "var(--hb-surface-sunken)", maxHeight: 140, overflow: "auto", whiteSpace: "pre-wrap" }}>
          {task.command}
        </pre>

        <div className="hb-inline">
          <span className="hb-subtitle">{t("目标服务器")}</span>
          <Badge>{chosen.length}/{profiles.length}</Badge>
          <span className="hb-spacer" />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setSelected(allSelected ? {} : Object.fromEntries(profiles.map((profile) => [profile.profileId, true])))}
            disabled={profiles.length === 0 || results !== null}
          >
            {allSelected ? t("全不选") : t("全选")}
          </Button>
        </div>

        <div className="hb-scroll" style={{ maxHeight: 220, border: "1px solid var(--hb-border-faint)", borderRadius: 8, padding: 4 }}>
          {profiles.length === 0 && <div className="hb-quiet hb-pad--tight">{t("还没有保存任何服务器。")}</div>}
          {profiles.map((profile) => (
            <label
              key={profile.profileId}
              className="hb-row hb-row--interactive"
              style={{ cursor: results === null ? "pointer" : "default" }}
            >
              <Checkbox
                checked={selected[profile.profileId] === true}
                disabled={results !== null || busy}
                onChange={(value) => setSelected((current) => ({ ...current, [profile.profileId]: value }))}
              />
              <div className="hb-row__main">
                <div className="hb-row__title">{profile.name || profile.host}</div>
                <div className="hb-row__meta hb-mono">{profile.username}@{profile.host}:{profile.port}</div>
              </div>
            </label>
 ))}
        </div>

        {error !== null && <ErrorNote>{error}</ErrorNote>}

        {results !== null && (
          <div className="hb-stack hb-stack--tight">
            <div className="hb-inline">
              <span className="hb-subtitle">{t("执行结果")}</span>
              <Badge tone="ok">{results.filter((item) => item.ok && !item.timedOut).length} {t("成功")}</Badge>
              {results.some((item) => item.timedOut) && <Badge tone="warn">{results.filter((item) => item.timedOut).length} {t("超时")}</Badge>}
              {results.some((item) => !item.ok && !item.timedOut) && <Badge tone="err">{results.filter((item) => !item.ok && !item.timedOut).length} {t("失败")}</Badge>}
            </div>
            <div className="hb-scroll hb-stack hb-stack--tight" style={{ maxHeight: 280 }}>
              {results.map((result, index) => (
                <div key={index} style={{ border: "1px solid var(--hb-border-faint)", borderRadius: 8, padding: "8px 10px" }}>
                  <div className="hb-inline" style={{ gap: 6 }}>
                    <Icon name={result.timedOut ? "warning-triangle-outline" : result.ok ? "check-circle-fill" : "close-outline"} size={14} />
                    <span className="hb-strong">{result.name || result.host}</span>
                    {result.timedOut && <Badge tone="warn">{t("超时")}</Badge>}
                    {result.truncated && <Badge>{t("输出已截断")}</Badge>}
                    <span className="hb-spacer" />
                    {result.exitCode !== null && <span className="hb-quiet hb-mono">exit {result.exitCode}</span>}
                  </div>
                  {result.error && (result.stdout || result.stderr) && (
                    <div className="hb-quiet" style={{ marginTop: 6 }}>{result.error}</div>
                  )}
                  <pre className="hb-mono" style={{ margin: "6px 0 0", whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 160, overflow: "auto" }}>
                    {`${result.stdout ?? ""}${result.stderr ?? ""}` || result.error || t("(无输出)")}
                  </pre>
                </div>
 ))}
            </div>
          </div>
 )}
      </div>
    </Dialog>
 );
}