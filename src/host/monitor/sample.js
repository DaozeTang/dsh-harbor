
/**
 * Turn one parsed probe run into the wire value the panel renders, and keep
 * the counters needed for the next rate.
 *
 * All of it is pure: the caller owns the previous snapshot, the carried slow
 * data and the clock, so a test can feed two fixtures 2000ms apart and assert
 * the percentages exactly.
 *
 * Numbers that cannot be known yet are null, never 0 — a panel that shows
 * "0%" while it is still measuring is lying, and after a reboot a counter
 * going backwards would produce a negative rate unless it is detected here.
 *
 * The probe has two cadences. #df and #diskstats are slow (10s): they are
 * carried forward between runs so the disk card does not blink out on a fast
 * tick, and the I/O rate is only recomputed when a fresh sample actually
 * arrived.
 */

const SECTOR_BYTES = 512;

/** Round to a fixed number of decimals, or null when the value is not finite. */
export function finite(value, digits = 0) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return null;
  return finite(Math.min(100, Math.max(0, value)), 1);
}

/** Counters that only ever grow; a smaller value means the host rebooted. */
function delta(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  const value = current - previous;
  return value >= 0 ? value : null;
}

function sumCounters(counters) {
  let total = 0;
  for (const value of counters) total += value;
  return total;
}

/** Usage from two /proc/stat snapshots: busy time over total time. */
function cpuUsage(previous, current) {
  const total = delta(sumCounters(current), sumCounters(previous));
  if (total === null || total <= 0) return null;
  const idle = delta(current[3] + current[4], previous[3] + previous[4]);
  if (idle === null || idle > total) return null;
  return clampPercent(((total - idle) / total) * 100);
}

/** One counter as a percentage of the same interval. */
function share(previous, current, totalBusy) {
  const value = delta(current, previous);
  if (value === null || totalBusy === null || totalBusy <= 0) return null;
  return clampPercent((value / totalBusy) * 100);
}

/** Drop undefined values so the object has exactly the fields we know. */
function compact(object) {
  const out = {};
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * The counter snapshot the next fast run diffs against.
 * @param {object} raw - parseProbe() output.
 * @param {number} now - milliseconds since epoch.
 */
export function snapshot(raw, now) {
  return {
    at: now,
    cpuTotal: raw.cpu?.total ?? null,
    cpuPerCore: raw.cpu?.perCore ?? null,
    net: new Map(raw.net.map((iface) => [iface.name, { rxBytes: iface.rxBytes, txBytes: iface.txBytes }]))
  };
}

function cpuSection(raw, previous, meta) {
  const counters = raw.cpu;
  if (counters === null) return undefined;
  const previousTotal = previous?.cpuTotal ?? null;
  const previousPerCore = previous?.cpuPerCore ?? null;
  const totalBusy = previousTotal === null ? null : delta(sumCounters(counters.total), sumCounters(previousTotal));
  const perCore = previousPerCore === null
    ? null
    : counters.perCore.map((core, index) => {
      const before = previousPerCore[index];
      return before === undefined ? null : cpuUsage(before, core);
    });
  return compact({
    usagePercent: previousTotal === null ? null : cpuUsage(previousTotal, counters.total),
    perCore,
    iowaitPercent: previousTotal === null ? null : share(previousTotal[4], counters.total[4], totalBusy),
    stealPercent: previousTotal === null ? null : share(previousTotal[7], counters.total[7], totalBusy),
    load: raw.load?.load ?? null,
    cores: counters.perCore.length > 0 ? counters.perCore.length : (meta?.cores ?? null),
    model: meta?.cpuModel ?? null
  });
}

function networkSection(raw, previous, dtSeconds) {
  const interfaces = [];
  for (const iface of raw.net) {
    const before = previous?.net?.get(iface.name);
    const rx = before === undefined || dtSeconds === null ? null : delta(iface.rxBytes, before.rxBytes);
    const tx = before === undefined || dtSeconds === null ? null : delta(iface.txBytes, before.txBytes);
    interfaces.push({
      name: iface.name,
      rxBytesPerSec: rx === null ? null : Math.max(0, Math.round(rx / dtSeconds)),
      txBytesPerSec: tx === null ? null : Math.max(0, Math.round(tx / dtSeconds)),
      rxTotalBytes: iface.rxBytes,
      txTotalBytes: iface.txBytes
    });
  }
  // Busiest interfaces first; loopback only survives when it is all there is.
  interfaces.sort((a, b) => (b.rxTotalBytes + b.txTotalBytes) - (a.rxTotalBytes + a.txTotalBytes));
  const real = interfaces.filter((iface) => iface.name !== "lo");
  return (real.length > 0 ? real : interfaces).slice(0, 6);
}

/** I/O rate from two /proc/diskstats samples; null until both exist. */
export function diskIoRate(current, previous, previousAt, now) {
  if (current === null || previous === null || previous === undefined) return null;
  const seconds = (now - previousAt) / 1000;
  if (!(seconds > 0.2)) return null;
  const read = delta(current.readSectors, previous.readSectors);
  const written = delta(current.writeSectors, previous.writeSectors);
  if (read === null || written === null) return null;
  return {
    readBytesPerSec: Math.max(0, Math.round((read * SECTOR_BYTES) / seconds)),
    writeBytesPerSec: Math.max(0, Math.round((written * SECTOR_BYTES) / seconds))
  };
}

/**
 * Build the normalized sample.
 * @param {object} raw - parseProbe() output for this run.
 * @param {object|null} previous - snapshot() of the previous run, or null.
 * @param {object} options
 * @param {number} options.now - when the probe started, ms since epoch.
 * @param {number} options.durationMs - round trip of the probe.
 * @param {{meta?: object|null, df?: Array|null, diskIo?: object|null}} [options.carry]
 *   slow data carried from the last full probe (the fast probe omits #df/#meta).
 * @param {{stats: object, at: number}|null} [options.diskBaseline]
 *   previous /proc/diskstats sample, when known.
 * @returns {{value: object, next: object, supported: boolean, diskStats: object|null}}
 */
export function buildSample(raw, previous, options) {
  const now = options.now;
  const carry = options.carry ?? {};
  const meta = raw.meta ?? carry.meta ?? null;
  const disks = Array.isArray(raw.df) ? raw.df : (Array.isArray(carry.df) ? carry.df : null);
  const elapsed = previous === null || previous === undefined ? null : (now - previous.at) / 1000;
  const dtSeconds = elapsed !== null && elapsed > 0.2 ? elapsed : null;

  const diskIo = raw.diskstats !== null
    ? diskIoRate(raw.diskstats, options.diskBaseline?.stats ?? null, options.diskBaseline?.at ?? 0, now)
    : (carry.diskIo ?? null);

  const supported = raw.cpu !== null || raw.memory !== null;
  const cpu = cpuSection(raw, previous, meta);
  const value = {
    sampledAt: new Date(now).toISOString(),
    sampleMs: Math.max(0, Math.round(options.durationMs)),
    platform: meta?.sysname === "Linux" ? "linux" : "other",
    supported,
    capabilities: {
      processes: raw.procs !== null && raw.procs.rows.length > 0,
      gpu: raw.gpu.length > 0,
      disks: Array.isArray(disks) && disks.length > 0,
      io: raw.diskstats !== null || diskIo !== null
    },
    gpu: raw.gpu,
    disks: Array.isArray(disks) ? disks : [],
    diskIo,
    network: networkSection(raw, previous, dtSeconds),
    processes: raw.procs === null
      ? null
      : {
        total: raw.load?.threads ?? null,
        running: raw.load?.running ?? null,
        top: raw.procs.rows
      },
    warnings: []
  };

  if (meta?.sysname !== null && meta?.sysname !== undefined) value.platformName = meta.sysname;
  const host = compact({
    hostname: meta?.hostname ?? undefined,
    os: meta?.os ?? undefined,
    kernel: meta?.kernel ?? undefined,
    arch: meta?.arch ?? undefined,
    cores: meta?.cores ?? undefined,
    cpuModel: meta?.cpuModel ?? undefined,
    uptimeSeconds: raw.uptimeSeconds ?? undefined
  });
  if (Object.keys(host).length > 0) value.host = host;

  if (cpu !== undefined) {
    value.cpu = previous === null || previous === undefined
      ? { ...cpu, usagePercent: null, perCore: null, iowaitPercent: null, stealPercent: null }
      : cpu;
    if (previous === null || previous === undefined) value.warmingUp = true;
  }
  if (raw.memory !== null) value.memory = raw.memory;
  if (!supported) value.reason = describeUnsupported(raw, meta);
  if (raw.complete === false) value.warnings.push("incomplete-output");

  return {
    value,
    next: snapshot(raw, now),
    supported,
    diskStats: raw.diskstats
  };
}

/**
 * A stable machine-readable reason the panel phrases itself; keeps the host
 * free of UI copy and lets an older panel show an honest fallback.
 */
function describeUnsupported(raw, meta) {
  if (raw.present.size === 0) return "no-posix-shell";
  if (meta !== null && meta.sysname !== null && meta.sysname !== "Linux") return "no-procfs";
  return "probe-empty";
}
