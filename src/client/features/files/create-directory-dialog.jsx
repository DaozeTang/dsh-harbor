/**
 * The 新建目录 dialog: one name field and the create action.
 *
 * Presentational: the name and the busy flag belong to the pane.
 */
import * as React from "react";
import { Button, Dialog, Field, TextInput } from "../../ui/kit.jsx";
import { t } from "../../../i18n/core.js";

const { Fragment } = React;

export function CreateDirectoryDialog({ open, path, busy, name, onNameChange, onClose, onSubmit }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("新建目录")}
      description={path}
      footer={
        <Fragment>
          <Button variant="secondary" onClick={onClose}>{t("取消")}</Button>
          <Button variant="primary" icon="plus-outline" busy={busy} disabled={!name.trim()} onClick={onSubmit}>{t("创建")}</Button>
        </Fragment>
      }
    >
      <Field label={t("名称")} htmlFor="harbor-files-new-directory">
        <TextInput
          id="harbor-files-new-directory"
          data-modal-autofocus=""
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") void onSubmit(); }}
          placeholder={t("新目录名")}
        />
      </Field>
    </Dialog>
  );
}
