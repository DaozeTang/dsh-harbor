import { z } from "zod";
import { credentialIdSchema, profileAuthKindSchema, resultSchema } from "./common.js";

const profileCredentialRefsSchema = z.object({
  password: z.string(),
  privateKey: z.string(),
  passphrase: z.string(),
  proxyJumpPasswords: z.array(z.string()).optional(),
  proxyJumpPrivateKeys: z.array(z.string()).optional(),
  proxyJumpPassphrases: z.array(z.string()).optional()
});

const credentialInfoSchema = z.object({ credentialId: credentialIdSchema, name: z.string(), authKind: profileAuthKindSchema, credentialConfigured: z.boolean(), passphraseConfigured: z.boolean(), secondaryConfigured: z.boolean() });
export const credentialListRequestSchema = z.object({});
export const credentialListResultSchema = resultSchema(z.object({ credentials: z.array(credentialInfoSchema) }));
export const credentialSaveRequestSchema = z.object({ credentialId: credentialIdSchema.optional(), name: z.string().min(1).max(120), authKind: profileAuthKindSchema });
export const credentialSaveResultSchema = resultSchema(z.object({ credential: credentialInfoSchema, credentialRefs: profileCredentialRefsSchema }));
export const credentialDeleteRequestSchema = z.object({ credentialId: credentialIdSchema });
export const credentialDeleteResultSchema = resultSchema(z.object({ deleted: z.boolean() }));

// Internal cross-module exports: declared here and consumed by sibling domain
// modules only; ../schemas.js re-exports just the public wire names.
export { profileCredentialRefsSchema };
