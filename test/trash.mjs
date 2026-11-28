import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSimpleDeleteCommand, buildTrashCommand, parseTrashOutput, TRASH_RETENTION_MS } from "../src/host/trash.js";

// The parser/serialiser halves run anywhere, but the end-to-end half executes
// the generated scripts through /bin/sh in a sandbox with HOME overrides and
// symlinks — POSIX shell semantics are the subject under test (the trash
// flow targets remote POSIX servers, not the local platform).
if (process.platform === "win32") {
  console.log("trash: skipped on Windows (end-to-end half requires /bin/sh sandbox semantics)");
  process.exit(0);
}

/** Manifest rows (name, original, epoch, iso), parsed here so the test pins the format itself. */
function manifestRows(text) {
  return String(text)
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split("\t"));
}

// ── parser ───────────────────────────────────────────────────────────────────

const parseable = [
  ["rm /tmp/x", [{ kind: "plain", path: "/tmp/x" }]],
  ["rm -rf /tmp/x", [{ kind: "plain", path: "/tmp/x" }]],
  ["rm -r -f /tmp/x /tmp/y", [{ kind: "plain", path: "/tmp/x" }, { kind: "plain", path: "/tmp/y" }]],
  ["rm -rfv /tmp/a b", [{ kind: "plain", path: "/tmp/a" }, { kind: "plain", path: "b" }]],
  ["rm -- -/weird", [{ kind: "plain", path: "-/weird" }]],
  ["rm '/tmp/a b'", [{ kind: "plain", path: "/tmp/a b" }]],
  ["unlink file", [{ kind: "plain", path: "file" }]],
  ["rmdir -v emptydir", [{ kind: "plain", path: "emptydir" }]],
  ["rm -rf '~/my dir'", [{ kind: "plain", path: "~/my dir" }]],
  ["rm -rf ~/logs", [{ kind: "home", path: "logs" }]],
  ["rm -f -- ./relative", [{ kind: "plain", path: "./relative" }]],
  ["rm -rf\tx", [{ kind: "plain", path: "x" }]] // a tab is an IFS separator, exactly like a space
];
for (const [command, expected] of parseable) {
  const parsed = parseSimpleDeleteCommand(command);
  assert.notEqual(parsed, null, `expected parseable: ${command}`);
  assert.deepEqual(parsed.targets, expected, `targets of: ${command}`);
}

const rejected = [
  null, undefined, "",
  "rm",
  "rm -rf", // flags only, no target
  "rm -rf /tmp/x && echo done", // compound
  "rm -rf /tmp/x; echo done",
  "rm -rf /tmp/x | cat",
  "cat log | rm -i", // not a leading delete
  "rm -rf /tmp/$(whoami)",
  "rm -rf /tmp/`id -u`",
  "rm -rf /tmp/x > /dev/null",
  "rm -rf /tmp/*.log", // globs cannot be re-quoted safely
  "rm -rf ~", // bare home
  "rm -rf /", // root
  "rm -rf .",
  "rm -rf ..",
  "rm --recursive /tmp/x", // long options
  "rm -p x", // unknown flag
  "rmdir -p a/b",
  "shred /tmp/x", // in-place overwrite is not trashable
  "sudo rm -rf /tmp/x",
  "/bin/rm -rf /tmp/x",
  "RM -rf /tmp/x", // commands are case-sensitive
  "rm ''",
  "rm ~user/x",
  "rm -rf -" // stdin convention
];
for (const command of rejected) {
  assert.equal(parseSimpleDeleteCommand(command), null, `expected rejected: ${JSON.stringify(command)}`);
}

// ── shell-active bytes in ~ targets stay literal ────────────────────────────
//
// A backslash-escaped character is a LITERAL byte for the shell. Re-emitting it
// inside double quotes would expand it in the generated trash script, so an
// approved "delete this literal path" could run $(...) or a backtick command.
{
  const literal = parseSimpleDeleteCommand("rm -rf ~/x\\$\\(echo\\ hi\\) ~/p\\`echo\\ hi\\` ~/v\\$PID");
  assert.notEqual(literal, null, "escaped characters are literal, not a reason to reject the rewrite");
  assert.deepEqual(literal.targets, [
    { kind: "home", path: "x$(echo hi)" },
    { kind: "home", path: "p`echo hi`" },
    { kind: "home", path: "v$PID" }
  ]);
  const script = buildTrashCommand(literal.targets);
  const listLine = script.split("\n").find((line) => line.startsWith("for __dsh_p in "));
  assert.equal(
    listLine,
    "for __dsh_p in \"$HOME\"/'x$(echo hi)' \"$HOME\"/'p`echo hi`' \"$HOME\"/'v$PID'; do",
    "the ~ tail must be single-quoted so no expansion can run"
  );

  // End-to-end: a file whose name is literally x$(echo hi) is the one moved.
  const base = mkdtempSync(join(tmpdir(), "dsh-trash-literal-"));
  try {
    const home = join(base, "home");
    mkdirSync(home, { recursive: true });
    const literalName = "x$(echo hi)";
    writeFileSync(join(home, literalName), "literal\n");
    const run = runInSandbox(buildTrashCommand([{ kind: "home", path: literalName }]), { home, cwd: base });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(existsSync(join(home, literalName)), false, "the literal file the operator approved is the one moved");
    assert.match(run.stdout, /__DSH_TRASH_V1__\tmoved\t/, run.stdout);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// ── output parsing ───────────────────────────────────────────────────────────

{
  const stdout = "__DSH_CWD_MARK__\n__DSH_TRASH_V1__\tpurged\t2\nsome output\n__DSH_TRASH_V1__\tmoved\t/tmp/x\t/root/.dsh-trash/1700000000-x\n__DSH_TRASH_V1__\tmissing\t/tmp/none\n__DSH_TRASH_V1__\tfailed\t/tmp/stuck\n";
  const parsed = parseTrashOutput(stdout);
  assert.deepEqual(parsed.events, [
    { event: "purged", count: 2 },
    { event: "moved", original: "/tmp/x", trashPath: "/root/.dsh-trash/1700000000-x" },
    { event: "missing", original: "/tmp/none" },
    { event: "failed", original: "/tmp/stuck" }
  ]);
  assert.equal(parsed.stdout, "__DSH_CWD_MARK__\nsome output\n", "protocol lines must be stripped from visible output");
}

// ── end-to-end with a real /bin/sh ───────────────────────────────────────────

function runInSandbox(script, sandbox) {
  return spawnSync("/bin/sh", ["-c", script], {
    encoding: "utf8",
    cwd: sandbox.cwd,
    // `PATH` is overridable so a case can put a refusing `rm` first, the way a
    // permission/immutable/mount failure refuses a purge in the field.
    env: { ...process.env, HOME: sandbox.home, PATH: sandbox.PATH ?? process.env.PATH }
  });
}

{
  const base = mkdtempSync(join(tmpdir(), "dsh-trash-"));
  const home = join(base, "home");
  const cwd = join(base, "work");
  mkdirSync(join(home, "data", "logs"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(home, "data", "db.sqlite"), "payload");
  writeFileSync(join(home, "data", "logs", "app.log"), "log line\n");
  writeFileSync(join(cwd, "relative.txt"), "rel");
  const sandbox = { home, cwd };

  const parsed = parseSimpleDeleteCommand("rm -rf ~/data/logs ~/data/db.sqlite relative.txt");
  const script = buildTrashCommand(parsed.targets);

  const run = runInSandbox(script, sandbox);
  assert.equal(run.status, 0, `script failed: ${run.stderr}`);
  assert.equal(run.stderr, "");

  const parsedOut = parseTrashOutput(run.stdout);
  const moved = parsedOut.events.filter((e) => e.event === "moved");
  assert.equal(moved.length, 3, `expected three moved events, got: ${run.stdout}`);

  // Originals are gone.
  assert.equal(existsSync(join(home, "data", "logs")), false);
  assert.equal(existsSync(join(home, "data", "db.sqlite")), false);
  assert.equal(existsSync(join(cwd, "relative.txt")), false);

  // Trash layout: three entries plus the manifest, and only those.
  const trashDir = join(home, ".dsh-trash");
  const entries = readdirSync(trashDir).filter((name) => name !== "manifest.tsv");
  assert.equal(entries.length, 3);
  const logsEntry = entries.find((name) => name.endsWith("-logs"));
  assert.ok(logsEntry && existsSync(join(trashDir, logsEntry, "app.log")), "directory contents move with the entry");

  // Manifest records absolute originals; the relative one resolved to the
  // physical cwd (pwd -P), which differs from the logical path on macOS.
  const manifest = readFileSync(join(trashDir, "manifest.tsv"), "utf8");
  const listed = manifestRows(manifest);
  assert.equal(listed.length, 3);
  const physicalCwd = realpathSync(cwd);
  assert.deepEqual(listed.map((row) => row[1]).sort(), [join(home, "data/logs"), join(home, "data/db.sqlite"), join(physicalCwd, "relative.txt")].sort());

  rmSync(base, { recursive: true, force: true });
}

// Retention: entries older than the window are purged on the next trash run,
// fresh entries survive.
{
  const base = mkdtempSync(join(tmpdir(), "dsh-trash-ret-"));
  const home = join(base, "home");
  mkdirSync(join(home, ".dsh-trash"), { recursive: true });
  const sandbox = { home, cwd: home };
  const oldEpoch = Math.floor(Date.now() / 1000) - Math.floor(TRASH_RETENTION_MS / 1000) - 120;
  const trashDir = join(home, ".dsh-trash");
  mkdirSync(join(trashDir, `${oldEpoch}-old`), { recursive: true });
  writeFileSync(join(trashDir, `${oldEpoch}-old`, "f"), "x");
  writeFileSync(join(trashDir, "manifest.tsv"), `${oldEpoch}-old\t/old\t${oldEpoch}\told-time\n`);

  const parsed = parseSimpleDeleteCommand("rm fresh.txt");
  writeFileSync(join(home, "fresh.txt"), "new");
  const run = runInSandbox(buildTrashCommand(parsed.targets), sandbox);
  assert.equal(run.status, 0, run.stderr);

  assert.equal(existsSync(join(trashDir, `${oldEpoch}-old`)), false, "expired entry must be purged");
  assert.equal(existsSync(join(trashDir, "fresh.txt")), false, "the new target must be moved");
  const listed = manifestRows(readFileSync(join(trashDir, "manifest.tsv"), "utf8"));
  assert.equal(listed.length, 1);
  assert.match(listed[0][0], /-fresh\.txt$/, "the fresh manifest line survives the purge");
  assert.equal(listed[0][1], join(realpathSync(home), "fresh.txt"));

  rmSync(base, { recursive: true, force: true });
}

// A copy the purge cannot remove must keep its manifest row. Rewriting the
// manifest for every expired row dropped the index entry of data that was
// still on disk: those bytes then had no listing and no way to be reclaimed.
{
  const base = mkdtempSync(join(tmpdir(), "dsh-trash-stuck-"));
  try {
    const home = join(base, "home");
    const trashDir = join(home, ".dsh-trash");
    mkdirSync(trashDir, { recursive: true });
    const oldEpoch = Math.floor(Date.now() / 1000) - Math.floor(TRASH_RETENTION_MS / 1000) - 120;
    const removable = `${oldEpoch}-gone`;
    const stuck = `${oldEpoch}-stuck`;
    mkdirSync(join(trashDir, removable), { recursive: true });
    writeFileSync(join(trashDir, removable, "f"), "x");
    mkdirSync(join(trashDir, stuck), { recursive: true });
    writeFileSync(join(trashDir, stuck, "f"), "x");
    writeFileSync(join(trashDir, "manifest.tsv"), [
      `${removable}\t/home/gone\t${oldEpoch}\told`, 
      `${stuck}\t/home/stuck\t${oldEpoch}\told`,
      ""
    ].join("\n"));
    // A `rm` that refuses one entry, the way a permission, immutable or busy-
    // mount failure does in the field.
    const fakeBin = join(base, "bin");
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(fakeBin, "rm"), `#!/bin/sh
case "$*" in *${stuck}*) exit 1 ;; esac
exec /bin/rm "$@"
`, { mode: 0o755 });
    const parsed = parseSimpleDeleteCommand("rm gone.txt");
    const run = runInSandbox(buildTrashCommand(parsed.targets), {
      home,
      cwd: home,
      PATH: `${fakeBin}:${process.env.PATH}`
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /__DSH_TRASH_V1__\tpurged\t1/, "only the removable copy counts as purged");
    assert.equal(existsSync(join(trashDir, removable)), false, "the removable copy is gone");
    assert.equal(existsSync(join(trashDir, stuck)), true, "the stuck copy is still on disk");
    const listed = manifestRows(readFileSync(join(trashDir, "manifest.tsv"), "utf8"));
    assert.deepEqual(listed.map((row) => row[0]), [stuck], "the stuck copy keeps its manifest row");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// Edge cases: missing target reported, symlink moved, broken symlink moved,
// quoting survives spaces and single quotes, and a quoted `~` stays literal
// (the shell would not expand it either).
{
  const base = mkdtempSync(join(tmpdir(), "dsh-trash-edge-"));
  const home = join(base, "home");
  mkdirSync(home, { recursive: true });
  const sandbox = { home, cwd: home };
  writeFileSync(join(home, "a b'c"), "quoted");
  writeFileSync(join(home, "spaced"), "spaced");
  symlinkSync("/nonexistent-target", join(home, "broken-link"));

  const parsed = parseSimpleDeleteCommand("rm -f '/tmp/never-exists' 'a b'\\''c' spaced broken-link");
  const run = runInSandbox(buildTrashCommand(parsed.targets), sandbox);
  assert.equal(run.status, 0, run.stderr);
  const { events } = parseTrashOutput(run.stdout);
  const missing = events.find((e) => e.event === "missing");
  assert.ok(missing && missing.original === "/tmp/never-exists");
  const moved = events.filter((e) => e.event === "moved");
  assert.equal(moved.length, 3, `quoted and symlink targets must move: ${run.stdout}`);

  const listed = manifestRows(readFileSync(join(home, ".dsh-trash", "manifest.tsv"), "utf8"));
  const physicalHome = realpathSync(home);
  assert.ok(listed.some((row) => row[1] === join(physicalHome, `a b'c`)), "single-quote path must land in the manifest verbatim");
  assert.ok(listed.some((row) => row[1] === join(physicalHome, "broken-link")));

  // A quoted `~/x` is a literal path — it moves a directory literally named
  // "~" relative to the cwd, never the real home.
  const literal = parseSimpleDeleteCommand("rm -rf '~/x'");
  assert.deepEqual(literal.targets, [{ kind: "plain", path: "~/x" }]);

  rmSync(base, { recursive: true, force: true });
}

// Collision: deleting the same basename twice in one run must not clobber.
{
  const base = mkdtempSync(join(tmpdir(), "dsh-trash-col-"));
  const home = join(base, "home");
  mkdirSync(join(home, "d1"), { recursive: true });
  mkdirSync(join(home, "d2"), { recursive: true });
  const sandbox = { home, cwd: home };
  writeFileSync(join(home, "d1", "same.txt"), "one");
  writeFileSync(join(home, "d2", "same.txt"), "two");

  const parsed = parseSimpleDeleteCommand("rm d1/same.txt d2/same.txt");
  const run = runInSandbox(buildTrashCommand(parsed.targets), sandbox);
  assert.equal(run.status, 0, run.stderr);
  const listed = manifestRows(readFileSync(join(home, ".dsh-trash", "manifest.tsv"), "utf8"));
  assert.equal(listed.length, 2, "both copies must be recorded");
  const names = new Set(listed.map((row) => row[0]));
  assert.equal(names.size, 2, "trash names must not collide");

  rmSync(base, { recursive: true, force: true });
}

console.log("trash: parser, builder, manifest and retention cases passed");
