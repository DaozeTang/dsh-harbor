import * as React from "react";
import { useEffect, useState } from "react";
import { Badge, Button, Checkbox, Dialog, ErrorNote, Field, Row, Select } from "../../ui/kit.jsx";
import { t } from "../../../i18n/core.js";

export function OpenSshImportDialog({ api, groups, profiles, onClose, onImported }) {
  const [preview, setPreview] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [group, setGroup] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api.openSshImport().then(({ preview: value }) => {
      if (!active) return;
      setPreview(value);
      setSelected(new Set(value.entries.filter((entry) => !entry.existing && !entry.unsupported).map((entry) => entry.name)));
    }).catch((cause) => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [api]);

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const { imported } = await api.openSshImport({ fingerprint: preview.fingerprint, names: [...selected], groupId: group || null });
      setResult(imported);
      await onImported();
    } catch (cause) {
      setError(cause.message);
    } finally {
      setBusy(false);
    }
  };
  const aliases = new Map((preview?.entries ?? []).map((entry) => [entry.name.toLowerCase(), entry]));
  const savedByName = new Map(profiles.map((profile) => [profile.name.toLowerCase(), profile]));
  const missingHops = (entry) => entry.hops.filter((hop) => {
    const alias = hop.toLowerCase();
    const target = aliases.get(alias);
    if (!target || target.unsupported || alias === entry.name.toLowerCase()) return true;
    if (!target.existing) return !selected.has(target.name);
    const saved = savedByName.get(alias);
    return saved?.host !== target.host || saved?.port !== target.port || saved?.username !== target.username;
  });
  return (
    <Dialog
      open
      onClose={busy ? () => {} : onClose}
      title={t("从 SSH 配置导入")}
      description={t("读取 DSH 宿主的 ~/.ssh/config；IdentityFile 指向的私钥会一并导入，密码和私钥口令仍需手动补填。")}
      width="wide"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t("关闭")}</Button>
          {!result && <Button variant="primary" onClick={submit} busy={busy} disabled={selected.size === 0}>{t("导入")}</Button>}
        </>
      }
    >
      <div className="hb-stack">
        {!preview && !error && <div className="hb-quiet" role="status">{t("处理中…")}</div>}
        {preview?.entries.length === 0 && <div className="hb-quiet">{t("没有找到可列出的 SSH 主机。")}</div>}
        {preview?.entries.length > 0 && !result && <>
          <Field label={t("分组")}>
            <Select
              value={group}
              onChange={(event) => setGroup(event.target.value)}
              disabled={busy}
              options={[{ value: "", label: t("未分组") }, ...groups.map((item) => ({ value: item.groupId, label: item.name }))]}
            />
          </Field>
          <div className="hb-settings-scroll hb-settings-list">
            {preview.entries.map((entry) => (
              <Row
                key={entry.name}
                leading={
                  <Checkbox
                    checked={selected.has(entry.name)}
                    disabled={busy || entry.existing || entry.unsupported}
                    label={<span className="hb-visually-hidden">{entry.name}</span>}
                    onChange={(checked) => {
                      setSelected((previous) => {
                        const next = new Set(previous);
                        if (checked) next.add(entry.name);
                        else next.delete(entry.name);
                        return next;
                      });
                    }}
                  />
                }
                title={entry.name}
                meta={
                  <>
                    <span className="hb-mono">{entry.username}@{entry.host}:{entry.port}</span>
                    {entry.hops.length > 0 && <Badge mono title={t("跳板机（ProxyJump）")}>{entry.hops.join(" → ")}</Badge>}
                    {entry.existing && <Badge>{t("已存在")}</Badge>}
                    {entry.unsupported && <Badge tone="warn">{t("配置暂不支持")} · {entry.issues.join(", ")}</Badge>}
                    {!entry.existing && !entry.unsupported && entry.authKind === "password" && <Badge tone="warn">{t("需补填密码")}</Badge>}
                    {!entry.existing && !entry.unsupported && entry.authKind === "key" && entry.keyStatus === "ready" && (
                      <Badge tone="ok" title={entry.keyPath ?? undefined}>{t("自动导入私钥")}</Badge>
                    )}
                    {!entry.existing && !entry.unsupported && entry.authKind === "key" && entry.keyStatus === "passphrase" && (
                      <Badge tone="warn" title={entry.keyPath ?? undefined}>{t("自动导入私钥（需填口令）")}</Badge>
                    )}
                    {!entry.existing && !entry.unsupported && entry.authKind === "key" && entry.keyStatus !== "ready" && entry.keyStatus !== "passphrase" && (
                      <Badge tone="warn" title={entry.keyPath ?? undefined}>{t("无法自动导入私钥")}</Badge>
                    )}
                    {!entry.existing && missingHops(entry).length > 0 && <Badge tone="err">{t("缺少可用跳板：")} {missingHops(entry).join(", ")}</Badge>}
                  </>
                }
              />
            ))}
          </div>
        </>}
        {error !== "" && <ErrorNote>{error}</ErrorNote>}
        {result && (
          <div className="hb-stack" role="status">
            <div>{t(`已导入 ${result.created} 台服务器。`)}</div>
            {result.keysImported > 0 && <div className="hb-quiet">{t(`已自动导入 ${result.keysImported} 个私钥。`)}</div>}
            {result.passphraseRequired.length > 0 && (
              <div className="hb-quiet">{t("以下服务器的私钥已导入，但需要补填私钥口令：")}{result.passphraseRequired.join(", ")}</div>
            )}
            {result.skipped.length > 0 && <div className="hb-quiet">{t("已存在")} · {result.skipped.join(", ")}</div>}
            {result.details.length > 0 && (
              <div className="hb-settings-scroll hb-stack hb-stack--tight">
                {result.details.map(({ name, reason, items }) => (
                  <div key={name} className="hb-quiet">
                    {name} · {{ unsupported: t("配置暂不支持"), cycle: t("跳板链存在循环"), repeated: t("跳板链包含重复服务器"), missing: t("缺少可用跳板："), save: t("保存服务器失败"), key: t("导入私钥失败") }[reason]} {items.join(", ")}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
