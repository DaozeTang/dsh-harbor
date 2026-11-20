/**
 * Package manifest and packed-artifact audit.
 *
 * Two failure classes are invisible on a developer machine and fatal for
 * everyone else, so they are pinned here rather than trusted to review:
 *
 * 1. The DSH web loader composes a package's browser half only when
 *    package.json declares `dsh.client` (platform "web") beside
 *    `dsh.bundle.patch`. Losing that block leaves the host half working while
 *    every client surface silently disappears.
 * 2. The packed tarball is the only runtime surface most users ever see, and a
 *    link-mounted dev tree always has `lib/` on disk. The exact packed file set
 *    is asserted, so adding a root file or losing a bundle must be a deliberate
 *    checklist change.
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// ── dependency placement ───────────────────────────────────────────────────
// Only modules the host keeps external (resolving from the profile's
// node_modules at runtime) may be runtime dependencies; everything else is
// bundled into lib/ or used at build time only, so shipping it as a runtime
// dependency would land it in the Desktop install closure twice.
assert.deepEqual(Object.keys(manifest.dependencies ?? {}).sort(), ["ssh2"],
  "runtime dependencies stay limited to modules resolved from the profile at runtime");
assert.ok(manifest.devDependencies?.zod, "the validator is bundled into lib/, so it is build-time only");
assert.equal(manifest.dependencies?.["@xterm/addon-search"], undefined,
  "the bundled xterm addon must not enter the Desktop runtime closure");
assert.ok(manifest.devDependencies?.["@xterm/addon-search"], "the xterm search addon remains available to the client build");
assert.equal(manifest.dependencies?.["@types/node"], undefined, "Node typings are build-time only");
assert.ok(manifest.devDependencies?.["@types/node"], "Node typings remain available to tooling");

// ── loader contract ────────────────────────────────────────────────────────
assert.ok(manifest.dsh?.bundle?.patch, "dsh.bundle.patch declares the cordis patch layer");
assert.equal(manifest.dsh?.client?.platform, "web", "dsh.client.platform=web is what makes the web loader compose the client bundle");
assert.ok(
  manifest.dsh?.client?.inject === undefined || Array.isArray(manifest.dsh.client.inject),
  "dsh.client.inject, when present, is an array of package rows"
);
// The browser bundle imports react (a platform module) and its own files only,
// so it must not request dynamic package rows. The host has no
// `@deepseek-ai/dsh-client-runtime` row to wait for; declaring one made the
// edge dead weight that could never be satisfied.
assert.deepEqual(manifest.dsh.client.inject ?? [], [],
  "the client bundle requests no dynamic package rows beyond the platform table");
assert.equal(manifest.exports?.["."]?.default, "./lib/index.js", 'exports["."] maps the host entry (exports wins over main)');
assert.equal(manifest.exports?.["./client"]?.default, "./lib/client.js", 'exports["./client"] maps the browser bundle');
assert.equal(manifest.exports?.["./typert"]?.default, "./lib/typert.js", 'exports["./typert"] is how the host loader finds RPC codecs');
assert.equal(manifest.exports?.["./remote"]?.default, "./lib/remote.js", 'exports["./remote"] is the client-side RPC contribution');
assert.equal(manifest.exports?.["./locale/*.json"], "./locale/*.json", "locale resources must be exported for the Host reader");
assert.equal(manifest.icon, "./icon.svg", "the plugin manager resolves the manifest icon from the package root");
assert.match(manifest.scripts?.prepare ?? "", /npm run build/,
  "scripts.prepare must run npm run build — git-channel installs rely on it to generate lib/");
assert.ok(manifest.engines?.dsh, "engines.dsh declares the supported host range");

// ── shipped metadata ──────────────────────────────────────────────────────
assert.ok(manifest.files.includes("lib/**/*.js"), "the npm package keeps generated runtime artifacts");
assert.ok(manifest.files.includes("locale/*.json"), "locale dictionaries must ship in the published package");
assert.ok(manifest.files.includes("CHANGELOG.md") && manifest.files.includes("INSTALL.md"),
  "the README links to CHANGELOG.md and INSTALL.md, so both must ship");
assert.ok(manifest.files.includes("docs/product-guide.md"), "the README links to the product guide");
assert.ok(!manifest.files.some((entry) => entry.startsWith("src")), "source stays in Git, not in the runtime package");

for (const language of ["en", "zh"]) {
  const dictionary = JSON.parse(readFileSync(join(root, "locale", `${language}.json`), "utf8"));
  assert.ok(typeof dictionary.meta?.title === "string" && dictionary.meta.title.trim() !== "",
    `locale/${language}.json needs a non-empty meta.title (the Host throws on empty strings)`);
  assert.ok(typeof dictionary.meta?.description === "string" && dictionary.meta.description.trim() !== "",
    `locale/${language}.json needs a non-empty meta.description (the Host throws on empty strings)`);
}

// ── packed file set ───────────────────────────────────────────────────────
// npm needs a writable cache; the machine-wide one can be owned by another user
// (a stale root-owned ~/.npm is common) and that must not fail a packaging
// audit. A throwaway cache keeps the check hermetic.
const npmCache = mkdtempSync(join(tmpdir(), "harbor-pack-"));
const npmEnv = { ...process.env, npm_config_cache: npmCache };

if (!existsSync(join(root, "lib", "index.js"))) {
  execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit", env: npmEnv, shell: process.platform === "win32" });
}
const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: root, encoding: "utf8", env: npmEnv, shell: process.platform === "win32"
});
assert.equal(packed.status, 0, `npm pack --dry-run failed: ${packed.stderr}`);
const stdout = packed.stdout;
const start = stdout.indexOf("[");
const end = stdout.lastIndexOf("]");
assert.ok(start !== -1 && end > start, `npm pack produced no JSON manifest; stdout was: ${stdout.slice(0, 400)}`);
const packedFiles = JSON.parse(stdout.slice(start, end + 1))[0].files.map((file) => file.path).sort();

const chunkFiles = readdirSync(join(root, "lib", "chunks")).map((name) => `lib/chunks/${name}`).sort();
assert.ok(chunkFiles.length >= 1, "the host build keeps its lazy and shared chunks");

const expected = [
  "CHANGELOG.md",
  "INSTALL.md",
  "LICENSE",
  "README.en.md",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "cordis.patch.yml",
  "docs/assets/files-light.png",
  "docs/assets/settings-light.png",
  "docs/assets/workspace-light.png",
  "docs/icon-pipeline.md",
  "docs/product-guide.md",
  "docs/ui-guidelines.md",
  "icon.svg",
  "lib/client.js",
  ...chunkFiles,
  "lib/index.js",
  "lib/remote.js",
  "lib/typert.js",
  "locale/en.json",
  "locale/zh.json",
  "package.json",
  "scripts/build-client.mjs",
  "scripts/build-host.mjs",
  "scripts/build-preview.mjs",
  "scripts/gen-xterm-css.mjs",
  "scripts/i18n-extract.mjs",
  "scripts/install-dev.mjs",
  "scripts/install-test-stubs.mjs",
  "scripts/list-tests.mjs",
  "scripts/package-release.mjs",
  "scripts/sync-theme-snapshot.mjs",
  "scripts/theme-tokens.mjs"
].sort();

assert.deepEqual(
  packedFiles,
  expected,
  "the packed tarball's file set drifted from the audited manifest — update the expectation deliberately"
);