import { z } from "zod";
import { resultSchema } from "./common.js";

// ── SFTP ────────────────────────────────────────────────────────────────────

// The attributes a listing entry and a stat result share. `name` is
// deliberately not one of them: `sftpStat` answers "what is at this path", and
// its caller already knows the path it asked about, so requiring a `name` here
// made every stat result fail the strict codec.
const sftpAttributesSchema = z.object({
  isDirectory: z.boolean(),
  size: z.number(),
  mtime: z.number(),
  mode: z.number()
});

const sftpEntrySchema = z.object({ name: z.string(), ...sftpAttributesSchema.shape });

export const sftpListRequestSchema = z.object({
  connectionId: z.string().optional(),
  path: z.string().optional()
});

export const sftpListResultSchema = resultSchema(
  z.object({ path: z.string(), entries: z.array(sftpEntrySchema) })
);

export const sftpStatRequestSchema = z.object({
  connectionId: z.string().optional(),
  path: z.string().min(1)
});

export const sftpStatResultSchema = resultSchema(z.object({ path: z.string(), ...sftpAttributesSchema.shape }));

export const sftpReadRequestSchema = z.object({
  connectionId: z.string().optional(),
  path: z.string().min(1),
  maxBytes: z.number().int().min(1024).max(16 * 1024 * 1024).optional()
});

export const sftpReadResultSchema = resultSchema(
  // `bytes` is the length of the returned content (min(file size, maxBytes)),
  // so it is only the file size when `truncated` is false.
  z.object({ path: z.string(), data: z.string(), truncated: z.boolean(), bytes: z.number() })
);

export const sftpWriteRequestSchema = z.object({
  connectionId: z.string().optional(),
  path: z.string().min(1),
  data: z.string()
});

export const sftpWriteResultSchema = resultSchema(
  z.object({ path: z.string(), bytes: z.number() })
);

export const sftpEditorSaveRequestSchema = z.object({
  connectionId: z.string().optional(), path: z.string().min(1),
  expected: z.string().max(14 * 1024 * 1024), data: z.string().max(14 * 1024 * 1024)
});
export const sftpEditorSaveResultSchema = resultSchema(z.object({ bytes: z.number() }));

// ── SCP fallback (single-file upload/download only) ─────────────────────────

export const scpReadRequestSchema = z.object({
  connectionId: z.string().optional(),
  path: z.string().min(1),
  maxBytes: z.number().int().min(1024).max(16 * 1024 * 1024).optional()
});

export const scpReadResultSchema = resultSchema(
  z.object({ path: z.string(), data: z.string(), truncated: z.boolean(), bytes: z.number() })
);

export const scpWriteRequestSchema = z.object({
  connectionId: z.string().optional(),
  path: z.string().min(1),
  data: z.string()
});

export const scpWriteResultSchema = resultSchema(
  z.object({ path: z.string(), bytes: z.number() })
);

export const sftpMkdirRequestSchema = z.object({
  connectionId: z.string().optional(),
  path: z.string().min(1)
});

export const sftpMkdirResultSchema = resultSchema(
  z.object({ path: z.string() })
);

export const sftpDeleteRequestSchema = z.object({
  connectionId: z.string().optional(),
  path: z.string().min(1)
});

export const sftpDeleteResultSchema = resultSchema(
  z.object({ path: z.string(), isDirectory: z.boolean() })
);

export const sftpRenameRequestSchema = z.object({
  connectionId: z.string().optional(),
  from: z.string().min(1),
  to: z.string().min(1)
});

export const sftpRenameResultSchema = resultSchema(
  z.object({ from: z.string(), to: z.string() })
);

export const sftpTransferListRequestSchema = z.object({ connectionId: z.string().min(1) });
export const sftpTransferListResultSchema = resultSchema(z.object({ transfers: z.array(z.object({
  id: z.string(), connectionId: z.string(), source: z.string(), target: z.string(),
  status: z.enum(["running", "done", "failed", "cancelled"]), total: z.number(), sent: z.number(), error: z.string()
})) }));
export const sftpTransferCancelRequestSchema = z.object({ connectionId: z.string().min(1), id: z.string().min(1) });
export const sftpTransferCancelResultSchema = resultSchema(z.object({ cancelled: z.boolean() }));
export const sftpTransferDiscardResultSchema = resultSchema(z.object({ discarded: z.boolean() }));
