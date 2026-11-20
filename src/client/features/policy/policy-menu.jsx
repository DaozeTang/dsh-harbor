/**
 * Execution-policy switcher (operator only).
 *
 * It lives in the toolbar rather than floating over the terminal: the tier is
 * session state that governs what the agent may run, so it must be readable at
 * a glance and impossible to mistake for terminal output.
 *
 * Loosening the gate is the direction that can destroy data, so it asks for a
 * second confirmation; tightening applies immediately. The choice never
 * persists — a reconnect falls back to the resource or global policy, so a
 * forgotten release cannot outlive its terminal.
 */
import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { Button, Dialog, Icon, Menu, MenuItem, MenuLabel, MenuSeparator } from "../../ui/kit.jsx";
import { TIER_ORDER, execPolicyLabel, execPolicyLooseningDetail } from "../../exec-policy-ui.js";
import { harborUiSetError } from "../../store.js";
import { t } from "../../../i18n/core.js";

const TIER_ICON = { standard: "shield-outline", custom: "sliders-two-outline", allowAll: "warning-outline" };

export function PolicyMenu({ api, connectionId }) {
  const [info, setInfo] = useState(null);
  const [open, setOpen] = useState(false);
  const [confirmTier, setConfirmTier] = useState(null);
  const [busy, setBusy] = useState(false);
  const anchorRef = useRef(null);

  useEffect(() => {
    let alive = true;
    setInfo(null);
    api.execPolicyGet(connectionId).then((value) => { if (alive) setInfo(value); }).catch(() => {});
    return () => { alive = false; };
  }, [api, connectionId]);

  const applyTier = async (tier) => {
    setBusy(true);
    try {
      setInfo(await api.execPolicySet(connectionId, tier));
    } catch (error) {
      harborUiSetError(t(`无法切换执行策略：${error?.message ?? String(error)}`));
    } finally {
      setBusy(false);
    }
  };

  const choose = (tier) => {
    setOpen(false);
    if (info === null || busy || tier === info.effective) return;
    if (TIER_ORDER[tier] > TIER_ORDER[info.effective]) setConfirmTier(tier);
    else void applyTier(tier);
  };

  const tier = info?.effective ?? "standard";
  const sessionScoped = info?.source === "session";

  return (
    <>
      <Button
        ref={anchorRef}
        variant="ghost"
        size="sm"
        icon={TIER_ICON[tier]}
        onClick={() => setOpen((value) => !value)}
        title={t("AI 命令执行策略（仅操作者可切换，本次会话内生效）")}
        style={tier === "allowAll" ? { color: "var(--hb-err)" } : undefined}
      >
        {execPolicyLabel(tier)}{sessionScoped ? t("（会话）") : ""}
      </Button>
      <Menu open={open} anchorRef={anchorRef} onClose={() => setOpen(false)} align="end" minWidth={240}>
        <MenuLabel>{t("AI 命令执行策略")}</MenuLabel>
        {["standard", "custom", "allowAll"].map((candidate) => (
          <MenuItem
            key={candidate}
            icon={TIER_ICON[candidate]}
            checked={tier === candidate}
            onSelect={() => choose(candidate)}
          >
            {execPolicyLabel(candidate)}
          </MenuItem>
 ))}
        <MenuSeparator />
        <div className="hb-quiet" style={{ padding: "2px 8px 6px", lineHeight: 1.5 }}>
          {info === null ? t("正在读取当前策略…") : t(`来源：${info.source === "session" ? t("本会话") : info.source === "profile" ? t("服务器") : info.source === "global" ? t("全局") : t("默认")}`)}
        </div>
      </Menu>

      <Dialog
        open={confirmTier !== null}
        onClose={() => setConfirmTier(null)}
        title={t("放宽 AI 命令执行策略？")}
        description={t("这是一次会话内的临时放宽，重连后恢复为资源或全局策略。")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmTier(null)}>{t("取消")}</Button>
            <Button
              variant="danger-solid"
              onClick={() => { const next = confirmTier; setConfirmTier(null); if (next !== null) void applyTier(next); }}
            >
              {t("确认放宽")}
            </Button>
          </>
        }
      >
        <div className="hb-stack">
          <div className="hb-inline">
            <Icon name="warning-triangle-outline" size={16} />
            <span>{t(`当前：${execPolicyLabel(tier)} → ${execPolicyLabel(confirmTier ?? tier)}`)}</span>
          </div>
          <div className="hb-secondary" style={{ fontSize: 12, lineHeight: 1.6 }}>
            {execPolicyLooseningDetail(confirmTier ?? tier, info?.allow?.length ?? 0)}
          </div>
        </div>
      </Dialog>
    </>
 );
}