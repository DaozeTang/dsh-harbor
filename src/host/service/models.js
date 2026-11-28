/**
 * Durable record schemas, storage domains and record normalizers.
 *
 * Every schema here is the one DSH re-validates at boot, so persistence code
 * and tests share the exact same shape.
 */
import { z } from "zod";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { normalizePolicy, normalizeAllowList, normalizeExactRules } from "../policy/safety.js";
import { featureSettingsSchema } from "../../rpc/schemas.js";

const profileRecordSchema = z.object({
  name: z.string(),
  host: z.string(),
  port: z.number().int(),
  username: z.string(),
  authKind: z.enum(["password", "key"]),
  groupId: z.string().uuid().nullable(),
  // Host-key TOFU mode persisted per saved server; optional so records saved
  // before this feature existed still load (treated as the accept-new default).
  hostKeyMode: z.string().optional(),
  agentForward: z.boolean().optional(),
  // Optional shared credential and jump chain.  Both are optional so the
  // domain can read every pre-0.3.3 resource without migration.
  credentialId: z.string().uuid().nullable().optional(),
  // Optional so already-saved resources load without a storage migration.
  // Nullable because profileSave persists `null` for "no project directory"
  // (the request schema accepts an explicit null to clear the entry) and DSH
  // re-validates every stored record when it reopens the domain at boot.
  // This is metadata only; it never contains credentials or shell syntax.
  defaultProjectPath: z.string().nullable().optional(),
  // Optional so pre-0.3.x resources load without a migration. Unlike
  // defaultProjectPath this IS shell syntax: it replaces the login shell of
  // terminal sessions (exec + pty) and runs with the resource's own authority,
  // so it is operator-authored config, never agent-writable mid-session.
  loginCommand: z.string().nullable().optional(),
  // Resource-level execution policy tier; null/absent follows the global
  // setting. Only the tier lives here — the custom tier's released-category
  // set is one operator-maintained global list.
  execPolicy: z.string().nullable().optional(),
  proxyJump: z.array(z.union([z.object({ profileId: z.string().uuid() }), z.object({
    host: z.string(), port: z.number().int(), username: z.string(),
    authKind: z.enum(["credential", "password", "key"]).optional(), credentialId: z.string().uuid().optional(), hostKeyMode: z.string().optional()
  })])).optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

const credentialRecordSchema = z.object({
  name: z.string(),
  authKind: z.enum(["password", "key"]),
  createdAt: z.string(),
  updatedAt: z.string()
});

const groupRecordSchema = z.object({
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string()
});

// Exported (with the credential and known-host specs below) so tests can
// assert that the records each save path writes satisfy the schemas DSH
// re-validates when it reopens the domain at boot.
export const profileDomainSpec = defineDomain({
  name: "harbor_profiles",
  version: 1,
  tables: {
    profiles: domainTable(profileRecordSchema),
    groups: domainTable(groupRecordSchema)
  }
});

// Keep shared credentials in a new unit rather than bumping the established
// profile unit. DSH's JSON storage rejects in-place unit-version changes, and
// users' existing server profiles must never prevent the host from booting.
export const credentialDomainSpec = defineDomain({
  name: "harbor_credentials",
  version: 1,
  tables: { credentials: domainTable(credentialRecordSchema) }
});

// One host can present several host keys (ed25519, rsa, ecdsa), and which one a
// handshake negotiates can change without the host changing, so trust is kept
// per algorithm. Optional: a record written before this field existed still
// loads, and the boot schema must not STRIP what a newer build stored.
const knownHostKeysSchema = z.array(z.object({
  algorithm: z.string(),
  fingerprint: z.string(),
  firstSeenAt: z.string().nullable().optional(),
  lastSeenAt: z.string().nullable().optional()
}));

const knownHostRecordSchema = z.object({
  host: z.string(),
  port: z.number().int(),
  algorithm: z.string(),
  fingerprint: z.string(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  keys: knownHostKeysSchema.optional()
});

export const knownHostDomainSpec = defineDomain({
  name: "harbor_known_hosts",
  version: 1,
  tables: {
    known_hosts: domainTable(knownHostRecordSchema)
  }
});

// Operator-level plugin settings (one row, id "main"). New fields must be
// optional so records written by older builds keep loading.
const settingsRecordSchema = z.object({
  agentAutoConnect: z.boolean().optional(),
  features: featureSettingsSchema.optional(),
  // Interface language chosen by the operator ("zh" | "en"). Absent means
  // "never chosen explicitly", so the settings page adopts whatever DSH
  // Settings → Language is showing and writes that back.
  language: z.enum(["zh", "en"]).optional(),
  // When false, the host language is never followed or written back: the
  // stored `language` value is authoritative. Absent means "true" so first
  // installs behave exactly as before this flag existed.
  autoApplySystemLanguage: z.boolean().optional(),
  // Global default execution policy (standard | custom | allowAll) and, for
  // the custom tier, the released deny-list category keys. Optional so records
  // written by older builds keep loading; invalid values fall back to the
  // standard tier at read time, never widen it.
  execPolicy: z.string().optional(),
  execPolicyAllow: z.array(z.string()).optional(),
  execPolicyExact: z.array(z.string()).optional(),
  // Username the panel prefills into its new-server form; auto-remembered
  // from the last profileSave. Empty/absent falls back to "root".
  defaultUsername: z.string().max(128).optional(),
  updatedAt: z.string().optional()
});

export const settingsDomainSpec = defineDomain({
  name: "harbor_settings",
  version: 1,
  tables: {
    settings: domainTable(settingsRecordSchema)
  }
});

export const SETTINGS_ROW_ID = "main";

/**
 * Keep only the feature switches this build knows. A settings record written
 * by an older build (or by a removed surface) may still carry dead keys —
 * notably `dbTools`/`showDatabase` — and the save path spreads the previous
 * record; filtering here stops them from being written back forever.
 */
export function normalizeFeatureSettings(features) {
  if (features === null || typeof features !== "object") return undefined;
  const next = {};
  for (const key of Object.keys(featureSettingsSchema.shape)) {
    if (typeof features[key] === "boolean") next[key] = features[key];
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * The stored default username, hardened: trim, cap the length, collapse
 * blank/absent/non-string to null ("no preference").
 */
export function normalizeDefaultUsername(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed.slice(0, 128);
}

/**
 * Interpret one persisted settings record into the runtime switches. Absent
 * `autoApplySystemLanguage` means "true" (follow the host), which is also what
 * a first install must behave like. Extracted so boot and tests share one
 * reading of the record.
 */
export function loadSettingsRecord(record = {}) {
  return {
    agentAutoConnect: record.agentAutoConnect === true,
    language: record.language === "zh" || record.language === "en" ? record.language : null,
    autoApplySystemLanguage: record.autoApplySystemLanguage !== false,
    // normalizePolicy hardens the tier (unknown values land on standard) and
    // normalizeAllowList hardens the checklist (unknown keys dropped). The two
    // are read independently on purpose: a record whose tier is not "custom"
    // still carries the operator's ticks, so switching tiers back and forth
    // never empties the checklist.
    execPolicy: normalizePolicy({ mode: record.execPolicy }).mode,
    execPolicyAllow: normalizeAllowList(record.execPolicyAllow),
    execPolicyExact: normalizeExactRules(record.execPolicyExact),
    defaultUsername: normalizeDefaultUsername(record.defaultUsername)
  };
}

export function profileCredentialRefs(profileId) {
  const stem = profileId.replaceAll("-", "").toUpperCase();
  return {
    password: `DSH_HARBOR_${stem}_PASSWORD`,
    privateKey: `DSH_HARBOR_${stem}_PRIVATE_KEY`,
    passphrase: `DSH_HARBOR_${stem}_PASSPHRASE`
  };
}

export function sharedCredentialRefs(credentialId) {
  const stem = credentialId.replaceAll("-", "").toUpperCase();
  return {
    password: `DSH_HARBOR_SHARED_${stem}_PASSWORD`,
    privateKey: `DSH_HARBOR_SHARED_${stem}_PRIVATE_KEY`,
    passphrase: `DSH_HARBOR_SHARED_${stem}_PASSPHRASE`
  };
}

export function profileJumpPasswordRef(profileId, index) {
  return `DSH_HARBOR_${profileId.replaceAll("-", "").toUpperCase()}_JUMP_${index}_PASSWORD`;
}

export function profileJumpPrivateKeyRef(profileId, index) {
  return `DSH_HARBOR_${profileId.replaceAll("-", "").toUpperCase()}_JUMP_${index}_PRIVATE_KEY`;
}

export function profileJumpPassphraseRef(profileId, index) {
  return `DSH_HARBOR_${profileId.replaceAll("-", "").toUpperCase()}_JUMP_${index}_PASSPHRASE`;
}
