import { z } from "zod";
import { resultSchema } from "./common.js";


// ── Port forwarding ──────────────────────────────────────────────────────────

export const tunnelStartLocalRequestSchema = z.object({
  connectionId: z.string().optional(),
  bindAddr: z.string().optional(),
  bindPort: z.number().int().min(0).max(65535).optional(),
  remoteHost: z.string().min(1),
  remotePort: z.number().int().min(1).max(65535)
});

export const tunnelStartDynamicRequestSchema = z.object({
  connectionId: z.string().optional(),
  bindAddr: z.string().optional(),
  bindPort: z.number().int().min(0).max(65535).optional()
});

export const tunnelStartDynamicResultSchema = resultSchema(
  z.object({
    tunnelId: z.string(),
    kind: z.literal("dynamic"),
    bindAddr: z.string(),
    bindPort: z.number()
  })
);

export const tunnelStartLocalResultSchema = resultSchema(
  z.object({
    tunnelId: z.string(),
    kind: z.literal("local"),
    bindAddr: z.string(),
    bindPort: z.number(),
    remoteHost: z.string(),
    remotePort: z.number()
  })
);

export const tunnelStartRemoteRequestSchema = z.object({
  connectionId: z.string().optional(),
  bindAddr: z.string().optional(),
  bindPort: z.number().int().min(0).max(65535).optional(),
  remoteHost: z.string().min(1),
  remotePort: z.number().int().min(1).max(65535),
  targetHost: z.string().min(1),
  targetPort: z.number().int().min(1).max(65535)
});

export const tunnelStartRemoteResultSchema = resultSchema(
  z.object({
    tunnelId: z.string(),
    kind: z.literal("remote"),
    bindAddr: z.string(),
    bindPort: z.number(),
    remoteHost: z.string(),
    remotePort: z.number(),
    targetHost: z.string(),
    targetPort: z.number()
  })
);

export const tunnelStopRequestSchema = z.object({
  connectionId: z.string().optional(),
  tunnelId: z.string().min(1)
});

export const tunnelStopResultSchema = resultSchema(
  z.object({ tunnelId: z.string(), stopped: z.boolean() })
);

export const tunnelListRequestSchema = z.object({
  connectionId: z.string().optional()
});

export const tunnelListResultSchema = resultSchema(
  z.object({
    tunnels: z.array(z.object({
      tunnelId: z.string(),
      kind: z.string(),
      bindAddr: z.string(),
      bindPort: z.number(),
      remoteHost: z.string().optional(),
      remotePort: z.number().optional(),
      targetHost: z.string().optional(),
      targetPort: z.number().optional(),
      /** Dynamic tunnels only: accepted client connections right now. */
      connections: z.number().int().nonnegative().optional(),
      active: z.boolean()
    }))
  })
);
