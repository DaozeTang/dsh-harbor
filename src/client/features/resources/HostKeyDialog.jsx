import * as React from "react";
import { Button, Dialog, Field } from "../../ui/kit.jsx";
import { t } from "../../../i18n/core.js";

/** View / copy / forget one trusted host's fingerprint. */
export function HostKeyDialog({ host, port, known, copied, onCopy, onForget, forgetBusy, onClose }) {
  const key = `${host}:${port}`;
  return (
    <Dialog
      open
      onClose={onClose}
      title={t(`主机指纹 · ${host}:${port}`)}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t("关闭")}</Button>
          <span className="hb-spacer" />
          <Button variant="secondary" icon="copy-outline" onClick={() => onCopy(host, port, known.fingerprint)}>
            {copied === key ? t("已复制") : t("复制指纹")}
          </Button>
          <Button variant="danger" disabled={forgetBusy === key} onClick={() => onForget(host, port)}>
            {forgetBusy === key ? t("忘记中…") : t("忘记指纹")}
          </Button>
        </>
      }
    >
      <div className="hb-stack">
        <Field label={t("SHA-256 指纹")} hint={t("可与此服务器上 ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub 的输出比对")}>
          <div className="hb-mono hb-settings-fingerprint">{"SHA256:" + known.fingerprint}</div>
        </Field>
        <div className="hb-quiet">{known.algorithm || "ssh-host-key"}</div>
        <div className="hb-quiet">{t(`首次信任 ${new Date(known.firstSeenAt).toLocaleString()} · 最近 ${new Date(known.lastSeenAt).toLocaleString()}`)}</div>
      </div>
    </Dialog>
  );
}
