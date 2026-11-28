import * as React from "react";
import { useRef, useState } from "react";
import { Button, Checkbox, Dialog, ErrorNote, Field, IconButton, Notice, SegmentedControl, Select, TextArea, TextInput } from "../../ui/kit.jsx";
import { privateKeyProblem } from "../connect/pemkey.js";
import { t } from "../../../i18n/core.js";
import { ResourceWorkspaces } from "./ResourceWorkspaces.jsx";
import { credentialUnset, credentialWrite, emptyForm, hostKeyModeOptions, profileToForm } from "./form.js";

export function ResourceEditor({ initial, groups, profiles, sharedCredentials = [], credentials, api, defaultUsername = null, onClose, onSaved }) {
  const [form, setForm] = useState(() => initial ? profileToForm(initial) : emptyForm(defaultUsername));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const keyFileInput = useRef(null);
  // Two tabs instead of one ever-growing form: 基本 carries the coordinates and
  // credentials, 高级选项 the rarely-touched knobs. The dialog always opens on
  // 基本 — an editor that jumps tabs based on what is configured feels random.
  const [formTab, setFormTab] = useState("basic");
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const setChecked = (key) => (value) => setForm((current) => ({ ...current, [key]: value }));
  const addJump = () => setForm((current) => ({ ...current, proxyJump: [...current.proxyJump, { profileId: "" }] }));
  const updateJump = (index, key, value) => setForm((current) => ({ ...current, proxyJump: current.proxyJump.map((hop, i) => i === index ? { ...hop, [key]: value } : hop) }));
  const removeJump = (index) => setForm((current) => ({ ...current, proxyJump: current.proxyJump.filter((_, i) => i !== index) }));

  const importKey = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 1024 * 1024) return setError(t("私钥文件不能超过 1 MB"));
    try {
      const secret = await file.text();
      if (!secret.trim()) throw new Error(t("所选私钥文件为空"));
      setForm((current) => ({ ...current, secret }));
      setError(null);
    } catch (cause) {
      setError(cause?.message ?? t("无法读取私钥文件"));
    }
  };

  const submit = async () => {
    if (!form.name.trim() || !form.host.trim() || !form.username.trim()) {
      setError(t("请填写名称、主机和用户名"));
      return;
    }
    if (!credentials) {
      setError(t("当前 DSH 未提供凭据服务，不能安全保存 SSH 认证信息"));
      return;
    }
    if (form.proxyJump.some((hop) => !hop.profileId)) {
      setError(t("请选择每台跳板服务器"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // A truncated paste is the most common way a saved key ends up
      // "valid-looking but rejected by the server": catch it before anything
      // is persisted instead of surfacing later as a bare auth failure.
      if (form.authKind === "key" && form.secret.trim()) {
        const problem = privateKeyProblem(form.secret, form.passphrase);
        if (problem) {
          setError(problem);
          return;
        }
      }
      const saved = await api.profileSave({
        ...(form.profileId ? { profileId: form.profileId } : {}),
        name: form.name.trim(),
        host: form.host.trim(),
        port: Number(form.port) || 22,
        username: form.username.trim(),
        authKind: form.authKind,
        hostKeyMode: form.hostKeyMode,
        agentForward: form.agentForward === true,
        groupId: form.groupId || null,
        credentialId: form.credentialId || null,
        defaultProjectPath: form.defaultProjectPath.trim() || null,
        loginCommand: form.loginCommand.trim() || null,
        execPolicy: form.execPolicy || null,
        proxyJump: form.proxyJump.map((hop) => ({ profileId: hop.profileId }))
      });
      const primaryRef = form.authKind === "password" ? saved.credentialRefs.password : saved.credentialRefs.privateKey;
      if (form.secret.trim()) await credentialWrite(credentials, primaryRef, form.secret);
      else if (form.clearSecret) await credentialUnset(credentials, primaryRef);
      if (form.authKind === "key") {
        if (form.passphrase) await credentialWrite(credentials, saved.credentialRefs.passphrase, form.passphrase);
        else if (form.clearPassphrase) await credentialUnset(credentials, saved.credentialRefs.passphrase);
      }
      // Optional second factor for dual-factor devices (AuthenticationMethods
      // password,publickey or the reverse): stored in the opposite-kind slot.
      const secondaryRef = form.authKind === "password" ? saved.credentialRefs.privateKey : saved.credentialRefs.password;
      if (form.secondary.trim()) await credentialWrite(credentials, secondaryRef, form.secondary);
      else if (form.clearSecondary) await credentialUnset(credentials, secondaryRef);
      // The saved username becomes the next new-server prefill: the host has
      // already persisted it by now; hand it up so this session's state keeps
      // up without a settings round-trip.
      await onSaved({ username: form.username.trim() });
      onClose();
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      setBusy(false);
    }
  };

  const primaryConfigured = initial?.credentialConfigured;
  return (
    <Dialog
      open
      onClose={busy ? () => {} : onClose}
      title={form.profileId ? t("编辑 SSH 资源") : t("新增 SSH 资源")}
      description={t("认证信息只写入本机 DSH 凭据库，不会出现在对话里。")}
      width="wide"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t("取消")}</Button>
          <Button variant="primary" onClick={submit} busy={busy}>{t("保存资源")}</Button>
        </>
      }
    >
      <div className="hb-stack">
        <SegmentedControl
          value={formTab}
          onChange={setFormTab}
          label={t("资源信息与高级选项")}
          items={[
            { value: "basic", label: t("基本"), icon: "edit-outline" },
            { value: "advanced", label: t("高级选项"), icon: "sliders-two-outline" }
          ]}
        />
        {formTab === "basic" && <>
          <div className="hb-grid hb-grid--2">
            <Field label={t("名称")}>
              <TextInput value={form.name} onChange={set("name")} placeholder={t("阿里云生产环境")} data-modal-autofocus />
            </Field>
            <Field label={t("主机")}>
              <TextInput value={form.host} onChange={set("host")} placeholder={t("example.com 或 IP 地址")} mono />
            </Field>
            <Field label={t("端口")}>
              <TextInput value={form.port} onChange={set("port")} inputMode="numeric" />
            </Field>
            <Field label={t("用户名")}>
              <TextInput value={form.username} onChange={set("username")} />
            </Field>
            <Field label={t("分组")}>
              <Select
                value={form.groupId}
                onChange={set("groupId")}
                options={[{ value: "", label: t("未分组") }, ...groups.map((group) => ({ value: group.groupId, label: group.name }))]}
              />
            </Field>
            <Field label={t("认证方式")}>
              <Select
                value={form.authKind}
                onChange={set("authKind")}
                options={[{ value: "password", label: t("密码") }, { value: "key", label: t("PEM / 私钥") }]}
              />
            </Field>
            <Field label={t("共享凭据")} hint={t("共享凭据只在本机凭据库中保存一份，多台服务器可共用。")} className="hb-settings-span">
              <Select
                value={form.credentialId}
                onChange={set("credentialId")}
                options={[
                  { value: "", label: t("此服务器专属凭据") },
                  ...sharedCredentials
                    .filter((item) => item.authKind === form.authKind)
                    .map((item) => ({ value: item.credentialId, label: item.name }))
                ]}
              />
            </Field>
          </div>

          <Field
            label={form.authKind === "password" ? t("密码") : t("私钥（PEM / .key）")}
            hint={primaryConfigured ? t("已保存；留空保持不变") : t("保存后仅显示已配置状态")}
          >
            <div className="hb-stack hb-stack--tight">
              {form.authKind === "password" ? (
                <TextInput type="password" value={form.secret} onChange={set("secret")} autoComplete="off" />
              ) : (
                <>
                  <TextArea value={form.secret} onChange={set("secret")} rows={4} className="hb-input--mono" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
                  {/* No accept filter: keys generated by some tools have no
                      extension (e.g. "1" instead of "1.key"), and a picker
                      restricted to known suffixes greys them out. The file is
                      validated after selection instead. */}
                  <input
                    ref={keyFileInput}
                    type="file"
                    onChange={importKey}
                    className="hb-visually-hidden"
                  />
                  <div>
                    <Button variant="secondary" size="sm" icon="upload-outline" onClick={() => keyFileInput.current?.click()}>
                      {t("导入 PEM / 私钥文件")}
                    </Button>
                  </div>
                </>
              )}
              {primaryConfigured && (
                <Checkbox checked={form.clearSecret} onChange={setChecked("clearSecret")} label={t("清除已保存的认证信息")} />
              )}
            </div>
          </Field>

          {form.authKind === "key" && (
            <Field label={t("私钥口令")} hint={initial?.passphraseConfigured ? t("已保存；留空保持不变") : t("可选")}>
              <div className="hb-stack hb-stack--tight">
                <TextInput type="password" value={form.passphrase} onChange={set("passphrase")} autoComplete="off" />
                {initial?.passphraseConfigured && (
                  <Checkbox checked={form.clearPassphrase} onChange={setChecked("clearPassphrase")} label={t("清除已保存的私钥口令")} />
                )}
              </div>
            </Field>
          )}

          <Field label={t("跳板机（ProxyJump）")}>
            <div className="hb-stack hb-stack--tight">
              {form.proxyJump.map((hop, index) => (
                <div key={index} className="hb-inline">
                  <span className="hb-quiet hb-numeric">{index + 1}</span>
                  <Select
                    value={hop.profileId ?? ""}
                    onChange={(event) => updateJump(index, "profileId", event.target.value)}
                    options={[
                      { value: "", label: t("选择已保存服务器") },
                      ...profiles
                        .filter((profile) => profile.profileId !== form.profileId)
                        .map((profile) => ({ value: profile.profileId, label: profile.name + " · " + profile.username + "@" + profile.host + ":" + profile.port }))
                    ]}
                  />
                  <IconButton icon="close-outline" label={t("移除")} onClick={() => removeJump(index)} />
                </div>
              ))}
              <div>
                <Button variant="ghost" size="sm" icon="plus-outline" onClick={addJump}>{t("＋ 添加跳板")}</Button>
              </div>
            </div>
          </Field>
        </>}
        {formTab === "advanced" && (
          <div className="hb-stack">
            <div className="hb-grid hb-grid--2">
              <Field label={t("默认项目目录")}>
                <TextInput value={form.defaultProjectPath} onChange={set("defaultProjectPath")} placeholder={t("例如 /srv/apps/my-service")} mono />
              </Field>
              <Field label={t("登录命令（可选）")} hint={t("设置后终端以该命令作为登录会话打开，替代服务器默认 shell")}>
                <TextInput
                  value={form.loginCommand}
                  onChange={set("loginCommand")}
                  placeholder={t("例如 bash -l")}
                  mono
                  title={t("在默认 shell 不兼容的服务器（如 zsh）上填 bash -l 可临时改用 bash；命令即整个登录会话，想要正常 profile 加载请带 -l；留空按服务器默认。")}
                />
              </Field>
              <Field label={t("主机指纹校验")}>
                <Select value={form.hostKeyMode} onChange={set("hostKeyMode")} options={hostKeyModeOptions()} />
              </Field>
              <Field label={t("SSH Agent 转发")} hint={t("连接后可从这台服务器的终端用本机密钥继续登录更深层的机器")}>
                <Checkbox checked={form.agentForward} onChange={setChecked("agentForward")} label={t("转发本机 ssh-agent（需本机已运行）")} />
              </Field>
              <Field label={t("执行策略")} hint={t("覆盖全局 AI 命令拦截档位；生产机保持「跟随全局设置」即可")}>
                <Select
                  value={form.execPolicy}
                  onChange={set("execPolicy")}
                  options={[
                    { value: "", label: t("跟随全局设置") },
                    { value: "standard", label: t("标准") },
                    { value: "custom", label: t("自定义放行") },
                    { value: "allowAll", label: t("全部放行") }
                  ]}
                />
              </Field>
              <Field label={t("第二因素（可选）")} hint={initial?.secondaryConfigured ? t("已保存；留空保持不变") : undefined}>
                <div className="hb-stack hb-stack--tight">
                  {form.authKind === "password" ? (
                    <TextArea
                      value={form.secondary}
                      onChange={set("secondary")}
                      rows={3}
                      className="hb-input--mono"
                      placeholder={t("双因素设备才需要填写")}
                      title={t("防火墙/交换机启用 AuthenticationMethods password+publickey 双因素认证时填写；PEM 可直接粘贴")}
                    />
                  ) : (
                    <TextInput
                      type="password"
                      value={form.secondary}
                      onChange={set("secondary")}
                      autoComplete="off"
                      placeholder={t("双因素设备才需要填写")}
                      title={t("防火墙/交换机启用 AuthenticationMethods publickey,password 双因素认证时填写")}
                    />
                  )}
                  {initial?.secondaryConfigured && (
                    <Checkbox checked={form.clearSecondary} onChange={setChecked("clearSecondary")} label={t("清除已保存的第二因素")} />
                  )}
                </div>
              </Field>
            </div>
            {/* Workspace-level counterpart of 默认项目目录: that field is the
                resource-wide default path, this one pins a specific DSH
                workspace to a directory on this very server. */}
            {form.profileId
              ? <ResourceWorkspaces api={api} profileId={form.profileId} projectPath={form.defaultProjectPath} />
              : <Notice icon="info-outline">{t("远程工作区需要先保存这台服务器——保存后回到「高级选项」即可把工作区绑定到它的目录。")}</Notice>}
          </div>
        )}
        {error !== null && <ErrorNote>{error}</ErrorNote>}
      </div>
    </Dialog>
  );
}
