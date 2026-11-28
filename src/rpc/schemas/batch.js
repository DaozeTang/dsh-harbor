import { z } from "zod";
import { resultSchema } from "./common.js";

// ── batch exec (profile-selected, operator-confirmed) ────────────────────────

export const batchPlanRequestSchema = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().min(1000).max(120000).optional()
});

const batchTaskSchema = z.object({
  batchId: z.string(),
  command: z.string(),
  timeoutMs: z.number(),
  dangerous: z.boolean(),
  reason: z.string().nullable(),
  createdAt: z.string()
});

export const batchPlanResultSchema = resultSchema(z.object({ task: batchTaskSchema }));

export const batchTaskListRequestSchema = z.object({});
export const batchTaskListResultSchema = resultSchema(z.object({ tasks: z.array(batchTaskSchema) }));

export const batchRunRequestSchema = z.object({
  batchId: z.string(),
  profileIds: z.array(z.string()).min(1)
});

/**
 * One per-host outcome row.
 *
 * `ok` means the command reached an exit status. A command killed by the
 * per-host deadline reports ok:false with timedOut:true and keeps the output
 * that arrived first; `truncated` says the tail was cut by the output cap.
 * Every field has to be declared here: the codec strips what it does not
 * know, which is how a killed command used to reach the panel looking exactly
 * like a clean success.
 */
export const batchRunRowSchema = z.object({
  profileId: z.string(),
  name: z.string(),
  host: z.string(),
  ok: z.boolean(),
  timedOut: z.boolean(),
  truncated: z.boolean(),
  exitCode: z.union([z.number(), z.null()]),
  stdout: z.string(),
  stderr: z.string(),
  error: z.string().nullable()
});

export const batchRunResultSchema = resultSchema(z.object({ results: z.array(batchRunRowSchema) }));

export const batchCancelRequestSchema = z.object({ batchId: z.string() });
export const batchCancelResultSchema = resultSchema(z.object({ cancelled: z.boolean() }));
