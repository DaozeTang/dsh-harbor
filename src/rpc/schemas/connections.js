import { z } from "zod";
import { authSchema } from "./auth.js";
import { hostKeyModeSchema, ownerSessionIdSchema, resultSchema } from "./common.js";

// ── connect ─────────────────────────────────────────────────────────────────

export const connectRequestSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1),
  // Binds the new connection's agent target to this conversation only.
  sessionId: ownerSessionIdSchema.optional(),
  // A temporary connection may reference a saved shared credential.  In that
  // case the secret is resolved only in the service, never returned to React.
  auth: authSchema.optional(),
  credentialId: z.string().uuid().optional(),
  readyTimeout: z.number().int().min(1000).max(120000).optional(),
  // Legacy KEX opt-in for old VRP/IOS devices that only offer SHA-1 group14.
  // Omitted → the plugin retries once automatically when the handshake fails
  // on KEX selection; true → use the legacy set up front (no downgrade
  // warning); false → modern algorithms only, no automatic retry.
  legacy: z.boolean().optional(),
  // Opt-in SSH agent forwarding: hand the local ssh-agent to the remote host
  // so terminals opened on it can authenticate onward with the local keys.
  // Requires a running local agent (SSH_AUTH_SOCK); the connect fails fast
  // with an actionable message otherwise.
  agentForward: z.boolean().optional(),
  name: z.string().optional(),
  hostKeyMode: hostKeyModeSchema.optional(),
  proxyJump: z.array(z.object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).optional(),
    username: z.string().min(1),
    auth: authSchema,
    readyTimeout: z.number().int().min(1000).max(120000).optional(),
    hostKeyMode: hostKeyModeSchema.optional()
  })).optional(),
  proxyJumpProfileIds: z.array(z.string().uuid()).max(8).optional()
}).refine((request) => request.auth !== undefined || request.credentialId !== undefined, {
  message: "auth or credentialId is required"
});

/**
 * The payload of a successful connect. Exported on its own so the typert drift
 * guard can compare every wire key against the hand-written declaration
 * (`SshConnectResult`), which is how the missing legacy/banner/warning fields
 * were caught.
 */
export const connectResultPayloadSchema = z.object({
  connectionId: z.string(),
  name: z.string().optional(),
  host: z.string(),
  port: z.number(),
  username: z.string(),
  // Set when the handshake needed the legacy KEX set; `warning` carries the
  // user-facing explanation so a weakened transport is never silent.
  legacyFallback: z.boolean().optional(),
  // Set when the peer's identification string had to be normalized before
  // ssh2 would accept it (see ssh-banner.js); also explained in `warning`.
  bannerRepair: z.boolean().optional(),
  warning: z.string().optional()
});

export const connectResultSchema = resultSchema(connectResultPayloadSchema);

// ── list ────────────────────────────────────────────────────────────────────

export const listRequestSchema = z.object({ sessionId: ownerSessionIdSchema.optional() });

/**
 * One live terminal on a connection, with the conversation that owns it.
 * `mine` is resolved against the listing caller's session, which is what lets
 * the panel show its own terminal instead of "the first one".
 */
const terminalInfoSchema = z.object({
  sessionId: z.string(),
  ownerSessionId: z.string().nullable(),
  openedBy: z.enum(["panel", "agent"]),
  alive: z.boolean(),
  mine: z.boolean()
});

const connectionInfoSchema = z.object({
  connectionId: z.string(),
  name: z.string().optional(),
  host: z.string(),
  port: z.number(),
  username: z.string(),
  connected: z.boolean(),
  // Kept for older panels: terminal ids only. New callers read `terminals`.
  sessions: z.array(z.string()),
  terminals: z.array(terminalInfoSchema),
  // True while the connection has a live session opened by the agent
  // (ssh_connect_profile); the browser auto-reveals the SSH surface for it.
  agentSession: z.boolean().optional(),
  // The same fact, scoped to the listing caller's conversation.
  agentSessionMine: z.boolean().optional(),
  agentRevealId: z.string().optional(),
  // Which conversation the reveal request belongs to; absent = anonymous.
  agentRevealOwnerSessionId: z.string().optional(),
  // Per-conversation agent activity, independent of terminal liveness. The
  // panel uses this to pulse the server strip while a tool is operating.
  agentActive: z.boolean().optional(),
  agentLastActivityAt: z.string().optional(),
  agentActivityKind: z.string().optional()
});

// A saved SSH resource as the agent sees it: coordinates only —
// no credentials, no credential ids, no jump chains.
const savedResourceInfoSchema = z.object({
  profileId: z.string(),
  name: z.string(),
  host: z.string(),
  port: z.number(),
  username: z.string(),
  connected: z.boolean()
});

export const listResultSchema = resultSchema(
  z.object({
    connections: z.array(connectionInfoSchema),
    activeConnectionId: z.string().nullable(),
    // Present only while the operator's AI-auto-connect switch is on.
    resources: z.array(savedResourceInfoSchema).optional()
  })
);

// ── select the connection the agent operates on ─────────────────────────────

export const selectConnectionRequestSchema = z.object({
  connectionId: z.string().min(1),
  // Binds only this conversation; absent keeps the shared compatibility pointer.
  sessionId: ownerSessionIdSchema.optional()
});

export const selectConnectionResultSchema = resultSchema(z.object({
  activeConnectionId: z.string().nullable()
}));

// ── known-hosts management (operator only) ──────────────────────────────────

const knownHostInfoSchema = z.object({
  host: z.string(),
  port: z.number().int(),
  algorithm: z.string(),
  fingerprint: z.string(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string()
});

export const listKnownHostsRequestSchema = z.object({});
export const listKnownHostsResultSchema = resultSchema(
  z.object({ hosts: z.array(knownHostInfoSchema) })
);

export const forgetHostKeyRequestSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22)
});
export const forgetHostKeyResultSchema = resultSchema(z.object({ forgotten: z.boolean() }));

// ── disconnect ──────────────────────────────────────────────────────────────

export const disconnectRequestSchema = z.object({
  connectionId: z.string().min(1)
});

export const disconnectResultSchema = resultSchema(
  z.object({ disconnected: z.boolean() })
);
