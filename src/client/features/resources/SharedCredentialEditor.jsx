import * as React from "react";
import { useRef, useState } from "react";
import { Button, Dialog, ErrorNote, Field, Select, TextArea, TextInput } from "../../ui/kit.jsx";
import { privateKeyProblem } from "../connect/pemkey.js";
import { t } from "../../../i18n/core.js";
import { credentialWrite } from "./form.js";

export function SharedCredentialEditor({ initial, credentials, api, onClose, onSaved }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [authKind, setAuthKind] = useState(initial?.authKind ?? "key");
  const [secret, setSecret] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [secondary, setSecondary] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef(null);

  const importKey = async (file) => {
    if (!file) return;
    if (file.size > 1024 * 1024) return setError(t("私钥文件不能超过 1 MB"));
    try {
      const text = await file.text();
      if (!text.trim()) throw new Error(t("所选私钥文件为空"));
      const problem = privateKeyProblem(text);
      if (problem) throw new Error(problem);
      setSecret(text);
      setError(null);
    } catch (cause) {
      setError(cause?.message ?? t("无法读取私钥文件"));
    }
  };

  const save = async () => {
    if (!name.trim()) return setError(t("请填写凭据名称"));
    if (authKind === "key" && secret) {
      const problem = privateKeyProblem(secret, passphrase);
      if (problem) return setError(problem);
    }
    setBusy(true);
    try {
      const saved = await api.credentialSave({
        ...(initial?.credentialId ? { credentialId: initial.credentialId } : {}),
        name: name.trim(),
        authKind
      });
      const ref = authKind === "password" ? saved.credentialRefs.password : saved.credentialRefs.privateKey;
      if (secret) await credentialWrite(credentials, ref, secret);
      if (authKind === "key" && passphrase) await credentialWrite(credentials, saved.credentialRefs.passphrase, passphrase);
      const secondaryRef = authKind === "password" ? saved.credentialRefs.privateKey : saved.credentialRefs.password;
      if (secondary.trim()) await credentialWrite(credentials, secondaryRef, secondary);
      await onSaved();
      onClose();
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={initial ? t("编辑共享凭据") : t("新增共享凭据")}
      description={t("共享凭据只在本机凭据库中保存一份，多台服务器可共用。")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t("取消")}</Button>
          <Button variant="primary" onClick={save} busy={busy}>{t("保存凭据")}</Button>
        </>
      }
    >
      <div
        className="hb-stack"
        onDragOver={(event) => { if (authKind === "key") event.preventDefault(); }}
        onDrop={(event) => {
          if (authKind !== "key") return;
          event.preventDefault();
          importKey(event.dataTransfer.files?.[0]);
        }}
      >
        <Field label={t("名称")}>
          <TextInput value={name} onChange={(event) => setName(event.target.value)} placeholder={t("生产环境运维私钥")} data-modal-autofocus />
        </Field>
        <Field label={t("认证方式")}>
          <Select
            value={authKind}
            onChange={(event) => setAuthKind(event.target.value)}
            options={[{ value: "key", label: t("PEM / 私钥") }, { value: "password", label: t("密码") }]}
          />
        </Field>
        <Field
          label={authKind === "key" ? t("私钥") : t("密码")}
          hint={initial?.credentialConfigured ? t("已保存；留空保持不变") : undefined}
        >
          {authKind === "key" ? (
            <div className="hb-stack hb-stack--tight">
              <TextArea value={secret} onChange={(event) => setSecret(event.target.value)} rows={4} className="hb-input--mono" />
              {/* Accepts extensionless keys too; see ResourceEditor's key input. */}
              <input
                ref={fileInput}
                type="file"
                onChange={(event) => { importKey(event.target.files?.[0]); event.target.value = ""; }}
                className="hb-visually-hidden"
              />
              <div className="hb-inline hb-inline--wrap">
                <Button variant="secondary" size="sm" icon="upload-outline" onClick={() => fileInput.current?.click()}>{t("选择私钥文件")}</Button>
                <span className="hb-quiet">{t("也可将 PEM / 私钥文件拖入此窗口。")}</span>
              </div>
            </div>
          ) : (
            <TextInput type="password" value={secret} onChange={(event) => setSecret(event.target.value)} autoComplete="off" />
          )}
        </Field>
        {authKind === "key" && (
          <Field label={t("私钥口令")}>
            <TextInput type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} autoComplete="off" />
          </Field>
        )}
        <Field
          label={authKind === "password" ? t("第二因素：私钥（可选）") : t("第二因素：密码（可选）")}
          hint={initial?.secondaryConfigured ? t("已保存；留空保持不变") : t("双因素设备（AuthenticationMethods password+publickey）才需要填写")}
        >
          {authKind === "password" ? (
            <TextArea value={secondary} onChange={(event) => setSecondary(event.target.value)} rows={4} className="hb-input--mono" />
          ) : (
            <TextInput type="password" value={secondary} onChange={(event) => setSecondary(event.target.value)} autoComplete="off" />
          )}
        </Field>
        {error !== null && <ErrorNote>{error}</ErrorNote>}
      </div>
    </Dialog>
  );
}
