/**
 * DSH session-permission adapter.
 *
 * Harbor's own execution policy predates DSH's named permission presets and
 * therefore used to be a parallel, unaware gate: a chat set to Auto review or
 * full access still met Harbor's standard deny-list. This module reads the
 * session's actual sandbox and approval knobs and composes them with Harbor's
 * ladder. It is deliberately pure (except for the optional service reads in
 * readDshPermission) so the mapping can be unit-tested without a DSH host.
 *
 * Semantics:
 * - the DSH mode is a CEILING (auto = the Auto review gate owns the decision);
 * - an explicit Harbor session switch may only tighten, never loosen past it;
 * - profile/global Harbor defaults follow the DSH mode;
 * - no mounted permission service means the historical Harbor behavior.
 */

/** DSH execution ceiling keys, in the order the policy module understands them. */
export const DSH_CEILINGS = Object.freeze(["auto", "allowAll", "standard", "readOnly"]);

const SANDBOX_MODES = Object.freeze(["read-only", "workspace-write", "danger-full-access"]);
const APPROVAL_POLICIES = Object.freeze(["ask", "never"]);

/**
 * Harden one snapshot of DSH permission facts into a ceiling.
 * Unknown or missing sandbox values keep the historical Harbor behavior,
 * except for the live Auto identity, which is explicit and sufficient.
 *
 * @param {{preset?: string|null, sandbox?: string|null, approval?: string|null}} input
 * @returns {{preset: string|null, sandbox: string|null, approval: string|null, ceiling: string, source: string}|null}
 */
export function normalizeDshPermission(input) {
  if (input === null || typeof input !== "object") return null;
  const preset = typeof input.preset === "string" && input.preset.length > 0 ? input.preset : null;
  const sandbox = SANDBOX_MODES.includes(input.sandbox) ? input.sandbox : null;
  const approval = APPROVAL_POLICIES.includes(input.approval) ? input.approval : null;
  if (preset === null && sandbox === null && approval === null) return null;
  let ceiling;
  let source;
  if (preset === "auto") {
    ceiling = "auto";
    source = "dsh-auto";
  } else if (sandbox === "danger-full-access") {
    ceiling = "allowAll";
    source = "dsh-full-access";
  } else if (sandbox === "read-only") {
    ceiling = "readOnly";
    source = "dsh-read-only";
  } else if (sandbox === "workspace-write") {
    ceiling = "standard";
    source = "dsh-workspace-write";
  } else {
    return null;
  }
  return Object.freeze({ preset, sandbox, approval, ceiling, source });
}

/**
 * Read the calling session's permission facts from the optional DSH services.
 *
 * Every read is guarded: a composition without permission presets, an older
 * DSH, or a projection that is not ready yet must fall back to Harbor's own
 * policy rather than fail the gate. When the preset name is readable but a
 * knob projection is not, the preset bundle is used as the fallback.
 *
 * @param {object|undefined} ctx - Harbor's Cordis context.
 * @param {object|undefined} session - the conversation's DSH Session.
 * @returns {ReturnType<typeof normalizeDshPermission>}
 */
export function readDshPermission(ctx, session) {
  if (session === undefined || session === null || ctx === undefined || typeof ctx.get !== "function") return null;
  let presets;
  try { presets = ctx.get("permissionPresets"); } catch { presets = undefined; }
  // The named permission selector is the feature this adapter follows. A host
  // that composes only sandboxPolicy (or an older DSH) keeps Harbor's own
  // historical policy rather than silently treating the deployment default as
  // a user choice.
  if (presets === undefined) return null;
  let preset = null;
  try { preset = presets.current?.(session) ?? null; } catch { /* projection not ready: use the knob fallback */ }
  let sandbox = null;
  let approval = null;
  try {
    const policy = ctx.get("sandboxPolicy");
    sandbox = policy?.resolve?.({ session })?.mode ?? null;
  } catch { /* unavailable projection: fall through with null */ }
  try {
    const service = ctx.get("approval");
    approval = service?.overrideOf?.(session) ?? service?.config?.policy ?? null;
  } catch { /* unavailable approval service: fall through with null */ }
  if (sandbox === null && preset !== null && presets !== undefined) {
    try {
      const spec = presets.resolve?.(preset);
      if (spec !== undefined) {
        sandbox = SANDBOX_MODES.includes(spec.sandbox) ? spec.sandbox : null;
        approval ??= APPROVAL_POLICIES.includes(spec.approval) ? spec.approval : null;
      }
    } catch { /* custom/unknown preset: keep the Harbor fallback */ }
  }
  return normalizeDshPermission({ preset, sandbox, approval });
}

/**
 * Compose the DSH ceiling over one Harbor policy.
 *
 * The returned object keeps Harbor's existing shape (mode, source, allow,
 * optional exact) and adds approval and dsh. The DSH mode sets the ceiling; a
 * Harbor session switch (source === "session") may tighten under a full-access
 * ceiling, and never loosens under a narrower one.
 *
 * @param {{mode: string, source: string, allow?: string[], exact?: string[]}} base - Harbor's resolved policy.
 * @param {ReturnType<typeof normalizeDshPermission>} dsh - the session's ceiling.
 * @returns {object} the policy the gates, the panel and the tools consume.
 */
export function composeExecPolicy(base, dsh) {
  if (dsh === null || dsh === undefined) return base;
  const allow = Array.isArray(base.allow) ? base.allow : [];
  const exact = Array.isArray(base.exact) ? base.exact : undefined;
  const common = {
    ...base,
    allow,
    ...(exact === undefined ? {} : { exact }),
    dsh
  };
  if (dsh.ceiling === "auto") {
    // Auto review is the selected review layer. Harbor must not prompt again
    // after Auto allows the call; its own deny-list stands down entirely.
    return { ...common, mode: "allowAll", approval: "never" };
  }
  if (dsh.ceiling === "readOnly") {
    // DSH read-only has no writable mode to approve. Harbor still uses its
    // standard deny-list, but refuses rather than asking, because "allow"
    // would contradict the session's no-write choice.
    return { ...common, mode: "standard", approval: "never" };
  }
  if (dsh.ceiling === "standard") {
    // Workspace writes are allowed; destructive remote commands still need
    // approval. Custom/allowAll cannot be used to loosen past this ceiling.
    return { ...common, mode: "standard", approval: dsh.approval ?? "ask" };
  }
  // Full access: a Harbor session switch may tighten, but the profile/global
  // default must not keep the old standard gate alive after the user chose
  // full access.
  if (base.source === "session" && base.mode !== "allowAll") {
    return { ...common, mode: base.mode, approval: dsh.approval ?? "never" };
  }
  return { ...common, mode: "allowAll", approval: dsh.approval ?? "never" };
}

/**
 * Why a requested Harbor tier cannot be selected under this session's DSH
 * mode, or null when the switch is legal.
 *
 * @param {ReturnType<typeof normalizeDshPermission>} dsh - the session ceiling.
 * @param {string} mode - the requested Harbor tier.
 * @returns {string|null} an operator-facing refusal, or null.
 */
export function dshPolicyRefusal(dsh, mode) {
  if (dsh === null || dsh === undefined) return null;
  if (dsh.ceiling === "auto") {
    return "本次对话已选择 DSH 自动审查，Harbor 执行策略由 Auto review 接管；请先在 DSH 权限选择器中切换模式。"; // i18n-identifier
  }
  if (dsh.ceiling === "readOnly") {
    return "本次对话处于 DSH 只读模式，Harbor 执行策略不能再放宽或切换；请先在 DSH 权限选择器中切换模式。"; // i18n-identifier
  }
  if (dsh.ceiling === "standard" && mode !== "standard") {
    return "本次对话的 DSH 模式为仅工作区写，Harbor 只能使用标准档；请先在 DSH 权限选择器中切换模式。"; // i18n-identifier
  }
  return null;
}
