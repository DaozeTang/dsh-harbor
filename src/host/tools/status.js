
/**
 * Agent tool: read the same normalized status sample the panel's status tab
 * shows.
 *
 * It exists so "how much disk is left?" is answered from one audited probe
 * instead of a hand-written df/free pipeline per question — the same numbers
 * the operator sees on screen, one round trip, no approval prompt, nothing
 * written on the remote host.
 */
import { defineTool } from "@deepseek-ai/dsh-tools";

const KIB = 1024;
const MIB = KIB * 1024;
const GIB = MIB * 1024;

/** Human units for the model: GiB once it is big, MiB/KiB below that. */
function size(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "?";
  if (bytes >= GIB) return (bytes / GIB).toFixed(1) + " GiB";
  if (bytes >= MIB) return (bytes / MIB).toFixed(1) + " MiB";
  if (bytes >= KIB) return (bytes / KIB).toFixed(0) + " KiB";
  return bytes + " B";
}

function rate(bytesPerSecond) {
  if (typeof bytesPerSecond !== "number" || !Number.isFinite(bytesPerSecond)) return "?";
  return size(bytesPerSecond) + "/s";
}

function percent(value, digits = 1) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "?";
  return value.toFixed(digits) + "%";
}

function duration(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "?";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return days + "d " + hours + "h";
  if (hours > 0) return hours + "h " + minutes + "m";
  return minutes + "m";
}

function gpuLine(gpu) {
  const parts = ["GPU" + gpu.index, gpu.name, percent(gpu.utilizationPercent, 0)];
  if (gpu.memoryTotalBytes !== null && gpu.memoryUsedBytes !== null) {
    parts.push(size(gpu.memoryUsedBytes) + "/" + size(gpu.memoryTotalBytes));
  }
  if (gpu.temperatureC !== null) parts.push(gpu.temperatureC + "C");
  if (gpu.powerW !== null) parts.push(gpu.powerW + "W");
  return parts.join(" · ");
}

/** The text the model reads. Compact on purpose: it is a status line set. */
export function renderStatusText(value) {
  if (value?.supported !== true) {
    const why = value?.reason === "no-posix-shell"
      ? "the server has no POSIX shell on the exec channel"
      : value?.reason === "no-procfs"
        ? "the remote OS has no /proc (only Linux hosts are supported)"
        : "the probe returned nothing usable";
    return "System status is unavailable on this host: " + why + ".";
  }
  const lines = [];
  const host = value.host ?? {};
  const head = [host.hostname, host.os, host.kernel ? "kernel " + host.kernel : null, host.arch,
    host.uptimeSeconds !== undefined ? "up " + duration(host.uptimeSeconds) : null].filter(Boolean);
  if (head.length > 0) lines.push(head.join(" · "));

  if (value.cpu !== undefined) {
    const cores = value.cpu.cores !== null && value.cpu.cores !== undefined ? " (" + value.cpu.cores + " cores)" : "";
    const load = value.cpu.load !== null ? ", load " + value.cpu.load.map((n) => n.toFixed(2)).join("/") : "";
    lines.push("cpu: " + percent(value.cpu.usagePercent) + cores + load);
  }
  if (value.memory !== undefined) {
    const mem = value.memory;
    const used = Math.max(0, mem.totalBytes - mem.availableBytes);
    lines.push("memory: " + size(used) + " used of " + size(mem.totalBytes) + ", available " + size(mem.availableBytes)
      + ", swap " + size(Math.max(0, mem.swapTotalBytes - mem.swapFreeBytes)) + "/" + size(mem.swapTotalBytes));
  }
  if (Array.isArray(value.gpu) && value.gpu.length > 0) {
    lines.push("gpu: " + value.gpu.map(gpuLine).join("; "));
  }
  if (Array.isArray(value.disks) && value.disks.length > 0) {
    lines.push("disks: " + value.disks.map((disk) => disk.mount + " " + percent(disk.usePercent, 0)
      + " (" + size(disk.usedBytes) + "/" + size(disk.totalBytes) + ")").join(" · "));
  }
  if (value.diskIo !== null && value.diskIo !== undefined) {
    lines.push("disk io: read " + rate(value.diskIo.readBytesPerSec) + ", write " + rate(value.diskIo.writeBytesPerSec));
  }
  if (Array.isArray(value.network) && value.network.length > 0) {
    lines.push("network: " + value.network.map((iface) => iface.name + " down " + rate(iface.rxBytesPerSec)
      + " up " + rate(iface.txBytesPerSec)).join(" · "));
  }
  if (value.processes !== null && value.processes !== undefined) {
    const total = value.processes.total !== null ? " (" + value.processes.total + " threads)" : "";
    const top = value.processes.top.map((proc) => proc.name + "#" + proc.pid + " " + percent(proc.cpuPercent, 0) + " cpu "
      + percent(proc.memPercent, 0) + " mem").join(" · ");
    if (top !== "") lines.push("top by cpu" + total + ": " + top);
  }
  lines.push("sampled " + value.sampledAt + " in " + value.sampleMs + "ms");
  return lines.join("\n");
}

export function registerStatusTools(ctx, service) {
  ctx.tools.register(defineTool({
    name: "ssh_status",
    description: "Read a read-only system status snapshot from an SSH server: CPU usage and load average, memory, NVIDIA GPUs, disk usage and I/O, network throughput, uptime, and the busiest processes. Nothing is written on the remote host and no approval is needed. Use this instead of writing your own df/free/top command when the operator asks how a machine is doing. Omit connection_id to read the current server.",
    parameters: {
      connection_id: { type: "string", description: "Optional. Omit to target the current right-side SSH connection." },
      refresh: { type: "boolean", description: "Bypass the 1s sample cache and re-read the slow parts (mount table, disk I/O)." }
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render(_args, value) { return [{ type: "text", text: renderStatusText(value) }]; }
    },
    async execute(args, exec) {
      const ownerSessionId = service.terminalOwner?.(exec?.agent) ?? undefined;
      const selected = service.resolveConnection(args.connection_id, ownerSessionId);
      if (!selected.ok) throw new Error("ssh_status failed: " + selected.error.message);
      // Read-only, but still agent activity: reveal the machine and light the
      // panel's activity indicator. No terminal is forced for a status read.
      try {
        await service.touchAgentTarget?.({ connectionId: selected.connectionId, ownerSessionId, kind: "status", ensureTerminal: false });
      } catch {}
      const result = await service.systemStats({ connectionId: selected.connectionId, refresh: args.refresh === true });
      if (!result.ok) throw new Error("ssh_status failed: " + result.error.message);
      return result.value;
    }
  }));
}
