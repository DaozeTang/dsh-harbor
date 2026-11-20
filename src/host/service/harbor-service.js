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
import { registerSshSessionTools } from "../tools/ssh-session.js";
import { registerSftpTools } from "../tools/sftp.js";
import { registerTunnelTools } from "../tools/tunnel.js";
import { registerBatchTools } from "../tools/batch.js";
import { registerSessionLogTools } from "../tools/session-log.js";
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

  /** The connection currently represented by the right-side terminal panel. */
  activeConnectionId = null;
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
    this.registeredToolGroups = groups;
  }
}
