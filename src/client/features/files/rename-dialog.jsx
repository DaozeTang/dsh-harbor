/**
 * The 改名 dialog: the current name pre-filled, so "unchanged" is visible.
 *
 * Presentational: the draft name and the busy flag belong to the pane.
 */
import * as React from "react";
import { Button, Dialog, Field, TextInput } from "../../ui/kit.jsx";
import { joinPath } from "./path-utils.js";
import { t } from "../../../i18n/core.js";

const { Fragment } = React;

export function RenameDialog({ open, cwd, selected, busy, name, onNameChange, onClose, onSubmit }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("改名")}
      description={selected === null ? undefined : joinPath(cwd, selected.name)}
      footer={
        <Fragment>
          <Button variant="secondary" onClick={onClose}>{t("取消")}</Button>
          <Button
            variant="primary"
            icon="list-pen-outline"
            busy={busy}
            disabled={selected === null || !name.trim() || name.trim() === selected.name}
            onClick={onSubmit}
          >
            {t("改名")}
          </Button>
        </Fragment>
      }
    >
      <Field label={t("名称")} htmlFor="harbor-files-rename">
        <TextInput
          id="harbor-files-rename"
          data-modal-autofocus=""
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") void onSubmit(); }}
        />
      </Field>
    </Dialog>
  );
}
