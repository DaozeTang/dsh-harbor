/**
 * Operator settings: agent switches, execution policy, interface language.
 */
import { fail } from "../../rpc/envelope.js";
import { setLanguage, t } from "../../i18n/core.js";
import { normalizeAllowList, normalizeExactRules, normalizePolicy, ALL_CATEGORY_KEYS, CATEGORY_LABELS, EXEC_POLICY_MODES } from "../policy/safety.js";
import { SETTINGS_ROW_ID, loadSettingsRecord, normalizeDefaultUsername, normalizeFeatureSettings } from "./models.js";
import { normalizeOwner, ownerKey } from "../terminal/owner.js";
import { composeExecPolicy, dshPolicyRefusal, readDshPermission } from "../policy/dsh-permission.js";

export const withSettings = (Base) => class extends Base {
  // ── agent auto-connect + operator-level switches ───────────────

  async patchSettingsRecord(patch) {
    const table = this.settingsTable;
    const previous = table.get(SETTINGS_ROW_ID);
    // Boot normally materializes the row. Use the atomic update API to keep
    // writes from different settings surfaces from clobbering each other.
    if (previous !== undefined && typeof table.update === "function") {
      return table.update(SETTINGS_ROW_ID, patch);
    }
    const next = patch(previous ?? {});
    await table.put(SETTINGS_ROW_ID, next);
    return next;
  }

  async agentSettingsGet() {
    const policy = this.globalExecPolicy();
    const toolGroups = this.configuredToolGroups();
    const registered = this.registeredToolGroups ?? toolGroups;
    return {
      ok: true,
      value: {
        agentAutoConnect: this.agentAutoConnect,
        features: {
 ...toolGroups,
          showTunnels: this.featureSettings?.showTunnels !== false,
          showSnippets: this.featureSettings?.showSnippets !== false,
          showLogs: this.featureSettings?.showLogs !== false,
          showMonitor: this.featureSettings?.showMonitor !== false
        },
        toolRestartRequired: Object.keys(toolGroups).some((key) => registered[key] !== toolGroups[key]),
        execPolicy: policy.mode,
        // The STORED checklist, not the tier-normalized one: the panel loads
        // its checkboxes from here, and a tier of standard/allowAll must not
        // hand it an empty list that it would then save back over.
        execPolicyAllow: normalizeAllowList(this.execPolicyAllow),
        execPolicyExact: normalizeExactRules(this.execPolicyExact),
        // Username the panel prefills into its new-server form (null = "root").
        defaultUsername: this.defaultUsername ?? null,
        // The category checklist the custom tier releases from, with its
        // display labels (i18n identifiers; the panel translates them).
        categories: ALL_CATEGORY_KEYS.map((key) => ({ key, label: CATEGORY_LABELS[key] }))
      }
    };
  }

  async agentSettingsSave(request) {
    const agentAutoConnect = request.agentAutoConnect ?? (this.agentAutoConnect === true);
    // Policy fields are optional so a panel built before this feature still
    // saves the auto-connect switch without touching the policy.
    //
    // The tier and the released-category checklist persist INDEPENDENTLY: the
    // decision path ignores the checklist outside the custom tier anyway, so
    // keeping it means an operator who ticks categories, flips to another tier
    // and flips back finds the ticks where they left them instead of silently
    // overwriting the stored list with an empty one.
    const mode = normalizePolicy({ mode: request.execPolicy ?? this.execPolicy }).mode;
    const allow = normalizeAllowList(request.execPolicyAllow ?? this.execPolicyAllow);
    const exact = normalizeExactRules(request.execPolicyExact ?? this.execPolicyExact);
    if (request.execPolicyExact?.some((rule) => !exact.includes(rule.trim()))) {
      return { ok: false, error: fail("invalid-exact-rule", t("精确放行规则只接受单条字面命令，不能包含引号、管道、重定向或变量。")) };
    }
    // Optional like the policy fields: absent keeps whatever is stored. The
    // panel normally never sends this — profileSave is what moves it — but the
    // explicit path stays honest (null clears back to the root fallback).
    const defaultUsername = request.defaultUsername === undefined
      ? (this.defaultUsername ?? null)
 : normalizeDefaultUsername(request.defaultUsername);
    let saved;
    try {
      saved = await this.patchSettingsRecord((previous) => ({
 ...previous,
 ...(request.features
          ? { features: normalizeFeatureSettings({ ...previous.features, ...request.features }) ?? {} }
          : {}),
        agentAutoConnect: request.agentAutoConnect ?? previous.agentAutoConnect ?? agentAutoConnect,
        execPolicy: request.execPolicy === undefined ? (previous.execPolicy ?? mode) : mode,
        execPolicyAllow: request.execPolicyAllow === undefined ? (previous.execPolicyAllow ?? allow) : allow,
        execPolicyExact: request.execPolicyExact === undefined ? (previous.execPolicyExact ?? exact) : exact,
        defaultUsername: request.defaultUsername === undefined ? (previous.defaultUsername ?? defaultUsername ?? undefined) : (defaultUsername ?? undefined),
        updatedAt: new Date().toISOString()
      }));
    } catch (error) {
      return { ok: false, error: fail("agent-settings-save-failed", error.message) };
    }
    const loaded = loadSettingsRecord(saved);
    this.agentAutoConnect = loaded.agentAutoConnect;
    this.featureSettings = saved.features;
    this.execPolicy = loaded.execPolicy;
    this.execPolicyAllow = loaded.execPolicyAllow;
    this.execPolicyExact = loaded.execPolicyExact;
    this.defaultUsername = loaded.defaultUsername;
    return this.agentSettingsGet();
  }

  // ── execution policy (operator-only; NEVER registered as an agent tool) ────

  /**
   * The global policy, normalized. Defensive against prototype-stub service
   * instances (tests) where class fields never initialized.
   *
   * The checklist is returned independently of the tier: it is one
   * operator-maintained list, and a session or resource switch to the custom
   * tier must release exactly what the operator ticked — not an empty set
   * produced by the global tier happening to sit on standard.
   */
  globalExecPolicy() {
    return {
      mode: normalizePolicy({ mode: this.execPolicy }).mode,
      allow: normalizeAllowList(this.execPolicyAllow)
    };
  }

  /**
   * Resolve the tier in force for one connection:
   * session switch > resource field > global setting > built-in standard.
   * Reads the resource record live (not a connect-time snapshot) so saving a
   * profile's policy applies to already-connected sessions. Storage that is
   * not ready fails safe to the global setting / standard.
   *
   * The released-category list travels WITH the result on every branch: only
   * the tier is layered (one operator-maintained checklist serves every
   * layer), but the decision function reads the list from this object. Leaving
   * it off made the custom tier a silent no-op — the panel said "released",
   * the gate kept blocking.
   */
  resolveExecPolicy(connectionId, ownerSessionId) {
    const base = this.resolveHarborExecPolicy(connectionId, ownerSessionId);
    const dsh = this.dshPermissionFor(ownerSessionId);
    return dsh === null ? base : composeExecPolicy(base, dsh);
  }

  /**
   * The DSH session ceiling for one conversation, or null when the host has
   * no permission-preset service (or the lookup cannot be completed). A null
   * result must preserve the historical Harbor policy exactly.
   *
   * @param {unknown} ownerSessionId - the conversation that owns the terminal.
   * @returns {object|null} the normalized DSH ceiling.
   */
  dshPermissionFor(ownerSessionId) {
    if (typeof this.ctx?.get !== "function") return null;
    const session = this.sessionForOwner(ownerSessionId);
    if (session === undefined) return null;
    try {
      return readDshPermission(this.ctx, session);
    } catch {
      return null;
    }
  }

  /**
   * Resolve one conversation id to its live DSH Session. Harbor's terminal
   * owner is usually the top-level conversation, so this is the session whose
   * permission selector the user actually sees.
   *
   * @param {unknown} ownerSessionId - conversation id.
   * @returns {object|undefined} the live Session.
   */
  sessionForOwner(ownerSessionId) {
    const id = normalizeOwner(ownerSessionId);
    if (id === null) return undefined;
    try {
      const sessions = this.ctx?.get?.("sessions");
      const session = sessions?.get?.(id);
      if (session !== undefined) return session;
    } catch {}
    try {
      const agents = this.ctx?.get?.("agents");
      const agent = agents?.get?.(id);
      if (agent?.session !== undefined) return agent.session;
    } catch {}
    return undefined;
  }

  /**
   * Harbor's own layer resolution, before the DSH session ceiling is applied.
   * Kept separate so tests and panels can explain each layer independently.
   *
   * @param {string|undefined} connectionId - the target connection.
   * @param {unknown} ownerSessionId - the calling conversation.
   * @returns {{mode: string, source: string, allow: string[], exact?: string[]}} the Harbor tier.
   */
  resolveHarborExecPolicy(connectionId, ownerSessionId) {
    const global = this.globalExecPolicy();
    const exact = normalizeExactRules(this.execPolicyExact);
    const rules = exact.length ? { exact } : {};
    const conn = this.connections.get(connectionId);
    const override = this.execPolicyOverrideFor(conn, ownerSessionId);
    if (override !== undefined) {
      return { mode: override, source: "session", allow: global.allow, ...rules };
    }
    let profileOverride;
    if (conn !== void 0 && conn.profileId && this.profileTable) {
      try {
        const record = this.profileTable.get(conn.profileId);
        if (record && record.execPolicy !== null && record.execPolicy !== undefined) profileOverride = record.execPolicy;
      } catch {}
    }
    if (profileOverride !== undefined) return { mode: profileOverride, source: "profile", allow: global.allow, ...rules };
    if (global.mode !== "standard") return { mode: global.mode, source: "global", allow: global.allow, ...rules };
    return {
      mode: "standard",
      source: this.profileTable === null && conn === void 0 ? "default" : "global",
      allow: global.allow, ...rules
    };
  }

  /**
   * Policy snapshot for the panel's pill. Also the single source the UI uses
   * to render where each layer points. Never exposed to the agent as a tool.
   */
  /**
   * The in-memory tier switch one conversation set on one connection.
   *
   * It used to sit on the connection record, so a chat that relaxed the gate
   * silently relaxed it for every other chat on that server. It is now keyed by
   * conversation; a caller with no session id (an older panel, the settings
   * page) reads and writes the anonymous bucket, which keeps the operator's
   * "relax it for this connection" gesture working where there is no chat.
   */
  execPolicyOverrideFor(conn, ownerSessionId) {
    const overrides = conn?.execPolicyOverrides;
    if (!(overrides instanceof Map)) return undefined;
    const mode = overrides.get(ownerKey(ownerSessionId));
    return typeof mode === "string" ? mode : undefined;
  }

  execPolicyGet(request) {
    const connectionId = request?.connectionId ?? this.activeConnectionFor(request?.sessionId);
    const resolved = this.resolveExecPolicy(connectionId, request?.sessionId);
    const global = this.globalExecPolicy();
    const conn = this.connections.get(connectionId);
    let profileOverride = null;
    if (conn !== void 0 && conn.profileId && this.profileTable) {
      try {
        const record = this.profileTable.get(conn.profileId);
        if (record && record.execPolicy !== null && record.execPolicy !== undefined) profileOverride = record.execPolicy;
      } catch {}
    }
    const value = {
      effective: resolved.mode,
      source: resolved.source,
      allow: global.allow,
      global: { policy: global.mode, allow: global.allow },
      profileOverride
    };
    // Only present when a DSH session permission was actually read; an older
    // host or a conversation without a preset keeps the historical payload.
    if (resolved.dsh !== undefined) {
      value.dsh = resolved.dsh;
      value.approval = resolved.approval;
    }
    return { ok: true, value };
  }

  /**
   * Switch the tier for one connection. Session-scoped by design: it mutates
   * the in-memory connection record only, so a reconnect or panel reload
   * falls back to the resource/global policy. This method must stay out of
   * the agent tool surface — an agent able to call it could lift its own gate
   * after a rejection.
   */
  execPolicySet(request) {
    const policy = normalizePolicy(request.policy);
    if (request.policy !== policy.mode) {
      return { ok: false, error: fail("exec-policy-unsupported", `the execution policy supports ${EXEC_POLICY_MODES.join(", ")}, not "${request.policy}"`) };
    }
    const conn = this.connections.get(request.connectionId);
    if (conn === void 0) return { ok: false, error: fail("no-connection", `connection "${request.connectionId}" does not exist`) };
    // The DSH session mode is a ceiling. Auto review and read-only own the
    // decision entirely; workspace-write cannot be widened to custom/allowAll
    // from Harbor. Refuse before mutating so a direct RPC cannot bypass the
    // menu's disabled rows.
    const dsh = this.dshPermissionFor(request.sessionId);
    const refusal = dshPolicyRefusal(dsh, policy.mode);
    if (refusal !== null) {
      return { ok: false, error: fail("dsh-policy-locked", t(refusal)) };
    }
    conn.execPolicyOverrides ??= new Map();
    conn.execPolicyOverrides.set(ownerKey(request.sessionId), policy.mode);
    return this.execPolicyGet({ connectionId: request.connectionId, sessionId: request.sessionId });
  }

  // ── interface language ─────────────────────────────────────────────────────

  /**
   * The stored language, or null when the operator never chose one (meaning:
   * follow DSH's own Settings → Language). The host half applies the choice
   * at boot; agent-visible tool messages and safety-policy notices follow the
   * same language as the panel.
   */
  async languageGet() {
    return { ok: true, value: { language: this.language, autoApplySystemLanguage: this.autoApplySystemLanguage } };
  }

  /**
   * Persist the interface language and apply it to the host half immediately.
   * `null` clears an explicit choice, so the next settings-page load goes back
   * to adopting DSH's own language.
   */
  async languageSave(request) {
    // Both fields are optional and independent: a settings page may change the
    // language, the follow switch, or both, and an untouched field must keep
    // its stored value rather than being reset to "follow".
    const requested = request.language === undefined
      ? undefined
      : request.language === null
        ? null
        : (request.language === "zh" || request.language === "en" ? request.language : "unsupported");
    if (requested === "unsupported") {
      return { ok: false, error: fail("language-unsupported", `the plugin supports "zh" and "en", not "${request.language}"`) };
    }
    const follow = typeof request.autoApplySystemLanguage === "boolean" ? request.autoApplySystemLanguage : undefined;
    if (requested === undefined && follow === undefined) {
      return { ok: true, value: { language: this.language, autoApplySystemLanguage: this.autoApplySystemLanguage } };
    }
    try {
      await this.patchSettingsRecord((previous) => ({
        ...previous,
        ...(requested === undefined ? {} : { language: requested ?? undefined }),
        ...(follow === undefined ? {} : { autoApplySystemLanguage: follow }),
        updatedAt: new Date().toISOString()
      }));
    } catch (error) {
      return { ok: false, error: fail("language-save-failed", error.message) };
    }
    if (requested !== undefined) {
      this.language = requested;
      if (requested !== null) setLanguage(requested);
    }
    if (follow !== undefined) this.autoApplySystemLanguage = follow;
    return { ok: true, value: { language: this.language, autoApplySystemLanguage: this.autoApplySystemLanguage } };
  }

  // ── Agent tools ────────────────────────────────────────────────────────────

  configuredToolGroups() {
    return {
      tunnelTools: this.featureSettings?.tunnelTools !== false,
      logTools: this.featureSettings?.logTools !== false,
      statusTools: this.featureSettings?.statusTools !== false
    };
  }
};
