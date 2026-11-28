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
import { Badge, Button, ConfirmHost, Dot, EmptyState, ErrorNote, Icon, IconButton, Tabs, ToastHost } from "./ui/kit.jsx";
import { TerminalAppearanceButton } from "./terminal-display/TerminalAppearanceButton.jsx";
import { XtermView } from "./features/terminal/xterm-view.jsx";
import { ConnectDialog } from "./features/connect/connect-dialog.jsx";
import { BatchDialog } from "./features/batch/batch-dialog.jsx";
import { SnippetsView } from "./features/snippets/snippets-view.jsx";
import { PolicyMenu } from "./features/policy/policy-menu.jsx";
import { HarborFiles } from "./HarborFiles.jsx";
import { TunnelsPane } from "./features/tunnels/tunnels-pane.jsx";
import { LogsPane } from "./features/logs/logs-pane.jsx";
import { MonitorPane } from "./features/monitor/monitor-pane.jsx";
import {
  getHarborUiSnapshot, useHarborUi, harborUiSetActiveConnection, harborUiSetBusy, harborUiSetConnections,
  harborUiSetError, harborUiSetFeatures, harborUiSetProjectTarget, harborUiAnnounceAgentConnections
} from "./store.js";
import {
  DEFAULT_VIEW_ID, adoptIntoView, claimPendingOpens, closeInView, forgetView, openInView,
  paneOpenRequestsRevision, reconcileViews, resolvePaneActiveConnection, selectInView,
  subscribePaneSessions, visiblePaneConnections, viewSession
} from "./pane-selection.js";
import { closeTabAction, resolvePaneTerminal } from "./session-terminals.js";
import { connectionStatusView } from "./connection-status.js";
import { t } from "../i18n/core.js";
import { useLanguage } from "./locale.js";

/**
 * Error boundary so one crashed pane never takes the whole workbench down.
 *
 * The caught error used to live in state nothing cleared: one throwing render
 * and that tab stayed an error card until the operator switched views and back
 * (which remounted the boundary) or reloaded. A retry button and a reset when
 * `resetKey` changes (view + server) make the pane recoverable.
 */
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
  componentDidUpdate(previous) {
    if (this.state.error !== null && previous.resetKey !== this.props.resetKey) this.reset();
  }
  reset() {
    if (this.state.error !== null) this.setState({ error: null });
  }
  render() {
    if (this.state.error === null) return this.props.children;
    return (
      <div className="hb-pad hb-stack">
        <ErrorNote>{t(`此页签出错：${this.state.error?.message ?? String(this.state.error)}`)}</ErrorNote>
        <div>
          <Button variant="secondary" size="sm" icon="refresh-outline" onClick={() => this.reset()}>{t("重试")}</Button>
        </div>
      </div>
 );
  }
}

/**
 * The exact message this poll last put in the shared error slot.
 *
 * The slot is a single string shared with every other failure in the workbench,
 * so a successful poll may only clear the message it wrote itself — clearing
 * unconditionally would wipe a newer, unrelated error on the next tick.
 */
let listErrorShown = null;

/** Mirror the host's connection list and this conversation's agent binding. */
async function refreshConnections(api, sessionId) {
  try {
    const { connections, activeConnectionId } = await api.list(sessionId);
    harborUiSetConnections(connections);
    harborUiSetActiveConnection(activeConnectionId ?? null);
    // The session watcher opens/focuses the tab; the panel only needs the
    // connection queued for its own view. Passing the session keeps another
    // conversation's reveal out of this pane.
    harborUiAnnounceAgentConnections(connections, { sessionId });
    // A poll that failed once used to leave its message up for the rest of the
    // session: the next successful list arrives five seconds later and nothing
    // removed it, so the panel kept claiming it could not refresh while showing
    // fresh data.
    if (listErrorShown !== null) {
      if (getHarborUiSnapshot().error === listErrorShown) harborUiSetError(null);
      listErrorShown = null;
    }
  } catch (error) {
    listErrorShown = t(`无法刷新 SSH 连接列表：${error?.message ?? String(error)}`);
    harborUiSetError(listErrorShown);
  }
}

// Labels are thunks: the literal lives inside t() at its definition site
// (so the i18n extractor sees it) while the actual wording is resolved at
// render time, which is what makes a language switch repaint the strip.
const VIEWS = [
  { value: "terminal", icon: "terminal", label: () => t("终端") },
  { value: "monitor", icon: "gauge-outline", label: () => t("状态"), needsConnection: true, feature: "showMonitor" },
  { value: "files", icon: "folder-open-outline", label: () => t("文件"), needsConnection: true },
  { value: "tunnels", icon: "tunnel", label: () => t("转发"), needsConnection: true, feature: "showTunnels" },
  { value: "snippets", icon: "checklist-outline", label: () => t("快捷命令"), feature: "showSnippets" },
  { value: "logs", icon: "archive-outline", label: () => t("日志"), feature: "showLogs" }
];

export function HarborPanel({ api, credentials, sessionId, viewId = DEFAULT_VIEW_ID, viewSignal, initialView = "terminal" }) {
  useLanguage();
  const ui = useHarborUi();
  // The panel owns its view state; initialView exists for the offline preview
  // harness and for tests, which need to render a specific surface.
  const [view, setView] = useState(initialView);
  const [connectOpen, setConnectOpen] = useState(false);
  const [batchTask, setBatchTask] = useState(null);
  const [pendingBatchCount, setPendingBatchCount] = useState(0);
  const [profiles, setProfiles] = useState([]);
  const [groups, setGroups] = useState([]);
  const seenBatchIdsRef = useRef(new Set());
  const pendingBatchRef = useRef(0);
  const batchPollInFlightRef = useRef(false);
  const adoptedRef = useRef(false);
  // A settings-page connect may hand this pane a starting directory. Consume
  // it once: leaving it in the store would snap the file pane back to that
  // path every time the operator returns to this server.
  const consumedProjectTargetRef = useRef(null);
  // True once this pane has adopted the host's connections at least once. Before
  // that, "no active connection" only means "the first paint has not finished",
  // and a fallback there would stomp the view the panel was mounted with.
  const [paneReady, setPaneReady] = useState(false);

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
    refreshConnections(api, sessionId);
    // A hidden window does not need a connection poll every five seconds; the
    // next visible tick catches up, and the host keeps sessions alive anyway.
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refreshConnections(api, sessionId);
    }, 5000);
    return () => clearInterval(timer);
  }, [api, sessionId]);

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
    // The one-second beat must not stack requests on a slow host: the panel
    // used to ask for the same list again before the previous answer landed.
    if (batchPollInFlightRef.current) return;
    batchPollInFlightRef.current = true;
    try {
      const { tasks } = await api.batchTaskList();
      setPendingBatchCount(tasks.length);
      pendingBatchRef.current = tasks.length;
      // A finished plan never comes back, so its id does not have to be
      // remembered: the set used to grow for the life of the panel.
      for (const id of seenBatchIdsRef.current) {
        if (!tasks.some((task) => task.batchId === id)) seenBatchIdsRef.current.delete(id);
      }
      const unseen = tasks.find((task) => !seenBatchIdsRef.current.has(task.batchId));
      if (unseen !== undefined) {
        seenBatchIdsRef.current.add(unseen.batchId);
        setBatchTask((current) => current ?? unseen);
      }
    } catch {
      // A temporarily unavailable host must not stop later polls.
    } finally {
      batchPollInFlightRef.current = false;
    }
  };

  useEffect(() => {
    let alive = true;
    let timer = null;
    const tick = async () => {
      // An occluded tab does not have to poll the host at all; the next visible
      // tick catches up.
      if (document.visibilityState === "visible") await refreshBatchTasks();
      if (!alive) return;
      // One beat while something is waiting for an answer, because the operator
      // is sitting in front of the dialog; a slower beat when only the arrival
      // of a NEW agent plan has to be noticed. A fixed 1 Hz per pane polled all
      // day for the idle case.
      timer = setTimeout(tick, pendingBatchRef.current > 0 ? 1000 : 4000);
    };
    void tick();
    return () => {
      alive = false;
      if (timer !== null) clearTimeout(timer);
    };
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
    if (!paneReady) return;
    if (active === null && (view === "monitor" || view === "files" || view === "tunnels")) setView("terminal");
  }, [paneReady, active, view]);

  useEffect(() => { reconcileViews(ui.connections); }, [ui.connections]);

  // Host-side sessions outlive a page reload; adopt them once per mount so a
  // refresh never leaves invisible zombies, but a close is never undone.
  useEffect(() => {
    if (adoptedRef.current || ui.connections.length === 0) return;
    adoptedRef.current = true;
    adoptIntoView(viewId, ui.connections);
    setPaneReady(true);
  }, [ui.connections, viewId]);

  // A surface that owns no pane (the settings page) queues what it connected;
  // the first pane to render claims it.
  const pendingOpenRevision = useSyncExternalStore(subscribePaneSessions, paneOpenRequestsRevision);
  // A project-directory request from the settings page is consumed by the
  // first mount of the file pane it belongs to. Clear it after that mount so
  // returning to the server later does not override the operator's own cwd.
  useEffect(() => {
    const target = ui.projectTarget;
    if (target === null || target === undefined) return undefined;
    if (target.connectionId !== resolvedActiveConnectionId) return undefined;
    const signature = target.connectionId + "\u0000" + target.path;
    if (consumedProjectTargetRef.current === signature) return undefined;
    consumedProjectTargetRef.current = signature;
    // Let HarborFiles mount (and load) with the target path first.
    const timer = setTimeout(() => harborUiSetProjectTarget(null), 0);
    return () => clearTimeout(timer);
  }, [ui.projectTarget, resolvedActiveConnectionId]);

  useEffect(() => {
    const claims = claimPendingOpens(sessionId);
    for (const claim of claims) {
      openInView(viewId, claim.connectionId);
      // A surface that owns no pane (the settings page) queued a connect whose
      // terminal is unclaimed: adopt it for this conversation so the pane shows
      // a shell instead of "no terminal".
      if (claim.adopt && typeof sessionId === "string") {
        void api.openSession(claim.connectionId, 100, 30, { sessionId, adopt: true, openedBy: "panel" })
          .then(() => refreshConnections(api, sessionId))
          .catch(() => {});
      }
    }
    // The settings page no longer writes its session-less list into the shared
    // store, so refresh here to make the claimed tab visible immediately
    // instead of waiting for the next five-second poll.
    if (claims.length > 0) void refreshConnections(api, sessionId);
  }, [pendingOpenRevision, viewId, sessionId, api]);

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
    api.selectConnection(connectionId, sessionId)
 .then(() => refreshConnections(api, sessionId))
 .catch((error) => {
        const message = error?.message ?? String(error);
        harborUiSetError(/404|not mounted|not-mounted/i.test(message)
          ? t("切换 Agent 目标失败：宿主端仍是旧版本（没有 selectConnection 接口），重启 dsh web / DSH.app 后即可生效")
 : t(`切换 Agent 目标失败：${message}`));
      });
  };

  const openTerminal = async () => {
    if (active === null) return;
    harborUiSetBusy(true);
    harborUiSetError(null);
    try {
      // Ownership makes this idempotent: the host returns this conversation's
      // live terminal when there is one, so a double click cannot open two.
      await api.openSession(active.connectionId, 100, 30, { sessionId, openedBy: "panel" });
      await refreshConnections(api, sessionId);
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
    // Re-read first: the cached list is up to five seconds old, and using it
    // to decide "no other conversation has a terminal" could disconnect a
    // transport another chat started using in that window. The read still is
    // not atomic with the disconnect, but it shrinks the race to one round
    // trip instead of a whole poll interval.
    let connection = ui.connections.find((entry) => entry.connectionId === connectionId);
    try {
      const latest = await api.list(sessionId);
      connection = latest?.connections?.find((entry) => entry.connectionId === connectionId) ?? connection;
    } catch {
      // Fall back to the cached snapshot; closing must still work offline.
    }
    // Ending this tab ends THIS conversation's terminal. The transport is
    // disconnected only when no other conversation still has a terminal on it:
    // closing your tab must never kill another chat's shell.
    const action = closeTabAction(connection, sessionId);
    const terminalId = resolvePaneTerminal(connection, sessionId).sessionId;
    if (!closeInView(viewId, connectionId)) return;
    try {
      if (action === "disconnect") await api.disconnect(connectionId);
      else if (action === "close-terminal" && terminalId !== null) await api.closeSession(terminalId);
      await refreshConnections(api, sessionId);
    } catch (error) {
      openInView(viewId, connectionId);
      harborUiSetError(t(`断开服务器失败：${error?.message ?? String(error)}`));
    }
  };

  const cdFromFiles = async (dir) => {
    const terminalId = resolvePaneTerminal(active, sessionId).sessionId;
    if (!terminalId || !dir) return harborUiSetError(t("请先打开当前服务器的终端，再使用 cd"));
    try {
      await api.changeDirectory(terminalId, dir);
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

  // A crashed pane is retried when the operator moves to another view or
  // server: the error belongs to the surface that threw, not to the session.
  const boundaryKey = `${view}:${resolvedActiveConnectionId ?? ""}`;

  /**
   * Arrow keys walk the open-server tabs (Left/Right/Home/End). The strip had
   * no keyboard model: every tab sat in the tab order and nothing moved
   * between them, so reaching the fourth server took four Tab presses.
   */
  const onServerStripKeyDown = (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const ids = paneConnections.map((connection) => connection.connectionId);
    if (ids.length === 0) return;
    const current = ids.indexOf(resolvedActiveConnectionId);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? ids.length - 1
      : current < 0 ? 0
      : (current + (event.key === "ArrowRight" ? 1 : -1) + ids.length) % ids.length;
    event.preventDefault();
    const id = ids[next];
    selectInView(viewId, id);
    bindAgent(id);
    event.currentTarget.querySelectorAll("[role=\"tab\"]")[next]?.focus?.();
  };

  return (
    <div className="hb hb-shell" data-dsh-harbor-panel="true">
      <div className="hb-toolbar">
        {/* The strip scrolls; the connect button must not: three open servers in
            a narrow sidebar used to push it out of reach. */}
        <div className="hb-strip">
          <div className="hb-servers" role="tablist" aria-label={t("已打开的服务器")} onKeyDown={onServerStripKeyDown}>
            {paneConnections.map((connection) => {
              const isActive = connection.connectionId === resolvedActiveConnectionId;
              const isAgentTarget = connection.connectionId === ui.activeConnectionId;
              // Transport, terminal and agent activity are independent. The
              // dot used to mean "this conversation's terminal is alive", so
              // an agent using ssh_exec on a healthy connection looked idle.
              const status = connectionStatusView(connection, sessionId);
              const statusText = !status.connected
                ? t("连接已断开")
                : status.agentActive
                  ? t("Agent 正在操作 · 已连接")
                  : status.hasTerminal
                    ? t("已连接 · 本对话终端运行中")
                    : t("已连接 · 本对话暂无终端");
              return (
                <div
                  key={connection.connectionId}
                  className="hb-server"
                  data-active={isActive ? "true" : "false"}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    // Roving tab order: one stop for the strip, arrows move between
                    // servers.
                    tabIndex={isActive ? 0 : -1}
                    className="hb-server__tab"
                    onClick={() => { selectInView(viewId, connection.connectionId); bindAgent(connection.connectionId); }}
                    title={`${connection.username}@${connection.host}:${connection.port} · ${statusText}${isAgentTarget ? t("（Agent 的作用目标）") : ""}`}
                  >
                    <Dot
                      tone={!status.connected ? "err" : status.agentActive ? "busy" : "ok"}
                      title={statusText}
                    />
                    <span className="hb-server__label">{connection.name || connection.host}</span>
                    <span
                      className="hb-server__terminal"
                      data-on={status.hasTerminal ? "true" : "false"}
                      title={status.hasTerminal ? t("本对话的终端运行中") : t("本对话暂无终端")}
                      aria-hidden="true"
                    >
                      <Icon name="terminal" size={11} />
                    </span>
                    {isAgentTarget && (
                      <Badge
                        tone="accent"
                        title={status.agentActive ? t("Agent 正在操作此连接") : t("Agent 正在使用此连接")}
                      >
                        {t("Agent")}
                      </Badge>
                    )}
                  </button>
                  <button
                    type="button"
                    className="hb-server__close"
                    aria-label={t(`关闭此栏的 ${connection.name || connection.host} 标签`)}
                    title={t("关闭此栏标签（只结束本对话的终端；没有别的对话在用这台服务器时才断开）")}
                    onClick={() => { void closePaneTab(connection.connectionId); }}
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
          {active !== null && <PolicyMenu api={api} connectionId={active.connectionId} sessionId={sessionId} />}
          <TerminalAppearanceButton className="hb-iconbtn" />
        </div>
      </div>

      <Tabs ariaLabel={t("工作区视图")} value={view} onChange={setView} items={tabs} />

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
          <PaneBoundary resetKey={boundaryKey}>
            {paneConnections.length === 0 ? (
              <EmptyState
                icon="terminal"
                title={t("还没有打开终端")}
                text={t("连接一台服务器即可开始。已保存的服务器会复用本机凭据，密码不会写进对话。")}
                action={<Button variant="primary" icon="plus-outline" onClick={() => setConnectOpen(true)}>{t("连接服务器")}</Button>}
              />
 ) : (
              paneConnections.map((connection) => {
                const terminal = resolvePaneTerminal(connection, sessionId);
                const isActive = connection.connectionId === resolvedActiveConnectionId;
                return (
                  <div
                    key={connection.connectionId}
                    className="hb-pane"
                    style={{ display: isActive ? "flex" : "none" }}
                    onMouseDown={() => bindAgent(connection.connectionId)}
                  >
                    {terminal.sessionId !== null ? (
                      <XtermView api={api} sessionId={terminal.sessionId} connectionId={connection.connectionId} />
 ) : (
                      <EmptyState
                        icon="terminal"
                        title={terminal.total > 0 ? t("本会话还没有终端") : t("会话已关闭")}
                        text={terminal.total > 0
                          ? t(`这台服务器上还有 ${terminal.total} 个终端正被其他会话使用；每个对话只看自己的终端，打开一个即可开始。`)
                          : t("这台服务器的终端已经结束，可以重新打开。")}
                        action={<Button variant="secondary" busy={ui.busy} onClick={openTerminal}>{t("打开终端")}</Button>}
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
            <div className="hb-pane" style={{ display: view === "monitor" ? "flex" : "none" }}>
              <PaneBoundary resetKey={boundaryKey}>
                <MonitorPane
                  api={api}
                  connection={active}
                  sessionId={sessionId}
                  active={view === "monitor"}
                  onOpenTerminal={() => setView("terminal")}
                />
              </PaneBoundary>
            </div>
            <div className="hb-pane" style={{ display: view === "files" ? "flex" : "none" }}>
              <PaneBoundary resetKey={boundaryKey}>
                {/* The pane owns per-server state (listing, cwd, selection,
                    editor). Keying it by the connection makes a switch a
                    remount: a response from server A can never land in the
                    pane that now shows server B, and a row action can never
                    combine B's connection with A's path. */}
                <HarborFiles
                  key={active.connectionId}
                  api={api}
                  connection={active}
                  connectionId={active.connectionId}
                  active={view === "files"}
                  onCd={cdFromFiles}
                  initialPath={ui.projectTarget?.connectionId === active.connectionId ? ui.projectTarget.path : "/"}
                />
              </PaneBoundary>
            </div>
            {features.showTunnels !== false && (
              <div className="hb-pane" style={{ display: view === "tunnels" ? "flex" : "none" }}>
                <PaneBoundary resetKey={boundaryKey}><TunnelsPane api={api} connectionId={active.connectionId} active={view === "tunnels"} /></PaneBoundary>
              </div>
 )}
          </>
 )}

        {features.showSnippets !== false && (
          <div className="hb-pane" style={{ display: view === "snippets" ? "flex" : "none" }}>
            <PaneBoundary resetKey={boundaryKey}>
              <SnippetsView
                api={api}
                active={active}
                sessionId={sessionId}
                profiles={profiles}
                groups={groups}
                onFilled={() => setView("terminal")}
                shown={view === "snippets"}
              />
            </PaneBoundary>
          </div>
 )}

        {features.showLogs !== false && (
          <div className="hb-pane" style={{ display: view === "logs" ? "flex" : "none" }}>
            <PaneBoundary resetKey={boundaryKey}><LogsPane api={api} /></PaneBoundary>
          </div>
 )}
      </div>

      <ConnectDialog
        api={api}
        credentials={credentials}
        sessionId={sessionId}
        open={connectOpen}
        onClose={() => setConnectOpen(false)}
        onConnected={(connectionId) => {
          openInView(viewId, connectionId);
          // The dialog just opened a PTY, but this pane renders from the
          // mirrored connection list, which the five-second poll had not
          // refreshed yet: the pane showed "no terminal" right after a
          // successful connect. The claim path above does the same.
          void refreshConnections(api, sessionId);
        }}
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