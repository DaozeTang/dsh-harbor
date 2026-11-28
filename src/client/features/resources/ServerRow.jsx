import * as React from "react";
import { useRef, useState } from "react";
import { Badge, Button, Icon, IconButton, Menu, MenuItem, MenuLabel, MenuSeparator, Row } from "../../ui/kit.jsx";
import { t } from "../../../i18n/core.js";

/**
 * One saved server. The row owns its overflow menu so a long list keeps a
 * single interaction target per server instead of a row of icon buttons.
 */
export function ServerRow({ profile, knownHost, connecting, jump, onConnect, onCancel, onDisconnect, onEdit, onDelete, onShowHostKey, onForgetHostKey }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const anchorRef = useRef(null);
  const connected = profile.connected === true;
  const busy = connecting === profile.profileId;
  const initial = (profile.name || profile.host || "?").trim().slice(0, 1).toUpperCase();
  const closeThen = (action) => () => { setMenuOpen(false); action(); };
  return (
    <Row
      className="hb-settings-server"
      leading={<span className="hb-avatar">{initial}</span>}
      title={
        <>
          <span className="hb-truncate">{profile.name}</span>
          {connected && <Badge tone="ok">{t("已连接")}</Badge>}
          {!profile.credentialConfigured && <Badge tone="warn">{t("未配置认证")}</Badge>}
        </>
      }
      meta={
        <>
          <span className="hb-mono hb-truncate">{profile.username + "@" + profile.host + ":" + profile.port}</span>
          {profile.groupName !== null && profile.groupName !== undefined && <Badge>{profile.groupName}</Badge>}
          {jump.length > 0 && (
            <Badge mono title={t("跳板机（ProxyJump）")}>
              <Icon name="branch-outline" size={12} />
              {jump.join(" → ")}
            </Badge>
          )}
          {typeof profile.defaultProjectPath === "string" && profile.defaultProjectPath !== "" && (
            <span className="hb-quiet hb-truncate">{t(`项目：${profile.defaultProjectPath}`)}</span>
          )}
        </>
      }
      actions={
        <>
          {connected ? (
            <Button variant="ghost" size="sm" onClick={() => onDisconnect(profile)}>{t("断开")}</Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              icon="terminal"
              busy={busy}
              disabled={!profile.credentialConfigured}
              title={busy ? t("连接中") : profile.defaultProjectPath ? t(`进入项目 ${profile.defaultProjectPath}`) : t("连接并打开终端")}
              onClick={() => onConnect(profile)}
            >
              {profile.defaultProjectPath ? t("进入项目") : t("连接")}
            </Button>
          )}
          {busy && <IconButton icon="close-outline" label={t(`取消连接 ${profile.name}`)} onClick={() => onCancel(profile)} />}
          <Button
            ref={anchorRef}
            variant="ghost"
            size="sm"
            icon="ellipsis-outline"
            title={t("更多操作")}
            aria-label={t("更多操作")}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((value) => !value)}
          />
          <Menu open={menuOpen} anchorRef={anchorRef} onClose={() => setMenuOpen(false)} align="end" minWidth={220}>
            <MenuLabel>{profile.name}</MenuLabel>
            <MenuItem icon="edit-outline" onSelect={closeThen(() => onEdit(profile))}>{t("编辑服务器")}</MenuItem>
            {connected
              ? <MenuItem icon="close-outline" onSelect={closeThen(() => onDisconnect(profile))}>{t("断开连接")}</MenuItem>
              : <MenuItem icon="terminal" disabled={!profile.credentialConfigured} onSelect={closeThen(() => onConnect(profile))}>{t("连接并打开终端")}</MenuItem>}
            {knownHost !== undefined && (
              <>
                <MenuSeparator />
                <MenuItem icon="shield-outline" onSelect={closeThen(() => onShowHostKey(knownHost))}>{t("主机指纹")}</MenuItem>
                <MenuItem icon="warning-outline" danger onSelect={closeThen(() => onForgetHostKey(knownHost))}>{t("忘记指纹")}</MenuItem>
              </>
            )}
            <MenuSeparator />
            <MenuItem icon="trash-outline" danger onSelect={closeThen(() => onDelete(profile))}>{t("删除服务器")}</MenuItem>
          </Menu>
        </>
      }
    />
  );
}
