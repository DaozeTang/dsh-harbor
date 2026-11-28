/**
 * Recorded SSH sessions.
 *
 * A recording is a faithful byte log on the host; the viewer reads bounded
 * ranges and renders the *readable* text, so a huge session never reaches the
 * browser in full and never shows escape debris. Paging is append-only: "load
 * more" continues from the last offset instead of re-reading the file.
 *
 * Deletion is deliberately manual and per-record. Logs can contain anything that
 * ever appeared on a terminal, so there is no "clear all" without a selection,
 * and the one bulk action ("0 字节") only targets records that carry no data.
 */
import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Checkbox, EmptyState, ErrorNote, Icon, IconButton, TextInput, confirmAction, cx } from "../../ui/kit.jsx";
import { readableLine, toReadableText } from "../../../shared/terminal-text.js";
import { classifyLogLine, segmentLogText } from "./log-highlight.js";
import { t } from "../../../i18n/core.js";
import { formatBytes, formatWhen } from "../../core/format.js";

const PAGE_BYTES = 48 * 1024;

/** Search hits reuse the body's line colouring so a match looks like its context. */
function hitClass(line) {
  const kind = classifyLogLine(line);
  if (kind === "error") return "hb-log-line--error";
  if (kind === "warning") return "hb-log-line--warn";
  return undefined;
}

export function LogsPane({ api }) {
  const [logs, setLogs] = useState(null);
  const [enabled, setEnabled] = useState(true);
  const [selected, setSelected] = useState(null);
  const [content, setContent] = useState("");
  const [nextOffset, setNextOffset] = useState(0);
  const [eof, setEof] = useState(true);
  const [size, setSize] = useState(0);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [selection, setSelection] = useState(() => new Set());
  const loadSeq = useRef(0);
  const rootRef = useRef(null);
  const bodyRef = useRef(null);
  // Below this width the list and the reader cannot share one row: the
  // sidebar would give each ~180px. Swap to a master/detail view instead.
  const [narrow, setNarrow] = useState(false);
  const segments = useMemo(() => segmentLogText(content), [content]);

  useEffect(() => {
    const node = rootRef.current;
    if (node === null || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect?.width ?? 0;
      setNarrow(width < 620);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const refresh = async () => {
    setError(null);
    try {
      const value = await api.sessionLogList();
      setEnabled(value.enabled !== false);
      setLogs(Array.isArray(value.logs) ? value.logs : []);
    } catch (cause) {
      setError(cause?.message ?? String(cause));
      setLogs([]);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const openLog = async (log, { offset = 0, append = false } = {}) => {
    const seq = ++loadSeq.current;
    setBusy(true);
    setError(null);
    try {
      const value = await api.sessionLogRead(log.sessionId, offset, PAGE_BYTES);
      if (seq !== loadSeq.current) return;
      setSelected(log);
      setSize(value.size);
      setNextOffset(value.nextOffset);
      setEof(value.eof);
      const readable = toReadableText(value.data);
      setContent((previous) => (append ? previous + readable : readable));
      if (!append) {
        setHits(null);
        // A replacement recording starts at its first line; appending
        // ("继续加载") keeps the reader where it is.
        if (bodyRef.current !== null) bodyRef.current.scrollTop = 0;
      }
    } catch (cause) {
      if (seq === loadSeq.current) setError(cause?.message ?? String(cause));
    } finally {
      if (seq === loadSeq.current) setBusy(false);
    }
  };

  const search = async () => {
    if (selected === null || query.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      const value = await api.sessionLogSearch(selected.sessionId, query.trim(), 200);
      setHits(Array.isArray(value.hits) ? value.hits.map((hit) => ({ ...hit, line: readableLine(hit.line) })) : []);
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    if (selected === null) return;
    setBusy(true);
    setError(null);
    try {
      let offset = 0;
      let text = "";
      for (;;) {
        const value = await api.sessionLogRead(selected.sessionId, offset, 1024 * 1024);
        text += value.data;
        offset = value.nextOffset;
        if (value.eof || offset <= value.startOffset) break;
      }
      const where = [selected.name, selected.host].filter(Boolean).join("-") || "session";
      const blob = new Blob([toReadableText(text)], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `harbor-session-${where}-${selected.sessionId}.log`;
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // Safari cancels the download if the blob URL dies in the same task.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      setBusy(false);
    }
  };

  const forget = async (log) => {
    const confirmed = await confirmAction({
      message: t(`删除会话日志 ${log.sessionId}？此操作不可恢复。`),
      confirmLabel: t("删除"),
      danger: true
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      await api.sessionLogDelete(log.sessionId);
      setSelection((previous) => {
        if (!previous.has(log.sessionId)) return previous;
        const next = new Set(previous);
        next.delete(log.sessionId);
        return next;
      });
      if (selected?.sessionId === log.sessionId) {
        setSelected(null);
        setContent("");
        setHits(null);
      }
      await refresh();
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      setBusy(false);
    }
  };

  const deleteSelected = async () => {
    const ids = (logs ?? []).map((log) => log.sessionId).filter((sessionId) => selection.has(sessionId));
    if (ids.length === 0) return;
    const confirmed = await confirmAction({
      message: t(`删除所选 ${ids.length} 条会话日志？此操作不可恢复。`),
      confirmLabel: t("删除"),
      danger: true
    });
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    let failure = null;
    try {
      for (const sessionId of ids) {
        try {
          await api.sessionLogDelete(sessionId);
        } catch (cause) {
          failure = failure ?? cause;
        }
      }
      setSelection(new Set());
      if (selected !== null && ids.includes(selected.sessionId)) {
        setSelected(null);
        setContent("");
        setHits(null);
      }
      await refresh();
      if (failure !== null) setError(failure?.message ?? String(failure));
    } finally {
      setBusy(false);
    }
  };

  const pruneEmpty = async () => {
    const empty = (logs ?? []).filter((log) => log.bytes === 0);
    if (empty.length === 0) return;
    const confirmed = await confirmAction({
      message: t(`删除 ${empty.length} 条 0 字节的会话日志？`),
      confirmLabel: t("删除"),
      danger: true
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      for (const log of empty) await api.sessionLogDelete(log.sessionId);
      await refresh();
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      setBusy(false);
    }
  };

  const allSelected = (logs?.length ?? 0) > 0 && (logs ?? []).every((log) => selection.has(log.sessionId));
  const toggleSelect = (sessionId) => setSelection((previous) => {
    const next = new Set(previous);
    if (next.has(sessionId)) next.delete(sessionId);
    else next.add(sessionId);
    return next;
  });

  const closeDetail = () => {
    setSelected(null);
    setContent("");
    setHits(null);
  };
  const listVisible = selected === null || !narrow;
  const selectionActive = selection.size > 0;

  return (
    <div ref={rootRef} className="hb-pane hb-pad" style={{ gap: 12 }}>
      <div className="hb-pane__head">
        <div className="hb-pane__heading">
          <div className="hb-title">{t("会话日志")}</div>
          <div className="hb-quiet">
            {enabled ? t("只保存在本机，按会话分文件；查看时按块读取，不会整段载入。") : t("宿主未启用会话日志记录。")}
          </div>
        </div>
        <div className="hb-pane__actions">
          {(logs?.length ?? 0) > 0 && (
            <Checkbox
              checked={allSelected}
              label={t("全选")}
              onChange={() => setSelection(allSelected ? new Set() : new Set((logs ?? []).map((log) => log.sessionId)))}
            />
          )}
          {selectionActive && (
            <Button variant="danger" size="sm" icon="trash-outline" onClick={deleteSelected} disabled={busy}>
              {t(`删除 ${selection.size} 条`)}
            </Button>
          )}
          {(logs ?? []).some((log) => log.bytes === 0) && (
            <Button variant="ghost" size="sm" onClick={pruneEmpty} disabled={busy}>{t("清除空记录")}</Button>
          )}
          <IconButton icon="refresh-outline" label={t("刷新")} onClick={() => void refresh()} disabled={busy} />
        </div>
      </div>

      {error !== null && <ErrorNote>{error}</ErrorNote>}

      {logs === null ? (
        <div className="hb-inline hb-quiet" style={{ padding: 12 }}><span className="hb-spinner" />{t("加载中…")}</div>
      ) : logs.length === 0 ? (
        <EmptyState icon="archive-outline" title={t("还没有会话日志")} text={t("用终端操作服务器后，记录会自动出现在这里。")} />
      ) : (
        <div className="hb-body" style={{ gap: 12, minHeight: 0 }}>
          {listVisible && (
            <div
              className="hb-scroll hb-stack hb-stack--tight"
              style={narrow || selected === null
                ? { flex: 1, minHeight: 0, overflowY: "auto" }
                : { width: 260, flex: "none", overflowY: "auto" }}
            >
              {logs.map((log) => (
                <div
                  key={log.sessionId}
                  className={cx("hb-row hb-row--interactive", selected?.sessionId === log.sessionId && "hb-row--selected")}
                  style={{ border: "1px solid var(--hb-border-faint)" }}
                  role="button"
                  tabIndex={0}
                  onClick={() => void openLog(log)}
                  onKeyDown={(event) => {
                    // Ignore keys bubbling from the checkbox/delete controls.
                    if (event.target !== event.currentTarget) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      void openLog(log);
                    }
                  }}
                >
                  <span onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                    <Checkbox
                      checked={selection.has(log.sessionId)}
                      ariaLabel={t("选择这条日志")}
                      onChange={() => toggleSelect(log.sessionId)}
                    />
                  </span>
                  <div className="hb-row__main">
                    <div className="hb-row__title">
                      <span className="hb-truncate">{log.name || log.profileName || log.host || log.sessionId}</span>
                    </div>
                    <div className="hb-row__meta">
                      <span className="hb-mono">{formatBytes(log.bytes)}</span>
                      <span>·</span>
                      <span>{formatWhen(log.startedAt)}</span>
                    </div>
                  </div>
                  <div className="hb-row__actions">
                    <IconButton icon="trash-outline" label={t("删除")} size="sm" danger onClick={(event) => { event.stopPropagation(); void forget(log); }} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {selected !== null && (
            <div className="hb-pane" style={{ flex: 1, minWidth: 0, border: "1px solid var(--hb-border-faint)", borderRadius: 8 }}>
              <div className="hb-inline" style={{ padding: "8px 10px", borderBottom: "1px solid var(--hb-border-faint)" }}>
                {narrow && (
                  <IconButton icon="chevron-left-outline" size="sm" label={t("返回日志列表")} onClick={closeDetail} />
                )}
                <Icon name="archive-outline" size={14} />
                <span className="hb-strong hb-truncate">{selected.name || selected.host || selected.sessionId}</span>
                <Badge mono>{formatBytes(size)}</Badge>
                <span className="hb-spacer" />
                <IconButton icon="download-outline" label={t("下载为文本")} size="sm" onClick={() => void download()} disabled={busy} />
                <IconButton icon="close-outline" label={t("关闭日志")} size="sm" onClick={closeDetail} />
              </div>

              <div className="hb-inline" style={{ padding: "6px 10px", borderBottom: "1px solid var(--hb-border-faint)" }}>
                <TextInput
                  size="sm"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") void search(); }}
                  placeholder={t("在日志里搜索")}
                  style={{ flex: 1, minWidth: 0 }}
                />
                <IconButton icon="search-outline" label={t("搜索")} size="sm" onClick={() => void search()} disabled={busy} />
              </div>

              {hits !== null && (
                <div className="hb-scroll" style={{ maxHeight: 140, overflow: "auto", padding: "6px 10px", borderBottom: "1px solid var(--hb-border-faint)" }}>
                  <div className="hb-quiet">{t(`${hits.length} 处匹配`)}</div>
                  {hits.slice(0, 40).map((hit, index) => (
                    <div
                      key={index}
                      className={cx("hb-mono hb-truncate", hitClass(hit.line))}
                      title={t(`字节偏移 ${hit.offset}`)}
                    >
                      <span className="hb-quiet hb-numeric">{index + 1}</span> {hit.line}
                    </div>
                  ))}
                </div>
              )}

              {/* The reader is the pane's slack-height element, so it must be the
                  scroll container itself: without overflow the text spills under
                  the footer and the shell clips it, leaving the tail unreachable. */}
              <div
                ref={bodyRef}
                className="hb-scroll hb-mono"
                style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 10, whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.65 }}
              >
                {segments.length === 0
                  ? <span className="hb-quiet">{t("这条记录是空的。")}</span>
                  : segments.map((segment, index) => (
                      <span key={index} className={segment.kind === "error" ? "hb-log-line--error" : segment.kind === "warning" ? "hb-log-line--warn" : undefined}>
                        {segment.text}
                      </span>
                    ))}
              </div>

              {!eof && (
                <div className="hb-inline" style={{ padding: 8, borderTop: "1px solid var(--hb-border-faint)" }}>
                  <span className="hb-quiet">{t(`已读取 ${formatBytes(nextOffset)} / ${formatBytes(size)}`)}</span>
                  <span className="hb-spacer" />
                  <Button variant="secondary" size="sm" busy={busy} onClick={() => void openLog(selected, { offset: nextOffset, append: true })}>
                    {t("继续加载")}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
