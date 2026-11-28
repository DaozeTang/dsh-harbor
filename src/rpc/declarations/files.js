// files wire types for the harbor service.
//
// Split out of typert.js: one file per RPC domain so a new method's request
// and result types land next to the schemas that define them.

export const FILES_TYPES = [
  { name: "SftpListRequest", declaration: "export interface SftpListRequest { readonly connectionId?: string; readonly path?: string; }" },
  { name: "SftpListResult", declaration: "export type SftpListResult = SshResult<{ path: string; entries: SftpEntry[] }>;" },
  { name: "SftpStatRequest", declaration: "export interface SftpStatRequest { readonly connectionId?: string; readonly path: string; }" },
  { name: "SftpStatResult", declaration: "export type SftpStatResult = SshResult<SftpStat>;" },
  { name: "SftpReadRequest", declaration: "export interface SftpReadRequest { readonly connectionId?: string; readonly path: string; readonly maxBytes?: number; }" },
  { name: "SftpReadResult", declaration: "export type SftpReadResult = SshResult<{ path: string; data: string; truncated: boolean; bytes: number }>;" },
  { name: "SftpWriteRequest", declaration: "export interface SftpWriteRequest { readonly connectionId?: string; readonly path: string; readonly data: string; }" },
  { name: "SftpWriteResult", declaration: "export type SftpWriteResult = SshResult<{ path: string; bytes: number }>;" },
  { name: "SftpEditorSaveRequest", declaration: "export interface SftpEditorSaveRequest { readonly connectionId?: string; readonly path: string; readonly expected: string; readonly data: string; }" },
  { name: "SftpEditorSaveResult", declaration: "export type SftpEditorSaveResult = SshResult<{ bytes: number }>;" },
  { name: "ScpReadRequest", declaration: "export interface ScpReadRequest { readonly connectionId?: string; readonly path: string; readonly maxBytes?: number; }" },
  { name: "ScpReadResult", declaration: "export type ScpReadResult = SshResult<{ path: string; data: string; truncated: boolean; bytes: number }>;" },
  { name: "ScpWriteRequest", declaration: "export interface ScpWriteRequest { readonly connectionId?: string; readonly path: string; readonly data: string; }" },
  { name: "ScpWriteResult", declaration: "export type ScpWriteResult = SshResult<{ path: string; bytes: number }>;" },
  { name: "SftpMkdirRequest", declaration: "export interface SftpMkdirRequest { readonly connectionId?: string; readonly path: string; }" },
  { name: "SftpMkdirResult", declaration: "export type SftpMkdirResult = SshResult<{ path: string }>;" },
  { name: "SftpDeleteRequest", declaration: "export interface SftpDeleteRequest { readonly connectionId?: string; readonly path: string; }" },
  { name: "SftpDeleteResult", declaration: "export type SftpDeleteResult = SshResult<{ path: string; isDirectory: boolean }>;" },
  { name: "SftpTransferListRequest", declaration: "export interface SftpTransferListRequest { readonly connectionId: string; }" },
  { name: "SftpTransferListResult", declaration: "export type SftpTransferListResult = SshResult<{ transfers: Array<{ id: string; connectionId: string; source: string; target: string; status: 'running' | 'done' | 'failed' | 'cancelled'; total: number; sent: number; error: string }> }>;" },
  { name: "SftpTransferCancelRequest", declaration: "export interface SftpTransferCancelRequest { readonly connectionId: string; readonly id: string; }" },
  { name: "SftpTransferDiscardResult", declaration: "export type SftpTransferDiscardResult = SshResult<{ discarded: boolean }>;" },
  { name: "SftpTransferCancelResult", declaration: "export type SftpTransferCancelResult = SshResult<{ cancelled: boolean }>;" },
  { name: "SftpRenameRequest", declaration: "export interface SftpRenameRequest { readonly connectionId?: string; readonly from: string; readonly to: string; }" },
  { name: "SftpRenameResult", declaration: "export type SftpRenameResult = SshResult<{ from: string; to: string }>;" },
  { name: "SftpEntry", declaration: "export interface SftpEntry { readonly name: string; readonly isDirectory: boolean; readonly size: number; readonly mtime: number; readonly mode: number; }" },
  { name: "SftpStat", declaration: "export interface SftpStat { readonly path: string; readonly isDirectory: boolean; readonly size: number; readonly mtime: number; readonly mode: number; }" },
];
