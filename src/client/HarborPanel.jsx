/**
 * The workbench surface.
 *
 * One entry point for the right sidebar tab: a server strip on top, the view
 * switcher under it, and the panes below. Panes are keep-alive (hidden with
 * CSS, never unmounted), because the terminal pool and the file browser's
 * scroll position both outlive a tab switch.
 *
 * Ownership: connection lifetime is host state. This component mirrors it and
 * never disconnects on unmount — closing a tab, collapsing the sidebar or
 * switching chats leaves every session exactly where it was.
 */
import * as React from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Badge, Button, ConfirmHost, Dot, EmptyState, ErrorNote, Icon, IconButton, ToastHost } from "./ui/kit.jsx";
import { TerminalAppearanceButton } from "./terminal-display/TerminalAppearanceButton.jsx";
import { XtermView } from "./features/terminal/xterm-view.jsx";
import { ConnectDialog } from "./features/connect/connect-dialog.jsx";
import { BatchDialog } from "./features/batch/batch-dialog.jsx";
import { SnippetsView } from "./features/snippets/snippets-view.jsx";
import { PolicyMenu } from "./features/policy/policy-menu.jsx";
import { HarborFiles } from "./HarborFiles.jsx";
import { TunnelsPane } from "./features/tunnels/tunnels-pane.jsx";
import { LogsPane } from "./features/logs/logs-pane.jsx";
import {
  getHarborUiSnapshot, useHarborUi, harborUiSetActiveConnection, harborUiSetBusy, harborUiSetConnections,
  harborUiSetError, harborUiSetFeatures, harborUiAnnounceAgentConnections
} from "./store.js";
import {
  DEFAULT_VIEW_ID, adoptIntoView, claimPendingOpens, closeInView, forgetView, openInView,
  paneOpenRequestsRevision, reconcileViews, resolvePaneActiveConnection, selectInView,
  subscribePaneSessions, visiblePaneConnections, viewSession
} from "./pane-selection.js";
import { t } from "../i18n/core.js";
import { useLanguage } from "./locale.js";

/** Error boundary so one crashed pane never takes the whole workbench down. */
class PaneBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error) {
    console.error("[dsh-harbor] pane crashed:", error);
  }
  render() {
    if (this.state.error === null) return this.props.children;
    return (
      <div className="hb-pad">
        <ErrorNote>{t(`此页签出错：${this.state.error?.message ?? String(this.state.error)}`)}</ErrorNote>
      </div>
 );
  }
}

/** Mirror the host's connection list and its agent binding into the UI store. */
async function refreshConnections(api) {
  try {
    const { connections, activeConnectionId } = await api.list();
    harborUiSetConnections(connections);
    harborUiSetActiveConnection(activeConnectionId ?? null);
    harborUiAnnounceAgentConnections(connections);
  } catch (error) {
    harborUiSetError(t(`无法刷新 SSH 连接列表：${error?.message ?? String(error)}`));
  }
}

// Labels are thunks: the literal lives inside t() at its definition site
// (so the i18n extractor sees it) while the actual wording is resolved at
// render time, which is what makes a language switch repaint the strip.
const VIEWS = [
  { value: "terminal", icon: "terminal", label: () => t("终端") },
  { value: "files", icon: "folder-open-outline", label: () => t("文件"), needsConnection: true },
  { value: "tunnels", icon: "tunnel", label: () => t("转发"), needsConnection: true, feature: "showTunnels" },
  { value: "snippets", icon: "checklist-outline", label: () => t("快捷命令"), feature: "showSnippets" },
  { value: "logs", icon: "archive-outline", label: () => t("日志"), feature: "showLogs" }
];

export function HarborPanel({ api, credentials, viewId = DEFAULT_VIEW_ID, viewSignal }) {
  useLanguage();
  const ui = useHarborUi();
  const [view, setView] = useState("terminal");
  const [connectOpen, setConnectOpen] = useState(false);
  const [batchTask, setBatchTask] = useState(null);
  const [pendingBatchCount, setPendingBatchCount] = useState(0);
  const [profiles, setProfiles] = useState([]);
  const [groups, setGroups] = useState([]);
  const seenBatchIdsRef = useRef(new Set());
  const adoptedRef = useRef(false);

  const features = ui.features ?? {};
  const visibleViews = VIEWS.filter((entry) => entry.feature === undefined || features[entry.feature] !== false);

  useEffect(() => {
    let alive = true;
    const before = getHarborUiSnapshot().features;
    api.agentSettingsGet().then(({ features: loaded }) => {
      if (alive && loaded !== undefined && getHarborUiSnapshot().features === before) harborUiSetFeatures(loaded);
    }).catch(() => {});
    return () => { alive = false; };
  }, [api]);

  useEffect(() => {
    refreshConnections(api);
    // A hidden window does not need a connection poll every five seconds; the
    // next visible tick catches up, and the host keeps sessions alive anyway.
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refreshConnections(api);
    }, 5000);
    return () => clearInterval(timer);
  }, [api]);

  useEffect(() => {
    Promise.all([api.profileList(), api.groupList()])
 .then(([profileValue, groupValue]) => {
        setProfiles(profileValue.profiles ?? []);
        setGroups(groupValue.groups ?? []);
      })
 .catch(() => {});
  }, [api]);

  // A feature switch can hide the view the operator is on. Keyed off the
  // feature flags (not the derived list) so the effect does not re-run on every
  // render and cannot loop through its own setState.
  const visibleViewIds = visibleViews.map((entry) => entry.value).join(",");
  useEffect(() => {
    if (!visibleViewIds.split(",").includes(view)) setView("terminal");
  }, [view, visibleViewIds]);

  const refreshBatchTasks = async () => {
    try {
      const { tasks } = await api.batchTaskList();
      setPendingBatchCount(tasks.length);
      const unseen = tasks.find((task) => !seenBatchIdsRef.current.has(task.batchId));
      if (unseen !== undefined) {
        seenBatchIdsRef.current.add(unseen.batchId);
        setBatchTask((current) => current ?? unseen);
      }
    } catch {}
  };

  useEffect(() => {
    void refreshBatchTasks();
    // Batch approvals need to surface promptly, but an occluded tab does not
    // have to poll the host every second.
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refreshBatchTasks();
    }, 1000);
    return () => clearInterval(timer);
  }, [api]);

  // Panes are sibling trees over one connection list, and the dock remounts
  // this body when the layout root becomes a split — which servers a pane shows
  // therefore lives in the shared pane store, keyed by the host's tab id.
  const paneView = useSyncExternalStore(subscribePaneSessions, () => viewSession(viewId));
  const paneConnections = visiblePaneConnections(ui.connections, paneView.connectionIds);
  const resolvedActiveConnectionId = resolvePaneActiveConnection(paneConnections, paneView.activeConnectionId);
  const active = paneConnections.find((connection) => connection.connectionId === resolvedActiveConnectionId) ?? null;

  // Files and tunnels are bound to one server. Closing the last server tab
  // while one of them is selected used to leave a blank body under a disabled
  // tab; fall back to the terminal, whose empty state explains what to do.
  useEffect(() => {
    if (active === null && (view === "files" || view === "tunnels")) setView("terminal");
  }, [active, view]);

  useEffect(() => { reconcileViews(ui.connections); }, [ui.connections]);

  // Host-side sessions outlive a page reload; adopt them once per mount so a
  // refresh never leaves invisible zombies, but a close is never undone.
  useEffect(() => {
    if (adoptedRef.current || ui.connections.length === 0) return;
    adoptedRef.current = true;
    adoptIntoView(viewId, ui.connections);
  }, [ui.connections, viewId]);

  // A surface that owns no pane (the settings page) queues what it connected;
  // the first pane to render claims it.
  const pendingOpenRevision = useSyncExternalStore(subscribePaneSessions, paneOpenRequestsRevision);
  useEffect(() => {
    for (const connectionId of claimPendingOpens()) openInView(viewId, connectionId);
  }, [pendingOpenRevision, viewId]);

  useEffect(() => {
    if (viewSignal === undefined) return undefined;
    const onAbort = () => forgetView(viewId);
    viewSignal.addEventListener("abort", onAbort);
    return () => viewSignal.removeEventListener("abort", onAbort);
  }, [viewSignal, viewId]);

  /**
   * Hand the agent this pane's connection. The report comes back from the host
   * rather than from a local guess: an optimistic badge made a failed switch
   * look applied for one poll tick and then flip back, which reads as the agent
   * wandering off on its own.
   */
  const bindAgent = (connectionId) => {
    if (connectionId === null || connectionId === ui.activeConnectionId) return;
    if (ui.connections.find((connection) => connection.connectionId === connectionId)?.connected === false) return;
    api.selectConnection(connectionId)
 .then(() => refreshConnections(api))
 .catch((error) => {
        const message = error?.message ?? String(error);
        harborUiSetError(/404|not mounted|not-mounted/i.test(message)
          ? t("切换 Agent 目标失败：宿主端仍是旧版本（没有 selectConnection 接口），重启 dsh web / DSH.app 后即可生效")
 : t(`切换 Agent 目标失败：${message}`));
      });
  };

  const openSession = async () => {
    if (active === null) return;
    harborUiSetBusy(true);
    harborUiSetError(null);
    try {
      await api.openSession(active.connectionId, 100, 30);
      await refreshConnections(api);
    } catch (error) {
      harborUiSetError(error?.message ?? String(error));
    } finally {
      harborUiSetBusy(false);
    }
  };

  /**
   * Hide one server tab from this pane. The host session is disconnected only
   * when no pane shows it any more, so a server open in both panes survives
   * being closed in one of them.
   */
  const closePaneTab = async (connectionId) => {
    if (!closeInView(viewId, connectionId)) return;
    try {
      await api.disconnect(connectionId);
      await refreshConnections(api);
    } catch (error) {
      openInView(viewId, connectionId);
      harborUiSetError(t(`断开服务器失败：${error?.message ?? String(error)}`));
    }
  };

  const cdFromFiles = async (dir) => {
    const sessionId = active?.sessions?.[0];
    if (!sessionId || !dir) return harborUiSetError(t("请先打开当前服务器的终端，再使用 cd"));
    try {
      await api.changeDirectory(sessionId, dir);
      setView("terminal");
    } catch (error) {
      harborUiSetError(t(`cd 失败：${error?.message ?? String(error)}`));
    }
  };

  const tabs = visibleViews.map((entry) => ({
    value: entry.value,
    label: entry.label(),
    icon: entry.icon,
    disabled: entry.needsConnection === true && active === null
  }));

  return (
    <div className="hb hb-shell" data-dsh-harbor-panel="true">
      <div className="hb-toolbar">
        {/* The strip scrolls; the connect button must not: three open servers in
            a narrow sidebar used to push it out of reach. */}
        <div className="hb-strip">
          <div className="hb-servers" role="tablist" aria-label={t("已打开的服务器")}>
            {paneConnections.map((connection) => {
              const isActive = connection.connectionId === resolvedActiveConnectionId;
              const isAgentTarget = connection.connectionId === ui.activeConnectionId;
              const alive = connection.connected !== false && (connection.sessions?.length ?? 0) > 0;
              return (
                <div
                  key={connection.connectionId}
                  className="hb-server"
                  data-active={isActive ? "true" : "false"}
                  role="tab"
                  aria-selected={isActive}
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      selectInView(viewId, connection.connectionId);
                      bindAgent(connection.connectionId);
                    }
                  }}
                  onClick={() => { selectInView(viewId, connection.connectionId); bindAgent(connection.connectionId); }}
                  title={`${connection.username}@${connection.host}:${connection.port}${isAgentTarget ? t("（Agent 正在使用此连接）") : ""}`}
                >
                  <Dot tone={alive ? "ok" : "idle"} />
                  <span className="hb-server__label">{connection.name || connection.host}</span>
                  {isAgentTarget && <Badge tone="accent">{t("Agent")}</Badge>}
                  <button
                    type="button"
                    className="hb-server__close"
                    aria-label={t(`关闭此栏的 ${connection.name || connection.host} 标签`)}
                    title={t("关闭此栏标签（两栏都关闭后断开服务器）")}
                    onClick={(event) => { event.stopPropagation(); void closePaneTab(connection.connectionId); }}
                  >
                    <Icon name="close-outline" size={12} />
                  </button>
                </div>
 );
            })}
            {paneConnections.length === 0 && <span className="hb-quiet hb-nowrap">{t("还没有连接")}</span>}
          </div>
          <IconButton icon="plus-outline" label={t("连接新服务器")} className="hb-server-add" onClick={() => setConnectOpen(true)} />
        </div>

        <div className="hb-views">
          {active !== null && <PolicyMenu api={api} connectionId={active.connectionId} />}
          <TerminalAppearanceButton className="hb-iconbtn" />
        </div>
      </div>

      <div className="hb-tabs" role="tablist" aria-label={t("工作区视图")}>
        {tabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            role="tab"
            className="hb-tab"
            aria-selected={view === tab.value}
            aria-label={tab.label}
            title={tab.label}
            disabled={tab.disabled}
            onClick={() => setView(tab.value)}
          >
            <Icon name={tab.icon} size={14} />
            <span className="hb-tab__label">{tab.label}</span>
          </button>
        ))}
      </div>

      {ui.error !== null && ui.error !== undefined && (
        <div className="hb-banner">
          <ErrorNote action={<IconButton icon="close-outline" label={t("关闭")} size="sm" onClick={() => harborUiSetError(null)} />}>
            {ui.error}
          </ErrorNote>
        </div>
 )}

      {batchTask === null && pendingBatchCount > 0 && (
        <div className="hb-banner">
          <button
            type="button"
            className="hb-notice hb-notice--action"
            onClick={async () => {
              try {
                const { tasks } = await api.batchTaskList();
                if (tasks.length > 0) {
                  seenBatchIdsRef.current.add(tasks[0].batchId);
                  setBatchTask(tasks[0]);
                }
              } catch {}
            }}
          >
            <Icon name="queue-outline" size={14} />
            <span style={{ flex: 1 }}>{t(`${pendingBatchCount} 个批量任务待处理，点击打开`)}</span>
            <Icon name="chevron-right-outline" size={14} />
          </button>
        </div>
 )}

      <div className="hb-body">
        <div className="hb-pane" style={{ display: view === "terminal" ? "flex" : "none" }}>
          <PaneBoundary>
            {paneConnections.length === 0 ? (
              <EmptyState
                icon="terminal"
                title={t("还没有打开终端")}
                text={t("连接一台服务器即可开始。已保存的服务器会复用本机凭据，密码不会写进对话。")}
                action={<Button variant="primary" icon="plus-outline" onClick={() => setConnectOpen(true)}>{t("连接服务器")}</Button>}
              />
 ) : (
              paneConnections.map((connection) => {
                const sessionId = connection.sessions?.[0] ?? null;
                const isActive = connection.connectionId === resolvedActiveConnectionId;
                return (
                  <div
                    key={connection.connectionId}
                    className="hb-pane"
                    style={{ display: isActive ? "flex" : "none" }}
                    onMouseDown={() => bindAgent(connection.connectionId)}
                  >
                    {sessionId !== null ? (
                      <XtermView api={api} sessionId={sessionId} connectionId={connection.connectionId} />
 ) : (
                      <EmptyState
                        icon="terminal"
                        title={t("会话已关闭")}
                        text={t("这台服务器的终端已经结束，可以重新打开。")}
                        action={<Button variant="secondary" busy={ui.busy} onClick={openSession}>{t("打开终端")}</Button>}
                      />
 )}
                  </div>
 );
              })
 )}
          </PaneBoundary>
        </div>

        {active !== null && (
          <>
            <div className="hb-pane" style={{ display: view === "files" ? "flex" : "none" }}>
              <PaneBoundary>
                <HarborFiles
                  api={api}
                  connectionId={active.connectionId}
                  onCd={cdFromFiles}
                  initialPath={ui.projectTarget?.connectionId === active.connectionId ? ui.projectTarget.path : "/"}
                />
              </PaneBoundary>
            </div>
            {features.showTunnels !== false && (
              <div className="hb-pane" style={{ display: view === "tunnels" ? "flex" : "none" }}>
                <PaneBoundary><TunnelsPane api={api} connectionId={active.connectionId} /></PaneBoundary>
              </div>
 )}
          </>
 )}

        {features.showSnippets !== false && (
          <div className="hb-pane" style={{ display: view === "snippets" ? "flex" : "none" }}>
            <PaneBoundary>
              <SnippetsView
                api={api}
                active={active}
                profiles={profiles}
                groups={groups}
                onFilled={() => setView("terminal")}
              />
            </PaneBoundary>
          </div>
 )}

        {features.showLogs !== false && (
          <div className="hb-pane" style={{ display: view === "logs" ? "flex" : "none" }}>
            <PaneBoundary><LogsPane api={api} /></PaneBoundary>
          </div>
 )}
      </div>

      <ConnectDialog
        api={api}
        credentials={credentials}
        open={connectOpen}
        onClose={() => setConnectOpen(false)}
        onConnected={(connectionId) => openInView(viewId, connectionId)}
        onDataChanged={() => { api.profileList().then((value) => setProfiles(value.profiles ?? [])).catch(() => {}); }}
      />

      {batchTask !== null && (
        <BatchDialog api={api} task={batchTask} onClose={() => setBatchTask(null)} />
 )}

      <ToastHost />
      <ConfirmHost />
    </div>
 );
}