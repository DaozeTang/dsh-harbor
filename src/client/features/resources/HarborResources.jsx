/**
 * Durable SSH resources for the plugin's Settings section.
 *
 * One column, six cards: saved servers, shared credentials, trusted host keys,
 * AI policy, feature switches, then language and update. A settings page is
 * scanned top to bottom, so records are cards instead of tabs, and each card
 * owns exactly one primary action.
 *
 * Server coordinates live in the host storage domain; secrets only cross the
 * web boundary through DSH's credentials.set/unset API and are never put in
 * React state after save.
 */
import * as React from "react";
import {
  Badge, Button, Card, Checkbox, ConfirmHost, Dialog, EmptyState, ErrorNote, Field, Icon, IconButton, InputGroup,
  Menu, MenuItem, MenuLabel, MenuSeparator, Notice, Row, Section, SegmentedControl, Select, Switch,
  TextArea, TextInput, confirmAction
} from "../../ui/kit.jsx";
import { installSurfaceStyles } from "../../ui/styles.js";
import SETTINGS_CSS from "./settings.css";
import {
  harborUiRequestSurface, harborUiSetError, harborUiSetFeatures, harborUiSetProjectTarget
} from "../../state/store.js";
import { requestPaneOpen } from "../../state/pane-selection.js";
import { privateKeyProblem } from "../connect/pemkey.js";
import { t } from "../../../i18n/core.js";
import { LANGUAGE_LABELS, getLanguage, setLanguage, useLanguage } from "../../core/locale.js";
import { ResourceWorkspaces } from "./ResourceWorkspaces.jsx";
import { TIER_ORDER, execPolicyLabel, execPolicyLooseningDetail } from "../policy/exec-policy-ui.js";
import { inspectInstallation } from "./update-guidance.js";

/**
 * Injected at build time from package.json (scripts/build-client.mjs). A
 * harness that does not define it must still render a neutral label, never the
 * fallback identifier.
 */
// eslint-disable-next-line no-undef
const INJECTED_VERSION = typeof __DSH_HARBOR_VERSION__ === "string" ? __DSH_HARBOR_VERSION__ : "";
const PLUGIN_VERSION = INJECTED_VERSION === "" ? "unknown" : INJECTED_VERSION;

// One sheet for what the kit's shared classes cannot express (group headers,
// grid spans, wrapping rows); installed under its own tag and guarded against
// duplicates by installSurfaceStyles.
installSurfaceStyles("settings", SETTINGS_CSS);

const { useEffect, useRef, useState } = React;
const LEGACY_PROFILES_KEY = "dsh-harbor.server-profiles.v1";

// Evaluated per render: a module-level object would freeze the labels in
// whatever language was active at import time.
const hostKeyModeLabels = () => ({
  "accept-new": t("默认（首次信任，变化才拒）"),
  verify: t("严格（拒绝未知主机）"),
  off: t("关闭校验（不推荐）")
});

const hostKeyModeOptions = () => Object.entries(hostKeyModeLabels()).map(([value, label]) => ({ value, label }));

function emptyForm(defaultUsername) {
  return {
    profileId: undefined,
    name: "",
    host: "",
    port: "22",
    username: (defaultUsername ?? "").trim() || "root",
    authKind: "password",
    hostKeyMode: "accept-new",
    agentForward: false,
    groupId: "",
    credentialId: "",
    defaultProjectPath: "",
    loginCommand: "",
    execPolicy: "",
    proxyJump: [],
    secret: "",
    passphrase: "",
    secondary: "",
    clearSecret: false,
    clearPassphrase: false,
    clearSecondary: false
  };
}

function profileToForm(profile) {
  return {
    ...emptyForm(),
    profileId: profile.profileId,
    name: profile.name,
    host: profile.host,
    port: String(profile.port),
    username: profile.username,
    authKind: profile.authKind,
    hostKeyMode: profile.hostKeyMode ?? "accept-new",
    agentForward: profile.agentForward === true,
    groupId: profile.groupId ?? "",
    credentialId: profile.credentialId ?? "",
    defaultProjectPath: profile.defaultProjectPath ?? "",
    loginCommand: profile.loginCommand ?? "",
    execPolicy: profile.execPolicy ?? "",
    proxyJump: (profile.proxyJump ?? []).map((hop) => ({ ...hop, authKind: hop.authKind ?? "credential", password: "", privateKey: "", passphrase: "" }))
  };
}

async function credentialWrite(credentials, ref, value) {
  const response = await credentials.set(ref, value);
  if (response && !response.ok) throw new Error(response.error?.message ?? t("无法保存凭据"));
}

async function credentialUnset(credentials, ref) {
  const response = await credentials.unset(ref);
  if (response && !response.ok) throw new Error(response.error?.message ?? t("无法清除凭据"));
}

function readLegacyProfiles() {
  try {
    const value = JSON.parse(localStorage.getItem(LEGACY_PROFILES_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((profile) => profile && typeof profile.host === "string" && typeof profile.username === "string");
  } catch {
    return [];
  }
}

/** Migrate only non-secret coordinates from older browser-local profiles. */
async function migrateLegacyProfiles(api) {
  const legacy = readLegacyProfiles().filter((p) => String(p.host ?? "").trim() !== "");
  if (legacy.length === 0) return false;
  const remaining = [];
  for (const profile of legacy) {
    try {
      await api.profileSave({
        name: String(profile.name || profile.host).trim() || "SSH server",
        host: String(profile.host).trim(),
        port: Number(profile.port) || 22,
        username: String(profile.username).trim(),
        authKind: profile.authKind === "key" ? "key" : "password"
      });
    } catch {
      remaining.push(profile);
    }
  }
  try {
    if (remaining.length === 0) localStorage.removeItem(LEGACY_PROFILES_KEY);
    else localStorage.setItem(LEGACY_PROFILES_KEY, JSON.stringify(remaining));
  } catch {}
  return true;
}

function ResourceEditor({ initial, groups, profiles, sharedCredentials = [], credentials, api, defaultUsername = null, onClose, onSaved }) {
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

function ImportSourceDialog({ onSelect, onClose }) {
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("导入服务器")}
      description={t("导入会新增服务器和凭据，不会覆盖现有服务器。")}
      footer={<Button variant="ghost" onClick={onClose}>{t("取消")}</Button>}
    >
      <div className="hb-stack hb-stack--tight">
        <Row
          leading={<Icon name="branch-outline" size={16} className="hb-tertiary" />}
          title={t("从 SSH 配置导入")}
          meta={t("读取 DSH 宿主的 ~/.ssh/config；IdentityFile 指向的私钥会一并导入，密码和私钥口令仍需手动补填。")}
          onClick={() => onSelect("ssh-config")}
        />
        <Row
          leading={<Icon name="archive-outline" size={16} className="hb-tertiary" />}
          title={t("加密备份文件")}
          meta={t("从本插件导出的加密备份恢复服务器、分组与共享凭据。")}
          onClick={() => onSelect("import")}
        />
      </div>
    </Dialog>
  );
}

function OpenSshImportDialog({ api, groups, profiles, onClose, onImported }) {
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

function ResourceBackupDialog({ mode, api, onClose, onImported }) {
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

function SharedCredentialEditor({ initial, credentials, api, onClose, onSaved }) {
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

/** View / copy / forget one trusted host's fingerprint. */
function HostKeyDialog({ host, port, known, copied, onCopy, onForget, forgetBusy, onClose }) {
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

/**
 * One saved server. The row owns its overflow menu so a long list keeps a
 * single interaction target per server instead of a row of icon buttons.
 */
function ServerRow({ profile, knownHost, connecting, jump, onConnect, onCancel, onDisconnect, onEdit, onDelete, onShowHostKey, onForgetHostKey }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const anchorRef = useRef(null);
  const connected = profile.connected === true;
  const busy = connecting === profile.profileId;
  const initial = (profile.name || profile.host || "?").trim().slice(0, 1).toUpperCase();
  const closeThen = (action) => () => { setMenuOpen(false); action(); };
  return (
    <Row
      className="hb-settings-server"
      leading={<span className="hb-avatar">{initial}</span>}
      title={
        <>
          <span className="hb-truncate">{profile.name}</span>
          {connected && <Badge tone="ok">{t("已连接")}</Badge>}
          {!profile.credentialConfigured && <Badge tone="warn">{t("未配置认证")}</Badge>}
        </>
      }
      meta={
        <>
          <span className="hb-mono hb-truncate">{profile.username + "@" + profile.host + ":" + profile.port}</span>
          {profile.groupName !== null && profile.groupName !== undefined && <Badge>{profile.groupName}</Badge>}
          {jump.length > 0 && (
            <Badge mono title={t("跳板机（ProxyJump）")}>
              <Icon name="branch-outline" size={12} />
              {jump.join(" → ")}
            </Badge>
          )}
          {typeof profile.defaultProjectPath === "string" && profile.defaultProjectPath !== "" && (
            <span className="hb-quiet hb-truncate">{t(`项目：${profile.defaultProjectPath}`)}</span>
          )}
        </>
      }
      actions={
        <>
          {connected ? (
            <Button variant="ghost" size="sm" onClick={() => onDisconnect(profile)}>{t("断开")}</Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              icon="terminal"
              busy={busy}
              disabled={!profile.credentialConfigured}
              title={busy ? t("连接中") : profile.defaultProjectPath ? t(`进入项目 ${profile.defaultProjectPath}`) : t("连接并打开终端")}
              onClick={() => onConnect(profile)}
            >
              {profile.defaultProjectPath ? t("进入项目") : t("连接")}
            </Button>
          )}
          {busy && <IconButton icon="close-outline" label={t(`取消连接 ${profile.name}`)} onClick={() => onCancel(profile)} />}
          <Button
            ref={anchorRef}
            variant="ghost"
            size="sm"
            icon="ellipsis-outline"
            title={t("更多操作")}
            aria-label={t("更多操作")}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((value) => !value)}
          />
          <Menu open={menuOpen} anchorRef={anchorRef} onClose={() => setMenuOpen(false)} align="end" minWidth={220}>
            <MenuLabel>{profile.name}</MenuLabel>
            <MenuItem icon="edit-outline" onSelect={closeThen(() => onEdit(profile))}>{t("编辑服务器")}</MenuItem>
            {connected
              ? <MenuItem icon="close-outline" onSelect={closeThen(() => onDisconnect(profile))}>{t("断开连接")}</MenuItem>
              : <MenuItem icon="terminal" disabled={!profile.credentialConfigured} onSelect={closeThen(() => onConnect(profile))}>{t("连接并打开终端")}</MenuItem>}
            {knownHost !== undefined && (
              <>
                <MenuSeparator />
                <MenuItem icon="shield-outline" onSelect={closeThen(() => onShowHostKey(knownHost))}>{t("主机指纹")}</MenuItem>
                <MenuItem icon="warning-outline" danger onSelect={closeThen(() => onForgetHostKey(knownHost))}>{t("忘记指纹")}</MenuItem>
              </>
            )}
            <MenuSeparator />
            <MenuItem icon="trash-outline" danger onSelect={closeThen(() => onDelete(profile))}>{t("删除服务器")}</MenuItem>
          </Menu>
        </>
      }
    />
  );
}

export function HarborResources({ api, credentials, pluginManager, openPluginManager }) {
  // Repaint on language change: every t() call below re-evaluates per render.
  useLanguage();
  const [profiles, setProfiles] = useState([]);
  const [sharedCredentials, setSharedCredentials] = useState([]);
  const [credentialEditor, setCredentialEditor] = useState(null);
  const [backupMode, setBackupMode] = useState(null);
  const [groups, setGroups] = useState([]);
  // Groups start expanded: a settings page has to show the servers it manages,
  // not a stack of headers. Collapsing is the operator's explicit choice and
  // lasts for this page life.
  const [collapsedGroups, setCollapsedGroups] = useState(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editor, setEditor] = useState(null);
  const [connecting, setConnecting] = useState(null);
  const [newGroupName, setNewGroupName] = useState("");
  const [resourceQuery, setResourceQuery] = useState("");
  const [connectedProfiles, setConnectedProfiles] = useState(null);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [featureSettings, setFeatureSettings] = useState(null);
  const [featureSaving, setFeatureSaving] = useState(false);
  // Whether the interface language follows DSH's own setting. Loaded from the
  // host so the switch reports what the next boot will actually do.
  const [languageFollow, setLanguageFollow] = useState(true);
  const [languageSaving, setLanguageSaving] = useState(false);
  const [knownHosts, setKnownHosts] = useState([]);
  const [forgetBusy, setForgetBusy] = useState(null);
  const [copiedHostKey, setCopiedHostKey] = useState(null);
  const [hostKeyPopup, setHostKeyPopup] = useState(null);
  // null = not loaded yet; the switch stays disabled until the host answers.
  const [agentAutoConnect, setAgentAutoConnect] = useState(null);
  const [agentSaving, setAgentSaving] = useState(false);
  // Execution policy (AI high-risk command gate): null = loading; the segment
  // and checklist stay disabled until the host answers.
  const [execPolicy, setExecPolicy] = useState(null);
  const [policyLoadFailed, setPolicyLoadFailed] = useState(false);
  const [execPolicyAllow, setExecPolicyAllow] = useState([]);
  const [exactRules, setExactRules] = useState([]);
  const [ruleDraft, setRuleDraft] = useState("");
  const [policyCategories, setPolicyCategories] = useState([]);
  const [policySaving, setPolicySaving] = useState(false);
  // Username the new-server form prefills: auto-remembered host-side from the
  // last profileSave (issue #36 feedback) — no manual knob, null falls back
  // to "root". Loaded once with the rest of the settings; updated locally
  // again whenever an editor saves.
  const [defaultUsername, setDefaultUsername] = useState(null);
  // null = still asking the plugin manager; the card reports what it knows.
  const [installKind, setInstallKind] = useState(null);

  const refresh = async ({ showLoading = true } = {}) => {
    // Poll ticks must not flip the loading flag: the list would unmount and
    // remount every 5 seconds (flicker, scroll and focus loss).
    if (showLoading) setLoading(true);
    try {
      const [profileResult, groupResult, knownResult, credentialResult] = await Promise.all([
        api.profileList(),
        api.groupList(),
        api.listKnownHosts?.().catch(() => ({ hosts: [] })) ?? { hosts: [] },
        api.credentialList()
      ]);
      setProfiles(profileResult.profiles);
      setGroups(groupResult.groups);
      setKnownHosts(knownResult.hosts ?? []);
      setSharedCredentials(credentialResult.credentials ?? []);
      // Deliberately no setError(null) here: this also runs on a 5s poll, and
      // wiping the banner would erase a connect failure before anyone reads it.
      // User actions clear the error when they start.
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      if (showLoading) setLoading(false);
    }
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try { await migrateLegacyProfiles(api); } catch {}
      // The auto-connect switch is a stored operator setting, not polled live
      // data: load it once and let the toggle own it from there.
      try {
        const settings = await api.agentSettingsGet();
        if (alive) {
          if (settings.features) {
            setFeatureSettings(settings);
            harborUiSetFeatures(settings.features);
          }
          setAgentAutoConnect(settings.agentAutoConnect === true);
          setPolicyLoadFailed(false);
          setExecPolicy(settings.execPolicy ?? "standard");
          setExecPolicyAllow(settings.execPolicyAllow ?? []);
          setExactRules(settings.execPolicyExact ?? []);
          setRuleDraft((settings.execPolicyExact ?? []).join("\n"));
          setPolicyCategories(settings.categories ?? []);
          setDefaultUsername(settings.defaultUsername ?? null);
        }
      } catch {
        if (alive) {
          setAgentAutoConnect(false);
          // Do not invent "standard": a failed read is not the same as a host
          // that really runs the standard gate, and choosing a tier from a
          // fake baseline could loosen or tighten the wrong thing.
          setPolicyLoadFailed(true);
        }
      }
      if (alive) await refresh();
    })();
    // The connected badge reflects live server-side connections, which also
    // change from outside this page (SSH panel ×, agent, disconnects). Poll
    // so the badge and its 断开 control never go stale.
    let checking = false;
    const refreshStatus = async () => {
      if (checking || document.hidden) return;
      checking = true;
      try {
        const { profileIds } = await api.profileConnectionStatus();
        if (alive) setConnectedProfiles(new Set(profileIds));
      } catch { /* Keep the last known connection status. */ }
      finally { checking = false; }
    };
    void refreshStatus();
    const timer = setInterval(refreshStatus, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [api]);

  // The install kind decides which update route the card offers; asking the
  // plugin manager is cheap and the answer never changes during a page life.
  useEffect(() => {
    let alive = true;
    inspectInstallation(pluginManager).then((kind) => { if (alive) setInstallKind(kind); });
    return () => { alive = false; };
  }, [pluginManager]);

  // The follow switch reports what the host stored; reading it here keeps the
  // page honest after a reload instead of assuming the default.
  useEffect(() => {
    let alive = true;
    api.languageGet()
      .then((value) => { if (alive) setLanguageFollow(value?.autoApplySystemLanguage !== false); })
      .catch(() => {});
    return () => { alive = false; };
  }, [api]);

  const toggleAgentAutoConnect = async (next) => {
    setAgentSaving(true);
    try {
      const saved = await api.agentSettingsSave(next);
      setAgentAutoConnect(saved.agentAutoConnect === true);
      setError(null);
    } catch (cause) {
      // A failed save must not look applied: put the switch back on the value
      // the host still enforces.
      setError(cause?.message ?? String(cause));
      setAgentAutoConnect(!next);
    } finally {
      setAgentSaving(false);
    }
  };

  /**
   * An explicit language choice pins the plugin to it: the same call stores the
   * language and stops the next load from re-adopting DSH's own language.
   */
  const chooseLanguage = async (next) => {
    if (languageSaving) return;
    const previous = getLanguage();
    setLanguage(next);
    setLanguageSaving(true);
    try {
      const saved = await api.languageSave(next, false);
      setLanguageFollow(saved?.autoApplySystemLanguage !== false);
      setError(null);
    } catch (cause) {
      // A rejected save must not leave the page speaking a language the host
      // did not record.
      setLanguage(previous);
      setError(cause?.message ?? String(cause));
    } finally {
      setLanguageSaving(false);
    }
  };

  /**
   * Following DSH re-adopts its language on the next load; turning the switch
   * off pins whatever language the page is showing now.
   */
  const toggleLanguageFollow = async (next) => {
    if (languageSaving) return;
    setLanguageSaving(true);
    try {
      const saved = await api.languageSave(next ? undefined : getLanguage(), next);
      setLanguageFollow(saved?.autoApplySystemLanguage !== false);
      setError(null);
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      setLanguageSaving(false);
    }
  };

  const saveFeature = async (key, value) => {
    setFeatureSaving(true);
    try {
      const saved = await api.saveFeatureSettings({ [key]: value });
      setFeatureSettings(saved);
      harborUiSetFeatures(saved.features);
      setError(null);
    } catch (error) {
      setError(error?.message ?? String(error));
    } finally {
      setFeatureSaving(false);
    }
  };

  /**
   * Persist the global execution policy and (for the custom tier) the released
   * categories. Saves carry the auto-connect switch too, since the settings
   * row is one record — the current state travels with the policy.
   */
  const saveExecPolicy = async (policy, allow, exact) => {
    setPolicySaving(true);
    try {
      const saved = await api.agentSettingsSave(agentAutoConnect === true, policy, allow, undefined, exact);
      setExecPolicy(saved.execPolicy ?? "standard");
      setExecPolicyAllow(saved.execPolicyAllow ?? []);
      setExactRules(saved.execPolicyExact ?? []);
      if (exact !== undefined) setRuleDraft((saved.execPolicyExact ?? []).join("\n"));
      setError(null);
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      setPolicySaving(false);
    }
  };

  const chooseExecPolicy = async (policy) => {
    if (policySaving || execPolicy === null || policy === execPolicy) return;
    // Loosening is the direction that can destroy data, so it asks first —
    // the same rule (and the same wording) the terminal panel's policy pill
    // follows. Tightening applies at once, because nobody needs to confirm
    // making the gate stricter.
    if (TIER_ORDER[policy] > TIER_ORDER[execPolicy]) {
      const detail = execPolicyLooseningDetail(policy, execPolicyAllow.length);
      const confirmed = await confirmAction({
        message: t(`确认放宽为「${execPolicyLabel(policy)}」？`) + "\n\n" + detail,
        confirmLabel: t("继续"),
        danger: true
      });
      if (!confirmed) return;
    }
    await saveExecPolicy(policy, execPolicyAllow);
  };

  const saveExactRules = async () => {
    const rules = [...new Set(ruleDraft.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
    if (rules.some((rule) => !exactRules.includes(rule))) {
      const confirmed = await confirmAction({
        message: t("保存后，AI 可在使用自定义放行策略的连接上直接执行新增的精确命令。继续吗？"),
        confirmLabel: t("继续"),
        danger: true
      });
      if (!confirmed) return;
    }
    await saveExecPolicy("custom", execPolicyAllow, rules);
  };

  const togglePolicyCategory = (key) => {
    if (policySaving) return;
    const next = execPolicyAllow.includes(key)
      ? execPolicyAllow.filter((item) => item !== key)
      : [...execPolicyAllow, key];
    void saveExecPolicy("custom", next);
  };

  const connect = async (profile) => {
    setConnecting(profile.profileId);
    setError(null);
    try {
      // Fast-fail budget: an unreachable host settles in ~15s with a clear
      // error instead of a minute of silent retrying; the user can also
      // cancel the pending handshake explicitly.
      const connection = await api.profileConnect({ profileId: profile.profileId, readyTimeout: 15000, retries: 0 });
      // This page owns no conversation, so the terminal it opens is anonymous;
      // the first pane that claims the reveal adopts it (see requestPaneOpen).
      const session = await api.openSession(connection.connectionId, 100, 30, { openedBy: "panel" });
      if (profile.defaultProjectPath) {
        await api.changeDirectory(session.sessionId, profile.defaultProjectPath);
        harborUiSetProjectTarget(connection.connectionId, profile.defaultProjectPath);
      }
      // This page owns no pane, so queue the connection for one to pick up and
      // ask the host to reveal the terminal. Without both halves a connect here
      // opened nothing and the new server never appeared in the panel.
      requestPaneOpen(connection.connectionId, { adopt: true });
      // The row's 已连接 badge (and its 断开 control) comes from the 5 s status
      // poll, so right after a successful connect the row still said
      // disconnected and its 连接 button was live — profileConnect does not
      // reuse by default, so a second click opened a second SSH connection.
      setConnectedProfiles((current) => {
        const next = new Set(current ?? []);
        next.add(profile.profileId);
        return next;
      });
      // A successful connect must clear any stale panel error (e.g. an earlier
      // host-key mismatch) so the error bar doesn't linger after recovery.
      harborUiSetError(null);
      harborUiRequestSurface();
      await refresh();
    } catch (cause) {
      if (cause?.code === "connect-cancelled") return;
      const message = cause?.message ?? String(cause);
      harborUiSetError(message);
      setError(message);
    } finally {
      setConnecting(null);
    }
  };

  const cancelConnect = async (profile) => {
    try { await api.cancelProfileConnect({ profileId: profile.profileId }); } catch {}
    setConnecting(null);
  };

  const remove = async (profile) => {
    const confirmed = await confirmAction({
      message: t(`删除 SSH 资源“${profile.name}”？这会删除该资源保存的凭据，但不会断开已经建立的连接。`),
      confirmLabel: t("删除"),
      danger: true
    });
    if (!confirmed) return;
    try {
      await api.profileDelete(profile.profileId);
      // Also drop the saved host-key trust record so the deleted server does
      // not linger in the known-hosts list.
      try { await api.forgetHostKey(profile.host, profile.port); } catch {}
      await refresh();
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    }
  };

  const disconnectProfile = async (profile) => {
    setError(null);
    try {
      await api.profileDisconnect(profile.profileId);
      await refresh();
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    }
  };

  const createGroup = async () => {
    const name = newGroupName.trim();
    if (!name) return;
    setCreatingGroup(true);
    try {
      await api.groupSave({ name });
      setNewGroupName("");
      await refresh();
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      setCreatingGroup(false);
    }
  };

  const deleteGroup = async (group) => {
    const confirmed = await confirmAction({
      message: t(`删除分组“${group.name}”？其中 ${group.profileCount} 台服务器会移到“未分组”，不会断开已建立的连接。`),
      confirmLabel: t("删除"),
      danger: true
    });
    if (!confirmed) return;
    try {
      await api.groupDelete(group.groupId);
      await refresh();
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    }
  };

  const forgetHost = async (host, port, confirmMessage) => {
    const confirmed = await confirmAction({
      message: confirmMessage ?? t(`忘记 ${host}:${port} 的主机指纹？下次连接将重新信任该服务器当前指纹。仅当服务器被合法重装/更换时才应操作。`),
      confirmLabel: t("忘记"),
      danger: true
    });
    if (!confirmed) return;
    const key = host + ":" + port;
    setForgetBusy(key);
    try {
      await api.forgetHostKey(host, port);
      await refresh();
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      setForgetBusy(null);
    }
  };

  const copyHostFingerprint = async (host, port, fingerprint) => {
    const key = host + ":" + port;
    try {
      if (!navigator.clipboard?.writeText) throw new Error(t("当前环境不支持复制到剪贴板"));
      await navigator.clipboard.writeText("SHA256:" + fingerprint);
      setCopiedHostKey(key);
      setTimeout(() => setCopiedHostKey((current) => current === key ? null : current), 1500);
    } catch (cause) {
      setError(cause?.message ?? t("无法复制主机指纹"));
    }
  };

  const removeSharedCredential = async (item) => {
    const confirmed = await confirmAction({
      message: t(`删除共享凭据“${item.name}”？仍被服务器或跳板机引用时不会删除。`),
      confirmLabel: t("删除"),
      danger: true
    });
    if (!confirmed) return;
    try {
      await api.credentialDelete(item.credentialId);
      await refresh({ showLoading: false });
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    }
  };

  const groupedProfiles = new Map(groups.map((group) => [group.groupId, []]));
  const ungrouped = [];
  const query = resourceQuery.trim().toLowerCase();
  let visibleProfiles = 0;
  for (const saved of profiles) {
    if (query && ![saved.name, saved.host, saved.host + ":" + saved.port, saved.username, saved.groupName].some((value) => value?.toLowerCase().includes(query))) continue;
    visibleProfiles += 1;
    const profile = connectedProfiles ? { ...saved, connected: connectedProfiles.has(saved.profileId) } : saved;
    const bucket = profile.groupId === null ? undefined : groupedProfiles.get(profile.groupId);
    if (bucket === undefined) ungrouped.push(profile);
    else bucket.push(profile);
  }
  // Known hosts are addressed by host:port so each saved-server row can offer
  // its trust record, and hosts trusted without a saved resource join the same
  // card instead of a separate list.
  const knownByHost = new Map(knownHosts.map((h) => [h.host + ":" + h.port, h]));
  const savedHostKeys = new Set(profiles.map((p) => p.host + ":" + p.port));
  const jumpChain = (profile) => (profile.proxyJump ?? [])
    .map((hop) => profiles.find((candidate) => candidate.profileId === hop.profileId)?.name ?? null)
    .filter((name) => name !== null);

  const toggleGroup = (key) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const renderServer = (profile) => (
    <ServerRow
      key={profile.profileId}
      profile={profile}
      knownHost={knownByHost.get(profile.host + ":" + profile.port)}
      connecting={connecting}
      jump={jumpChain(profile)}
      onConnect={connect}
      onCancel={cancelConnect}
      onDisconnect={disconnectProfile}
      onEdit={(item) => setEditor({ mode: "edit", profile: item })}
      onDelete={remove}
      onShowHostKey={(known) => setHostKeyPopup(known)}
      onForgetHostKey={(known) => forgetHost(known.host, known.port)}
    />
  );

  const saveAsResource = (known) => setEditor({
    mode: "new",
    profile: { profileId: undefined, name: known.host, host: known.host, port: known.port, username: "root", authKind: "password", hostKeyMode: "accept-new" }
  });

  const policyHint = policyLoadFailed
    ? t("执行策略不可用，请刷新页面后重试")
    : execPolicy === null
      ? t("正在读取执行策略…")
      : execPolicy === "custom"
        ? t("放行勾选的类别及精确匹配的命令")
        : execPolicy === "allowAll"
          ? t("AI 可直接执行任何命令，含不可逆删除（不进回收站）")
          : t("破坏性命令一律拦截，由操作者在会话内审批后才执行");

  return (
    <div className="hb hb-page hb-settings">
      <p className="hb-page__desc">{t("保存的服务器、共享凭据、已知主机与 AI 策略都在这里配置。")}</p>

      {error !== null && <ErrorNote>{error}</ErrorNote>}

      <Card
        title={t("已保存的服务器")}
        description={profiles.length > 0 ? t(`${profiles.length} 台服务器`) : undefined}
        action={
          <>
            <Button variant="ghost" size="sm" icon="download-outline" onClick={() => setBackupMode("choose")}>{t("导入")}</Button>
            <Button variant="ghost" size="sm" icon="upload-outline" onClick={() => setBackupMode("export")}>{t("导出")}</Button>
            <Button variant="primary" size="sm" icon="plus-outline" onClick={() => setEditor({ mode: "new" })}>{t("新增服务器")}</Button>
          </>
        }
      >
        {profiles.length > 0 && (
          <InputGroup icon="search-outline">
            <TextInput
              type="search"
              value={resourceQuery}
              onChange={(event) => setResourceQuery(event.target.value)}
              aria-label={t("搜索服务器")}
              placeholder={t("按名称、地址或分组搜索服务器")}
            />
          </InputGroup>
        )}

        <details className="hb-settings-fold">
          <summary className="hb-caption">{t("管理分组")}</summary>
          <div className="hb-stack hb-stack--tight">
            <form
              className="hb-settings-formrow"
              onSubmit={(event) => { event.preventDefault(); if (!creatingGroup) void createGroup(); }}
            >
              <TextInput
                value={newGroupName}
                onChange={(event) => setNewGroupName(event.target.value)}
                aria-label={t("分组名称")}
                placeholder={t("例如：生产环境")}
                className="hb-settings-grow"
              />
              <Button type="submit" variant="secondary" size="sm" disabled={creatingGroup || !newGroupName.trim()} busy={creatingGroup}>
                {t("创建")}
              </Button>
            </form>
            {groups.length > 0 && (
              <div className="hb-settings-list">
                {groups.map((group) => (
                  <Row
                    key={group.groupId}
                    leading={<Icon name="folder-open-outline" size={14} className="hb-tertiary" />}
                    title={group.name}
                    meta={t(`（${group.profileCount}）`)}
                    actions={
                      <IconButton
                        icon="trash-outline"
                        size="sm"
                        danger
                        label={t(`删除分组 ${group.name}`)}
                        onClick={() => deleteGroup(group)}
                      />
                    }
                  />
                ))}
              </div>
            )}
          </div>
        </details>

        {loading ? (
          <div className="hb-quiet">{t("加载 SSH 资源中…")}</div>
        ) : profiles.length === 0 ? (
          <EmptyState icon="server" title={t("还没有保存的服务器。新增后可一键连接并打开右侧终端。")} />
        ) : query && visibleProfiles === 0 ? (
          <EmptyState icon="search-outline" title={t("没有匹配的服务器。")} text={t("换个名称、地址或分组试试。")} />
        ) : (
          <div className="hb-settings-groups">
            {groups.map((group) => {
              const key = `group:${group.groupId}`;
              const collapsed = !query && collapsedGroups.has(key);
              const items = groupedProfiles.get(group.groupId) ?? [];
              if (query && !items.length) return null;
              return (
                <section key={group.groupId} className="hb-settings-group">
                  <button type="button" className="hb-settings-group__head" onClick={() => toggleGroup(key)} aria-expanded={!collapsed}>
                    <Icon name={collapsed ? "chevron-right-outline" : "chevron-down-outline"} size={14} className="hb-tertiary" />
                    <span className="hb-settings-group__name">{group.name}</span>
                    <Badge>{items.length}</Badge>
                  </button>
                  {!collapsed && (items.length === 0
                    ? <div className="hb-quiet hb-settings-empty">{t("这个分组还没有服务器。")}</div>
                    : <div className="hb-settings-list">{items.map(renderServer)}</div>)}
                </section>
              );
            })}
            {ungrouped.length > 0 && (() => {
              const key = "ungrouped";
              const collapsed = !query && collapsedGroups.has(key);
              return (
                <section className="hb-settings-group">
                  <button type="button" className="hb-settings-group__head" onClick={() => toggleGroup(key)} aria-expanded={!collapsed}>
                    <Icon name={collapsed ? "chevron-right-outline" : "chevron-down-outline"} size={14} className="hb-tertiary" />
                    <span className="hb-settings-group__name">{t("未分组")}</span>
                    <Badge>{ungrouped.length}</Badge>
                  </button>
                  {!collapsed && <div className="hb-settings-list">{ungrouped.map(renderServer)}</div>}
                </section>
              );
            })()}
          </div>
        )}
      </Card>

      <Card
        title={t("共享 SSH 凭据")}
        action={<Button variant="secondary" size="sm" icon="plus-outline" onClick={() => setCredentialEditor({})}>{t("新增共享凭据")}</Button>}
      >
        {loading ? (
          <div className="hb-quiet">{t("加载 SSH 资源中…")}</div>
        ) : sharedCredentials.length === 0 ? (
          <EmptyState icon="key" title={t("还没有共享凭据。")} text={t("新增后可在服务器表单里复用同一份凭据。")} />
        ) : (
          <div className="hb-settings-list">
            {sharedCredentials.map((item) => (
              <Row
                key={item.credentialId}
                leading={<Icon name="key" size={16} className="hb-tertiary" />}
                title={item.name}
                meta={
                  <>
                    <span>
                      {item.authKind === "key" ? t("私钥") : t("密码")}
                      {item.secondaryConfigured ? " + " + (item.authKind === "key" ? t("密码") : t("私钥")) : ""}
                    </span>
                    <Badge tone={item.credentialConfigured ? "ok" : "warn"}>{item.credentialConfigured ? t("已保存") : t("未配置")}</Badge>
                  </>
                }
                actions={
                  <>
                    <IconButton icon="edit-outline" size="sm" label={t(`编辑共享凭据 ${item.name}`)} onClick={() => setCredentialEditor(item)} />
                    <IconButton icon="trash-outline" size="sm" danger label={t(`删除共享凭据 ${item.name}`)} onClick={() => removeSharedCredential(item)} />
                  </>
                }
              />
            ))}
          </div>
        )}
      </Card>

      <Card title={t("已知主机")} description={t("已信任的主机指纹；换机或重装服务器后可在这里忘记。")}>
        {knownHosts.length === 0 ? (
          <EmptyState icon="shield-outline" title={t("还没有已知主机")} text={t("首次连接并信任服务器指纹后，会出现在这里。")} />
        ) : (
          <div className="hb-settings-list">
            {knownHosts.map((known) => {
              const key = `${known.host}:${known.port}`;
              const saved = savedHostKeys.has(key);
              return (
                <Row
                  key={key}
                  leading={<Icon name="shield-outline" size={16} className="hb-tertiary" />}
                  title={<span className="hb-mono hb-truncate">{key}</span>}
                  meta={
                    <>
                      <span className="hb-truncate">
                        {t(`${known.algorithm || "ssh-host-key"} · 首次信任 ${new Date(known.firstSeenAt).toLocaleString()}`)}
                      </span>
                      {saved && <Badge>{t("已保存")}</Badge>}
                    </>
                  }
                  onClick={() => setHostKeyPopup(known)}
                  actions={
                    <>
                      {!saved && (
                        <Button
                          variant="secondary"
                          size="sm"
                          title={t("把该服务器保存为 SSH 资源（可改用户名与认证方式）")}
                          onClick={() => saveAsResource(known)}
                        >
                          {t("保存为资源")}
                        </Button>
                      )}
                      <IconButton
                        icon="trash-outline"
                        size="sm"
                        danger
                        label={t(`删除 ${known.host}:${known.port} 的信任记录`)}
                        title={t("删除这条信任记录（仅清理临时使用过的主机）")}
                        disabled={forgetBusy === key}
                        onClick={() => forgetHost(
                          known.host,
                          known.port,
                          saved
                            ? undefined
                            : t(`删除 ${known.host}:${known.port} 的信任记录？此主机未保存为资源，删除后将从「已信任主机」列表移除；下次连接将重新信任其当前指纹。`)
                        )}
                      />
                    </>
                  }
                />
              );
            })}
          </div>
        )}
      </Card>

      <Card
        title={t("AI 命令执行策略")}
        description={t("控制 AI（agent）发起的破坏性命令拦截强度。你在右侧终端亲手敲的命令不受影响。")}
      >
        <Row
          title={<label className="hb-settings-toggle" htmlFor="harbor-agent-auto-connect">{t("AI 自动连接")}</label>}
          meta={t("允许 AI 按名称连接已保存的服务器，并在右侧打开终端。")}
          actions={
            <Switch
              id="harbor-agent-auto-connect"
              checked={agentAutoConnect === true}
              disabled={agentAutoConnect === null || agentSaving}
              onChange={toggleAgentAutoConnect}
            />
          }
        />
        <hr className="hb-hr" />
        {policyLoadFailed && (
          <ErrorNote>
            {t("无法读取当前的 AI 执行策略，下面的选项不代表宿主真实设置；请刷新页面后重试。")}
          </ErrorNote>
        )}
        <Field label={t("执行策略")}>
          <SegmentedControl
            value={execPolicy ?? ""}
            onChange={chooseExecPolicy}
            label={t("AI 命令执行策略")}
            items={Object.keys(TIER_ORDER).map((tier) => ({
              value: tier,
              label: execPolicyLabel(tier),
              disabled: execPolicy === null
            }))}
          />
        </Field>
        <div className="hb-quiet">{policyHint}</div>
        <Notice icon="info-outline">{t("对话里选择的 DSH 权限模式会作为本次对话的上限：自动审查和完全访问会让 Harbor 让出默认拦截，仅工作区写只能使用标准档，只读会直接拒绝危险命令。")}</Notice>

        {execPolicy === "custom" && (
          <div className="hb-stack hb-stack--tight">
            <div className="hb-grid hb-grid--2">
              {policyCategories.map((category) => (
                <Checkbox
                  key={category.key}
                  checked={execPolicyAllow.includes(category.key)}
                  disabled={policySaving || execPolicy === null}
                  onChange={() => togglePolicyCategory(category.key)}
                  label={t(category.label)}
                />
              ))}
            </div>
            <Field label={t("精确放行命令")} hint={t("每行一条完整命令，最多 32 条。命令和参数须完全匹配。规则作用于所有采用「自定义放行」的连接。")}>
              <TextArea
                value={ruleDraft}
                rows={5}
                spellCheck={false}
                disabled={policySaving}
                onChange={(event) => setRuleDraft(event.target.value)}
                className="hb-input--mono"
              />
              <div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={policySaving || ruleDraft === exactRules.join("\n")}
                  onClick={() => void saveExactRules()}
                >
                  {t("保存精确规则")}
                </Button>
              </div>
            </Field>
          </div>
        )}
        {execPolicy === "allowAll" && (
          <Notice icon="warning-triangle-outline">{t("全部放行后，AI 删除文件不进回收站、可直接格式化磁盘或重启关机。仅建议用于测试或可丢弃的环境。")}</Notice>
        )}
        <Notice icon="info-outline">{t("执行策略保存后立即生效，无需重启 DSH。")}</Notice>
      </Card>

      <Card title={t("功能开关")} description={t("控制面板标签与 Agent 可用的工具。")}>
        {featureSettings?.features ? (
          <>
            <Section title={t("对话中的 AI 工具")}>
              <div className="hb-quiet">{t("AI 在对话里可调用的插件工具。")}</div>
              {[
                ["tunnelTools", t("端口转发工具"), t("建立与查看端口转发")],
                ["logTools", t("会话日志工具"), t("读取与检索终端会话日志")],
                ["statusTools", t("系统状态工具"), t("读取 CPU、内存、磁盘、网络与 GPU 状态")]
              ].map(([key, label, hint]) => (
                <Row
                  key={key}
                  title={<label className="hb-settings-toggle" htmlFor={"harbor-feature-" + key}>{label}</label>}
                  meta={hint}
                  actions={
                    <Switch
                      id={"harbor-feature-" + key}
                      checked={featureSettings.features[key] !== false}
                      disabled={featureSaving}
                      onChange={(value) => saveFeature(key, value)}
                    />
                  }
                />
              ))}
              {/* A tool switch only takes effect after the host re-registers its
                  agent tools, so this note is state, not a hint. */}
              <div role="status">
                <Notice icon="info-outline">
                  {featureSettings.toolRestartRequired ? t("工具设置已保存，重启 DSH 后生效。") : t("修改 AI 工具开关后需重启 DSH。")}
                </Notice>
              </div>
            </Section>
            <hr className="hb-hr" />
            <Section title={t("右侧面板标签")}>
              <div className="hb-quiet">{t("勾选要显示的标签，保存后立即生效。")}</div>
              {[
                ["showMonitor", t("状态")],
                ["showTunnels", t("转发")],
                ["showSnippets", t("快捷命令")],
                ["showLogs", t("日志")]
              ].map(([key, label]) => (
                <Row
                  key={key}
                  title={<label className="hb-settings-toggle" htmlFor={"harbor-feature-" + key}>{label}</label>}
                  actions={
                    <Switch
                      id={"harbor-feature-" + key}
                      checked={featureSettings.features[key] !== false}
                      disabled={featureSaving}
                      onChange={(value) => saveFeature(key, value)}
                    />
                  }
                />
              ))}
            </Section>
          </>
        ) : (
          <ErrorNote>{t("暂时无法读取功能开关，请确认宿主插件已重新加载。")}</ErrorNote>
        )}
      </Card>

      <Card title={t("语言与更新")}>
        <Field label={t("界面语言")} hint={t("插件界面与 Agent 可见消息使用同一种语言。")}>
          <Select
            value={getLanguage()}
            onChange={(event) => chooseLanguage(event.target.value)}
            options={[{ value: "zh", label: LANGUAGE_LABELS.zh }, { value: "en", label: LANGUAGE_LABELS.en }]}
          />
        </Field>
        <Row
          title={<label className="hb-settings-toggle" htmlFor="harbor-language-follow">{t("跟随 DSH 的语言设置")}</label>}
          meta={t("开启后每次加载都采用 DSH 自身的语言；关闭则固定使用上面选定的语言。")}
          actions={
            <Switch
              id="harbor-language-follow"
              checked={languageFollow}
              disabled={languageSaving}
              onChange={toggleLanguageFollow}
            />
          }
        />
        <hr className="hb-hr" />
        <Section title={t("插件更新")}>
          <Notice icon="refresh-outline">
            <span className="hb-stack hb-stack--tight">
              <span>{PLUGIN_VERSION === "unknown" ? t("未知版本") : t(`当前版本：v${PLUGIN_VERSION}`)}</span>
              {installKind === null ? (
                <span>{t("正在读取安装方式…")}</span>
              ) : installKind === "local" ? (
                <span>{t("当前为本地链接安装，请在源码目录更新。插件不会自动替换此链接。")}</span>
              ) : installKind === "git" ? (
                <span>{t("当前通过 Git 安装，请按原安装方式更新；更新前请确认来源和本地修改。")}</span>
              ) : (
                <>
                  <span>{t("请打开 DSH 左侧的插件管理页面，找到 dsh-harbor 并检查可用更新。")}</span>
                  {installKind === "unknown" && <span>{t("无法确认安装来源；请先在插件管理页面确认，避免覆盖本地链接。")}</span>}
                  <span>{t("旧版 DSH 如果没有更新功能，请参考安装说明手动更新。")}</span>
                  <span>{t("更新可能中断 SSH 连接和正在进行的传输，请先完成当前操作。")}</span>
                  {openPluginManager !== undefined && (
                    <span className="hb-inline hb-inline--wrap">
                      <Button variant="secondary" size="sm" icon="apps-add-outline" onClick={() => openPluginManager()}>{t("打开插件管理")}</Button>
                    </span>
                  )}
                </>
              )}
            </span>
          </Notice>
        </Section>
      </Card>

      {hostKeyPopup && (
        <HostKeyDialog
          host={hostKeyPopup.host}
          port={hostKeyPopup.port}
          known={hostKeyPopup}
          copied={copiedHostKey}
          onCopy={copyHostFingerprint}
          onForget={forgetHost}
          forgetBusy={forgetBusy}
          onClose={() => setHostKeyPopup(null)}
        />
      )}
      {editor && (
        <ResourceEditor
          initial={editor.profile}
          groups={groups}
          profiles={profiles}
          sharedCredentials={sharedCredentials}
          api={api}
          credentials={credentials}
          defaultUsername={defaultUsername}
          onClose={() => setEditor(null)}
          onSaved={(saved) => { if (saved?.username) setDefaultUsername(saved.username); return refresh(); }}
        />
      )}
      {credentialEditor && (
        <SharedCredentialEditor
          initial={credentialEditor.credentialId ? credentialEditor : null}
          credentials={credentials}
          api={api}
          onClose={() => setCredentialEditor(null)}
          onSaved={refresh}
        />
      )}
      {backupMode === "choose" && <ImportSourceDialog onSelect={setBackupMode} onClose={() => setBackupMode(null)} />}
      {backupMode === "ssh-config" && (
        <OpenSshImportDialog
          api={api}
          groups={groups}
          profiles={profiles}
          onClose={() => setBackupMode(null)}
          onImported={() => refresh({ showLoading: false })}
        />
      )}
      {(backupMode === "import" || backupMode === "export") && (
        <ResourceBackupDialog
          mode={backupMode}
          api={api}
          onClose={() => setBackupMode(null)}
          onImported={() => refresh({ showLoading: false })}
        />
      )}
      <ConfirmHost />
    </div>
  );
}
