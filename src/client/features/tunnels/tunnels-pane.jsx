/**
 * Port forwarding pane.
 *
 * Three shapes of one feature, so the form switches idiom rather than growing:
 * local (this machine → something the server can reach), remote (the server →
 * something this machine can reach) and dynamic (a SOCKS5 proxy whose exit is
 * the server). Binding port 0 asks the OS for a free port; the list then shows
 * the port that was actually bound, which is the only value worth copying.
 */
import * as React from "react";
import { useEffect, useState } from "react";
import {
  Badge, Button, Dialog, Dot, EmptyState, ErrorNote, Field, Icon, IconButton, Row, SegmentedControl, TextInput, toast
} from "../../ui/kit.jsx";
import { t } from "../../../i18n/core.js";

export function TunnelsPane({ api, connectionId }) {
  const [tunnels, setTunnels] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [kind, setKind] = useState("local");
  const [form, setForm] = useState({
    bindAddr: "127.0.0.1", bindPort: "", remoteHost: "", remotePort: "", targetHost: "127.0.0.1", targetPort: ""
  });

  const load = async () => {
    if (!connectionId) return;
    try {
      const value = await api.tunnelList(connectionId);
      setTunnels(Array.isArray(value?.tunnels) ? value.tunnels : []);
      setError(null);
    } catch (cause) {
      setError(cause?.message ?? String(cause));
      setTunnels([]);
    }
  };

  useEffect(() => {
    setTunnels(null);
    if (connectionId) void load();
    const timer = connectionId ? setInterval(() => { void load(); }, 4000) : null;
    return () => { if (timer !== null) clearInterval(timer); };
  }, [connectionId]);

  const isDynamic = kind === "dynamic";
  // Dynamic only needs an optional bind port (empty = OS-assigned); local and
  // remote need the target/listen fields, and remote also needs the local
  // target port — sending 0 used to fail the request schema instead.
  const canStart = isDynamic
    ? true
    : form.remoteHost.trim() !== "" && form.remotePort !== "" && (kind !== "remote" || form.targetPort !== "");
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));

  /** Port fields reach the wire as numbers; reject typos before the RPC does. */
  const validPort = (raw, allowZero = false) => {
    if (raw === "") return allowZero;
    const value = Number(raw);
    return Number.isInteger(value) && value >= (allowZero ? 0 : 1) && value <= 65535;
  };

  const start = async () => {
    if (!canStart) return;
    if (!validPort(form.bindPort, true)
      || (kind !== "dynamic" && !validPort(form.remotePort))
      || (kind === "remote" && !validPort(form.targetPort))) {
      setError(t("端口需为 1–65535 的整数"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (kind === "dynamic") {
        await api.tunnelStartDynamic(connectionId, form.bindAddr.trim() || "127.0.0.1", form.bindPort ? Number(form.bindPort) : 0);
      } else if (kind === "local") {
        await api.tunnelStartLocal({
          connectionId,
          bindAddr: form.bindAddr.trim() || "127.0.0.1",
          bindPort: form.bindPort ? Number(form.bindPort) : 0,
          remoteHost: form.remoteHost.trim(),
          remotePort: Number(form.remotePort)
        });
      } else {
        await api.tunnelStartRemote({
          connectionId,
          // For a remote forward the server listens on remoteHost:remotePort;
          // bindAddr/bindPort belong to the local listener kinds only.
          remoteHost: form.remoteHost.trim(),
          remotePort: Number(form.remotePort),
          targetHost: form.targetHost.trim() || "127.0.0.1",
          targetPort: Number(form.targetPort)
        });
      }
      setFormOpen(false);
      setForm((current) => ({ ...current, remoteHost: "", remotePort: "", targetPort: "" }));
      toast(t("转发已启动"));
      void load();
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      setBusy(false);
    }
  };

  const stop = async (tunnelId) => {
    setBusy(true);
    setError(null);
    try {
      await api.tunnelStop(connectionId, tunnelId);
      void load();
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      setBusy(false);
    }
  };

  const describe = (tunnel) => tunnel.kind === "dynamic"
    ? t("动态 SOCKS5")
 : tunnel.kind === "local" ? t("本地转发") : t("远程转发");

  return (
    <div className="hb-pane hb-pad hb-stack">
      <div className="hb-pane__head">
        <div className="hb-pane__heading">
          <div className="hb-title">{t("端口转发")}</div>
          <div className="hb-quiet">{t("所有隧道都随这台服务器的连接存活；断开连接即全部关闭。")}</div>
        </div>
        <div className="hb-pane__actions">
          <IconButton icon="refresh-outline" label={t("刷新")} onClick={() => void load()} disabled={busy || tunnels === null} />
          <Button variant="secondary" size="sm" icon="plus-outline" onClick={() => setFormOpen(true)} disabled={!connectionId}>
            {t("新建转发")}
          </Button>
        </div>
      </div>

      {error !== null && <ErrorNote>{error}</ErrorNote>}

      <div className="hb-scroll hb-stack hb-stack--tight" style={{ flex: 1, minHeight: 0 }}>
        {tunnels === null && (
          <div className="hb-liststate"><span className="hb-spinner" />{t("加载中…")}</div>
 )}
        {tunnels !== null && tunnels.length === 0 && (
          <EmptyState
            icon="tunnel"
            title={t("还没有端口转发")}
            text={t("本地转发把服务器能访问的端口带到本机；远程转发把本机端口暴露给服务器；动态转发在本机开一个 SOCKS5 代理。")}
            action={<Button variant="secondary" size="sm" icon="plus-outline" onClick={() => setFormOpen(true)}>{t("新建转发")}</Button>}
          />
 )}
        {tunnels?.map((tunnel) => (
          <Row
            key={tunnel.tunnelId}
            leading={<Dot tone={tunnel.active ? "ok" : "idle"} />}
            title={
              <>
                <span className="hb-tunnel__kind">{describe(tunnel)}</span>
                <span className="hb-tunnel__addr hb-quiet hb-mono" title={`${tunnel.bindAddr}:${tunnel.bindPort}`}>{tunnel.bindAddr}:{tunnel.bindPort}</span>
              </>
            }
            meta={
              <>
                <span className="hb-mono hb-truncate" title={tunnel.tunnelId}>
                  {tunnel.kind === "dynamic"
                    ? `SOCKS5 · ${tunnel.tunnelId}`
                    : tunnel.kind === "remote"
                      ? `→ ${tunnel.targetHost}:${tunnel.targetPort} · ${tunnel.tunnelId}`
                      : `→ ${tunnel.remoteHost}:${tunnel.remotePort} · ${tunnel.tunnelId}`}
                </span>
                {tunnel.kind === "dynamic" && (
                  <Badge tone={tunnel.connections > 0 ? "ok" : "neutral"}>
                    {tunnel.connections > 0 ? t(`活动连接 ${tunnel.connections}`) : t("等待连接")}
                  </Badge>
                )}
              </>
            }
            actions={<Button variant="ghost" size="sm" icon="stop-fill" onClick={() => void stop(tunnel.tunnelId)} disabled={busy}>{t("停止")}</Button>}
          />
 ))}
      </div>

      <Dialog
        open={formOpen}
        onClose={busy ? () => {} : () => setFormOpen(false)}
        title={t("新建端口转发")}
        description={t("绑定端口留空或填 0 时由系统分配，启动后可在列表里看到实际端口。")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setFormOpen(false)} disabled={busy}>{t("取消")}</Button>
            <span className="hb-spacer" />
            <Button variant="primary" onClick={start} busy={busy} disabled={!canStart} data-modal-autofocus>{t("启动")}</Button>
          </>
        }
      >
        <div className="hb-stack">
          <Field label={t("类型")}>
            <SegmentedControl
              value={kind}
              onChange={setKind}
              items={[
                { value: "local", label: t("本地转发") },
                { value: "remote", label: t("远程转发") },
                { value: "dynamic", label: t("动态 SOCKS5") }
              ]}
            />
          </Field>
          {kind !== "remote" && (
            <div className="hb-grid hb-grid--2">
              <Field label={t("绑定地址")} hint={t("留空为 127.0.0.1")}>
                <TextInput value={form.bindAddr} onChange={set("bindAddr")} mono />
              </Field>
              <Field label={t("绑定端口")} hint={t("0 或留空 = 随机")}>
                <TextInput value={form.bindPort} onChange={set("bindPort")} inputMode="numeric" />
              </Field>
            </div>
          )}
          {!isDynamic && (
            <div className="hb-grid hb-grid--2">
              <Field label={kind === "local" ? t("目标主机（服务器可达）") : t("服务器监听主机")}>
                <TextInput value={form.remoteHost} onChange={set("remoteHost")} placeholder="127.0.0.1" mono />
              </Field>
              <Field label={kind === "local" ? t("目标端口") : t("服务器监听端口")}>
                <TextInput value={form.remotePort} onChange={set("remotePort")} placeholder="3306" inputMode="numeric" />
              </Field>
            </div>
 )}
          {kind === "remote" && (
            <div className="hb-grid hb-grid--2">
              <Field label={t("本机目标主机")}>
                <TextInput value={form.targetHost} onChange={set("targetHost")} mono />
              </Field>
              <Field label={t("本机目标端口")}>
                <TextInput value={form.targetPort} onChange={set("targetPort")} inputMode="numeric" />
              </Field>
            </div>
 )}
          {isDynamic && (
            <div className="hb-notice">
              <Icon name="info-outline" size={14} />
              <span>{t("客户端连到绑定地址后自行选择目标，流量都从这台服务器出去；需要固定端口时把绑定端口填上一个非 0 值。")}</span>
            </div>
 )}
        </div>
      </Dialog>
    </div>
 );
}
