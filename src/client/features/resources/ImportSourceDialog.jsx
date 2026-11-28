import * as React from "react";
import { Button, Dialog, Icon, Row } from "../../ui/kit.jsx";
import { t } from "../../../i18n/core.js";

export function ImportSourceDialog({ onSelect, onClose }) {
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
