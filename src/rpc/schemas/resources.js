import { z } from "zod";
import { credentialIdSchema, groupIdSchema, hostKeyModeSchema, ownerSessionIdSchema, profileAuthKindSchema, profileIdSchema, resultSchema } from "./common.js";
import { connectResultSchema } from "./connections.js";
import { profileCredentialRefsSchema } from "./credentials.js";
import { execPolicyModeSchema } from "./settings.js";

// ── saved SSH resources ────────────────────────────────────────────────────

export const resourceBackupExportRequestSchema = z.object({ password: z.string().min(12).max(1024) });
export const resourceBackupExportResultSchema = resultSchema(z.object({ archive: z.string() }));
export const resourceBackupImportRequestSchema = z.object({ password: z.string().min(12).max(1024), archive: z.string().max(64 * 1024 * 1024), skipDuplicates: z.boolean().optional() });
export const profileConnectionStatusResultSchema = resultSchema(z.object({ profileIds: z.array(z.string().uuid()) }));
const openSshPreviewEntrySchema = z.object({
  name: z.string(), host: z.string(), username: z.string(), port: z.number().int(),
  hops: z.array(z.string()), issues: z.array(z.string()), unsupported: z.boolean(), existing: z.boolean(), authKind: z.enum(["key", "password"]),
  // The IdentityFile resolved on the host: its path and whether a usable key
  // sits there. Only the status crosses the wire — never the key itself.
  keyPath: z.string().max(4096).nullable(),
  keyStatus: z.enum(["ready", "passphrase", "missing", "unreadable", "invalid"]).nullable()
});
export const openSshImportRequestSchema = z.object({
  selection: z.object({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    names: z.array(z.string().min(1).max(120)).min(1).max(500),
    groupId: z.string().uuid().nullable()
  }).optional()
});
export const openSshImportResultSchema = resultSchema(z.union([
  z.object({ preview: z.object({ fingerprint: z.string(), entries: z.array(openSshPreviewEntrySchema).max(500) }) }),
  z.object({ imported: z.object({
    created: z.number().int(),
    // Keys copied from IdentityFile during this import; those profiles open
    // without a second manual step.
    keysImported: z.number().int(),
    // Imported profiles whose key needs a passphrase before it can connect.
    passphraseRequired: z.array(z.string()).max(500),
    skipped: z.array(z.string()),
    failed: z.array(z.string()),
    details: z.array(z.object({ name: z.string(), reason: z.enum(["unsupported", "cycle", "repeated", "missing", "save", "key"]), items: z.array(z.string()) }))
  }) })
]));
export const resourceBackupImportResultSchema = resultSchema(z.object({ profiles: z.number().int(), groups: z.number().int(), credentials: z.number().int(), duplicates: z.array(z.string()).max(5000).optional(), skipped: z.number().int().optional(), retained: z.array(z.string()).max(5000).optional() }));

// A saved project directory is deliberately an absolute POSIX path.  It is
// passed to SFTP and to the guarded `changeDirectory` RPC, so accepting shell
// syntax, relative paths, or control characters here would create two subtly
// different meanings for one saved value.
const projectDirectorySchema = z.string().min(1).max(1024).refine(
  (path) => path.startsWith("/") && !/[\x00-\x1f\x7f]/.test(path),
  "项目目录必须是绝对路径，且不能包含控制字符" // i18n-ignore: schema-time message, frozen by design
);
// A saved login command replaces the resource's login shell for terminal
// sessions (exec + pty): `bash -l` drops into bash on a zsh-default server.
// Single line only — a saved value containing a newline would make it
// ambiguous what actually runs in the exec request.
const loginCommandSchema = z.string().min(1).max(1024).refine(
  (command) => !/[\x00-\x1f\x7f]/.test(command),
  "登录命令必须是单行命令，不能包含控制字符" // i18n-ignore: schema-time message, frozen by design
);
const legacySavedJumpSchema = z.object({
  host: z.string().min(1).max(255), port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).max(128), authKind: z.enum(["credential", "password", "key"]).default("credential"), credentialId: credentialIdSchema.optional(),
  hostKeyMode: hostKeyModeSchema.optional()
});
const savedJumpSchema = z.union([z.object({ profileId: profileIdSchema }), legacySavedJumpSchema]);

const profileMetadataSchema = z.object({
  name: z.string().min(1).max(120),
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).max(128),
  authKind: profileAuthKindSchema,
  hostKeyMode: hostKeyModeSchema.default("accept-new"),
  // SSH agent forwarding (resolved false for records saved before this
  // field existed): forward the local ssh-agent so a terminal on this server
  // can authenticate onward with the local keys.
  agentForward: z.boolean().default(false)
});

export const profileSaveRequestSchema = profileMetadataSchema.extend({
  // The stored record carries these defaults; the request must not invent
  // them. A default here turns "this caller did not send hostKeyMode" into
  // "accept-new", which silently downgrades a resource pinned to `verify` on
  // every partial save. profileMetadataSchema keeps its defaults for the
  // *output* shape, where a record saved before a field existed must still
  // read back as a complete object.
  hostKeyMode: hostKeyModeSchema.optional(),
  agentForward: z.boolean().optional(),
  profileId: profileIdSchema.optional(),
  groupId: groupIdSchema.nullable().optional(),
  credentialId: credentialIdSchema.nullable().optional(),
  proxyJump: z.array(savedJumpSchema).max(8).optional(),
  defaultProjectPath: projectDirectorySchema.nullable().optional(),
  loginCommand: loginCommandSchema.nullable().optional(),
  // Execution policy override for this resource (null = follow the global
  // setting). Only the tier travels here; the custom tier's released-category
  // set stays a single global list in harbor_settings.
  execPolicy: execPolicyModeSchema.nullable().optional()
});

export const profileInfoSchema = profileMetadataSchema.extend({
  profileId: profileIdSchema,
  groupId: groupIdSchema.nullable(),
  groupName: z.string().nullable(),
  credentialConfigured: z.boolean(),
  passphraseConfigured: z.boolean(),
  // Optional second factor (dual-factor auth): whether the opposite-kind
  // secret is also configured. Resolved to false for records saved before
  // dual-factor support existed.
  secondaryConfigured: z.boolean(),
  connected: z.boolean()
 ,credentialId: credentialIdSchema.nullable(),
  credentialName: z.string().nullable(),
  proxyJump: z.array(savedJumpSchema),
  defaultProjectPath: projectDirectorySchema.nullable(),
  loginCommand: loginCommandSchema.nullable(),
  execPolicy: execPolicyModeSchema.nullable()
});

export const profileSaveResultSchema = resultSchema(
  z.object({
    profile: profileInfoSchema,
    credentialRefs: profileCredentialRefsSchema
  })
);

export const profileListRequestSchema = z.object({});
export const profileListResultSchema = resultSchema(
  z.object({ profiles: z.array(profileInfoSchema) })
);

export const profileDeleteRequestSchema = z.object({ profileId: profileIdSchema });
export const profileDeleteResultSchema = resultSchema(z.object({ deleted: z.boolean() }));

export const profileDisconnectRequestSchema = z.object({ profileId: profileIdSchema });
export const profileDisconnectResultSchema = resultSchema(z.object({ disconnected: z.number().int().min(0) }));

export const profileConnectRequestSchema = z.object({
  profileId: profileIdSchema,
  /** Join an already-live connection for this saved server when possible. */
  reuseExisting: z.boolean().optional(),
  /** UI connects pass a shorter handshake budget and zero retries to fail fast. */
  readyTimeout: z.number().int().positive().max(120000).optional(),
  retries: z.number().int().min(0).max(5).optional(),
  /** When supplied, override this saved resource's jump chain for one connect only. */
  proxyJumpProfileIds: z.array(profileIdSchema).max(8).optional(),
  /** Binds the agent target to this conversation instead of the shared pointer. */
  sessionId: ownerSessionIdSchema.optional()
});
export const profileConnectResultSchema = connectResultSchema;

export const cancelProfileConnectRequestSchema = z.object({ profileId: profileIdSchema.optional() });
export const cancelProfileConnectResultSchema = resultSchema(z.object({ cancelled: z.number().int().min(0) }));

const groupInfoSchema = z.object({
  groupId: groupIdSchema,
  name: z.string(),
  profileCount: z.number().int().nonnegative()
});
export const groupListRequestSchema = z.object({});
export const groupListResultSchema = resultSchema(z.object({ groups: z.array(groupInfoSchema) }));
export const groupSaveRequestSchema = z.object({ groupId: groupIdSchema.optional(), name: z.string().min(1).max(80) });
export const groupSaveResultSchema = resultSchema(z.object({ group: groupInfoSchema }));
export const groupDeleteRequestSchema = z.object({ groupId: groupIdSchema });
export const groupDeleteResultSchema = resultSchema(z.object({ deleted: z.boolean(), movedProfiles: z.number().int().nonnegative() }));
