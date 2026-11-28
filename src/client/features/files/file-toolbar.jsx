/**
 * The chrome above the listing: the path bar (up, breadcrumbs, favorites, pin,
 * more) and the action row (upload, directory, refresh, search, filter).
 *
 * Presentational only — the listing, the favorites store and the transfer
 * registry stay with their hooks; this file just says where the controls go.
 */
import * as React from "react";
import { Button, Icon, IconButton, Menu, MenuItem, MenuLabel, Pill, Spinner, TextInput } from "../../ui/kit.jsx";
import { basenameOf, crumbsOf } from "./path-utils.js";
import { t } from "../../../i18n/core.js";

const { Fragment, useRef } = React;

export function FileToolbar({
  cwd, busy, favorites, favoritesStorageKey, isFavorite,
  onGoUp, onNavigate, onUnpin, onPinCurrent,
  canResumeDownloads, moreOpen, onMoreOpenChange, persistDownloads, onTogglePersistDownloads,
  uploading, onChooseFiles, onChooseFolder, onCreateDirectory, onRefresh,
  searchOpen, onToggleSearch, filter, onFilterChange,
  fileInputRef, dirInputRef, onUpload
}) {
  const moreAnchorRef = useRef(null);

  return (
    <Fragment>
      <div className="hb-files__bar">
        <IconButton icon="chevron-up-outline" size="sm" label={t("上级目录")} onClick={onGoUp} disabled={cwd === "/"} />
        <div className="hb-crumbs" title={cwd} aria-label={t("当前远程路径")}>
          {crumbsOf(cwd).map((crumb, index) => (
            <Fragment key={crumb.path}>
              {index > 0 && <Icon name="chevron-right-outline" size={12} className="hb-files__sep" />}
              <button
                type="button"
                className="hb-crumb"
                title={index === 0 ? t("服务器根目录") : crumb.path}
                onClick={() => { void onNavigate(crumb.path); }}
              >
                {index === 0 && <Icon name="server" size={12} />}
                {crumb.label}
              </button>
            </Fragment>
          ))}
        </div>
        {favorites.some((path) => path !== cwd) && (
          <div className="hb-files__favorites" role="group" aria-label={t("收藏的路径")}>
            {favorites.map((path) => (
              path === cwd ? null : (
                <span key={path} className="hb-files__favorite">
                  <Pill icon="folder-close" title={path} onClick={() => { void onNavigate(path); }}>{basenameOf(path)}</Pill>
                  <IconButton icon="close-outline" size="sm" label={t(`取消收藏 ${path}`)} onClick={() => onUnpin(path)} />
                </span>
              )
            ))}
          </div>
        )}
        {busy && <span className="hb-files__busy"><Spinner label={t("加载中…")} /></span>}
        <IconButton
          icon="pin-outline"
          size="sm"
          active={isFavorite}
          disabled={favoritesStorageKey === null}
          label={favoritesStorageKey === null
            ? t("这台服务器缺少主机信息，暂时不能收藏")
            : isFavorite ? t("取消收藏当前目录") : t("收藏当前目录")}
          onClick={onPinCurrent}
        />
        {canResumeDownloads && (
          <span className="hb-files__anchor" ref={moreAnchorRef}>
            <IconButton
              icon="ellipsis-outline"
              size="sm"
              label={t("更多")}
              active={moreOpen}
              onClick={() => onMoreOpenChange(!moreOpen)}
            />
          </span>
        )}
      </div>

      <Menu open={moreOpen} anchorRef={moreAnchorRef} onClose={() => onMoreOpenChange(false)} align="end">
        <MenuLabel>{t("下载")}</MenuLabel>
        <MenuItem icon="save-outline" checked={persistDownloads} onSelect={onTogglePersistDownloads}>
          {t("允许下载跨重启续传")}
        </MenuItem>
        {persistDownloads && (
          <div className="hb-files__menunote">{t("未完成的文件会以明文保存在此浏览器的本地存储中，占用磁盘空间；请在完成后或不再需要时清理。")}</div>
        )}
      </Menu>

      <div className="hb-files__bar hb-files__bar--actions">
        {/* A batch keeps running after this pane remounts, so the buttons must
            report that state instead of silently ignoring the click. */}
        <Button variant="primary" size="sm" icon="upload-outline" disabled={uploading} onClick={onChooseFiles}>{t("上传")}</Button>
        <Button variant="secondary" size="sm" icon="folder-open-outline" disabled={uploading} title={t("上传目录并合并已有目录")} onClick={onChooseFolder}>
          {t("上传目录")}
        </Button>
        <IconButton icon="plus-outline" size="sm" label={t("新建目录")} onClick={onCreateDirectory} />
        <IconButton icon="refresh-outline" size="sm" label={t("刷新")} onClick={onRefresh} disabled={busy} />
        <IconButton
          icon="search-outline"
          size="sm"
          active={searchOpen}
          label={t("递归搜索文件名")}
          onClick={onToggleSearch}
        />
        <TextInput
          size="sm"
          className="hb-files__filter"
          value={filter}
          onChange={(event) => onFilterChange(event.target.value)}
          placeholder={t("过滤")}
          title={t("按名称过滤当前目录")}
          aria-label={t("按名称过滤当前目录")}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const files = event.target.files;
            if (files && files.length > 0) void onUpload([...files]);
            event.target.value = "";
          }}
        />
        <input
          ref={dirInputRef}
          type="file"
          webkitdirectory=""
          hidden
          onChange={(event) => {
            const files = [...event.target.files];
            event.target.value = "";
            void onUpload(files);
          }}
        />
      </div>
    </Fragment>
  );
}
