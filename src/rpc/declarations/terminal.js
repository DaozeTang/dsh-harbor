// terminal wire types for the harbor service.
//
// Split out of typert.js: one file per RPC domain so a new method's request
// and result types land next to the schemas that define them.

export const TERMINAL_TYPES = [
  { name: "SessionLogInfo", declaration: "export interface SessionLogInfo { readonly sessionId: string; readonly connectionId: string | null; readonly name: string | null; readonly host: string | null; readonly port: number | null; readonly openedBy: string | null; readonly startedAt: string; readonly endedAt: string | null; readonly exitCode: number | null; readonly bytes: number; readonly truncated: boolean; }" },
  { name: "SessionLogListRequest", declaration: "export interface SessionLogListRequest {}" },
  { name: "SessionLogListResult", declaration: "export type SessionLogListResult = SshResult<{ enabled: boolean; logs: SessionLogInfo[] }>;" },
  { name: "SessionLogReadRequest", declaration: "export interface SessionLogReadRequest { readonly sessionId: string; readonly offset?: number; readonly maxBytes?: number; }" },
  { name: "SessionLogReadResult", declaration: "export type SessionLogReadResult = SshResult<{ sessionId: string; data: string; startOffset: number; nextOffset: number; eof: boolean; size: number }>;" },
  { name: "SessionLogSearchRequest", declaration: "export interface SessionLogSearchRequest { readonly sessionId: string; readonly query: string; readonly maxHits?: number; }" },
  { name: "SessionLogSearchResult", declaration: "export type SessionLogSearchResult = SshResult<{ sessionId: string; hits: { offset: number; line: string }[]; scannedBytes: number; stoppedEarly: boolean }>;" },
  { name: "SessionLogDeleteRequest", declaration: "export interface SessionLogDeleteRequest { readonly sessionId?: string; }" },
  { name: "SessionLogDeleteResult", declaration: "export type SessionLogDeleteResult = SshResult<{ deleted: number; remaining: number }>;" },
];
