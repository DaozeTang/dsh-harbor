/**
 * Learning a PTY's remote tty.
 *
 * The census is what keeps ssh_exec's directory inheritance exact once a
 * connection carries several terminals: the resolver targets one tty by name
 * instead of requiring "the only shell on this transport". The script runs in
 * the login shell, so this spec drives the real generated script against a
 * fake /proc (same technique as exec-cwd.mjs) and can only run on POSIX.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { CENSUS_MARKER, buildCensusScript, isPtyPath, newestUnclaimedTty, parseCensus, pickNewTty } from "../src/host/terminal-census.js";
import { buildCwdAwareCommand, extractExecCwd } from "../src/host/exec-cwd.js";

// ── parser: only well-formed census lines count ─────────────────────────────
{
  const out = [
    "Welcome to the device",
    `${CENSUS_MARKER} /dev/pts/3 1234 9988`,
    `${CENSUS_MARKER} /dev/pts/4 77 12345`,
    `${CENSUS_MARKER} not-a-tty 5 6`,
    `${CENSUS_MARKER} /dev/pts/9 abc 10`,
    `${CENSUS_MARKER}`,
    "\u0007garbage"
  ].join("\r\n");
  assert.deepEqual(parseCensus(out), [
    { tty: "/dev/pts/3", pid: 1234, startTime: 9988 },
    { tty: "/dev/pts/4", pid: 77, startTime: 12345 }
  ]);
  assert.deepEqual(parseCensus(""), []);
  assert.deepEqual(parseCensus(undefined), []);
  assert.equal(isPtyPath("/dev/pts/12"), true);
  assert.equal(isPtyPath("/dev/tty1"), true);
  assert.equal(isPtyPath("/dev/ttys001"), true);
  assert.equal(isPtyPath("/dev/pts/x"), false);
  assert.equal(isPtyPath("/dev/null"), false);
}

// ── diff selection ──────────────────────────────────────────────────────────
{
  const before = [{ tty: "/dev/pts/1" }, { tty: "/dev/pts/2" }];
  assert.equal(pickNewTty(before, [...before, { tty: "/dev/pts/3" }]), "/dev/pts/3");
  assert.equal(pickNewTty(before, before), null, "no new shell means nothing to learn");
  assert.equal(pickNewTty(before, [...before, { tty: "/dev/pts/3" }, { tty: "/dev/pts/4" }]), null, "an ambiguous diff is refused");
  assert.equal(pickNewTty([], [{ tty: "/dev/pts/3" }]), "/dev/pts/3");

  const rows = [
    { tty: "/dev/pts/1", pid: 10, startTime: 100 },
    { tty: "/dev/pts/2", pid: 11, startTime: 200 },
    { tty: "/dev/pts/3", pid: 12, startTime: 300 }
  ];
  assert.equal(newestUnclaimedTty(rows, new Set(["/dev/pts/1", "/dev/pts/2"])), "/dev/pts/3");
  assert.equal(newestUnclaimedTty(rows, new Set(["/dev/pts/3"])), "/dev/pts/2", "newest first, skipping claimed ttys");
  assert.equal(newestUnclaimedTty(rows, new Set(rows.map((row) => row.tty))), null);
  // Equal start ticks fall back to the pid, which is also monotone.
  assert.equal(newestUnclaimedTty([{ tty: "/dev/pts/7", pid: 5, startTime: 9 }, { tty: "/dev/pts/8", pid: 6, startTime: 9 }], new Set()), "/dev/pts/8");
}

// ── the generated script against a real /proc shape ─────────────────────────
if (process.platform === "win32") {
  console.log("terminal census: script half skipped on Windows (POSIX /proc is the subject under test)");
} else {
  const root = mkdtempSync(join(tmpdir(), "dsh-census-test-"));
  const procRoot = join(root, "proc");
  mkdirSync(procRoot);
  const cwdOne = join(root, "one");
  const cwdTwo = join(root, "two");
  mkdirSync(cwdOne);
  mkdirSync(cwdTwo);

  /** One interactive login shell; startTime is /proc/<pid>/stat field 22. */
  function shell(pid, { tty = "/dev/pts/1", directory = cwdOne, startTime = 100, connection = "test-transport", foreground = true } = {}) {
    const dir = join(procRoot, String(pid));
    mkdirSync(join(dir, "fd"), { recursive: true });
    symlinkSync(tty, join(dir, "fd/0"));
    symlinkSync(directory, join(dir, "cwd"));
    writeFileSync(join(dir, "comm"), "bash\n");
    writeFileSync(join(dir, "environ"), `SSH_CONNECTION=${connection}\0`);
    writeFileSync(join(dir, "cmdline"), "-bash\0");
    // /proc/<pid>/stat fields after the comm section: state ppid pgrp session
    // tty_nr tpgid, then 13 more up to itrealvalue, then starttime (#20).
    writeFileSync(join(dir, "stat"), `${pid} (bash) S 1 ${pid} 100 34816 ${foreground ? pid : 101} 0 ${Array.from({ length: 12 }, () => 0).join(" ")} ${startTime} 0 0\n`);
  }

  const census = () => spawnSync("/bin/sh", ["-c", buildCensusScript({ procRoot })], {
    cwd: root, env: { ...process.env, SSH_CONNECTION: "test-transport" }, encoding: "utf8"
  });
  const runCwd = (command, tty) => spawnSync("/bin/sh", ["-c", buildCwdAwareCommand(command, { procRoot, tty })], {
    cwd: root, env: { ...process.env, SSH_CONNECTION: "test-transport" }, encoding: "utf8"
  });

  try {
    // No candidate: the script stays silent instead of failing the caller.
    const empty = census();
    assert.equal(empty.status, 0);
    assert.deepEqual(parseCensus(empty.stdout), []);

    shell(101, { tty: "/dev/pts/1", directory: cwdOne, startTime: 100 });
    shell(303, { tty: "/dev/pts/2", directory: cwdTwo, startTime: 200 });
    shell(404, { tty: "/dev/pts/3", directory: cwdTwo, startTime: 300, connection: "other-transport" });
    shell(505, { tty: "/dev/null", directory: cwdTwo, startTime: 400 });

    const rows = parseCensus(census().stdout);
    assert.deepEqual(rows.map((row) => row.tty).sort(), ["/dev/pts/1", "/dev/pts/2"], "another transport's shell and a non-tty stdin are excluded");
    assert.deepEqual(rows.map((row) => row.startTime).sort((a, b) => a - b), [100, 200], "start times come from stat, not from pid order");

    // Two idle terminals on one transport: the tty filter picks the right one,
    // which is exactly the case where the pre-0.3.0 "unique shell" rule gave up.
    const unfiltered = runCwd("pwd -P");
    assert.equal(extractExecCwd(unfiltered.stdout).cwd, null, "without a tty the ambiguity is reported, not guessed");
    assert.match(unfiltered.stderr, /multiple interactive shells/);

    const first = runCwd("pwd -P", "/dev/pts/1");
    assert.equal(first.status, 0);
    // pwd -P resolves symlinks: on macOS /var is a link to /private/var.
    const realOne = realpathSync(cwdOne);
    const realTwo = realpathSync(cwdTwo);
    assert.equal(extractExecCwd(first.stdout).cwd, realOne, "the filter lands in the first terminal's directory");
    const second = runCwd("pwd -P", "/dev/pts/2");
    assert.equal(second.status, 0);
    assert.equal(extractExecCwd(second.stdout).cwd, realTwo, "and the second one in its own");

    // A tty that no longer has a shell degrades to the login directory; the
    // command still runs (never blocked for a diagnostic mismatch).
    const stale = runCwd("echo RAN", "/dev/pts/99");
    assert.equal(stale.status, 0);
    assert.match(stale.stdout, /RAN/);
    assert.equal(extractExecCwd(stale.stdout).cwd, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log("terminal census: parser, tty diff, unclaimed fallback, script and tty-targeted cwd: passed");
}
