/**
 * The remote text editor: one file read into memory, diffed and written back.
 *
 * Open, save and close stay together because each step guards the next: the
 * byte cap on read, the original bytes on save, and the discard prompt on
 * close. Escape, the scrim and the 关闭 button all land on the same guard so a
 * stray key can never drop the buffer silently.
 */
import { useState } from "react";
import { MAX_EDITABLE_BYTES, changedLineRegions, decodeEditableText, encodeEditableText } from "../file-editor.js";
import { confirmAction } from "../../../ui/kit.jsx";
import { formatBytes } from "../../../core/format.js";
import { joinPath } from "../path-utils.js";
import { t } from "../../../../i18n/core.js";

export function useEditor({ api, connectionId, connectionRef, cwd, cwdRef, load, setBusy, setError }) {
  const [editing, setEditing] = useState(null);
  const [previewChanges, setPreviewChanges] = useState(false);
  const [editorBusy, setEditorBusy] = useState(false);

  /** Read one remote file into the text editor, refusing binaries and big files. */
  const openEditor = async (entry) => {
    const path = joinPath(cwd, entry.name);
    setBusy(true);
    setError(null);
    try {
      const stat = await api.sftpStat(connectionId, path).catch(() => null);
      if (stat?.size > MAX_EDITABLE_BYTES) {
        setError(t(`文件 ${formatBytes(stat.size)} 超过 ${MAX_EDITABLE_BYTES / 1024 / 1024} MB 的编辑上限，请下载后编辑`));
        return;
      }
      const file = await api.sftpReadFile(connectionId, path, MAX_EDITABLE_BYTES + 1);
      const decoded = decodeEditableText(file.data);
      if (!decoded.ok) {
        setError(t(`${entry.name}：${decoded.reason}`));
        return;
      }
      setEditing({
        path,
        text: decoded.text,
        original: decoded.text,
        originalBytes: file.data,
        replaced: decoded.replaced,
        bytes: file.data.length,
        mtime: stat?.mtime ?? entry.mtime ?? null
      });
      setPreviewChanges(false);
    } catch (err) {
      setError(t(`打开失败：${err?.message ?? String(err)}`));
    } finally {
      setBusy(false);
    }
  };

  const saveEditor = async () => {
    if (!editing) return;
    setEditorBusy(true);
    setError(null);
    try {
      const replacement = encodeEditableText(editing.text);
      await api.sftpEditorSave(connectionId, editing.path, editing.originalBytes, replacement);
      if (connectionRef.current !== connectionId) return;
      setEditing(null);
      load(cwdRef.current);
    } catch (err) {
      setError(t(`保存失败：${err?.message ?? String(err)}`));
    } finally {
      setEditorBusy(false);
    }
  };

  /**
   * Close the editor, asking first when the buffer differs from what was read.
   *
   * Escape, the scrim and the 关闭 button all landed on `setEditing(null)`: one
   * stray key on a full-screen editor silently dropped the edits, with nothing
   * on the page saying they were gone. The shared confirm is themeable and
   * resolves false for Escape/cancel, so the editor simply stays open.
   */
  const closeEditor = async () => {
    if (editing === null || editorBusy) return;
    if (editing.text === editing.original) { setEditing(null); return; }
    const confirmed = await confirmAction({
      title: t("放弃未保存的修改？"),
      message: t("修改还没有保存，关闭编辑器会丢弃这些修改。"),
      confirmLabel: t("放弃修改"),
      cancelLabel: t("继续编辑"),
      danger: true
    });
    if (confirmed) setEditing(null);
  };

  const changes = editing && previewChanges ? changedLineRegions(editing.original, editing.text) : null;
  const setText = (text) => setEditing({ ...editing, text });
  const togglePreview = () => setPreviewChanges(!previewChanges);

  return { editing, previewChanges, editorBusy, changes, openEditor, saveEditor, closeEditor, setText, togglePreview };
}
