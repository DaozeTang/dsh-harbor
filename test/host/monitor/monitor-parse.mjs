
/**
 * System monitor: probe script invariants, /proc parsing, and the rate math.
 *
 * The parsers are the place where every real-world dialect difference lands
 * (busybox ps without pcpu, df with pseudo filesystems, nvidia-smi printing
 * [N/A]), so they are tested from fixtures instead of a live host. The rate
 * math is tested with two snapshots a known interval apart, because "CPU 44%"
 * is the only kind of number an operator will act on.
 */
import assert from "node:assert/strict";
import { buildProbeCommand, buildProbeScript } from "../../../src/host/monitor/probe-script.js";
import {
  parseProbe, parseCpuLines, parseMeminfo, parseDf, parseDiskstats, parseNvidiaSmi, parsePs, parseNetDev
} from "../../../src/host/monitor/parse.js";
import { buildSample, diskIoRate, finite } from "../../../src/host/monitor/sample.js";
import { systemStatsResultSchema } from "../../../src/rpc/schemas.js";

const INTERPOLATION = "$" + "{";

// ── the wire command is inert ───────────────────────────────────────────────
{
  const script = buildProbeScript({ slow: true });
  assert.equal(script.includes("'"), false, "the script never contains a single quote, so sh -c needs no escaping");
  assert.equal(script.includes(INTERPOLATION), false, "the script contains no template interpolation: nothing can be spliced in");
  assert.equal(script.includes("$("), true, "it does use command substitution, which is not interpolation");
  const command = buildProbeCommand({ slow: true });
  assert.match(command, /^sh -c '/, "the command rides inside sh -c single quotes");
  assert.match(command, /'$/, "and closes them");
  for (const marker of ["#meta", "#cpu", "#mem", "#load", "#uptime", "#net", "#gpu", "#procs", "#df", "#diskstats", "#end"]) {
    assert.ok(script.includes("echo \"" + marker + "\""), "the slow script announces " + marker);
  }
  // ps prints in pid order, so a cap before the sort kept the 200 lowest pids
  // and the parser then ranked those: on a host with more processes than the
  // cap, the busiest one (usually a recent, high-pid process) was never seen.
  const procs = script.split("\n").find((line) => line.startsWith("ps -e"));
  assert.ok(procs !== undefined, "the fast tick reads the process table");
  assert.ok(procs.includes("sort -k2,2rn"), "processes are ordered by cpu on the server: " + procs);
  assert.ok(procs.indexOf("sort") < procs.indexOf("head"), "the cap applies to the sorted list, not before it");
  assert.equal(procs.includes("'"), false, "the sort adds no single quote");

  const fast = buildProbeScript();
  assert.equal(fast.includes("#meta"), false, "the fast tick does not pay for the inventory");
  assert.equal(fast.includes("#df"), false, "the fast tick does not pay for the mount table (it can block on NFS)");
  assert.ok(fast.includes("#end"), "both cadences end with the same terminator");
}

// ── fixtures: a normal Linux host ───────────────────────────────────────────
const PROC_STAT = [
  "cpu  4321 12 1200 88000 300 0 120 45 0 0",
  "cpu0 2100 5 600 44000 150 0 60 20 0 0",
  "cpu1 2221 7 600 44000 150 0 60 25 0 0",
  "intr 12345 0 0",
  "ctxt 999",
  "btime 1700000000",
  "processes 123456"
].join("\n");

const MEMINFO = [
  "MemTotal:       16316332 kB",
  "MemFree:         1234567 kB",
  "MemAvailable:    7654321 kB",
  "Buffers:          123456 kB",
  "Cached:          3456789 kB",
  "SReclaimable:     123456 kB",
  "SwapTotal:       2097148 kB",
  "SwapFree:        1048574 kB",
  "VmallocTotal:   34359738367 kB"
].join("\n");

const NETDEV = [
  "Inter-|   Receive                                                |  Transmit",
  " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
  "    lo: 1234567    1000    0    0    0     0          0         0  1234567    1000    0    0    0     0       0          0",
  "  eth0: 987654321  500000    0    0    0     0          0         0 123456789  400000    0    0    0     0       0          0"
].join("\n");

const DF = [
  "Filesystem     1024-blocks      Used  Available Capacity Mounted on",
  "/dev/nvme0n1p2    81000000  34000000   47000000      43% /",
  "tmpfs              8000000         0    8000000       0% /dev/shm",
  "overlay          100000000  50000000   50000000      50% /var/lib/docker/overlay2/abc/merged",
  "/dev/nvme0n1p3   358000000 120000000  238000000      34% /var",
  "/dev/nvme0n1p4  1953000000 1800000000 153000000      93% /data"
].join("\n");

const DISKSTATS = [
  "   8       0 sda 12000 0 900000 3000 4000 0 500000 2000 0 1000 5000 0 0 0 0 0",
  "   8       1 sda1 100 0 1000 10 0 0 0 0 0 0 0",
  " 259       0 nvme0n1 50000 0 4000000 9000 30000 0 6000000 8000 0 12000 17000 0",
  " 259       1 nvme0n1p1 10 0 100 1 0 0 0 0 0 0 0",
  "   7       0 loop0 10 0 100 1 0 0 0 0 0 0 0"
].join("\n");

const NVIDIA = [
  "0, NVIDIA GeForce RTX 4090, 78, 19661, 24564, 68, 310.45",
  "1, NVIDIA A100-SXM4-40GB, [N/A], 100, 40960, 40, [N/A]"
].join("\n");

const PS = [
  "  4213 84.2 12.1 python3",
  "   887  3.0  1.2 nginx",
  "   902 30.5  0.4 node",
  "not a process line"
].join("\n");

function linuxProbeText(extra = {}) {
  const parts = [
    "#meta",
    "sysname=Linux",
    "kernel=6.8.0-45-generic",
    "arch=x86_64",
    "host=prod-web-01",
    "os=\"Ubuntu 24.04.1 LTS\"",
    "model=Intel(R) Xeon(R) Gold 6248 CPU @ 2.50GHz",
    "cores=16",
    "#cpu", extra.stat ?? PROC_STAT,
    "#mem", MEMINFO,
    "#load", "0.08 0.12 0.09 1/823 4213",
    "#uptime", "3648123",
    "#net", extra.net ?? NETDEV,
    "#gpu", NVIDIA,
    "#procs", PS,
    "#df", DF,
    "#diskstats", extra.diskstats ?? DISKSTATS,
    "#end"
  ];
  return parts.join("\n") + "\n";
}

// ── parsing ────────────────────────────────────────────────────────────────
{
  const cpu = parseCpuLines(PROC_STAT.split("\n"));
  assert.deepEqual(cpu.total, [4321, 12, 1200, 88000, 300, 0, 120, 45]);
  assert.equal(cpu.perCore.length, 2, "one entry per core");
  assert.equal(cpu.perCore[1][3], 44000);

  const memory = parseMeminfo(MEMINFO.split("\n"));
  assert.equal(memory.totalBytes, 16316332 * 1024);
  assert.equal(memory.cachedBytes, (3456789 + 123456) * 1024, "Cached folds in SReclaimable like top does");
  assert.equal(memory.swapFreeBytes, 1048574 * 1024);

  const net = parseNetDev(NETDEV.split("\n"));
  assert.equal(net.length, 2, "header lines are skipped");
  assert.equal(net[1].name, "eth0");
  assert.equal(net[1].rxBytes, 987654321);
  assert.equal(net[1].txBytes, 123456789);

  // A container reports an overlay root; dropping pseudo devices must not
  // remove the one filesystem the operator actually wants to see.
  const container = parseDf([
    "overlay 102400000 51200000 51200000 50% /",
    "/dev/sda1 204800 102400 102400 40% /etc/hosts",
    "tmpfs 4096 0 4096 0% /dev/shm",
    "overlay 1024 512 512 50% /var/lib/docker/overlay2/abc/merged"
  ]);
  assert.deepEqual(container.map((disk) => disk.mount), ["/", "/etc/hosts"], "a container keeps its overlay root, not just the binds");
  assert.equal(container[0].usePercent, 50);

  const disks = parseDf(DF.split("\n"));
  assert.deepEqual(disks.map((disk) => disk.mount), ["/data", "/", "/var"], "pseudo filesystems are dropped and the fullest mount leads");
  assert.equal(disks[0].totalBytes, 1953000000 * 1024);
  assert.equal(disks[0].usePercent, 93);

  const disk = parseDiskstats(DISKSTATS.split("\n"));
  assert.deepEqual(disk, { readSectors: 900000 + 4000000, writeSectors: 500000 + 6000000 }, "partitions and loop devices do not double count");

  const gpu = parseNvidiaSmi(NVIDIA.split("\n"));
  assert.equal(gpu.length, 2);
  assert.equal(gpu[0].memoryUsedBytes, 19661 * 1024 * 1024);
  assert.equal(gpu[1].utilizationPercent, null, "[N/A] is unknown, never 0");
  assert.equal(gpu[1].powerW, null);

  const procs = parsePs(PS.split("\n"));
  assert.deepEqual(procs.rows.map((row) => row.name), ["python3", "node", "nginx"], "sorted by CPU, garbage lines skipped");
  // `count` used to ride along here and was stripped by the RPC schema, so no
  // caller could ever read it: the parser returns exactly what the wire carries.
  assert.equal("count" in procs, false, "no field the wire cannot carry");
  assert.equal(procs.rows.length, 3);
}

// ── parseProbe: section split and completeness ─────────────────────────────
{
  const raw = parseProbe(linuxProbeText());
  assert.equal(raw.complete, true);
  assert.equal(raw.meta.os, "Ubuntu 24.04.1 LTS", "quotes around PRETTY_NAME are stripped");
  assert.equal(raw.meta.cores, 16);
  assert.equal(raw.load.load[0], 0.08);
  assert.equal(raw.load.threads, 823);
  assert.equal(raw.uptimeSeconds, 3648123);
  assert.equal(raw.procs.rows.length, 3);

  const truncated = parseProbe(linuxProbeText({ stat: PROC_STAT }).replace(/#end\n?$/, ""));
  assert.equal(truncated.complete, false, "a missing #end means the output was cut, not that the host is quiet");

  const nothing = parseProbe("");
  assert.equal(nothing.complete, false);
  assert.equal(nothing.cpu, null);
  assert.equal(nothing.net.length, 0);
}

// ── rate math ──────────────────────────────────────────────────────────────
{
  const before = [
    "#cpu", "cpu  500 0 500 9000 0 0 0 0",
    "#mem", "MemTotal: 1000 kB", "MemAvailable: 500 kB",
    "#load", "1.00 1.00 1.00 2/10 100",
    "#net", "  eth0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0",
    "#gpu",
    "#procs", "  1 10.0 1.0 busy",
    "#end"
  ].join("\n");
  const after = before
    .replace("cpu  500 0 500 9000 0 0 0 0", "cpu  600 0 600 9250 0 0 0 0")
    .replace("  eth0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0", "  eth0: 3000 0 0 0 0 0 0 0 4000 0 0 0 0 0 0 0")
    .replace("  1 10.0 1.0 busy", "  1 20.0 2.0 busy");

  const first = parseProbe(before);
  const second = parseProbe(after);
  const t0 = 1700000000000;
  const t1 = t0 + 2000;

  const one = buildSample(first, null, { now: t0, durationMs: 40 });
  assert.equal(one.supported, true);
  assert.equal(one.value.warmingUp, true, "the first sample has counters but no interval");
  assert.equal(one.value.cpu.usagePercent, null, "never 0% while measuring");
  assert.equal(one.value.network[0].rxBytesPerSec, null);

  const two = buildSample(second, one.next, { now: t1, durationMs: 40 });
  assert.equal(two.value.cpu.usagePercent, 44.4, "450 jiffies total, 250 idle, so 200 busy");
  assert.equal(two.value.network[0].rxBytesPerSec, 1000, "2000 bytes over 2s");
  assert.equal(two.value.network[0].txBytesPerSec, 1000);
  assert.equal(two.value.capabilities.processes, true);
  assert.equal(two.value.capabilities.gpu, false, "no GPUs in this fixture");
  assert.equal(two.value.capabilities.disks, false, "the fast tick carries no mount table");

  const reset = buildSample(
    { ...second, cpu: parseCpuLines(["cpu 10 0 10 100 0 0 0 0"]) },
    two.next,
    { now: t1 + 2000, durationMs: 30 }
  );
  assert.equal(reset.value.cpu.usagePercent, null, "a rebooted host reports unknown, not a negative rate");
}

// ── slow data is carried between fast ticks ────────────────────────────────
{
  const t0 = 1700000000000;
  const fullText = linuxProbeText();
  const full = buildSample(parseProbe(fullText), null, { now: t0, durationMs: 50 });
  assert.equal(full.value.disks.length, 3);
  assert.equal(full.value.capabilities.disks, true);
  assert.equal(full.value.capabilities.io, true);
  assert.equal(full.value.diskIo, null, "I/O needs two samples");

  const fastText = [
    "#cpu", "cpu  4400 12 1300 89000 300 0 120 45",
    "#mem", MEMINFO,
    "#load", "0.08 0.12 0.09 1/823 4213",
    "#uptime", "3648126",
    "#net", NETDEV,
    "#gpu", NVIDIA,
    "#procs", PS,
    "#end"
  ].join("\n");
  const fast = buildSample(parseProbe(fastText), full.next, {
    now: t0 + 2000,
    durationMs: 30,
    carry: { meta: parseProbe(fullText).meta, df: full.value.disks }
  });
  assert.equal(fast.value.disks.length, 3, "the disk list survives a fast tick");
  assert.equal(fast.value.capabilities.disks, true);
  assert.equal(fast.value.host.os, "Ubuntu 24.04.1 LTS", "the identity is carried too");
  assert.ok(fast.value.cpu.usagePercent !== null, "the fast tick still produces a CPU number");
}

// ── disk I/O rate ──────────────────────────────────────────────────────────
{
  const rate = diskIoRate({ readSectors: 2048, writeSectors: 1024 }, { readSectors: 1024, writeSectors: 0 }, 1000, 3000);
  assert.deepEqual(rate, { readBytesPerSec: 512 * 1024 / 2, writeBytesPerSec: 512 * 1024 / 2 });
  assert.equal(diskIoRate({ readSectors: 10, writeSectors: 10 }, { readSectors: 20, writeSectors: 0 }, 1000, 3000), null, "a counter reset yields no rate");
  assert.equal(diskIoRate({ readSectors: 10, writeSectors: 10 }, null, 0, 3000), null);
}

// ── unsupported hosts stay honest ──────────────────────────────────────────
{
  const macosText = [
    "#meta", "sysname=Darwin", "kernel=24.1.0", "arch=arm64", "host=studio",
    "#cpu", "#mem", "#load", "#uptime", "#net", "#gpu", "#procs",
    "#df", DF, "#diskstats", "#end"
  ].join("\n");
  const mac = buildSample(parseProbe(macosText), null, { now: 1700000000000, durationMs: 12 });
  assert.equal(mac.supported, false);
  assert.equal(mac.value.reason, "no-procfs", "a non-Linux host says exactly why");
  assert.equal(mac.value.platform, "other");
  assert.equal(mac.value.platformName, "Darwin");

  const empty = buildSample(parseProbe(""), null, { now: 1700000000000, durationMs: 5 });
  assert.equal(empty.supported, false);
  assert.equal(empty.value.reason, "no-posix-shell", "nothing at all means there is no POSIX shell behind exec");
}

// ── numbers are always JSON-safe ───────────────────────────────────────────
{
  assert.equal(finite(0.123456, 1), 0.1);
  assert.equal(finite(Number.NaN), null);
  assert.equal(finite(Number.POSITIVE_INFINITY), null);
  const value = buildSample(parseProbe(linuxProbeText()), null, { now: 1700000000000, durationMs: 9.7 }).value;
  const serialized = JSON.parse(JSON.stringify(value));
  assert.equal(serialized.sampleMs, 10, "the sampled duration is rounded for the wire");
}

// ── the produced value satisfies the strict wire codec ─────────────────────
// The typert gateway validates every result, so a field the host adds or
// forgets fails at runtime in the panel — this is the cheapest place to catch
// that drift.
{
  const t0 = 1700000000000;
  const first = buildSample(parseProbe(linuxProbeText()), null, { now: t0, durationMs: 12 });
  const second = buildSample(parseProbe(linuxProbeText()), first.next, { now: t0 + 2000, durationMs: 9 });
  const fast = buildSample(parseProbe([
    "#cpu", "cpu  4400 12 1300 89000 300 0 120 45",
    "#mem", "MemTotal: 1000 kB", "MemAvailable: 500 kB",
    "#net", "  eth0: 1 0 0 0 0 0 0 0 2 0 0 0 0 0 0 0",
    "#gpu", "", "#procs", "  1 10.0 1.0 init", "#end"
  ].join("\n")), second.next, {
    now: t0 + 4000,
    durationMs: 8,
    carry: { meta: first.value.host === undefined ? null : parseProbe(linuxProbeText()).meta, df: first.value.disks }
  });
  const unsupported = buildSample(parseProbe(""), null, { now: t0, durationMs: 3 });
  for (const sample of [first, second, fast, unsupported]) {
    const wire = JSON.parse(JSON.stringify({ ok: true, value: sample.value }));
    const parsed = systemStatsResultSchema.safeParse(wire);
    assert.equal(parsed.success, true, "the host value matches the wire schema: " + JSON.stringify(parsed.error?.issues));
  }
}

console.log("monitor parse: probe invariants, /proc dialects, rate math, carry-over and honest degradation: passed");
