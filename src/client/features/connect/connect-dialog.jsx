/**
 * Connect to a saved server or open a temporary one.
 *
 * Two modes in one dialog because they answer one question ("which machine?")
 * and share every other field: pick a saved resource, or type a host. ProxyJump
 * hops are chosen from saved resources only — a jump host needs the same
 * credentials, so an ad-hoc hop would either prompt twice or be unusable.
 *
 * Secrets never leave this dialog's state: passwords and private keys go
 * straight to the credential service, and a temporary connection keeps them in
 * memory only.
 */
import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Badge, Button, Checkbox, Dialog, ErrorNote, Field, Icon, IconButton, Menu, MenuItem, MenuLabel,
  MenuSeparator, SegmentedControl, Select, TextArea, TextInput, toast
} from "../../ui/kit.jsx";
import { privateKeyProblem } from "../../pemkey.js";
import { t } from "../../../i18n/core.js";


export function ConnectDialog({ api, credentials, open, onClose, onConnected, onDataChanged }) {
  const [profiles, setProfiles] = useState([]);
  const [sharedCredentials, setSharedCredentials] = useState([]);
  const [pickedProfileId, setPickedProfileId] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef(null);
  const keyFileRef = useRef(null);

  const [form, setForm] = useState({
    name: "", host: "", port: "22", username: "root",
    authKind: "password", credentialId: "", password: "", privateKey: "", passphrase: ""
  });
  const [keyFileName, setKeyFileName] = useState(null);
  const [reuseExisting, setReuseExisting] = useState(false);
  const [proxyJumps, setProxyJumps] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);

  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));

  useEffect(() => {
    if (!open) return;
    let alive = true;
    Promise.all([api.profileList(), api.credentialList?.() ?? { credentials: [] }])
 .then(([profileValue, credentialValue]) => {
        if (!alive) return;
        setProfiles(profileValue.profiles ?? []);
        setSharedCredentials(credentialValue.credentials ?? []);
      })
 .catch(() => {});
    return () => { alive = false; };
  }, [open, api]);

  // Reset transient state whenever the dialog opens, so a failed attempt does
  // not greet the next visitor with its error.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setStatus(null);
    setBusy(false);
  }, [open]);

  const groups = useMemo(() => {
    const map = new Map();
    for (const profile of profiles) {
      const key = profile.groupId ?? "";
      if (!map.has(key)) map.set(key, { name: profile.groupName || t("未分组"), profiles: [] });
      map.get(key).profiles.push(profile);
    }
    return [...map.entries()];
  }, [profiles]);

  const pickedProfile = profiles.find((profile) => profile.profileId === pickedProfileId);

  const finishConnect = async (connectionId) => {
    onConnected?.(connectionId);
    // The dialog is about to close, so a failure to open the PTY must surface
    // as a toast: setting it on a dismissed dialog hid the message entirely.
    await api.openSession(connectionId, 100, 30).catch((sessionError) => {
      toast(t(`已连接，但无法自动打开终端：${sessionError?.message ?? String(sessionError)}`), { tone: "error" });
    });
    onDataChanged?.();
    onClose();
  };

  const guard = () => {
    if (proxyJumps.some((hop) => hop.profileId === "")) {
      setError(t("请选择每台跳板服务器"));
      return false;
    }
    // Validate the endpoint before the RPC layer does: a bad port used to come
    // back as an opaque schema rejection after a click that looked fine.
    if (pickedProfileId === "") {
      if (form.host.trim() === "" || form.username.trim() === "") {
        setError(t("请填写主机、端口和用户名"));
        return false;
      }
      const port = Number(form.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        setError(t("端口需为 1–65535 的整数"));
        return false;
      }
    }
    // A temporary connection carries the key inline: reject a truncated or
    // empty-shell paste up front instead of surfacing it as a bare auth
    // failure twenty seconds later.
    if (pickedProfileId === "" && form.credentialId === "") {
      const problem = privateKeyProblem(form.privateKey, form.passphrase);
      if (form.authKind === "key" && problem) {
        setError(problem);
        return false;
      }
    }
    return true;
  };

  const submit = async () => {
    if (!guard()) return;
    setBusy(true);
    setError(null);
    setStatus(t("正在连接服务器，最多需要 20 秒…"));
    try {
      const connection = pickedProfileId !== ""
        ? await api.profileConnect({
            profileId: pickedProfileId,
            readyTimeout: 15000,
            retries: 0,
            reuseExisting: reuseExisting && proxyJumps.length === 0,
 ...(proxyJumps.length > 0 ? { proxyJumpProfileIds: proxyJumps.map((hop) => hop.profileId) } : {})
          })
 : await api.connect({
            host: form.host.trim(),
            port: Number(form.port) || 22,
            username: form.username.trim(),
 ...(form.credentialId !== ""
              ? { credentialId: form.credentialId }
 : {
                  auth: form.authKind === "password"
                    ? { kind: "password", password: form.password }
 : { kind: "key", privateKey: form.privateKey, ...(form.passphrase !== "" ? { passphrase: form.passphrase } : {}) }
                }),
            name: form.name.trim() || undefined,
 ...(proxyJumps.length > 0 ? { proxyJumpProfileIds: proxyJumps.map((hop) => hop.profileId) } : {})
          });
      setStatus(null);
      await finishConnect(connection.connectionId);
    } catch (cause) {
      setError(cause?.message ?? String(cause));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  };

  /** Persist the temporary form as a resource, then connect through it. */
  const saveAndConnect = async () => {
    if (credentials === undefined || credentials === null) {
      setError(t("当前 DSH 未提供凭据服务，不能安全保存 SSH 认证信息"));
      return;
    }
    if (form.name.trim() === "" || form.host.trim() === "" || form.username.trim() === "") {
      setError(t("请填写名称、主机和用户名（名称会用于保存的资源）"));
      return;
    }
    const port = Number(form.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setError(t("端口需为 1–65535 的整数"));
      return;
    }
    if (form.authKind === "password" && form.password === "") {
      setError(t("请输入密码后再保存并连接"));
      return;
    }
    if (!guard()) return;
    setBusy(true);
    setError(null);
    setStatus(t("正在保存并连接…"));
    try {
      const saved = await api.profileSave({
        name: form.name.trim(),
        host: form.host.trim(),
        port: Number(form.port) || 22,
        username: form.username.trim(),
        authKind: form.authKind,
        hostKeyMode: "accept-new",
        groupId: null,
        proxyJump: proxyJumps.map((hop) => ({ profileId: hop.profileId }))
      });
      const primaryRef = form.authKind === "password" ? saved.credentialRefs.password : saved.credentialRefs.privateKey;
      const secret = form.authKind === "password" ? form.password : form.privateKey;
      if (secret !== "") {
        const response = await credentials.set(primaryRef, secret);
        if (response && response.ok === false) throw new Error(response.error?.message ?? t("无法保存凭据"));
      }
      if (form.authKind === "key" && form.passphrase !== "") {
        const response = await credentials.set(saved.credentialRefs.passphrase, form.passphrase);
        if (response && response.ok === false) throw new Error(response.error?.message ?? t("无法保存私钥口令"));
      }
      const profileId = saved?.profile?.profileId;
      if (profileId === undefined) throw new Error(t("保存资源后未能取得 profileId"));
      const connection = await api.profileConnect({ profileId, readyTimeout: 15000, retries: 0 });
      setStatus(null);
      await finishConnect(connection.connectionId);
    } catch (cause) {
      setError(cause?.message ?? String(cause));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  };

  const importPrivateKey = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file === undefined) return;
    if (file.size > 1024 * 1024) {
      setError(t("私钥文件不能超过 1 MB"));
      return;
    }
    try {
      const privateKey = await file.text();
      if (privateKey.trim() === "") throw new Error(t("所选私钥文件为空"));
      setForm((current) => ({ ...current, privateKey }));
      setKeyFileName(file.name);
      setError(null);
    } catch (cause) {
      setError(cause?.message ?? t("无法读取私钥文件"));
    }
  };

  const updateHop = (index, value) => setProxyJumps((hops) => hops.map((hop, at) => (at === index ? { profileId: value } : hop)));

  const canSubmit = pickedProfileId !== "" || form.host.trim() !== "";

  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : onClose}
      title={t("连接服务器")}
      description={t("连接后终端会在右侧打开；切换到其他标签不会断开。")}
      width="wide"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t("取消")}</Button>
          <span className="hb-spacer" />
          {pickedProfileId === "" && (
            <Button variant="secondary" onClick={saveAndConnect} disabled={busy || form.host.trim() === ""} title={t("保存为 SSH 资源并连接（认证信息存入本机 DSH 凭据库）")}>
              {t("保存并连接")}
            </Button>
 )}
          <Button variant="primary" onClick={submit} busy={busy} disabled={!canSubmit} data-modal-autofocus>
            {pickedProfileId !== "" ? t("连接并打开") : t("临时连接")}
          </Button>
        </>
      }
    >
      <div className="hb-stack">
        <Field label={t("已保存的服务器")}>
          <div className="hb-inline">
            <Button ref={pickerRef} variant="secondary" icon="server" trailingIcon="chevron-down-outline" onClick={() => setPickerOpen((value) => !value)} style={{ flex: 1, justifyContent: "flex-start" }}>
              <span className="hb-truncate">
                {pickedProfile
                  ? `${pickedProfile.name || pickedProfile.host} — ${pickedProfile.username}@${pickedProfile.host}:${pickedProfile.port}`
 : t("临时连接（不保存）")}
              </span>
            </Button>
            {pickedProfileId !== "" && (
              <IconButton icon="close-outline" label={t("改用临时连接")} onClick={() => setPickedProfileId("")} />
 )}
          </div>
        </Field>

        <Menu open={pickerOpen} anchorRef={pickerRef} onClose={() => setPickerOpen(false)} minWidth={320}>
          <MenuItem icon="terminal" checked={pickedProfileId === ""} onSelect={() => { setPickedProfileId(""); setPickerOpen(false); }}>
            {t("临时连接（不保存）")}
          </MenuItem>
          {groups.map(([key, group]) => (
            <React.Fragment key={key}>
              <MenuSeparator />
              <MenuLabel>{group.name}</MenuLabel>
              {group.profiles.map((profile) => (
                <MenuItem
                  key={profile.profileId}
                  icon="server"
                  checked={pickedProfileId === profile.profileId}
                  onSelect={() => { setPickedProfileId(profile.profileId); setPickerOpen(false); }}
                >
                  {profile.name || profile.host} — {profile.username}@{profile.host}:{profile.port}
                </MenuItem>
 ))}
            </React.Fragment>
 ))}
        </Menu>

        {pickedProfileId !== "" ? (
          <Checkbox
            checked={reuseExisting}
            onChange={setReuseExisting}
            label={t("复用已打开的连接（本栏将加入那条连接，与另一栏共用同一个终端）")}
          />
 ) : (
          <>
            <div className="hb-grid hb-grid--2">
              <Field label={t("名称（保存时必填）")}>
                <TextInput value={form.name} onChange={set("name")} placeholder="prod-web-01" />
              </Field>
              <Field label={t("主机")} hint={t("域名或 IP，不含端口")}>
                <TextInput value={form.host} onChange={set("host")} placeholder="192.168.1.100" mono />
              </Field>
              <Field label={t("端口")}>
                <TextInput value={form.port} onChange={set("port")} inputMode="numeric" />
              </Field>
              <Field label={t("用户名")}>
                <TextInput value={form.username} onChange={set("username")} />
              </Field>
            </div>

            <Field label={t("认证方式")}>
              <SegmentedControl
                value={form.authKind}
                onChange={(value) => setForm((current) => ({ ...current, authKind: value, credentialId: "" }))}
                items={[{ value: "password", label: t("密码"), icon: "key" }, { value: "key", label: t("私钥"), icon: "shield-outline" }]}
              />
            </Field>

            <Field label={t("复用共享凭据（可选）")} hint={t("共享凭据只在本机凭据库中保存一份，多台服务器可共用。")}>
              <Select
                value={form.credentialId}
                onChange={set("credentialId")}
                options={[
                  { value: "", label: t(`不复用，临时输入${form.authKind === "password" ? t("密码") : t("私钥")}`) },
 ...sharedCredentials
 .filter((credential) => credential.authKind === form.authKind && credential.credentialConfigured)
 .map((credential) => ({ value: credential.credentialId, label: credential.name }))
                ]}
              />
            </Field>

            {form.credentialId === "" && (form.authKind === "password" ? (
              <Field label={t("密码")} hint={t("临时连接不会保存到本机；保存资源后写入 DSH 凭据库。")}>
                <TextInput type="password" value={form.password} onChange={set("password")} autoComplete="off" />
              </Field>
 ) : (
              <>
                <Field label={t("私钥内容（PEM / OpenSSH）")}>
                  <TextArea value={form.privateKey} onChange={set("privateKey")} rows={4} className="hb-input--mono" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
                </Field>
                <div className="hb-inline">
                  <input
                    ref={keyFileRef}
                    type="file"
                    accept=".pem,.key,.rsa,.ed25519,.txt,application/x-pem-file,application/x-pkcs8,text/plain"
                    onChange={importPrivateKey}
                    style={{ display: "none" }}
                  />
                  <Button variant="secondary" icon="upload-outline" size="sm" onClick={() => keyFileRef.current?.click()}>{t("导入 PEM / 私钥文件")}</Button>
                  <span className="hb-quiet hb-truncate">{keyFileName !== null ? t(`已导入：${keyFileName}`) : t("不会保存到本机")}</span>
                </div>
                <Field label={t("私钥口令（可选）")}>
                  <TextInput type="password" value={form.passphrase} onChange={set("passphrase")} autoComplete="off" />
                </Field>
              </>
 ))}
          </>
 )}

        <details className="hb-stack hb-stack--tight" open={proxyJumps.length > 0}>
          <summary className="hb-inline" style={{ cursor: "pointer", fontSize: 12, color: "var(--hb-text-secondary)" }}>
            <Icon name="branch-outline" size={14} />
            {t("跳板机（ProxyJump）")}
            {proxyJumps.length > 0 && <Badge>{proxyJumps.length}</Badge>}
            {pickedProfileId !== "" && <span className="hb-quiet">{t("留空沿用已保存配置")}</span>}
          </summary>
          <div className="hb-stack hb-stack--tight" style={{ paddingTop: 8 }}>
            {proxyJumps.map((hop, index) => (
              <div key={index} className="hb-inline">
                <span className="hb-quiet hb-numeric" style={{ width: 18 }}>{index + 1}</span>
                <Select
                  value={hop.profileId}
                  onChange={(event) => updateHop(index, event.target.value)}
                  options={[
                    { value: "", label: t("选择已保存服务器") },
 ...profiles.map((profile) => ({ value: profile.profileId, label: `${profile.name || profile.host} · ${profile.username}@${profile.host}:${profile.port}` }))
                  ]}
                />
                <IconButton icon="close-outline" label={t("移除这一跳")} onClick={() => setProxyJumps((hops) => hops.filter((_, at) => at !== index))} />
              </div>
 ))}
            <div>
              <Button variant="ghost" size="sm" icon="plus-outline" onClick={() => setProxyJumps((hops) => [...hops, { profileId: "" }])} disabled={profiles.length === 0}>
                {t("添加跳板")}
              </Button>
            </div>
          </div>
        </details>

        {status !== null && <div className="hb-notice" role="status"><Icon name="loading-outline" size={14} />{status}</div>}
        {error !== null && <ErrorNote>{error}</ErrorNote>}
      </div>
    </Dialog>
 );
}