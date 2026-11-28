/**
 * Shared wire-contract pieces: the envelope helpers (okSchema/resultSchema),
 * the error shape, and the id/enum schemas reused by more than one domain
 * module.
 */
import { z } from "zod";

export const sshErrorSchema = z.object({
  code: z.string(),
  message: z.string()
});

export function okSchema(value) {
  return z.object({ ok: z.literal(true), value });
}

export function resultSchema(value) {
  return z.union([
    okSchema(value),
    z.object({ ok: z.literal(false), error: sshErrorSchema })
  ]);
}

// ── host-key TOFU policy ─────────────────────────────────────────────────────
// accept-new: trust on first use, reject on change (OpenSSH accept-new).
// verify:     reject unseen hosts, reject on change.
// off:        skip host-key verification entirely (not recommended).

const hostKeyModeSchema = z.enum(["accept-new", "verify", "off"]);

// ── terminal ownership ──────────────────────────────────────────────────────

/**
 * The DSH session that owns a terminal, or that binds an agent target.
 *
 * Optional everywhere: a caller without one (an older panel build, the
 * settings page, a host that predates the SessionId plumbing) keeps working
 * through the anonymous path, which is why this never becomes a required
 * field. Absent means "no conversation to attribute this to", not "any".
 */
const ownerSessionIdSchema = z.string().min(1).max(128);

const profileIdSchema = z.string().uuid();
const groupIdSchema = z.string().uuid();
const credentialIdSchema = z.string().uuid();

const profileAuthKindSchema = z.enum(["password", "key"]);

// Internal cross-module exports: declared here and consumed by sibling domain
// modules only; ../schemas.js re-exports just the public wire names.
export { hostKeyModeSchema, ownerSessionIdSchema, profileIdSchema, groupIdSchema, credentialIdSchema, profileAuthKindSchema };
