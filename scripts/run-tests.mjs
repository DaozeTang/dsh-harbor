/**
 * Run the test suite on every platform.
 *
 * `package.json` used to spell `node --test $(node scripts/list-tests.mjs)`:
 * command substitution is a POSIX shell feature, so the documented test
 * command failed outright in cmd.exe even though the rest of the tooling
 * (build-preview, i18n-extract, manifest) handles win32 deliberately. This one
 * entry point walks the spec directories and spawns the runner, so `npm test`
 * behaves the same in cmd, PowerShell and sh.
 *
 * Specs live in nested directories that mirror `src/`; a new file is picked
 * up automatically and can never be silently left out of CI. Only `support`
 * and `fixtures` are skipped: they hold helpers and data, not specs.
 *
 * Usage: node scripts/run-tests.mjs [--list] [extra node --test args]
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["support", "fixtures", "node_modules"]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
      continue;
    }
    if (entry.name.endsWith(".mjs")) out.push(relative(root, full).split(sep).join("/"));
  }
  return out;
}

const files = walk(join(root, "test")).sort();

if (files.length === 0) {
  console.error("no test files found under test/");
  process.exit(1);
}

if (process.argv.includes("--list")) {
  process.stdout.write(files.join(process.platform === "win32" ? "\n" : " ") + "\n");
  process.exit(0);
}

const extra = process.argv.slice(2).filter((arg) => arg !== "--list");
const child = spawn(process.execPath, ["--test", ...extra, ...files], { cwd: root, stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal !== null) {
    console.error(`test runner was killed by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
child.on("error", (error) => {
  console.error("could not start node --test:", error.message);
  process.exit(1);
});
