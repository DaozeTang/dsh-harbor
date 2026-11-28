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
import { TIER_ORDER, execPolicyLabel, execPolicyLooseningDetail } from "./exec-policy-ui.js";
import { harborUiSetError } from "../../state/store.js";
import { t } from "../../../i18n/core.js";

const TIER_ICON = { standard: "shield-outline", custom: "sliders-two-outline", allowAll: "warning-outline" };
const TIER_CHOICES = Object.keys(TIER_ORDER);

/** Operator-facing name for the DSH session ceiling. */
function dshCeilingLabel(ceiling) {
  if (ceiling === "auto") return t("自动审查");
  if (ceiling === "readOnly") return t("只读");
  if (ceiling === "standard") return t("仅工作区写");
  if (ceiling === "allowAll") return t("完全访问");
  return "";
}

/**
 * Which Harbor tiers this session's DSH mode still permits. Auto and read-only
 * own the decision; workspace-write is a hard standard ceiling; full access
 * still lets the operator tighten. Absent DSH info keeps the old menu.
 */
function allowedTiers(dsh) {
  if (dsh === null || dsh === undefined) return TIER_CHOICES;
  if (dsh.ceiling === "auto" || dsh.ceiling === "readOnly") return [];
  if (dsh.ceiling === "standard") return ["standard"];
  return TIER_CHOICES;
}

export function PolicyMenu({ api, connectionId, sessionId }) {
  const [info, setInfo] = useState(null);
  const [open, setOpen] = useState(false);
  const [confirmTier, setConfirmTier] = useState(null);
  const [busy, setBusy] = useState(false);
  const anchorRef = useRef(null);

  useEffect(() => {
    let alive = true;
    setInfo(null);
    api.execPolicyGet(connectionId, sessionId).then((value) => { if (alive) setInfo(value); }).catch(() => {});
    return () => { alive = false; };
  }, [api, connectionId, sessionId]);

  // The DSH permission selector can change while this menu is mounted (for
  // example from the composer). Re-read whenever it opens so the pill and the
  // disabled rows describe the live ceiling, not the one at mount time.
  const refresh = () => {
    api.execPolicyGet(connectionId, sessionId).then(setInfo).catch(() => {});
  };

  const applyTier = async (tier) => {
    setBusy(true);
    try {
      setInfo(await api.execPolicySet(connectionId, tier, sessionId));
    } catch (error) {
      harborUiSetError(t(`无法切换执行策略：${error?.message ?? String(error)}`));
    } finally {
      setBusy(false);
    }
  };

  const choices = allowedTiers(info?.dsh ?? null);

  const choose = (tier) => {
    setOpen(false);
    if (info === null || busy || tier === info.effective || !choices.includes(tier)) return;
    if (TIER_ORDER[tier] > TIER_ORDER[info.effective]) setConfirmTier(tier);
    else void applyTier(tier);
  };

  const tier = info?.effective ?? "standard";
  const dsh = info?.dsh ?? null;
  const sessionScoped = info?.source === "session";
  const suffix = dsh !== null ? t("（DSH）") : sessionScoped ? t("（会话）") : "";

  return (
    <>
      <Button
        ref={anchorRef}
        variant="ghost"
        size="sm"
        icon={dsh?.ceiling === "auto" ? "sparkle" : dsh?.ceiling === "readOnly" ? "eye-outline" : TIER_ICON[tier]}
        onClick={() => { if (!open) refresh(); setOpen((value) => !value); }}
        title={t("AI 命令执行策略（仅操作者可切换，仅对当前对话生效）")}
        style={tier === "allowAll" && dsh?.ceiling !== "auto" ? { color: "var(--hb-err)" } : undefined}
      >
        {dsh?.ceiling === "auto" ? t("自动审查") : dsh?.ceiling === "readOnly" ? t("只读") : execPolicyLabel(tier)}{suffix}
      </Button>
      <Menu open={open} anchorRef={anchorRef} onClose={() => setOpen(false)} align="end" minWidth={280}>
        <MenuLabel>{t("AI 命令执行策略")}</MenuLabel>
        {TIER_CHOICES.map((candidate) => (
          <MenuItem
            key={candidate}
            icon={TIER_ICON[candidate]}
            checked={tier === candidate}
            disabled={!choices.includes(candidate)}
            onSelect={() => choose(candidate)}
          >
            {execPolicyLabel(candidate)}
          </MenuItem>
 ))}
        <MenuSeparator />
        <div className="hb-quiet" style={{ padding: "2px 8px 6px", lineHeight: 1.5 }}>
          {info === null
            ? t("正在读取当前策略…")
            : dsh !== null
              ? dsh.ceiling === "auto"
                ? t("DSH 会话为自动审查；Auto review 接管执行审查，Harbor 不再额外拦截。")
                : dsh.ceiling === "readOnly"
                  ? t("DSH 会话为只读；危险命令直接拒绝，Harbor 不再请求审批。")
                  : dsh.ceiling === "standard"
                    ? t("DSH 会话为仅工作区写；Harbor 只能使用标准档，不能再放宽。")
                    : t("DSH 会话为完全访问；Harbor 默认不额外拦截，可在本会话内收紧。")
              : t(`来源：${info.source === "session" ? t("本会话") : info.source === "profile" ? t("服务器") : info.source === "global" ? t("全局") : t("默认")}`)}
        </div>
        {info !== null && dsh !== null && (
          <div className="hb-quiet" style={{ padding: "0 8px 6px", lineHeight: 1.5 }}>
            {t(`Harbor 层级：${execPolicyLabel(tier)}；DSH 上限：${dshCeilingLabel(dsh.ceiling)}。`)}
          </div>
        )}
        {info !== null && dsh?.ceiling === "allowAll" && dsh.approval === "never" && tier !== "allowAll" && (
          <div className="hb-quiet" style={{ padding: "0 8px 6px", lineHeight: 1.5 }}>
            {t("注意：DSH 完全访问的审批策略为 never，收紧后危险命令会被直接拒绝，无法在会话内请求授权。")}
          </div>
        )}
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