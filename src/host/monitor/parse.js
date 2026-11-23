
/**
 * Parsers for the remote probe output. Every function here is pure and takes
 * the raw text lines, so the whole /proc dialect can be tested from fixtures
 * without an SSH connection.
 *
 * The probe prints "#section" markers; parseProbe() splits on them once and
 * hands each section to its own parser. Unknown sections are ignored, which is
 * how a newer script can talk to an older parser.
 */

/** Pseudo filesystems that are never worth a row in the disk list. */
const PSEUDO_DEVICES = new Set([
  "tmpfs", "devtmpfs", "devfs", "udev", "shm", "overlay", "overlayfs", "none",
  "proc", "sysfs", "cgroup", "cgroup2", "devpts", "mqueue", "hugetlbfs",
  "debugfs", "tracefs", "securityfs", "pstore", "bpf", "configfs",
  "fusectl", "autofs", "binfmt_misc", "rpc_pipefs", "nsfs", "squashfs",
  "ramfs", "efivarfs", "map", "sunrpc", "selinuxfs", "fuse.lxcfs", "lxcfs"
]);

/** Physical block devices only: no partitions, no device-mapper double count. */
const PHYSICAL_DISK = /^(?:sd[a-z]+|hd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;

/** One "key=value" line of the #meta section. */
export function parseMetaLines(lines) {
  const meta = {};
  for (const line of lines) {
    const at = line.indexOf("=");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    const value = stripQuotes(line.slice(at + 1).trim());
    if (key !== "" && value !== "") meta[key] = value;
  }
  const cores = Number.parseInt(meta.cores, 10);
  return {
    sysname: meta.sysname ?? null,
    kernel: meta.kernel ?? null,
    arch: meta.arch ?? null,
    hostname: meta.host ?? null,
    os: meta.os ?? null,
    cpuModel: meta.model ?? null,
    cores: Number.isFinite(cores) && cores > 0 ? cores : null
  };
}

function stripQuotes(value) {
  if (value.length >= 2 && (value[0] === "\"" || value[0] === "'") && value[value.length - 1] === value[0]) {
    return value.slice(1, -1);
  }
  return value;
}

/** Split the probe output into sections keyed by their marker name. */
export function splitSections(stdout) {
  const sections = new Map();
  const lines = String(stdout ?? "").split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    const marker = /^#([a-z]+)\s*$/.exec(line);
    if (marker !== null) {
      current = marker[1];
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    if (current !== null && line !== "") sections.get(current).push(line);
  }
  return sections;
}

/**
 * /proc/stat cpu lines. Field layout: name user nice system idle iowait irq
 * softirq steal guest guest_nice — guest time is already folded into user, so
 * the last two fields are dropped instead of being double counted.
 */
export function parseCpuLines(lines) {
  const perCore = [];
  let total = null;
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const name = parts[0];
    if (!/^cpu\d*$/.test(name)) continue;
    const counters = [];
    for (let i = 1; i <= 8; i += 1) {
      const value = Number(parts[i] ?? 0);
      counters.push(Number.isFinite(value) && value >= 0 ? value : 0);
    }
    if (name === "cpu") total = counters;
    else perCore.push(counters);
  }
  if (total === null && perCore.length === 0) return null;
  return { total: total ?? sumCounters(perCore), perCore };
}

function sumCounters(list) {
  const total = [0, 0, 0, 0, 0, 0, 0, 0];
  for (const counters of list) {
    for (let i = 0; i < 8; i += 1) total[i] += counters[i] ?? 0;
  }
  return total;
}

/** /proc/meminfo in bytes. Cached folds in SReclaimable, as top does. */
export function parseMeminfo(lines) {
  const values = new Map();
  for (const line of lines) {
    const match = /^([A-Za-z_()]+):\s+(\d+)/.exec(line.trim());
    if (match === null) continue;
    values.set(match[1], Number(match[2]) * 1024);
  }
  const total = values.get("MemTotal");
  if (!Number.isFinite(total) || total <= 0) return null;
  const free = values.get("MemFree") ?? 0;
  const buffers = values.get("Buffers") ?? 0;
  const cached = (values.get("Cached") ?? 0) + (values.get("SReclaimable") ?? 0);
  const available = Number.isFinite(values.get("MemAvailable"))
    ? values.get("MemAvailable")
    : Math.max(0, total - free - buffers - cached);
  return {
    totalBytes: total,
    freeBytes: free,
    availableBytes: Math.max(0, Math.min(total, available)),
    buffersBytes: buffers,
    cachedBytes: cached,
    swapTotalBytes: values.get("SwapTotal") ?? 0,
    swapFreeBytes: values.get("SwapFree") ?? 0
  };
}

/** /proc/loadavg: three load averages, then running/total threads. */
export function parseLoadavg(lines) {
  const line = (lines.find((entry) => entry.trim() !== "") ?? "").trim();
  const parts = line.split(/\s+/);
  if (parts.length < 3) return null;
  const load = parts.slice(0, 3).map((value) => Number(value));
  if (load.some((value) => !Number.isFinite(value))) return null;
  const threads = /^(\d+)\/(\d+)$/.exec(parts[3] ?? "");
  return {
    load: [load[0], load[1], load[2]],
    running: threads === null ? null : Number(threads[1]),
    threads: threads === null ? null : Number(threads[2])
  };
}

/** Uptime in seconds; the probe already cuts the fractional part. */
export function parseUptime(lines) {
  const line = (lines.find((entry) => entry.trim() !== "") ?? "").trim();
  const seconds = Number.parseFloat(line);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds) : null;
}

/**
 * /proc/net/dev. Two header lines, then "iface: rx_bytes ... (8 counters) ...
 * tx_bytes ...". Byte counters are absolute; rates are computed by the sampler.
 */
export function parseNetDev(lines) {
  const interfaces = [];
  for (const line of lines) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const name = line.slice(0, at).trim();
    if (name === "" || name === "Inter-|" || name.startsWith("face")) continue;
    const counters = line.slice(at + 1).trim().split(/\s+/).map(Number);
    if (counters.length < 9 || !counters.every((value) => Number.isFinite(value))) continue;
    interfaces.push({ name, rxBytes: counters[0], txBytes: counters[8] });
  }
  return interfaces;
}

/**
 * df -P -k. A full mount table is noise (tmpfs, overlay, proc), and a machine
 * can have hundreds of mounts, so pseudo filesystems are dropped and the list
 * is capped to the fullest real ones.
 */
export function parseDf(lines, max = 8) {
  const mounts = [];
  for (const line of lines) {
    const match = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/.exec(line.trimEnd());
    if (match === null) continue;
    const device = match[1];
    const mount = match[6].trim();
    if (mount === "") continue;
    // Root always counts, even when it is an overlay or a tmpfs (containers):
    // dropping it left the disk card empty on a host that has exactly one
    // filesystem worth showing.
    if (mount !== "/" && PSEUDO_DEVICES.has(device)) continue;
    if (/^\/(?:dev|proc|sys|run)(?:\/|$)/.test(mount) && !/^\/dev\/disk/.test(device)) continue;
    const totalKb = Number(match[2]);
    const usedKb = Number(match[3]);
    const availableKb = Number(match[4]);
    const usePercent = Number(match[5]);
    if (!Number.isFinite(totalKb) || totalKb <= 0) continue;
    mounts.push({
      mount,
      device,
      totalBytes: totalKb * 1024,
      usedBytes: usedKb * 1024,
      availableBytes: availableKb * 1024,
      usePercent: Number.isFinite(usePercent) ? Math.max(0, Math.min(100, usePercent)) : 0
    });
  }
  mounts.sort((a, b) => b.usePercent - a.usePercent || a.mount.localeCompare(b.mount));
  return mounts.slice(0, max);
}

/** /proc/diskstats: total sectors read/written on physical devices. */
export function parseDiskstats(lines) {
  let readSectors = 0;
  let writeSectors = 0;
  let matched = 0;
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 10) continue;
    if (!PHYSICAL_DISK.test(parts[2])) continue;
    const read = Number(parts[5]);
    const written = Number(parts[9]);
    if (!Number.isFinite(read) || !Number.isFinite(written)) continue;
    readSectors += read;
    writeSectors += written;
    matched += 1;
  }
  return matched === 0 ? null : { readSectors, writeSectors };
}

/** nvidia-smi --query-gpu CSV rows; missing values print "[N/A]". */
export function parseNvidiaSmi(lines) {
  const gpus = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    const fields = line.split(",").map((field) => field.trim());
    if (fields.length < 3) continue;
    const index = Number.parseInt(fields[0], 10);
    const name = fields[1] ?? "";
    const utilization = numberOrNull(fields[2]);
    const memoryUsedMb = numberOrNull(fields[3]);
    const memoryTotalMb = numberOrNull(fields[4]);
    const temperature = numberOrNull(fields[5]);
    const power = numberOrNull(fields[6]);
    if (!Number.isFinite(index) || name === "") continue;
    gpus.push({
      index,
      name,
      utilizationPercent: utilization === null ? null : clamp(utilization, 0, 100),
      memoryUsedBytes: memoryUsedMb === null ? null : Math.round(memoryUsedMb * 1024 * 1024),
      memoryTotalBytes: memoryTotalMb === null ? null : Math.round(memoryTotalMb * 1024 * 1024),
      temperatureC: temperature === null ? null : Math.round(temperature),
      powerW: power === null ? null : Math.round(power * 10) / 10
    });
  }
  return gpus;
}

function numberOrNull(text) {
  if (typeof text !== "string" || text === "" || text.startsWith("[")) return null;
  const value = Number.parseFloat(text);
  return Number.isFinite(value) ? value : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** ps -e -o pid=,pcpu=,pmem=,comm= rows, sorted by CPU and capped. */
export function parsePs(lines, max = 6) {
  const rows = [];
  for (const line of lines) {
    const match = /^\s*(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.+)$/.exec(line);
    if (match === null) continue;
    const pid = Number.parseInt(match[1], 10);
    const cpu = Number.parseFloat(match[2]);
    const mem = Number.parseFloat(match[3]);
    const name = match[4].trim();
    if (!Number.isFinite(pid) || !Number.isFinite(cpu) || !Number.isFinite(mem) || name === "") continue;
    rows.push({ pid, name, cpuPercent: Math.max(0, cpu), memPercent: Math.max(0, Math.min(100, mem)) });
  }
  rows.sort((a, b) => b.cpuPercent - a.cpuPercent || b.memPercent - a.memPercent);
  return { rows: rows.slice(0, max), count: rows.length };
}

/**
 * Parse one probe run.
 * @param {string} stdout - raw output of the probe command.
 * @returns {object} parsed sections plus which markers actually arrived.
 */
export function parseProbe(stdout) {
  const sections = splitSections(stdout);
  const lines = (name) => sections.get(name) ?? [];
  const cpu = parseCpuLines(lines("cpu"));
  const load = parseLoadavg(lines("load"));
  const memory = parseMeminfo(lines("mem"));
  const df = sections.has("df") ? parseDf(lines("df")) : null;
  const diskstats = sections.has("diskstats") ? parseDiskstats(lines("diskstats")) : null;
  const procs = sections.has("procs") ? parsePs(lines("procs")) : null;
  return {
    complete: sections.has("end"),
    present: new Set(sections.keys()),
    meta: sections.has("meta") ? parseMetaLines(lines("meta")) : null,
    cpu,
    memory,
    load,
    uptimeSeconds: parseUptime(lines("uptime")),
    net: parseNetDev(lines("net")),
    gpu: parseNvidiaSmi(lines("gpu")),
    procs,
    df,
    diskstats
  };
}
