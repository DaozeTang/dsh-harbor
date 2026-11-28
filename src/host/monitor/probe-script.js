
/**
 * The remote probe: one fixed, read-only shell script.
 *
 * Why a dedicated script instead of letting the panel pass commands: this runs
 * on a timer (every 2s while the status tab is visible), so it must be
 * auditable, free of caller input, and cheap. Nothing here writes a file,
 * changes state, or needs root: the whole inventory is /proc reads plus df,
 * ps, and one nvidia-smi query.
 *
 * Invariants enforced by test/monitor-parse.mjs:
 * - the script contains no single quote, so it can ride inside
 *   "sh -c '<script>'" with zero escaping;
 * - it contains no template interpolation, so nothing can be spliced into it
 *   at runtime;
 * - every section is preceded by a "#marker" line and the script ends with
 *   "#end", which lets the parser tell a complete run from a truncated one.
 *
 * Sections marked "slow" cost a fork of df or a stat of every process (and df
 * can block on a stale NFS mount), so they only ship on the slow cadence.
 */

/** Fast sections: pure /proc reads plus one ps and one guarded nvidia-smi. */
const TICK = [
  "echo \"#cpu\"",
  "grep \"^cpu\" /proc/stat 2>/dev/null",
  "echo \"#mem\"",
  "grep -E \"^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SReclaimable|SwapTotal|SwapFree)\" /proc/meminfo 2>/dev/null",
  "echo \"#load\"",
  "cat /proc/loadavg 2>/dev/null",
  "echo \"#uptime\"",
  "cut -d. -f1 /proc/uptime 2>/dev/null",
  "echo \"#net\"",
  "cat /proc/net/dev 2>/dev/null",
  "echo \"#gpu\"",
  "if command -v nvidia-smi >/dev/null 2>&1; then nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits 2>/dev/null; fi",
  "echo \"#procs\"",
  // Sorted REMOTELY, before the cap. ps lists processes in pid order, so
  // `| head -n 200` kept the 200 lowest pids and the parse then picked the
  // busiest of those: on a host with more processes than the cap, the top-CPU
  // list showed long-running daemons and missed whatever was actually busy
  // (a recent process almost always has the highest pid). The field order is
  // pinned by parsePs: pid, %cpu, %mem, command.
  "ps -e -o pid=,pcpu=,pmem=,comm= 2>/dev/null | sort -k2,2rn -k3,3rn | head -n 200"
].join("\n");

/** Identity of the machine: static enough to fetch once per inventory refresh. */
const META = [
  "echo \"#meta\"",
  "printf \"sysname=%s\\n\" \"$(uname -s 2>/dev/null)\"",
  "printf \"kernel=%s\\n\" \"$(uname -r 2>/dev/null)\"",
  "printf \"arch=%s\\n\" \"$(uname -m 2>/dev/null)\"",
  "printf \"host=%s\\n\" \"$(uname -n 2>/dev/null)\"",
  "printf \"os=%s\\n\" \"$(grep \"^PRETTY_NAME=\" /etc/os-release 2>/dev/null | head -n 1 | cut -d= -f2-)\"",
  "printf \"model=%s\\n\" \"$(grep -m1 \"^model name\" /proc/cpuinfo 2>/dev/null | cut -d: -f2-)\"",
  "printf \"cores=%s\\n\" \"$(getconf _NPROCESSORS_ONLN 2>/dev/null)\""
].join("\n");

/** Slow sections: mount table (may block on NFS) and per-device I/O counters. */
const SLOW = [
  "echo \"#df\"",
  "df -P -k 2>/dev/null",
  "echo \"#diskstats\"",
  "cat /proc/diskstats 2>/dev/null"
].join("\n");

/**
 * Build the script body for one probe.
 * @param {{slow?: boolean}} [options] - include the once-per-inventory sections.
 * @returns {string} the script body (already safe to single-quote).
 */
export function buildProbeScript(options = {}) {
  const parts = [];
  if (options.slow === true) parts.push(META);
  parts.push(TICK);
  if (options.slow === true) parts.push(SLOW);
  parts.push("echo \"#end\"");
  return parts.join("\n") + "\n";
}

/**
 * The exact command line sent over the exec channel. Kept beside the script so
 * a test can assert the whole wire string, not just the body.
 * @param {{slow?: boolean}} [options]
 * @returns {string}
 */
export function buildProbeCommand(options = {}) {
  return "sh -c '" + buildProbeScript(options).trimEnd() + "'";
}
