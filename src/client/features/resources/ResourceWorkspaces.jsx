/**
 * Remote-workspace bindings for one saved SSH resource (issue #38).
 *
 * Rendered inside the resource editor's 高级选项 tab, next to the default
 * project directory, because a binding is a per-resource fact: "this DSH
 * workspace's files live on THIS server, under THIS directory".
 *
 * The binding deliberately does NOT turn the workspace into a remote mount.
 * DSH keeps treating the workspace as the host directory it always was; what
 * changes is (a) this plugin's SFTP tools default to the bound server and
 * resolve relative paths under the bound root, and (b) the conversation is
 * told where the files actually live. The copy below spells that split out for
 * the operator instead of promising transparent remote file I/O.
 */
import * as React from "react";
import { useEffect, useState } from "react";
import { Badge, Button, Checkbox, ErrorNote, Row, Section, Select, TextInput } from "../../ui/kit.jsx";
import { t } from "../../../i18n/core.js";

export function ResourceWorkspaces({ api, profileId, projectPath }) {
  const [bindings, setBindings] = useState(null);
  const [allBindings, setAllBindings] = useState([]);
  const [workspaces, setWorkspaces] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ workspacePath: "", remotePath: "", autoConnect: true });

  const load = async () => {
    try {
      setError(null);
      const value = await api.remoteWorkspaceList();
      const all = Array.isArray(value?.bindings) ? value.bindings : [];
      setAllBindings(all);
      setBindings(all.filter((binding) => binding.profileId === profileId));
      setWorkspaces(Array.isArray(value?.workspaces) ? value.workspaces : []);
    } catch (cause) {
      setError(cause?.message ?? String(cause));
      setBindings([]);
      setAllBindings([]);
    }
  };

  useEffect(() => {
    load();
  }, [profileId]);

  const save = async () => {
    if (!profileId || !form.workspacePath || !form.remotePath.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.remoteWorkspaceSave({
        workspacePath: form.workspacePath,
        profileId,
        remotePath: form.remotePath.trim(),
        autoConnect: form.autoConnect
      });
      setForm({ workspacePath: "", remotePath: "", autoConnect: true });
      await load();
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      setBusy(false);
    }
  };

  const unbind = async (workspacePath) => {
    setBusy(true);
    setError(null);
    try {
      await api.remoteWorkspaceDelete(workspacePath);
      await load();
    } catch (cause) {
      setError(cause?.message ?? String(cause));
    } finally {
      setBusy(false);
    }
  };

  const titleOf = (path) => workspaces.find((workspace) => workspace.path === path)?.title ?? path;
  const boundPaths = new Set((bindings ?? []).map((binding) => binding.workspacePath));
  const bindingByPath = new Map(allBindings.map((binding) => [binding.workspacePath, binding]));
  // Only offered when it would actually change the field.
  const projectSuggestion = typeof projectPath === "string" ? projectPath.trim() : "";
  const suggestion = projectSuggestion.length > 0 && projectSuggestion !== form.remotePath.trim() ? projectSuggestion : null;

  const workspaceOptions = [
    { value: "", label: t("选择工作区…") },
    ...workspaces.map((workspace) => {
      const owner = bindingByPath.get(workspace.path);
      // A workspace bound elsewhere can still be picked: selecting it replaces
      // that binding, which is what "move this workspace to this server" means.
      if (owner !== undefined && !boundPaths.has(workspace.path)) {
        return { value: workspace.path, label: `${workspace.title ?? workspace.path} — ${t(`已绑定到其他 SSH 资源：${owner.profileName || owner.profileId}`)}` };
      }
      return { value: workspace.path, label: workspace.title ? `${workspace.title} — ${workspace.path}` : workspace.path };
    })
  ];

  return (
    <Section title={t("远程工作区")}>
      <div className="hb-caption">{t("sftp_* 默认落在这个目录；原生 read/write/glob/grep 与本地 bash 不变")}</div>

      {error !== null && <ErrorNote>{error}</ErrorNote>}

      {bindings === null ? (
        <div className="hb-quiet">{t("加载中…")}</div>
      ) : bindings.length === 0 ? (
        <div className="hb-quiet">{t("还没有绑定工作区。")}</div>
      ) : (
        <div className="hb-settings-list">
          {bindings.map((binding) => (
            <Row
              key={binding.workspacePath}
              title={<span className="hb-mono hb-truncate">{binding.remotePath}</span>}
              meta={
                <>
                  <span className="hb-truncate" title={binding.workspacePath}>{titleOf(binding.workspacePath)}</span>
                  {binding.autoConnect && <Badge>{t("自动连接")}</Badge>}
                  {binding.connected && <Badge tone="ok">{t("已连接")}</Badge>}
                </>
              }
              actions={
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => setForm({ workspacePath: binding.workspacePath, remotePath: binding.remotePath, autoConnect: binding.autoConnect })}
                  >
                    {t("修改")}
                  </Button>
                  <Button variant="ghost" size="sm" danger disabled={busy} onClick={() => unbind(binding.workspacePath)}>{t("解除")}</Button>
                </>
              }
            />
          ))}
        </div>
      )}

      <div className="hb-settings-formrow">
        <Select
          value={form.workspacePath}
          onChange={(event) => setForm({ ...form, workspacePath: event.target.value })}
          options={workspaceOptions}
          aria-label={t("选择 DSH 工作区")}
          title={t("选择 DSH 工作区")}
          className="hb-settings-grow"
        />
        <TextInput
          value={form.remotePath}
          onChange={(event) => setForm({ ...form, remotePath: event.target.value })}
          placeholder={t("远端绝对路径，例如 /srv/app")}
          aria-label={t("远端绝对路径")}
          mono
          className="hb-settings-grow"
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={save}
          disabled={busy || !form.workspacePath || !form.remotePath.trim()}
          busy={busy}
        >
          {t("绑定")}
        </Button>
      </div>

      {suggestion !== null && (
        // The resource's 默认项目目录 is almost always the same path; offer it
        // as a one-click fill instead of asking the operator to type it twice.
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setForm({ ...form, remotePath: suggestion })}
          title={t("用这台服务器的默认项目目录作为远端根")}
        >
          {t(`填入默认项目目录：${suggestion}`)}
        </Button>
      )}

      <Checkbox
        checked={form.autoConnect}
        onChange={(value) => setForm({ ...form, autoConnect: value })}
        label={t("文件操作时自动连接（受设置里的总开关约束）")}
      />
    </Section>
  );
}
