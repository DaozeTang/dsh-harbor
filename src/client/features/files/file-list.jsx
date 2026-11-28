/**
 * The listing itself, including the four states it can be in (loading, no
 * connection, failed listing, empty/filtered) and the .. row.
 *
 * Presentational: the entries arrive filtered and sorted by the pane, and every
 * action is a callback.
 */
import * as React from "react";
import { Button, EmptyState, ErrorNote, Icon, IconButton, Spinner } from "../../ui/kit.jsx";
import { formatBytes, formatWhen } from "../../core/format.js";
import { modeString } from "./entries.js";
import { t } from "../../../i18n/core.js";

const { Fragment } = React;

export function FileList({
  connectionId, cwd, entries, sortedEntries, listError, selected,
  onGoUp, onOpenEntry, onDownload, onSelect, onRowMenu, onRetryList, onChooseFiles, onClearFilter
}) {
  if (entries === null) {
    return connectionId ? (
      <div className="hb-files__center">
        <Spinner label={t("加载中…")} />
        <span className="hb-quiet">{t("加载中…")}</span>
      </div>
    ) : (
      <EmptyState icon="folder-open-outline" title={t("请连接服务器")} text={t("连接服务器后即可浏览远端文件。")} />
    );
  }
  if (listError !== null) {
    return (
      <div className="hb-files__center">
        <ErrorNote action={<Button variant="secondary" size="sm" icon="refresh-outline" onClick={onRetryList}>{t("重试")}</Button>}>
          {listError}
        </ErrorNote>
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <EmptyState
        icon="folder-open-outline"
        title={t("空目录")}
        text={t("把文件拖到这里，或点下面的上传按钮。")}
        action={<Button variant="secondary" size="sm" icon="upload-outline" onClick={onChooseFiles}>{t("上传")}</Button>}
      />
    );
  }
  if (sortedEntries.length === 0) {
    return (
      <EmptyState
        icon="search-outline"
        title={t("没有匹配的文件")}
        text={t("换个关键词，或清除过滤。")}
        action={<Button variant="secondary" size="sm" onClick={onClearFilter}>{t("清除过滤")}</Button>}
      />
    );
  }
  return (
    <Fragment>
      {cwd !== "/" && (
        <div
          className="hb-file hb-files__row hb-file--up"
          role="button"
          tabIndex={0}
          title={t("上级目录")}
          onClick={onGoUp}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); onGoUp(); } }}
        >
          <span className="hb-file__icon"><Icon name="chevron-up-outline" size={14} /></span>
          <span className="hb-file__name">..</span>
        </div>
      )}
      {sortedEntries.map((entry) => {
        const isSelected = selected?.name === entry.name;
        return (
          <div
            key={entry.name}
            className="hb-file hb-files__row"
            data-selected={isSelected ? "true" : "false"}
            data-dir={entry.isDirectory ? "true" : "false"}
            role="button"
            tabIndex={0}
            aria-current={isSelected ? "true" : undefined}
            title={entry.isDirectory ? `${entry.name} · ${t("双击打开")}` : `${entry.name} · ${t("双击下载")}`}
            onClick={() => onSelect(entry)}
            onDoubleClick={() => { if (entry.isDirectory) onOpenEntry(entry); else void onDownload(entry); }}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget || event.key !== "Enter") return;
              event.preventDefault();
              if (entry.isDirectory) onOpenEntry(entry); else void onDownload(entry);
            }}
          >
            <span className="hb-file__icon"><Icon name={entry.isDirectory ? "folder-open-outline" : "file"} size={14} /></span>
            <span className="hb-file__name">{entry.name}</span>
            <span className="hb-file__meta">
              <span>{entry.isDirectory ? "—" : formatBytes(entry.size)}</span>
              <span>{entry.mtime > 0 ? formatWhen(entry.mtime) : "—"}</span>
              <span className="hb-files__perm">{modeString(entry.mode)}</span>
            </span>
            <span
              className="hb-files__actions"
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
            >
              <IconButton
                icon="ellipsis-outline"
                size="sm"
                label={t(`更多操作：${entry.name}`)}
                onClick={(event) => onRowMenu(event, entry)}
              />
            </span>
          </div>
        );
      })}
    </Fragment>
  );
}
