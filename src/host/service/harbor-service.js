/**
 * The Harbor service state machine: instance state, domain boot and tool
 * registration. Behaviour lives in the concern mixins composed by index.js.
 */
import { Service } from "@deepseek-ai/cordis";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";
import { KnownHosts } from "../hostkey.js";
import { RemoteWorkspaceStore, remoteWorkspaceDomainSpec } from "../remote-workspace.js";
import { TransferTasks } from "../transfer-tasks.js";
import { setLanguage } from "../../i18n/core.js";
import { normalizeOwner, resolveTerminalOwner } from "../terminal-owner.js";
import { registerSshSessionTools } from "../tools/ssh-session.js";
import { registerSftpTools } from "../tools/sftp.js";
import { registerTunnelTools } from "../tools/tunnel.js";
import { registerBatchTools } from "../tools/batch.js";
import { registerSessionLogTools } from "../tools/session-log.js";
import { registerStatusTools } from "../tools/status.js";
import { profileDomainSpec, credentialDomainSpec, knownHostDomainSpec, settingsDomainSpec, loadSettingsRecord, normalizeFeatureSettings, SETTINGS_ROW_ID } from "./models.js";

/** Shared instance state and the durable-domain boot sequence. */
export class HarborServiceBase extends TypertRemoteService {
  static inject = ["tools", "storageDomain", "credentials"];

  /** connectionId -> live connection record */
  connections = new Map();
  /** sessionId -> live PTY shell session record */
  sessions = new Map();
  /** sessionId -> tombstoned exit records for late reads */
  exitedSessions = new Map();
  /**
   * callId -> operator approval voucher for one agent-originated dangerous
   * command. The tools/pre-execute gate asks through the host's approval
   * channel and records the grant here; the tool body consumes it exactly
   * once (and only for the same connection/command) to proceed past the
   * inner safety gate. TTL-bounded so an aborted execution cannot leak a
   * live grant. This replaced the 0.3.x confirmation-card queue: the ask
   * suspends the tool call itself, so nothing waits in a panel-side queue
   * anymore.
   */
  operatorApprovals = new Map();
  /** batchId -> operator-selected batch exec task awaiting selection/execution. */
  batchTasks = new Map();
  transferTasks = new TransferTasks({ journalPath: joinPath(homedir(), ".dsh", "harbor-transfer-journal.json") });

  /**
   * The connection the agent's connection-less tool calls target, per DSH
   * conversation. Every chat keeps its own pointer: two chats on the same
   * server used to fight over one process-global value, so the second click
   * silently retargeted the first chat's agent.
   *
   * DSH session id -> connectionId. A session with no entry falls back to
   * `activeConnectionId` and then to the single-connection case.
   */
  activeConnectionByOwner = new Map();
  /**
   * Compatibility pointer for callers that carry no session id: an older
   * panel build, a settings-page action, or a host that predates the SessionId
   * plumbing. Also keeps the pre-0.3.0 "last click wins" behaviour for them.
   */
  activeConnectionId = null;
  /**
   * How a subagent's terminal is attributed. "conversation" (default) walks
   * `header.parentSession` up to the top-level chat, so a delegated agent types
   * into the conversation's own visible terminal. "agent" gives every subagent
   * its own private PTY — maximum isolation, invisible in the panel.
   */
  terminalScope = "conversation";
  /**
   * Agent auto-connect switch: when true the agent may connect
   * saved SSH resources itself (ssh_connect_profile, and ssh_list shows the
   * saved resources). Persisted in harbor_settings; default OFF.
   */
  agentAutoConnect = false;
  /**
   * Global default execution policy ("standard" | "custom" | "allowAll") and
   * the custom tier's released deny-list category keys. Persisted in
   * harbor_settings; the default keeps the historical behavior where every
   * destructive pattern is held for the operator. Resource records may
   * override the tier per server; a session switch (execPolicySet) overrides
   * both in memory for one connection and never persists.
   */
  execPolicy = "standard";
  execPolicyAllow = [];
  execPolicyExact = [];
  /**
   * Last username the operator saved a server with; the panel prefills its
   * new-server form with it. Persisted
   * in harbor_settings on every profileSave; null falls back to "root".
   */
  defaultUsername = null;
  /**
   * Interface language last resolved from DSH's own Settings → Language by
   * the browser half ("zh" | "en"), or null before the first write-back.
   * There is no manual language switch: the plugin always follows the host,
   * and this stored value lets the host half (agent-visible messages) speak
   * the same language from the first message built after boot.
   */
  language = null;
  /**
   * Whether the plugin follows DSH's own Settings → Language ("true", the
   * default) or is pinned to the stored `language` value ("false", operator
   * edit of harbor_settings.json). When false the host language is neither
   * followed nor written back by the browser half.
   */
  autoApplySystemLanguage = true;
  profileTable = null;
  groupTable = null;
  credentialTable = null;
  /** known_hosts table (host:port → fingerprint record); null until [Service.init]. */
  knownHostTable = null;
  /** KnownHosts adapter over `knownHostTable`; null until [Service.init]. */
  knownHosts = null;
  /** Operator settings table; null until [Service.init]. */
  settingsTable = null;
  /** Remote-workspace bindings table and its adapter; null until [Service.init]. */
  remoteWorkspaceTable = null;
  remoteWorkspaces = null;

  async [Service.init]() {
    const domain = await this.ctx.storageDomain.open(profileDomainSpec);
    this.profileTable = domain.table("profiles");
    this.groupTable = domain.table("groups");
    this.ctx.effect(() => () => domain.close(), "harbor: profile domain close");
    const credentialDomain = await this.ctx.storageDomain.open(credentialDomainSpec);
    this.credentialTable = credentialDomain.table("credentials");
    this.ctx.effect(() => () => credentialDomain.close(), "harbor: credential domain close");
    const knownHostDomain = await this.ctx.storageDomain.open(knownHostDomainSpec);
    this.knownHostTable = knownHostDomain.table("known_hosts");
    this.knownHosts = new KnownHosts(this.knownHostTable);
    this.ctx.effect(() => () => knownHostDomain.close(), "harbor: known-host domain close");
    const settingsDomain = await this.ctx.storageDomain.open(settingsDomainSpec);
    this.settingsTable = settingsDomain.table("settings");
    this.ctx.effect(() => () => settingsDomain.close(), "harbor: settings domain close");
    // Load the persisted operator switch; a missing row (first boot) keeps the
    // safe default off, and a read failure must not block service startup.
    try {
      const settingsRecord = this.settingsTable.get(SETTINGS_ROW_ID) ?? {};
      const loaded = loadSettingsRecord(settingsRecord);
      this.agentAutoConnect = loaded.agentAutoConnect;
      this.featureSettings = normalizeFeatureSettings(settingsRecord.features);
      this.execPolicy = loaded.execPolicy;
      this.execPolicyAllow = loaded.execPolicyAllow;
      this.execPolicyExact = loaded.execPolicyExact;
      this.defaultUsername = loaded.defaultUsername;
      // An explicit choice drives the host half from the first message it
      // builds. With no choice stored, the host keeps its default (zh) and
      // the browser half adopts DSH's language and writes it back.
      this.language = loaded.language;
      // "false" pins the stored language: the browser half must never follow
      // (or write back) the host language. Absent defaults to true so first
      // installs keep the auto-follow behaviour.
      this.autoApplySystemLanguage = loaded.autoApplySystemLanguage;
      // Materialize the default: the flag is an operator-editable field of
      // harbor_settings.json, so a record that predates it must gain the
      // explicit "true" on first load after the upgrade — otherwise the
      // settings file would never show the knob the operator can flip.
      if (settingsRecord.autoApplySystemLanguage === undefined) {
        await this.settingsTable.put(SETTINGS_ROW_ID, {
 ...settingsRecord,
          autoApplySystemLanguage: true,
          updatedAt: new Date().toISOString()
        });
      }
      // The browser half refreshes this from the live host on every load;
      // until then it is the best-known host language.
      if (this.language !== null) setLanguage(this.language);
    } catch {}
    const workspaceDomain = await this.ctx.storageDomain.open(remoteWorkspaceDomainSpec);
    this.remoteWorkspaceTable = workspaceDomain.table("workspaces");
    this.remoteWorkspaces = new RemoteWorkspaceStore(this.remoteWorkspaceTable);
    this.ctx.effect(() => () => workspaceDomain.close(), "harbor: remote workspace domain close");
    this.registerTools(this.ctx);
    // The model must know which of its tools reach which filesystem. Announced
    // only for a bound workspace, so an ordinary local workspace keeps the
    // system prompt it always had.
    // SSH terminals are registry sessions served by the official terminal
    // tools; the model has to know the type name and the shared-terminal
    // rules, because the host's own pty guidance describes local shells.
    this.ctx.inject(["systemPrompt"], (promptCtx) => {
      promptCtx.effect(() => promptCtx.systemPrompt.context({
        name: "harbor:ssh-terminals",
        order: promptCtx.systemPrompt.getContextOrder("WORKING_DIRECTORY") + 2,
        required: false,
        interpolate: false,
        text: (context) => {
          try {
            return this.sshTerminalPromptText(context?.agent?.session);
          } catch {
            return "";
          }
        }
      }), "harbor: ssh terminal prompt");
    });
    this.ctx.inject(["systemPrompt"], (promptCtx) => {
      promptCtx.effect(() => promptCtx.systemPrompt.context({
        name: "harbor:remote-workspace",
        order: promptCtx.systemPrompt.getContextOrder("WORKING_DIRECTORY") + 1,
        required: false,
        interpolate: false,
        text: (context) => {
          try {
            return this.remoteWorkspacePromptFor(context?.agent?.session);
          } catch {
            return "";
          }
        }
      }), "harbor: remote workspace prompt");
    });
  }

  /**
   * Resolve the terminal owner for one caller. Tools pass their `exec.agent`;
   * the service turns it into the conversation that should own the terminal.
   * @param {object|undefined} agent - the agent on whose behalf the call runs.
   * @returns {string|null} owner session id, or null for the anonymous path.
   */
  terminalOwner(agent) {
    const session = agent?.session;
    const sessionId = typeof agent?.id === "string" ? agent.id : session?.header?.id;
    return resolveTerminalOwner({
      sessionId,
      session,
      scope: this.terminalScope,
      getAgent: (id) => {
        try {
          return this.ctx.get("agents")?.get?.(id);
        } catch {
          return undefined;
        }
      }
    });
  }

  /**
   * Point one caller at a connection. A call without a session id keeps the
   * compatibility pointer; a call with one binds only that conversation.
   * @param {string|null} connectionId - the connection, or null to clear.
   * @param {unknown} ownerSessionId - the calling conversation.
   */
  bindActiveConnection(connectionId, ownerSessionId) {
    const owner = normalizeOwner(ownerSessionId);
    if (owner === null) {
      this.activeConnectionId = connectionId ?? null;
      return;
    }
    // Prototype-stub service instances (tests) never ran the class field
    // initializer, so the map is created on first use.
    this.activeConnectionByOwner ??= new Map();
    if (connectionId === null || connectionId === undefined) this.activeConnectionByOwner.delete(owner);
    else this.activeConnectionByOwner.set(owner, connectionId);
  }

  /**
   * The connection one conversation's agent tools target, when it is still
   * usable. A binding that points at a closed or dead transport is dropped so
   * the caller can fall through to the other resolution steps.
   * @param {unknown} ownerSessionId - the calling conversation.
   * @returns {string|null} connection id, or null.
   */
  activeConnectionFor(ownerSessionId) {
    const owner = normalizeOwner(ownerSessionId);
    const byOwner = this.activeConnectionByOwner;
    if (owner !== null && byOwner instanceof Map) {
      const bound = byOwner.get(owner);
      if (bound !== undefined) {
        const connection = this.connections.get(bound);
        if (connection !== undefined && !connection.dead && !connection.closing) return bound;
        byOwner.delete(owner);
      }
    }
    return this.activeConnectionId;
  }

  /** Drop every selection that points at a connection that is going away. */
  forgetActiveConnection(connectionId) {
    if (this.activeConnectionId === connectionId) this.activeConnectionId = null;
    if (!(this.activeConnectionByOwner instanceof Map)) return;
    for (const [owner, bound] of [...this.activeConnectionByOwner]) {
      if (bound === connectionId) this.activeConnectionByOwner.delete(owner);
    }
  }

  /**
   * Guidance for the host's persistent-terminal tools on SSH targets, plus the
   * live connection list to open one on. Empty while the official terminal
   * registry does not serve Harbor (the Persistent terminals plugin is off),
   * so a composition without it keeps a clean prompt.
   * @param {object|undefined} session - the calling agent's Session.
   * @returns {string} prompt context, or an empty string.
   */
  sshTerminalPromptText(session) {
    if (typeof this.sshTerminalBackendActive !== "function" || !this.sshTerminalBackendActive()) return "";
    const lines = [
      "SSH terminals use the host's persistent-terminal tools. ssh_connect and ssh_connect_profile already open THIS conversation's terminal on the new connection and show it in Harbor's side panel; use terminal_list to find its session id, then terminal_send and terminal_read to work in it, terminal_signal to interrupt a foreground command, and terminal_close to remove it. Call terminal_open with type \"harbor-ssh\" only when you deliberately need another shell (for example after the person took over the existing terminal); cwd is ignored because the shell starts in its login directory. ssh_exec opens that terminal automatically when it is missing and mirrors its command and output into it. The person sees the same shell in the panel; after their first keystroke you can only read it. Never type passwords or one-time codes into a terminal; ask the person to type them."
    ];
    const live = [...(this.connections ?? new Map()).values()].filter((connection) => !connection.dead && !connection.closing);
    const owner = normalizeOwner(this.terminalOwner?.({ session }) ?? null);
    const active = owner === null ? null : this.activeConnectionFor?.(owner);
    if (live.length === 0) {
      lines.push("No SSH connection is open yet; connect a saved resource with ssh_connect_profile (or ssh_connect) first.");
    } else {
      lines.push("Open SSH connections: " + live.map((connection) => {
        const name = connection.name ?? connection.host;
        return `${connection.id === active ? "* " : ""}${name} (${connection.username}@${connection.host}:${connection.port}, id: ${connection.id})`;
      }).join("; ") + ".");
    }
    return lines.join("\n");
  }

  registerTools(ctx) {
    // Tool bodies live in src/tools/*; each register function binds this
    // service instance via closure (defineTool invokes execute as a bare
    // function, so the tools reach service methods through this argument).
    registerSshSessionTools(ctx, this);
    registerSftpTools(ctx, this);
    const groups = this.configuredToolGroups();
    if (groups.tunnelTools) registerTunnelTools(ctx, this);
    registerBatchTools(ctx, this);
    if (groups.logTools) registerSessionLogTools(ctx, this);
    if (groups.statusTools) registerStatusTools(ctx, this);
    this.registeredToolGroups = groups;
  }
}
