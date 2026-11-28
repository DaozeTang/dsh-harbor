import { z } from "zod";
import { ownerSessionIdSchema, resultSchema } from "./common.js";

// ── agent auto-connect settings (operator switch,) ────────────────

// The operator-level settings RPC now carries every global switch. The
// execution-policy fields are optional so an older panel build (which only
// knows agentAutoConnect) still round-trips through these schemas.
const execPolicyModeSchema = z.enum(["standard", "custom", "allowAll"]);
const execPolicyAllowSchema = z.array(z.string()).max(32);

export const agentSettingsGetRequestSchema = z.object({});
export const featureSettingsSchema = z.object({
  tunnelTools: z.boolean().optional(),
  logTools: z.boolean().optional(),
  statusTools: z.boolean().optional(),
  showTunnels: z.boolean().optional(),
  showSnippets: z.boolean().optional(),
  showLogs: z.boolean().optional(),
  showMonitor: z.boolean().optional()
});
export const agentSettingsResultSchema = resultSchema(z.object({
  agentAutoConnect: z.boolean(),
  features: featureSettingsSchema.optional(),
  toolRestartRequired: z.boolean().optional(),
  execPolicy: execPolicyModeSchema.optional(),
  execPolicyAllow: execPolicyAllowSchema.optional(),
  execPolicyExact: z.array(z.string().min(1).max(512)).max(32).optional(),
  // Username the panel prefills into its new-server form; null = "root".
  defaultUsername: z.string().max(128).nullable().optional(),
  // The custom tier's checklist as served by the host (single source of truth).
  categories: z.array(z.object({ key: z.string(), label: z.string() })).optional()
}));
export const agentSettingsSaveRequestSchema = z.object({
  agentAutoConnect: z.boolean().optional(),
  features: featureSettingsSchema.optional(),
  execPolicy: execPolicyModeSchema.optional(),
  execPolicyAllow: execPolicyAllowSchema.optional(),
  execPolicyExact: z.array(z.string().min(1).max(512)).max(32).optional(),
  // Optional: absent keeps the stored value, null clears it back to "root".
  defaultUsername: z.string().max(128).nullable().optional()
});

// ── execution policy (session-scoped switching; operator-only RPC) ──────────

const dshPermissionSchema = z.object({
  preset: z.string().nullable(),
  sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).nullable(),
  approval: z.enum(["ask", "never"]).nullable(),
  ceiling: z.enum(["auto", "allowAll", "standard", "readOnly"]),
  source: z.enum(["dsh-auto", "dsh-full-access", "dsh-workspace-write", "dsh-read-only"])
});

export const execPolicyGetRequestSchema = z.object({ connectionId: z.string().optional(), sessionId: ownerSessionIdSchema.optional() });
export const execPolicyGetResultSchema = resultSchema(z.object({
  // The tier in force for this connection right now.
  effective: execPolicyModeSchema,
  // Where it came from: an operator session switch, the resource field, the
  // global setting, or the built-in default (no storage / nothing stored).
  source: z.enum(["session", "profile", "global", "default"]),
  // The custom tier's released-category keys (from the global setting).
  allow: z.array(z.string()),
  // Raw settings so the panel can render where each layer points.
  global: z.object({ policy: execPolicyModeSchema, allow: z.array(z.string()) }),
  profileOverride: execPolicyModeSchema.nullable(),
  // The DSH session ceiling, when the host composed permission presets. Absent
  // on older hosts and for callers without a conversation id.
  dsh: dshPermissionSchema.optional(),
  approval: z.enum(["ask", "never"]).optional()
}));
export const execPolicySetRequestSchema = z.object({ connectionId: z.string(), policy: execPolicyModeSchema, sessionId: ownerSessionIdSchema.optional() });
export const execPolicySetResultSchema = execPolicyGetResultSchema;

// ── interface language (operator choice; null = follow DSH's own language) ──

const languageValueSchema = z.enum(["zh", "en"]);
export const languageGetRequestSchema = z.object({});
export const languageResultSchema = resultSchema(z.object({
  language: z.enum(["zh", "en"]).nullable(),
  // When false, the plugin never follows (or writes back) the host language:
  // the stored `language` value is authoritative. Absent means "true" (follow
  // the host), matching the behaviour of installs written before this field.
  autoApplySystemLanguage: z.boolean().optional()
}));
export const languageSaveRequestSchema = z.object({
  // Absent leaves the stored choice untouched; null clears it (back to follow).
  language: languageValueSchema.nullable().optional(),
  // Absent leaves the follow switch untouched. false pins the stored language:
  // the plugin then never adopts (or writes back) the host language again.
  autoApplySystemLanguage: z.boolean().optional()
});

// Internal cross-module exports: declared here and consumed by sibling domain
// modules only; ../schemas.js re-exports just the public wire names.
export { execPolicyModeSchema };
