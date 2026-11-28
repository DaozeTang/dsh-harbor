import * as React from "react";
import { Button, Card, Checkbox, ErrorNote, Field, Notice, Row, SegmentedControl, Switch, TextArea } from "../../ui/kit.jsx";
import { t } from "../../../i18n/core.js";
import { TIER_ORDER, execPolicyLabel } from "../policy/exec-policy-ui.js";

/**
 * AI command-gate card: one switch, one tier selector, and the custom tier's
 * released categories plus exact rules.
 */
export function PolicyCard({
  agentAutoConnect, agentSaving, onToggleAgentAutoConnect,
  policyLoadFailed, execPolicy, onChooseExecPolicy, execPolicyAllow,
  policyCategories, policySaving, onTogglePolicyCategory,
  exactRules, ruleDraft, onRuleDraftChange, onSaveExactRules
}) {
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
              onChange={onToggleAgentAutoConnect}
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
            onChange={onChooseExecPolicy}
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
                  onChange={() => onTogglePolicyCategory(category.key)}
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
                onChange={(event) => onRuleDraftChange(event.target.value)}
                className="hb-input--mono"
              />
              <div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={policySaving || ruleDraft === exactRules.join("\n")}
                  onClick={() => void onSaveExactRules()}
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
  );
}

