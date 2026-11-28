// resources wire types for the harbor service.
//
// Split out of typert.js: one file per RPC domain so a new method's request
// and result types land next to the schemas that define them.

export const RESOURCES_TYPES = [
  { name: "ResourceBackupExportRequest", declaration: "export interface ResourceBackupExportRequest { readonly password: string; }" },
  { name: "ResourceBackupExportResult", declaration: "export type ResourceBackupExportResult = SshResult<{ archive: string }>;" },
  { name: "ProfileConnectionStatusResult", declaration: "export type ProfileConnectionStatusResult = SshResult<{ profileIds: readonly string[] }>;" },
  { name: "OpenSshImportRequest", declaration: "export interface OpenSshImportRequest { readonly selection?: { fingerprint: string; names: readonly string[]; groupId: string | null }; }" },
  { name: "OpenSshImportResult", declaration: "export type OpenSshImportResult = SshResult<{ preview: { fingerprint: string; entries: readonly { name: string; host: string; username: string; port: number; hops: readonly string[]; issues: readonly string[]; unsupported: boolean; existing: boolean; authKind: 'key' | 'password'; keyPath: string | null; keyStatus: 'ready' | 'passphrase' | 'missing' | 'unreadable' | 'invalid' | null }[] } } | { imported: { created: number; keysImported: number; passphraseRequired: readonly string[]; skipped: readonly string[]; failed: readonly string[]; details: readonly { name: string; reason: 'unsupported' | 'cycle' | 'repeated' | 'missing' | 'save' | 'key'; items: readonly string[] }[] } }>;" },
  { name: "ResourceBackupImportRequest", declaration: "export interface ResourceBackupImportRequest { readonly password: string; readonly archive: string; readonly skipDuplicates?: boolean; }" },
  { name: "ResourceBackupImportResult", declaration: "export type ResourceBackupImportResult = SshResult<{ profiles: number; groups: number; credentials: number; duplicates?: readonly string[]; skipped?: number; retained?: readonly string[] }>;" },
];
