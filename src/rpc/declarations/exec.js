// exec wire types for the harbor service.
//
// Split out of typert.js: one file per RPC domain so a new method's request
// and result types land next to the schemas that define them.

export const EXEC_TYPES = [
  { name: "ExecPolicyMode", declaration: "export type ExecPolicyMode = 'standard' | 'custom' | 'allowAll';" },
  { name: "ExecPolicyGetRequest", declaration: "export interface ExecPolicyGetRequest { readonly connectionId?: string; readonly sessionId?: string; }" },
  { name: "ExecPolicyGetResult", declaration: "export type ExecPolicyGetResult = SshResult<{ effective: ExecPolicyMode; source: 'session' | 'profile' | 'global' | 'default'; allow: string[]; global: { policy: ExecPolicyMode; allow: string[] }; profileOverride: ExecPolicyMode | null; dsh?: DshPermissionInfo; approval?: 'ask' | 'never'; }>;" },
  { name: "ExecPolicySetRequest", declaration: "export interface ExecPolicySetRequest { readonly connectionId: string; readonly policy: ExecPolicyMode; readonly sessionId?: string; }" },
  { name: "ExecPolicySetResult", declaration: "export type ExecPolicySetResult = ExecPolicyGetResult;" },
];
