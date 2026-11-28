/**
 * The full-screen editor dialog: metadata line, before/after diff and the text
 * area.
 *
 * Presentational: the buffer, the byte policy and the close guard live in
 * hooks/useEditor.js. Every exit (Escape, the scrim, 关闭) routes through the
 * same closeEditor, so unsaved edits always get their prompt.
 */
import * as React from "react";
import { Button, Dialog, TextArea } from "../../ui/kit.jsx";
import { formatBytes } from "../../core/format.js";
import { t } from "../../../i18n/core.js";

const { Fragment } = React;

export function FileEditorPane({ editing, changes, previewChanges, editorBusy, closeEditor, onTogglePreview, onSave, onChangeText }) {
  return (
    <Dialog
      open
      onClose={closeEditor}
      title={t(`编辑：${editing.path}`)}
      description={
        `${formatBytes(editing.bytes)} · UTF-8${editing.replaced ? t(" · 含无法按 UTF-8 解码的字节（保存会按 UTF-8 重写）") : ""}${editing.text !== editing.original ? t(" · 已修改") : ""}`
      }
      width="full"
      footer={
        <Fragment>
          <Button variant="secondary" onClick={closeEditor}>{t("关闭")}</Button>
          <Button variant="secondary" icon="compare-split-outline" onClick={onTogglePreview}>
            {previewChanges ? t("返回编辑") : t("预览修改")}
          </Button>
          <Button
            variant="primary"
            icon="save-outline"
            busy={editorBusy}
            disabled={editing.text === editing.original}
            onClick={onSave}
          >
            {editorBusy ? t("保存中…") : t("保存")}
          </Button>
        </Fragment>
      }
    >
      <div className="hb-files__editor">
        {previewChanges && changes !== null ? (
          <div className="hb-files__diff">
            {[changes.left, changes.right].map((part, index) => (
              <div key={index === 0 ? "before" : "after"} className="hb-files__diffcol">
                <span className="hb-files__difflabel">{index === 0 ? t("修改前") : t("修改后")}</span>
                <pre className="hb-files__difftext">
                  {part.before}
                  {part.before !== "" ? "\n" : ""}
                  <span className={index === 0 ? "hb-files__removed" : "hb-files__added"}>{part.changed}</span>
                  {part.after !== "" ? "\n" : ""}
                  {part.after}
                </pre>
              </div>
            ))}
          </div>
        ) : (
          <TextArea
            className="hb-files__code"
            data-modal-autofocus=""
            value={editing.text}
            onChange={(event) => onChangeText(event.target.value)}
            spellCheck={false}
          />
        )}
      </div>
    </Dialog>
  );
}
