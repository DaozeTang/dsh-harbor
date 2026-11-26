/**
 * Browser half of the plugin.
 *
 * Two registrations, both first-class in DeepSeek Harness:
 *
 * - a **right-sidebar tab** (a tab type in `ctx.sidebarRightTabs` plus its body
 *   in the keyed `sidebar.right.pane.tab` seat). The Sidebar owns width, split,
 *   fullscreen and collapse; the workbench fills whatever box it is given.
 * - a **settings section** beside General and Models, because a server
 *   inventory is product surface, not plugin implementation detail.
 *
 * Plus the small affordances that make them reachable: a session-header action
 * that opens or focuses the tab, and the settings nav icon.
 *
 * Everything is registered through one disposer list and unwound in reverse:
 * the host retries a failed plugin by calling apply() again *without* a
 * teardown in between, so anything left behind by a mid-apply throw turns every
 * retry into a misleading duplicate-registration error that buries the cause.
 */
import * as React from "react";
import { createHarborApi } from "./api.js";
import { HarborSidebarBody } from "./HarborSidebarBody.jsx";
import { HarborResources } from "./HarborResources.jsx";
import { HarborHeaderAction } from "./HarborHeaderAction.jsx";
import { AgentRevealWatcher } from "./AgentRevealWatcher.jsx";
import { harborUiSetSurfaceOpener } from "./store.js";
import { activateSidebarWhenAvailable } from "./sidebar-lifecycle.js";
import { readHostLanguage, setLanguage } from "./locale.js";
import { registerSettingsNavIcon } from "./settings-nav-icon.js";
import { installStyles } from "./ui/styles.js";
import { Icon } from "./ui/kit.jsx";
import TYPERT_REMOTE from "../rpc/remote.js";

/** Namespace for host-provided locale entries owned by this plugin. */
const NS = "harbor";

/** The tab kind this plugin owns in the official Sidebar, and its registry id. */
export const HARBOR_TAB_KIND = "harbor";
export const HARBOR_TAB_ID = "dsh-harbor";

export const inject = ["remote", "remote.credentials", "slots", "locale", "connection"];

export async function apply(ctx) {
  const disposers = [];
  const own = (dispose) => {
    if (typeof dispose === "function") disposers.push(dispose);
    return dispose;
  };
  const unwind = async () => {
    let failure = null;
    for (const dispose of disposers.reverse()) {
      try {
        await dispose();
      } catch (error) {
        failure ??= error;
      }
    }
    disposers.length = 0;
    if (failure) throw failure;
  };

  try {
    // The sheet is installed before anything paints so the first frame of the
    // sidebar body is already styled (no flash of unstyled controls).
    installStyles();

    own(await ctx.remote.$mount(TYPERT_REMOTE));

    const api = createHarborApi(ctx);

    // Agent reveals are watched per conversation, inside the session header
    // (see applySidebarRegistrations). A plugin-root poll has no session id,
    // so it could only target whichever conversation happened to be on screen.

    own(ctx.locale.register(NS, {
      zh: {
        settingsSectionLabel: "Harbor", // i18n-ignore: host locale entry
        sidebarTabTitle: "Harbor", // i18n-ignore: host locale entry
        openSidebarTab: "打开或聚焦 Harbor 标签", // i18n-ignore: host locale entry
        guideTitle: "Harbor", // i18n-ignore: host locale entry
        guideDescription: "连接服务器：看状态，用终端、远程文件、端口转发与快捷命令" // i18n-ignore: host locale entry
      },
      en: {
        settingsSectionLabel: "Harbor",
        sidebarTabTitle: "Harbor",
        openSidebarTab: "Open or focus the Harbor tab",
        guideTitle: "Harbor",
        guideDescription: "Connect to servers: live status, a terminal, remote files, tunnels, and snippets"
      }
    }));

    const hostT = ctx.locale.bind(NS);

    own(syncLanguageWithHost(api, ctx));

    own(activateSidebarWhenAvailable(ctx, {
      registerSidebar: (sidebarCtx) => applySidebarRegistrations(sidebarCtx, { api, hostT }),
      onSidebarError: (error) => {
        console.error("[dsh-harbor] sidebar tab registration failed; no terminal surface available:", error);
      }
    }));

    // The icon slot is optional; without it the section simply shows no glyph,
    // which is a better failure than a DOM-injected icon that drifts out of
    // sync with the host's markup.
    own(registerSettingsNavIcon({
      slots: ctx.slots,
      component: SettingsTerminalIcon,
      onError: (error) => console.error("[dsh-harbor] settings nav icon unavailable:", error)
    }));

    // Optional host services are obtained inside their own injection scopes:
    // reading an undeclared face throws on older hosts.
    let pluginManager;
    let pluginNavigation;
    own(ctx.inject(["remote.pluginManager"], (optionalCtx) => {
      pluginManager = optionalCtx.remote.pluginManager;
      return () => { pluginManager = undefined; };
    }));
    own(ctx.inject(["pluginNavigation"], (optionalCtx) => {
      pluginNavigation = optionalCtx.pluginNavigation;
      return () => { pluginNavigation = undefined; };
    }));

    own(ctx.slots.inject("settings.section", () =>
      ctx.slots.register(
        {
          name: "settings.section",
          id: "harbor-resources",
          order: 35,
          label: () => hostT("settingsSectionLabel"), // getter: the host menu re-renders it per language change
          locale: NS,
          inject: () => ({
            api,
            credentials: ctx.remote?.credentials,
            pluginManager,
            openPluginManager: typeof pluginNavigation?.openBundle === "function" ? () => pluginNavigation?.openBundle("dsh-harbor") : undefined
          })
        },
        HarborResources
 )
 ));

    return async () => {
      await unwind();
    };
  } catch (error) {
    try {
      await unwind();
    } catch (cleanupError) {
      console.error("[dsh-harbor] apply failed and its cleanup failed too:", cleanupError);
    }
    throw error;
  }
}

function SettingsTerminalIcon({ size = 16 }) {
  return <Icon name="terminal" size={size} />;
}

/** Official Sidebar registrations: both stages live under one disposable scope. */
function applySidebarRegistrations(ctx, { api, hostT }) {
  const disposers = [];
  const own = (dispose) => {
    if (typeof dispose === "function") disposers.push(dispose);
    return dispose;
  };
  const openTab = () => {
    try {
      ctx.sidebarRight.openTab(HARBOR_TAB_KIND);
    } catch (error) {
      console.warn("[dsh-harbor] openTab failed:", error?.message ?? error);
    }
  };
  /**
   * Open/focus the Harbor tab for ONE conversation. The official sidebar
   * exposes openTabIn(sessionId, kind); older hosts only have the on-screen
   * openTab, which is why this falls back instead of throwing.
   */
  const openTabIn = (sessionId) => {
    try {
      if (typeof sessionId === "string" && typeof ctx.sidebarRight.openTabIn === "function") {
        ctx.sidebarRight.openTabIn(sessionId, HARBOR_TAB_KIND);
      } else {
        ctx.sidebarRight.openTab(HARBOR_TAB_KIND);
      }
    } catch (error) {
      console.warn("[dsh-harbor] openTabIn failed:", error?.message ?? error);
    }
  };
  try {
    // Surfaces that own no pane (the settings page) ask for the terminal
    // through the shared store; cleared on release so a disposed registration
    // cannot keep calling into a host whose Sidebar is gone.
    harborUiSetSurfaceOpener(openTab);
    own(() => harborUiSetSurfaceOpener(null));

    own(ctx.sidebarRightTabs.register({
      id: HARBOR_TAB_ID,
      kind: HARBOR_TAB_KIND,
      priority: "extension",
      title: () => hostT("sidebarTabTitle"),
      guide: [{
        order: 20,
        title: () => hostT("guideTitle"),
        description: () => hostT("guideDescription"),
        icon: SettingsTerminalIcon
      }]
    }));

    own(ctx.slots.inject("sidebar.right.pane.tab", () =>
      ctx.slots.register(
        {
          name: "sidebar.right.pane.tab",
          key: HARBOR_TAB_ID,
          locale: NS,
          // Session-scoped seat: the framework hands the pane its DSH session,
          // which is the key the host uses to give this conversation its own
          // terminal on every server.
          inject: (sessionId) => ({ api, credentials: ctx.remote?.credentials, sessionId })
        },
        HarborSidebarBody
 )
 ));

    own(ctx.slots.inject("conversation.session.header.actions", () =>
      ctx.slots.register(
        {
          name: "conversation.session.header.actions",
          id: "harbor-terminal",
          order: 90,
          locale: NS,
          inject: (sessionId) => ({
            openTab: () => openTabIn(sessionId),
            isActive: () => {
              try {
                if (!ctx.sidebarRight.isExpanded()) return false;
                return ctx.sidebarRight.active()?.kind === HARBOR_TAB_KIND;
              } catch {
                return false;
              }
            },
            label: hostT("sidebarTabTitle"),
            hint: hostT("openSidebarTab")
          })
        },
        HarborHeaderAction
 )
 ));

    // Agent reveals are session-scoped. The header is mounted for the
    // displayed conversation, so a reveal for a background chat waits until
    // that chat is shown instead of hijacking the current one.
    own(ctx.slots.inject("conversation.session.header.actions", () =>
      ctx.slots.register(
        {
          name: "conversation.session.header.actions",
          id: "harbor-agent-reveal",
          order: 91,
          locale: NS,
          inject: (sessionId) => ({
            api,
            sessionId,
            openTab: () => openTabIn(sessionId)
          })
        },
        AgentRevealWatcher
 )
 ));

    return () => {
      for (const dispose of disposers.reverse()) dispose();
    };
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose();
    throw error;
  }
}

/**
 * Resolve the stored language choice and keep follow mode tracking the host.
 * Returns a disposer for the optional live subscription.
 */
function syncLanguageWithHost(api, ctx) {
  let disposed = false;
  let unsubscribe = null;
  const applyFollow = async () => {
    if (disposed) return;
    let stored = null;
    try {
      // Read the stored settings first so a pin is respected even before the
      // host locale is consulted: a third-party locale DSH may add later would
      // otherwise be coerced to the default and written back on every load.
      stored = await api.languageGet();
      if (disposed) return;
    } catch {
      // Older host without the languageGet RPC: treat as auto mode.
    }
    if (stored?.autoApplySystemLanguage === false) {
      if (stored.language !== null) setLanguage(stored.language);
      return;
    }
    const host = readHostLanguage(ctx.locale);
    if (host !== null) {
      setLanguage(host);
      // Write back so the host half (agent-visible messages) speaks the same
      // language immediately and after the next restart.
      api.languageSave(host).catch(() => {});
      return;
    }
    if (stored?.language != null) setLanguage(stored.language);
  };
  void applyFollow();
  try {
    if (typeof ctx.locale?.subscribe === "function") {
      unsubscribe = ctx.locale.subscribe(() => { void applyFollow(); });
    }
  } catch {}
  return () => {
    disposed = true;
    try { unsubscribe?.(); } catch {}
  };
}
