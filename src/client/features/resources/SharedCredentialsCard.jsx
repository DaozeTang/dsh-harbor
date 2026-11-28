import * as React from "react";
import { Badge, Button, Card, EmptyState, Icon, IconButton, Row } from "../../ui/kit.jsx";
import { t } from "../../../i18n/core.js";

export function SharedCredentialsCard({ sharedCredentials, loading, onAdd, onEdit, onRemove }) {
  return (
      <Card
        title={t("共享 SSH 凭据")}
        action={<Button variant="secondary" size="sm" icon="plus-outline" onClick={onAdd}>{t("新增共享凭据")}</Button>}
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
                    <IconButton icon="edit-outline" size="sm" label={t(`编辑共享凭据 ${item.name}`)} onClick={() => onEdit(item)} />
                    <IconButton icon="trash-outline" size="sm" danger label={t(`删除共享凭据 ${item.name}`)} onClick={() => onRemove(item)} />
                  </>
                }
              />
            ))}
          </div>
        )}
      </Card>
  );
}

