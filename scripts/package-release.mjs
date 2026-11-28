import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The source archive (the ZIP) carries this tree; the tarball beside it is the
 * installable package and is defined by package.json `files`. Two different
 * artifacts on purpose — but every entry here must exist, because a stale name
 * used to be skipped without a word.
 */
export const RELEASE_ARCHIVE_ENTRIES = [
  "lib",
  "src",
  "scripts",
  "test",
  "locale",
  "docs",
  "package.json",
  "package-lock.json",
  "eslint.config.js",
  ".editorconfig",
  "cordis.patch.yml",
  "icon.svg",
  "preview",
  "README.md",
  "README.en.md",
  "INSTALL.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "CHANGELOG.md"
];

/**
 * Local manual integration files are ignored in Git and must never reach ZIPs;
 * the preview's generated `out/` is rebuilt by `npm run preview:ui` and would
 * only bloat the archive with stale screenshots.
 */
export function shouldCopyReleaseEntry(source, root = DEFAULT_ROOT) {
  const excluded = [join(root, "test", "manual"), join(root, "preview", "out")];
  return excluded.every((directory) => source !== directory && !source.startsWith(`${directory}${sep}`));
}

function packageRelease(root = DEFAULT_ROOT) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const release = join(root, "release");
  const archiveRoot = `${pkg.name}-${pkg.version}`;
  const stage = join(release, archiveRoot);

  rmSync(release, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  for (const entry of RELEASE_ARCHIVE_ENTRIES) {
    const source = join(root, entry);
    if (!existsSync(source)) throw new Error(`release archive entry does not exist: ${entry} (${source})`);
    cpSync(source, join(stage, basename(entry)), {
      recursive: true,
      filter: (candidate) => shouldCopyReleaseEntry(candidate, root)
    });
  }

  // --ignore-scripts: prepare (which builds lib/) must not re-run during pack —
  // pack:release has already built the exact artifacts this tarball should ship.
  execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", release], { cwd: root, stdio: "inherit" });
  execFileSync("zip", ["-q", "-r", "-X", join(release, `${archiveRoot}.zip`), archiveRoot], { cwd: release, stdio: "inherit" });
  rmSync(stage, { recursive: true, force: true });

  console.log(`release assets created in ${release}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  packageRelease();
}
