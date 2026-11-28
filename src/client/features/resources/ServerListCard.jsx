import * as React from "react";
import { useState } from "react";
import { Badge, Button, Card, EmptyState, Icon, IconButton, InputGroup, Row, TextInput, confirmAction } from "../../ui/kit.jsx";
import { t } from "../../../i18n/core.js";
import { ServerRow } from "./ServerRow.jsx";

/**
 * The saved-server card: toolbar, group management, and the grouped list.
 *
 * It keeps only presentation state (search text, disclosure, group-name
 * draft); the inventory, connection actions and page error stay with the
 * page and travel in as props.
 */
export function ServerListCard({
  api, profiles, groups, knownHosts, loading, connecting, connectedProfiles,
  onReload, onError, onConnect, onCancelConnect, onDisconnect, onDelete, onEdit,
  onShowHostKey, onForgetHostKey, onNewServer, onImport, onExport
}) {
  const [newGroupName, setNewGroupName] = useState("");
  // Groups start expanded: a settings page has to show the servers it manages,
  // not a stack of headers. Collapsing is the operator's explicit choice and
  // lasts for this page life.
  const [collapsedGroups, setCollapsedGroups] = useState(() => new Set());
  const [resourceQuery, setResourceQuery] = useState("");
  const [creatingGroup, setCreatingGroup] = useState(false);

  const createGroup = async () => {
    const name = newGroupName.trim();
    if (!name) return;
    setCreatingGroup(true);
    try {
      await api.groupSave({ name });
      setNewGroupName("");
      await onReload();
    } catch (cause) {
      onError(cause?.message ?? String(cause));
    } finally {
      setCreatingGroup(false);
    }
  };

  const deleteGroup = async (group) => {
    const confirmed = await confirmAction({
      message: t(`删除分组“${group.name}”？其中 ${group.profileCount} 台服务器会移到“未分组”，不会断开已建立的连接。`),
      confirmLabel: t("删除"),
      danger: true
    });
    if (!confirmed) return;
    try {
      await api.groupDelete(group.groupId);
      await onReload();
    } catch (cause) {
      onError(cause?.message ?? String(cause));
    }
  };

  const groupedProfiles = new Map(groups.map((group) => [group.groupId, []]));
  const ungrouped = [];
  const query = resourceQuery.trim().toLowerCase();
  let visibleProfiles = 0;
  for (const saved of profiles) {
    if (query && ![saved.name, saved.host, saved.host + ":" + saved.port, saved.username, saved.groupName].some((value) => value?.toLowerCase().includes(query))) continue;
    visibleProfiles += 1;
    const profile = connectedProfiles ? { ...saved, connected: connectedProfiles.has(saved.profileId) } : saved;
    const bucket = profile.groupId === null ? undefined : groupedProfiles.get(profile.groupId);
    if (bucket === undefined) ungrouped.push(profile);
    else bucket.push(profile);
  }
  // Known hosts are addressed by host:port so each saved-server row can offer
  // its trust record, and hosts trusted without a saved resource join the same
  // card instead of a separate list.
  const knownByHost = new Map(knownHosts.map((h) => [h.host + ":" + h.port, h]));
  const jumpChain = (profile) => (profile.proxyJump ?? [])
    .map((hop) => profiles.find((candidate) => candidate.profileId === hop.profileId)?.name ?? null)
    .filter((name) => name !== null);

  const toggleGroup = (key) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const renderServer = (profile) => (
    <ServerRow
      key={profile.profileId}
      profile={profile}
      knownHost={knownByHost.get(profile.host + ":" + profile.port)}
      connecting={connecting}
      jump={jumpChain(profile)}
      onConnect={onConnect}
      onCancel={onCancelConnect}
      onDisconnect={onDisconnect}
      onEdit={onEdit}
      onDelete={onDelete}
      onShowHostKey={onShowHostKey}
      onForgetHostKey={onForgetHostKey}
    />
  );

  return (
      <Card
        title={t("已保存的服务器")}
        description={profiles.length > 0 ? t(`${profiles.length} 台服务器`) : undefined}
        action={
          <>
            <Button variant="ghost" size="sm" icon="download-outline" onClick={onImport}>{t("导入")}</Button>
            <Button variant="ghost" size="sm" icon="upload-outline" onClick={onExport}>{t("导出")}</Button>
            <Button variant="primary" size="sm" icon="plus-outline" onClick={onNewServer}>{t("新增服务器")}</Button>
          </>
        }
      >
        {profiles.length > 0 && (
          <InputGroup icon="search-outline">
            <TextInput
              type="search"
              value={resourceQuery}
              onChange={(event) => setResourceQuery(event.target.value)}
              aria-label={t("搜索服务器")}
              placeholder={t("按名称、地址或分组搜索服务器")}
            />
          </InputGroup>
        )}

        <details className="hb-settings-fold">
          <summary className="hb-caption">{t("管理分组")}</summary>
          <div className="hb-stack hb-stack--tight">
            <form
              className="hb-settings-formrow"
              onSubmit={(event) => { event.preventDefault(); if (!creatingGroup) void createGroup(); }}
            >
              <TextInput
                value={newGroupName}
                onChange={(event) => setNewGroupName(event.target.value)}
                aria-label={t("分组名称")}
                placeholder={t("例如：生产环境")}
                className="hb-settings-grow"
              />
              <Button type="submit" variant="secondary" size="sm" disabled={creatingGroup || !newGroupName.trim()} busy={creatingGroup}>
                {t("创建")}
              </Button>
            </form>
            {groups.length > 0 && (
              <div className="hb-settings-list">
                {groups.map((group) => (
                  <Row
                    key={group.groupId}
                    leading={<Icon name="folder-open-outline" size={14} className="hb-tertiary" />}
                    title={group.name}
                    meta={t(`（${group.profileCount}）`)}
                    actions={
                      <IconButton
                        icon="trash-outline"
                        size="sm"
                        danger
                        label={t(`删除分组 ${group.name}`)}
                        onClick={() => deleteGroup(group)}
                      />
                    }
                  />
                ))}
              </div>
            )}
          </div>
        </details>

        {loading ? (
          <div className="hb-quiet">{t("加载 SSH 资源中…")}</div>
        ) : profiles.length === 0 ? (
          <EmptyState icon="server" title={t("还没有保存的服务器。新增后可一键连接并打开右侧终端。")} />
        ) : query && visibleProfiles === 0 ? (
          <EmptyState icon="search-outline" title={t("没有匹配的服务器。")} text={t("换个名称、地址或分组试试。")} />
        ) : (
          <div className="hb-settings-groups">
            {groups.map((group) => {
              const key = `group:${group.groupId}`;
              const collapsed = !query && collapsedGroups.has(key);
              const items = groupedProfiles.get(group.groupId) ?? [];
              if (query && !items.length) return null;
              return (
                <section key={group.groupId} className="hb-settings-group">
                  <button type="button" className="hb-settings-group__head" onClick={() => toggleGroup(key)} aria-expanded={!collapsed}>
                    <Icon name={collapsed ? "chevron-right-outline" : "chevron-down-outline"} size={14} className="hb-tertiary" />
                    <span className="hb-settings-group__name">{group.name}</span>
                    <Badge>{items.length}</Badge>
                  </button>
                  {!collapsed && (items.length === 0
                    ? <div className="hb-quiet hb-settings-empty">{t("这个分组还没有服务器。")}</div>
                    : <div className="hb-settings-list">{items.map(renderServer)}</div>)}
                </section>
              );
            })}
            {ungrouped.length > 0 && (() => {
              const key = "ungrouped";
              const collapsed = !query && collapsedGroups.has(key);
              return (
                <section className="hb-settings-group">
                  <button type="button" className="hb-settings-group__head" onClick={() => toggleGroup(key)} aria-expanded={!collapsed}>
                    <Icon name={collapsed ? "chevron-right-outline" : "chevron-down-outline"} size={14} className="hb-tertiary" />
                    <span className="hb-settings-group__name">{t("未分组")}</span>
                    <Badge>{ungrouped.length}</Badge>
                  </button>
                  {!collapsed && <div className="hb-settings-list">{ungrouped.map(renderServer)}</div>}
                </section>
              );
            })()}
          </div>
        )}
      </Card>
  );
}

