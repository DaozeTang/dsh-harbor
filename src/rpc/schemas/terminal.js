import { z } from "zod";
import { ownerSessionIdSchema, resultSchema } from "./common.js";

// ── open shell session ──────────────────────────────────────────────────────

export const openSessionRequestSchema = z.object({
  connectionId: z.string().min(1),
  cols: z.number().int().min(2).max(500).optional(),
  rows: z.number().int().min(1).max(200).optional(),
  openedBy: z.enum(["panel", "agent"]).optional(),
  // The conversation that will own the terminal. Absent opens an anonymous
  // terminal, which the first conversation that asks may adopt.
  sessionId: ownerSessionIdSchema.optional(),
  // false refuses to adopt this connection's single anonymous terminal.
  adopt: z.boolean().optional(),
  // Open a fresh shell even when this conversation already owns one here. The
  // panel re-requests its terminal on every layout change, so reuse is the
  // default; this exists for the "the person took the shell over" path and for
  // callers that really need a second PTY.
  forceNew: z.boolean().optional()
});

const sessionInfoSchema = z.object({
  sessionId: z.string(),
  connectionId: z.string(),
  cols: z.number(),
  rows: z.number(),
  alive: z.boolean(),
  ownerSessionId: z.string().nullable(),
  // true when an existing terminal was returned rather than created.
  reused: z.boolean(),
  // true when an anonymous terminal was claimed instead of created.
  adopted: z.boolean().optional()
});

export const openSessionResultSchema = resultSchema(sessionInfoSchema);

// ── write ───────────────────────────────────────────────────────────────────

export const writeRequestSchema = z.object({
  sessionId: z.string().min(1),
  data: z.string()
});

export const writeResultSchema = resultSchema(
  z.object({ written: z.number() })
);

// ── read ────────────────────────────────────────────────────────────────────

export const readRequestSchema = z.object({
  sessionId: z.string().min(1),
  timeoutMs: z.number().int().min(0).max(60000).optional(),
  after: z.number().int().nonnegative().safe().optional()
});

// Stream push: one sessionId, endless item stream. Each yielded item reuses
// the read() envelope so the client render path stays identical.
export const terminalStreamRequestSchema = z.object({
  sessionId: z.string().min(1),
  after: z.number().int().nonnegative().safe().optional()
});

export const changeDirectoryRequestSchema = z.object({
  sessionId: z.string().min(1),
  path: z.string().min(1).max(4096).refine((path) => path.startsWith("/") && !/[\x00-\x1f\x7f]/.test(path))
});

export const readResultSchema = resultSchema(
  z.object({
    data: z.string(),
    startOffset: z.number().int().nonnegative().optional(),
    offset: z.number().int().nonnegative().optional(),
    exit: z.union([z.object({ code: z.number(), signal: z.number().optional(), reason: z.enum(["remote-exit", "remote-signal", "channel-closed", "channel-error", "transport-lost", "operator-close", "session-closed"]).optional() }), z.null()])
  })
);

// ── resize ──────────────────────────────────────────────────────────────────

export const resizeRequestSchema = z.object({
  sessionId: z.string().min(1),
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(1).max(200)
});

export const resizeResultSchema = resultSchema(
  z.object({ cols: z.number(), rows: z.number() })
);

// ── close session ───────────────────────────────────────────────────────────

export const closeSessionRequestSchema = z.object({
  sessionId: z.string().min(1)
});

export const closeSessionResultSchema = resultSchema(
  z.object({ closed: z.boolean() })
);
