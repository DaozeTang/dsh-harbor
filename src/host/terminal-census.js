/**
 * Learn which remote tty a PTY session runs on.
 *
 * `ssh_exec` runs on a separate non-interactive channel, yet it should start
 * in the directory the operator's terminal is in. Until 0.2.2 that was
 * resolved by finding "the one foreground login shell on this SSH transport"
 * (see exec-cwd.js) — a rule that only works while a connection carries a
 * single terminal. Per-session terminals make several shells on one transport
 * the normal case, and the old rule degrades to the login directory exactly
 * when it is most needed.
 *
 * So each PTY learns its own tty once, right after its channel opens: a census
 * of the transport's interactive shells is taken, and the shell that appeared
 * is the new channel's. `exec-cwd.js` then targets that tty by name instead of
 * relying on uniqueness.
 *
 * The probe is a read-only shell script (no /proc writes, no signals) and the
 * same `SSH_CONNECTION` filter the resolver already uses, so a census can
 * never mistake another user's or another transport's shell for ours.
 */
import { shellQuote } from "./safety.js";

/** Prefix that makes census lines distinguishable from shell noise. */
export const CENSUS_MARKER = "__DSH_HARBOR_TTY_CENSUS_V1__";

/** A tty path the remote may report for an interactive session. */
const PTY_PATH = /^\/dev\/(?:pts\/\d+|tty\d+|ttys\d+)$/;

/**
 * Whether a path looks like a pty the census would report.
 * @param {unknown} value - path candidate.
 * @returns {boolean} true for /dev/pts/N, /dev/ttyNN and /dev/ttysNN.
 */
export function isPtyPath(value) {
  return typeof value === "string" && PTY_PATH.test(value);
}


/**
 * One-line-per-shell census script.
 *
 * Kept to POSIX sh constructs only: sshd runs it through the login shell,
 * which may be dash, ash, ksh or zsh — the `read` heredoc split is the same
 * zsh-safe trick exec-cwd.js uses, because unquoted field splitting is off
 * there.
 *
 * @param {{procRoot?: string}} [options] - `procRoot` is injectable for tests.
 * @returns {string} the shell script.
 */
export function buildCensusScript({ procRoot = "/proc" } = {}) {
  return `
[ -n "${'$'}SSH_CONNECTION" ] || exit 0
for __dsh_p in ${shellQuote(procRoot)}/[0-9]*; do
  __dsh_n=${'$'}{__dsh_p##*/}
  case ${'$'}__dsh_n in ''|*[!0-9]*) continue ;; esac
  __dsh_t=$(readlink "${'$'}__dsh_p/fd/0" 2>/dev/null) || continue
  case ${'$'}__dsh_t in /dev/pts/*|/dev/tty[0-9]*|/dev/ttys[0-9]*) ;; *) continue ;; esac
  __dsh_c=$(cat "${'$'}__dsh_p/comm" 2>/dev/null) || continue
  case ${'$'}__dsh_c in bash|zsh|sh|dash|ash|ksh|mksh) ;; *) continue ;; esac
  tr '\\0' '\\n' < "${'$'}__dsh_p/environ" 2>/dev/null | grep -Fxq "SSH_CONNECTION=${'$'}SSH_CONNECTION" || continue
  __dsh_stat=$(cat "${'$'}__dsh_p/stat" 2>/dev/null) || continue
  __dsh_stat=${'$'}{__dsh_stat##*) }
  # Fields 20 of /proc/<pid>/stat (starttime, in jiffies since boot) after the
  # comm field has been stripped. read with explicitly named variables is the
  # zsh-safe split: unquoted expansion leaves the whole line in one word there.
  __dsh_f1=''; __dsh_f2=''; __dsh_f3=''; __dsh_f4=''; __dsh_f5=''; __dsh_f6=''; __dsh_f7=''
  __dsh_f8=''; __dsh_f9=''; __dsh_f10=''; __dsh_f11=''; __dsh_f12=''; __dsh_f13=''; __dsh_f14=''
  __dsh_f15=''; __dsh_f16=''; __dsh_f17=''; __dsh_f18=''; __dsh_f19=''; __dsh_start=''
  read -r __dsh_f1 __dsh_f2 __dsh_f3 __dsh_f4 __dsh_f5 __dsh_f6 __dsh_f7 __dsh_f8 __dsh_f9 __dsh_f10 __dsh_f11 __dsh_f12 __dsh_f13 __dsh_f14 __dsh_f15 __dsh_f16 __dsh_f17 __dsh_f18 __dsh_f19 __dsh_start <<EOF
${'$'}__dsh_stat
EOF
  # read hands the LAST variable whatever remains on the line; keep its first word.
  __dsh_start=${'$'}{__dsh_start%% *}
  case ${'$'}__dsh_start in ''|*[!0-9]*) __dsh_start=0 ;; esac
  printf '%s %s %s %s\\n' '${CENSUS_MARKER}' "${'$'}__dsh_t" "${'$'}__dsh_n" "${'$'}__dsh_start"
done
`.trim();
}

/**
 * Parse census output into records. Anything that is not a well-formed census
 * line is ignored: a login shell's greeting must not break the probe.
 * @param {unknown} stdout - raw exec output.
 * @returns {{tty: string, pid: number, startTime: number}[]} census rows.
 */
export function parseCensus(stdout) {
  if (typeof stdout !== "string") return [];
  const rows = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    if (!line.startsWith(CENSUS_MARKER + " ")) continue;
    const parts = line.slice(CENSUS_MARKER.length + 1).split(/\s+/);
    if (parts.length < 3) continue;
    const [tty, pid, startTime] = parts;
    if (!isPtyPath(tty) || !/^\d+$/.test(pid) || !/^\d+$/.test(startTime)) continue;
    rows.push({ tty, pid: Number(pid), startTime: Number(startTime) });
  }
  return rows;
}

/**
 * The tty that appeared between two censuses: the new PTY channel's own shell.
 * @param {{tty: string}[]} before - census taken before opening the channel.
 * @param {{tty: string}[]} after - census taken after it.
 * @returns {string|null} the new tty, or null when the diff is not exactly one.
 */
export function pickNewTty(before, after) {
  const seen = new Set((before ?? []).map((row) => row.tty));
  const fresh = (after ?? []).filter((row) => !seen.has(row.tty));
  if (fresh.length !== 1) return null;
  return isPtyPath(fresh[0].tty) ? fresh[0].tty : null;
}
