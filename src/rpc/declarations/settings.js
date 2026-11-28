// settings wire types for the harbor service.
//
// Split out of typert.js: one file per RPC domain so a new method's request
// and result types land next to the schemas that define them.

export const SETTINGS_TYPES = [
  { name: "DshPermissionInfo", declaration: "export interface DshPermissionInfo { readonly preset: string | null; readonly sandbox: 'read-only' | 'workspace-write' | 'danger-full-access' | null; readonly approval: 'ask' | 'never' | null; readonly ceiling: 'auto' | 'allowAll' | 'standard' | 'readOnly'; readonly source: 'dsh-auto' | 'dsh-full-access' | 'dsh-workspace-write' | 'dsh-read-only'; }" },
];
