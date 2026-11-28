import * as React from "react";
import { Button, Card, Field, Notice, Row, Section, Select, Switch } from "../../ui/kit.jsx";
import { t } from "../../../i18n/core.js";
import { LANGUAGE_LABELS, getLanguage } from "../../core/locale.js";

/**
 * Injected at build time from package.json (scripts/build-client.mjs). A
 * harness that does not define it must still render a neutral label, never the
 * fallback identifier.
 */
// eslint-disable-next-line no-undef
const INJECTED_VERSION = typeof __DSH_HARBOR_VERSION__ === "string" ? __DSH_HARBOR_VERSION__ : "";
const PLUGIN_VERSION = INJECTED_VERSION === "" ? "unknown" : INJECTED_VERSION;

export function LanguageUpdateCard({
  languageFollow, languageSaving, onChooseLanguage, onToggleLanguageFollow,
  installKind, openPluginManager
}) {
  return (
      <Card title={t("语言与更新")}>
        <Field label={t("界面语言")} hint={t("插件界面与 Agent 可见消息使用同一种语言。")}>
          <Select
            value={getLanguage()}
            onChange={(event) => onChooseLanguage(event.target.value)}
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
              onChange={onToggleLanguageFollow}
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
  );
}

