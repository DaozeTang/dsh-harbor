// batch wire types for the harbor service.
//
// Split out of typert.js: one file per RPC domain so a new method's request
// and result types land next to the schemas that define them.

export const BATCH_TYPES = [
  { name: "BatchPlanRequest", declaration: "export interface BatchPlanRequest { readonly command: string; readonly timeoutMs?: number; }" },
  { name: "BatchTask", declaration: "export interface BatchTask { readonly batchId: string; readonly command: string; readonly timeoutMs: number; readonly dangerous: boolean; readonly reason: string | null; readonly createdAt: string; }" },
  { name: "BatchPlanResult", declaration: "export type BatchPlanResult = SshResult<{ task: BatchTask }>;" },
  { name: "BatchTaskListRequest", declaration: "export interface BatchTaskListRequest {}" },
  { name: "BatchTaskListResult", declaration: "export type BatchTaskListResult = SshResult<{ tasks: BatchTask[] }>;" },
  { name: "BatchRunRequest", declaration: "export interface BatchRunRequest { readonly batchId: string; readonly profileIds: string[]; }" },
  { name: "BatchRunResult", declaration: "export type BatchRunResult = SshResult<{ results: { profileId: string; name: string; host: string; ok: boolean; timedOut: boolean; truncated: boolean; exitCode: number | null; stdout: string; stderr: string; error: string | null }[] }>;" },
  { name: "BatchCancelRequest", declaration: "export interface BatchCancelRequest { readonly batchId: string; }" },
  { name: "BatchCancelResult", declaration: "export type BatchCancelResult = SshResult<{ cancelled: boolean }>;" },
];
