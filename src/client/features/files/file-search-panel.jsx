/**
 * The recursive filename search strip: query, run/cancel, progress line and the
 * clickable result list.
 *
 * Presentational: the search state machine lives in hooks/useFileSearch.js.
 */
import * as React from "react";
import { Button, Icon, IconButton, InputGroup, TextInput } from "../../ui/kit.jsx";
import { dirnameOf } from "./path-utils.js";
import { t } from "../../../i18n/core.js";

export function FileSearchPanel({ searchState, query, onQueryChange, onSearch, onCancel, onClose, onOpenPath }) {
  return (
    <div className="hb-files__search">
      <div className="hb-inline">
        <InputGroup icon="search-outline" className="hb-files__grow">
          <TextInput
            size="sm"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void onSearch(); }}
            placeholder={t("搜索当前目录下的文件名")}
          />
        </InputGroup>
        <Button variant="secondary" size="sm" disabled={!query.trim() || searchState?.running === true} onClick={onSearch}>
          {t("搜索")}
        </Button>
        {searchState?.running === true && (
          <Button variant="ghost" size="sm" onClick={onCancel}>{t("取消")}</Button>
        )}
        <IconButton icon="close-outline" size="sm" label={t("关闭")} onClick={onClose} />
      </div>
      {searchState !== null && (
        <div className="hb-files__searchbody">
          <div className="hb-quiet">
            {searchState.running
              ? t("搜索中…")
              : searchState.reason === "failed"
                ? `${t("搜索失败：")}${searchState.failure ?? ""}`
                : t(`已搜索 ${searchState.visited} 个目录，找到 ${searchState.results.length} 项`)}
            {searchState.reason === "limit" ? t("（达到上限）") : searchState.reason === "timeout" ? t("（超时，结果不完整）") : searchState.reason === "cancelled" ? t("（已取消）") : ""}
          </div>
          {searchState.errors.length > 0 && (
            <div className="hb-quiet">{t(`有 ${searchState.errors.length} 个目录无法读取，结果可能不完整`)}</div>
          )}
          {searchState.results.length > 0 && (
            <div className="hb-files__results">
              {searchState.results.map((item) => (
                <button
                  key={item.path}
                  type="button"
                  className="hb-files__result"
                  title={item.path}
                  onClick={() => { void onOpenPath(item.isDirectory ? item.path : dirnameOf(item.path)); onClose(); }}
                >
                  <Icon name={item.isDirectory ? "folder-open-outline" : "file"} size={13} />
                  <span className="hb-truncate">{item.path}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
