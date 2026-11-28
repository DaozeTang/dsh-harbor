import * as React from "react";
import { Card, ErrorNote, Notice, Row, Section, Switch } from "../../ui/kit.jsx";
import { t } from "../../../i18n/core.js";

export function FeatureSwitchesCard({ featureSettings, featureSaving, onSaveFeature }) {
  return (
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
                      onChange={(value) => onSaveFeature(key, value)}
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
                      onChange={(value) => onSaveFeature(key, value)}
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
  );
}

