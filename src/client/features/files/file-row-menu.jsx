/**
 * The per-entry actions menu (⋯ on a row).
 *
 * Presentational: the anchor element and the open entry live with the listing,
 * the actions with the pane.
 */
import * as React from "react";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "../../ui/kit.jsx";
import { joinPath } from "./path-utils.js";
import { t } from "../../../i18n/core.js";

export function FileRowMenu({
  entry, anchorRef, cwd, busy, onCd, onEnterDirectory, onDownload, openEditor, onRename, onDelete, onClose
}) {
  if (entry === null) return null;
  return (
    <Menu open anchorRef={anchorRef} onClose={onClose} align="end">
      <MenuLabel><span className="hb-files__menuname">{entry.name}</span></MenuLabel>
      {entry.isDirectory && onCd !== undefined && (
        <MenuItem icon="terminal" disabled={busy} onSelect={() => { onClose(); onCd(joinPath(cwd, entry.name)); }}>
          {t("在右侧终端 cd 到此目录")}
        </MenuItem>
      )}
      {entry.isDirectory && (
        <MenuItem icon="folder-open-outline" onSelect={() => { onClose(); onEnterDirectory(entry); }}>
          {t("进入此目录")}
        </MenuItem>
      )}
      {!entry.isDirectory && (
        <MenuItem icon="download-outline" disabled={busy} onSelect={() => { onClose(); void onDownload(entry); }}>
          {t("下载")}
        </MenuItem>
      )}
      {!entry.isDirectory && (
        <MenuItem icon="edit-outline" disabled={busy} onSelect={() => { onClose(); void openEditor(entry); }}>
          {t("在文本编辑器中打开（上限 10 MB）")}
        </MenuItem>
      )}
      <MenuSeparator />
      <MenuItem icon="list-pen-outline" onSelect={() => { onClose(); onRename(entry); }}>
        {t("改名")}
      </MenuItem>
      <MenuItem icon="trash-outline" danger disabled={busy} onSelect={() => { onClose(); void onDelete(entry); }}>
        {t("删除")}
      </MenuItem>
    </Menu>
  );
}
