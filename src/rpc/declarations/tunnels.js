// tunnels wire types for the harbor service.
//
// Split out of typert.js: one file per RPC domain so a new method's request
// and result types land next to the schemas that define them.

export const TUNNELS_TYPES = [
  { name: "TunnelStartLocalRequest", declaration: "export interface TunnelStartLocalRequest { readonly connectionId?: string; readonly bindAddr?: string; readonly bindPort?: number; readonly remoteHost: string; readonly remotePort: number; }" },
  { name: "TunnelStartLocalResult", declaration: "export type TunnelStartLocalResult = SshResult<{ tunnelId: string; kind: 'local'; bindAddr: string; bindPort: number; remoteHost: string; remotePort: number }>;" },
  { name: "TunnelStartRemoteRequest", declaration: "export interface TunnelStartRemoteRequest { readonly connectionId?: string; readonly bindAddr?: string; readonly bindPort?: number; readonly remoteHost: string; readonly remotePort: number; readonly targetHost: string; readonly targetPort: number; }" },
  { name: "TunnelStartRemoteResult", declaration: "export type TunnelStartRemoteResult = SshResult<{ tunnelId: string; kind: 'remote'; bindAddr: string; bindPort: number; remoteHost: string; remotePort: number; targetHost: string; targetPort: number }>;" },
  { name: "TunnelStopRequest", declaration: "export interface TunnelStopRequest { readonly connectionId?: string; readonly tunnelId: string; }" },
  { name: "TunnelStopResult", declaration: "export type TunnelStopResult = SshResult<{ tunnelId: string; stopped: boolean }>;" },
  { name: "TunnelListRequest", declaration: "export interface TunnelListRequest { readonly connectionId?: string; }" },
  { name: "TunnelListResult", declaration: "export type TunnelListResult = SshResult<{ tunnels: TunnelInfo[] }>;" },
  { name: "TunnelStartDynamicRequest", declaration: "export interface TunnelStartDynamicRequest { readonly connectionId?: string; readonly bindAddr?: string; readonly bindPort?: number; }" },
  { name: "TunnelStartDynamicResult", declaration: "export type TunnelStartDynamicResult = SshResult<{ tunnelId: string; kind: 'dynamic'; bindAddr: string; bindPort: number }>;" },
  { name: "TunnelInfo", declaration: "export interface TunnelInfo { readonly tunnelId: string; readonly kind: string; readonly bindAddr: string; readonly bindPort: number; readonly remoteHost?: string; readonly remotePort?: number; readonly targetHost?: string; readonly targetPort?: number; readonly connections?: number; readonly active: boolean; }" },
];
