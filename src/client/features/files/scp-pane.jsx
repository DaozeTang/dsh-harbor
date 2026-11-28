/**
 * The SCP fallback surface, shown when the SFTP subsystem cannot be opened.
 *
 * One file in, one file out, by absolute path — the only thing SCP can do here.
 * The notice keeps the retry that leaves the downgrade (the listing decides it)
 * so one unlucky first load does not cost the connection its file manager.
 */
import * as React from "react";
import { Button, Card, ErrorNote, Field, IconButton, Notice, TextInput } from "../../ui/kit.jsx";
import { t } from "../../../i18n/core.js";

const { useRef } = React;

export function ScpPane({
  busy, error, scpReason, retrySftp, onDismissError,
  uploadFile, uploadPath, downloadPath, onUploadFileChange, onUploadPathChange, onDownloadPathChange,
  onUpload, onDownload
}) {
  const scpFileInputRef = useRef(null);
  return (
    <div className="hb-files hb-files__scp">
      <div className="hb-inline" style={{ alignItems: "flex-start" }}>
        <Notice icon="warning-triangle-outline">
          {t("SFTP 子系统不可用，已切换到 SCP 兼容模式。仅支持单文件上传和下载，需填写远端完整路径。")}
        </Notice>
        <Button variant="secondary" size="sm" icon="refresh-outline" busy={busy} onClick={retrySftp}>
          {t("重试 SFTP")}
        </Button>
      </div>
      {scpReason !== "" && <div className="hb-quiet">{scpReason}</div>}
      {error !== null && (
        <ErrorNote action={<IconButton icon="close-outline" size="sm" label={t("关闭")} onClick={onDismissError} />}>
          {error}
        </ErrorNote>
      )}
      <Card title={t("上传文件")}>
        <Field label={t("本地文件")}>
          <div className="hb-inline">
            <Button variant="secondary" size="sm" icon="folder-open-outline" onClick={() => scpFileInputRef.current?.click()}>
              {t("选择文件")}
            </Button>
            <span className="hb-quiet hb-truncate">{uploadFile === null ? t("未选择文件") : uploadFile.name}</span>
          </div>
          <input
            ref={scpFileInputRef}
            type="file"
            hidden
            onChange={(event) => onUploadFileChange(event.target.files?.[0] ?? null)}
          />
        </Field>
        <Field label={t("远端路径")}>
          <TextInput
            value={uploadPath}
            onChange={(event) => onUploadPathChange(event.target.value)}
            placeholder={t("远端完整目标路径，例如 /tmp/report.zip")}
            mono
          />
        </Field>
        <div className="hb-inline">
          <span className="hb-spacer" />
          <Button variant="primary" icon="upload-outline" busy={busy} disabled={!uploadFile || !uploadPath.trim()} onClick={onUpload}>
            {t("上传")}
          </Button>
        </div>
      </Card>
      <Card title={t("下载文件")}>
        <Field label={t("远端路径")}>
          <TextInput
            value={downloadPath}
            onChange={(event) => onDownloadPathChange(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void onDownload(); }}
            placeholder={t("远端完整文件路径，例如 /var/log/app.log")}
            mono
          />
        </Field>
        <div className="hb-inline">
          <span className="hb-spacer" />
          <Button variant="primary" icon="download-outline" busy={busy} disabled={!downloadPath.trim()} onClick={onDownload}>
            {t("下载")}
          </Button>
        </div>
      </Card>
    </div>
  );
}
