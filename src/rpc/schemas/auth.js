import { z } from "zod";

// ── auth ────────────────────────────────────────────────────────────────────

// A single authentication factor. Dual-factor devices (firewalls/switches
// with `AuthenticationMethods password,publickey` or the reverse) require two
// factors on the SAME connection, so a credential may carry a primary factor
// plus an optional secondary of the opposite kind.
const passwordFactorSchema = z.object({
  kind: z.literal("password"),
  password: z.string()
});

const keyFactorSchema = z.object({
  kind: z.literal("key"),
  privateKey: z.string(),
  passphrase: z.string().optional()
});

const passwordAuthSchema = passwordFactorSchema.extend({
  // Optional second factor: a key, when the primary factor is the password.
  secondary: keyFactorSchema.optional()
});

const keyAuthSchema = keyFactorSchema.extend({
  // Optional second factor: a password, when the primary factor is the key.
  secondary: passwordFactorSchema.optional()
});

export const authSchema = z.union([passwordAuthSchema, keyAuthSchema]);
