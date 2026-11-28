/**
 * The upload name-conflict prompt: skip, keep both, or overwrite — optionally
 * for every remaining file of the batch.
 *
 * Presentational: the pending choice lives in the transfer registry, so the
 * prompt reopens after a remount instead of stranding the upload.
 */
import * as React from "react";
import { Button, Checkbox, Dialog } from "../../ui/kit.jsx";
import { t } from "../../../i18n/core.js";

export function UploadConflictDialog({ conflict, applyAll, onApplyAllChange }) {
  return (
    <Dialog
      open={conflict !== null}
      onClose={() => conflict?.cancel()}
      title={t("上传遇到同名项")}
      closeOnScrim={false}
      footer={conflict === null ? undefined : (
        <div className="hb-files__foot">
          <Button variant="ghost" onClick={() => conflict.cancel()}>{t("取消上传")}</Button>
          <span className="hb-spacer" />
          <Button variant="secondary" onClick={() => conflict.choose("skip", applyAll)}>{t("跳过")}</Button>
          <Button variant="primary" onClick={() => conflict.choose("rename", applyAll)}>{t("保留两份")}</Button>
          {conflict.canOverwrite && (
            <Button variant="secondary" onClick={() => conflict.choose("overwrite", applyAll)}>{t("覆盖")}</Button>
          )}
        </div>
      )}
    >
      {conflict !== null && (
        <div className="hb-files__conflict">
          <code className="hb-files__conflictpath">{conflict.path}</code>
          {conflict.moreFiles === true && (
            <Checkbox checked={applyAll} onChange={onApplyAllChange} label={t("对剩余同名项应用此选择")} />
          )}
        </div>
      )}
    </Dialog>
  );
}
