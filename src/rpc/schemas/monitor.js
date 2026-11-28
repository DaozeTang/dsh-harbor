import { z } from "zod";
import { resultSchema } from "./common.js";

// ── system monitor (read-only status panel + ssh_status) ─────────────────────

/**
 * connectionId is optional: the host resolves the caller's current connection
 * when it is omitted, exactly like the agent tools do. The panel always sends
 * one, so a stale panel can never silently sample a different server.
 */
export const systemStatsRequestSchema = z.object({
  connectionId: z.string().min(1).max(128).optional(),
  refresh: z.boolean().optional()
});

const statBytes = z.number().min(0);
const statPercent = z.number().min(0).max(100).nullable();

const systemStatsHostSchema = z.object({
  hostname: z.string().optional(),
  os: z.string().optional(),
  kernel: z.string().optional(),
  arch: z.string().optional(),
  cores: z.number().int().min(1).optional(),
  cpuModel: z.string().optional(),
  uptimeSeconds: z.number().min(0).optional()
});

const systemStatsCpuSchema = z.object({
  usagePercent: statPercent,
  perCore: z.array(statPercent).nullable(),
  iowaitPercent: statPercent.optional(),
  stealPercent: statPercent.optional(),
  load: z.tuple([z.number(), z.number(), z.number()]).nullable(),
  cores: z.number().int().min(1).nullable().optional(),
  model: z.string().nullable().optional()
});

const systemStatsMemorySchema = z.object({
  totalBytes: statBytes,
  freeBytes: statBytes,
  availableBytes: statBytes,
  buffersBytes: statBytes,
  cachedBytes: statBytes,
  swapTotalBytes: statBytes,
  swapFreeBytes: statBytes
});

const systemStatsGpuSchema = z.object({
  index: z.number().int().min(0),
  name: z.string(),
  utilizationPercent: statPercent,
  memoryUsedBytes: statBytes.nullable(),
  memoryTotalBytes: statBytes.nullable(),
  temperatureC: z.number().nullable(),
  powerW: z.number().nullable()
});

const systemStatsDiskSchema = z.object({
  mount: z.string(),
  device: z.string(),
  totalBytes: statBytes,
  usedBytes: statBytes,
  availableBytes: statBytes,
  usePercent: z.number().min(0).max(100)
});

const systemStatsDiskIoSchema = z.object({
  readBytesPerSec: z.number().min(0),
  writeBytesPerSec: z.number().min(0)
});

const systemStatsNetworkSchema = z.object({
  name: z.string(),
  rxBytesPerSec: z.number().min(0).nullable(),
  txBytesPerSec: z.number().min(0).nullable(),
  rxTotalBytes: statBytes,
  txTotalBytes: statBytes
});

const systemStatsProcessSchema = z.object({
  pid: z.number().int().min(0),
  name: z.string(),
  cpuPercent: z.number().min(0),
  memPercent: z.number().min(0)
});

const systemStatsProcessesSchema = z.object({
  total: z.number().int().nullable(),
  running: z.number().int().nullable(),
  top: z.array(systemStatsProcessSchema)
});

const systemStatsCapabilitiesSchema = z.object({
  processes: z.boolean(),
  gpu: z.boolean(),
  disks: z.boolean(),
  io: z.boolean()
});

export const systemStatsResultSchema = resultSchema(
  z.object({
    sampledAt: z.string(),
    sampleMs: z.number().min(0),
    platform: z.enum(["linux", "other"]),
    platformName: z.string().optional(),
    supported: z.boolean(),
    // Machine-readable, so the panel owns the wording (and an older panel can
    // fall back to a generic sentence instead of showing a raw code).
    reason: z.enum(["no-posix-shell", "no-procfs", "probe-empty"]).optional(),
    warmingUp: z.boolean().optional(),
    host: systemStatsHostSchema.optional(),
    cpu: systemStatsCpuSchema.optional(),
    memory: systemStatsMemorySchema.optional(),
    gpu: z.array(systemStatsGpuSchema),
    disks: z.array(systemStatsDiskSchema),
    diskIo: systemStatsDiskIoSchema.nullable(),
    network: z.array(systemStatsNetworkSchema),
    processes: systemStatsProcessesSchema.nullable(),
    capabilities: systemStatsCapabilitiesSchema,
    warnings: z.array(z.string())
  })
);
