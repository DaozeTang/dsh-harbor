import * as React from "react";
import { useState } from "react";
import { Button, Checkbox, Dialog, ErrorNote, Field, Notice, TextInput } from "../../ui/kit.jsx";
import { t } from "../../../i18n/core.js";

export function ResourceBackupDialog({ mode, api, onClose, onImported }) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [importResult, setImportResult] = useState(null);
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [preview, setPreview] = useState(null);
  const submit = async () => {
    if (password.length < 12) return setError(t("备份口令至少需要 12 个字符。"));
    if (mode === "export" && password !== confirmation) return setError(t("两次输入的备份口令不一致。"));
    if (mode === "import" && !file) return setError(t("请选择加密备份文件。"));
    if (file?.size > 64 * 1024 * 1024) return setError(t("备份文件超过 64 MB。"));
    setBusy(true); setError("");
    try {
      if (mode === "export") {
        const { archive } = await api.resourceBackupExport(password);
        const url = URL.createObjectURL(new Blob([archive], { type: "application/json" }));
        const link = document.createElement("a"); link.href = url; link.download = "harbor-resources-" + new Date().toISOString().slice(0, 10) + ".json";
        document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        setSuccess(t("加密备份已生成，请妥善保存文件和口令。"));
      } else {
        if (!preview) {
          const archive = await file.text();
          setPreview({ ...await api.resourceBackupPreview(password, archive), archive });
          return;
        }
        const result = await api.resourceBackupImport(password, preview.archive, skipDuplicates);
        setImportResult(result);
        await onImported();
        setSuccess(t(`已导入 ${result.profiles} 台服务器、${result.groups} 个分组和 ${result.credentials} 个共享凭据。`));
      }
      setPassword(""); setConfirmation("");
    } catch (cause) { setError(cause?.message ?? t("备份操作失败。")); }
    finally { setBusy(false); }
  };
  const submitLabel = mode === "export" ? t("导出") : preview ? t("确认导入") : t("预览备份");
  return (
    <Dialog
      open
      onClose={busy ? () => {} : onClose}
      title={mode === "export" ? t("导出服务器") : t("导入服务器")}
      description={mode === "export"
        ? t("备份包含服务器配置、分组、共享凭据、密码、私钥和已信任的主机指纹。文件使用口令加密；忘记口令将无法恢复。")
        : t("导入会新增服务器和凭据，相同名称的分组会复用，不会覆盖现有服务器。重复导入会产生重复服务器；主机指纹冲突时会拒绝导入。")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t("关闭")}</Button>
          <Button variant="primary" onClick={submit} busy={busy} disabled={Boolean(success)}>{submitLabel}</Button>
        </>
      }
    >
      <div className="hb-stack">
        <Notice icon="info-outline">{t("备份不包含全局 AI 策略或本机工作区绑定。")}</Notice>
        {mode === "import" && (
          <Field label={t("加密备份文件")}>
            <input
              type="file"
              accept=".json,application/json"
              disabled={busy || Boolean(success)}
              onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPreview(null); }}
              className="hb-input hb-settings-file"
            />
          </Field>
        )}
        <Field label={t("备份口令")}>
          <TextInput
            type="password"
            autoComplete="new-password"
            value={password}
            disabled={busy || Boolean(success)}
            onChange={(event) => { setPassword(event.target.value); setPreview(null); }}
            data-modal-autofocus={mode === "export" ? true : undefined}
          />
        </Field>
        {mode === "export" && (
          <Field label={t("再次输入口令")}>
            <TextInput
              type="password"
              autoComplete="new-password"
              value={confirmation}
              disabled={busy || Boolean(success)}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </Field>
        )}
        {preview && !success && (
          <div className="hb-stack hb-stack--tight" role="status">
            <span>{t(`备份包含 ${preview.profiles} 台服务器、${preview.groups} 个分组和 ${preview.credentials} 个共享凭据。`)}</span>
            {preview.duplicates.length > 0 && (
              <span className="hb-quiet">{t("以下服务器可能重复：")} {preview.duplicates.join(", ")}</span>
            )}
            <Checkbox checked={skipDuplicates} disabled={busy} onChange={setSkipDuplicates} label={t("跳过重复服务器")} />
          </div>
        )}
        {importResult?.skipped > 0 && <div className="hb-quiet">{t(`已跳过 ${importResult.skipped} 台重复服务器。`)}</div>}
        {importResult?.retained?.length > 0 && (
          <div className="hb-quiet">{t("以下跳板无法确认与现有记录等同，已保留备份中的版本：")} {importResult.retained.join(", ")}</div>
        )}
        {error !== "" && <ErrorNote>{error}</ErrorNote>}
        {success !== "" && <Notice icon="check-circle-fill">{success}</Notice>}
      </div>
    </Dialog>
  );
}
