import { z } from "zod";
import { resultSchema } from "./common.js";

// ── session logs (recording) ─────────────────────────────────────────────────

const sessionLogInfoSchema = z.object({
  sessionId: z.string(),
  connectionId: z.string().nullable(),
  name: z.string().nullable(),
  host: z.string().nullable(),
  port: z.number().nullable(),
  openedBy: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  exitCode: z.number().nullable(),
  bytes: z.number(),
  truncated: z.boolean()
});

export const sessionLogListRequestSchema = z.object({});
export const sessionLogListResultSchema = resultSchema(
  z.object({ enabled: z.boolean(), logs: z.array(sessionLogInfoSchema) })
);

export const sessionLogReadRequestSchema = z.object({
  sessionId: z.string().min(1),
  offset: z.number().int().min(0).optional(),
  maxBytes: z.number().int().min(1).max(4194304).optional()
});
export const sessionLogReadResultSchema = resultSchema(
  z.object({
    sessionId: z.string(),
    data: z.string(),
    startOffset: z.number(),
    nextOffset: z.number(),
    eof: z.boolean(),
    size: z.number()
  })
);

export const sessionLogSearchRequestSchema = z.object({
  sessionId: z.string().min(1),
  query: z.string().min(1),
  maxHits: z.number().int().min(1).max(1000).optional()
});
export const sessionLogSearchResultSchema = resultSchema(
  z.object({
    sessionId: z.string(),
    hits: z.array(z.object({ offset: z.number(), line: z.string() })),
    scannedBytes: z.number(),
    stoppedEarly: z.boolean()
  })
);

export const sessionLogDeleteRequestSchema = z.object({ sessionId: z.string().min(1).optional() });
export const sessionLogDeleteResultSchema = resultSchema(
  z.object({ deleted: z.number(), remaining: z.number() })
);
