import { z } from "zod";
import { profileIdSchema, resultSchema } from "./common.js";

// ── remote workspaces ───────────────────────────────────────────
//
// A workspace stays a host directory; only its *file work* is redirected to a
// saved SSH resource. `workspacePath` is the canonical directory DSH stores for
// the Workspace, so it doubles as the row identity.
const remoteWorkspaceBindingSchema = z.object({
  workspacePath: z.string().min(1),
  remotePath: z.string().min(1),
  profileId: profileIdSchema,
  profileName: z.string(),
  host: z.string(),
  port: z.number().int(),
  username: z.string(),
  autoConnect: z.boolean(),
  // Whether the bound resource currently holds a live connection.
  connected: z.boolean(),
  // The binding points at a resource that was deleted.
  missingResource: z.boolean().optional()
});

const remoteWorkspaceCandidateSchema = z.object({
  path: z.string().min(1),
  title: z.string()
});

export const remoteWorkspaceListRequestSchema = z.object({});
export const remoteWorkspaceListResultSchema = resultSchema(z.object({
  bindings: z.array(remoteWorkspaceBindingSchema),
  workspaces: z.array(remoteWorkspaceCandidateSchema)
}));

export const remoteWorkspaceSaveRequestSchema = z.object({
  workspacePath: z.string().min(1),
  profileId: profileIdSchema,
  remotePath: z.string().min(1),
  autoConnect: z.boolean().optional()
});
export const remoteWorkspaceSaveResultSchema = resultSchema(z.object({ binding: remoteWorkspaceBindingSchema }));

export const remoteWorkspaceDeleteRequestSchema = z.object({ workspacePath: z.string().min(1) });
export const remoteWorkspaceDeleteResultSchema = resultSchema(z.object({ removed: z.boolean() }));
