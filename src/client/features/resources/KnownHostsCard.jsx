import * as React from "react";
import { Badge, Button, Card, EmptyState, Icon, IconButton, Row } from "../../ui/kit.jsx";
import { t } from "../../../i18n/core.js";

export function KnownHostsCard({ knownHosts, profiles, forgetBusy, onForget, onShowHostKey, onSaveAsResource }) {
  const savedHostKeys = new Set(profiles.map((p) => p.host + ":" + p.port));
  return (
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
                  onClick={() => onShowHostKey(known)}
                  actions={
                    <>
                      {!saved && (
                        <Button
                          variant="secondary"
                          size="sm"
                          title={t("把该服务器保存为 SSH 资源（可改用户名与认证方式）")}
                          onClick={() => onSaveAsResource(known)}
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
                        onClick={() => onForget(
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
  );
}

