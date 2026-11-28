// Structural guards for the layout described in docs/restructure-plan.md.
//
// These assertions are deliberately cheap: they read file names and import
// specifiers, never module behaviour, so they fail on a move that was not
// finished instead of failing somewhere deep in a feature test.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Public entry points named by package.json, cordis.patch.yml and the loader. */
const ENTRY_POINTS = [
  "src/index.js",
  "src/terminal-backend.js",
  "src/rpc/typert.js",
  "src/rpc/remote.js",
  "src/client/index.jsx",
];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|jsx|mjs|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function readImports(file) {
  const text = fs.readFileSync(file, "utf8");
  const specs = [];
  for (const match of text.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)) specs.push(match[1]);
  return specs;
}

function resolves(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  return [base, base + ".js", base + ".jsx", base + ".mjs", base + ".css", path.join(base, "index.js")].some((candidate) =>
    fs.existsSync(candidate),
  );
}

test("public entry points exist", () => {
  for (const entry of ENTRY_POINTS) assert.ok(fs.existsSync(path.join(ROOT, entry)), `missing entry point: ${entry}`);
});

test("package.json keeps its public export surface", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.deepEqual(
    Object.keys(manifest.exports ?? {}).sort(),
    [".", "./client", "./locale/*.json", "./package.json", "./remote", "./terminal-backend", "./typert"],
  );
  if (!fs.existsSync(path.join(ROOT, "lib"))) return;
  for (const [name, target] of Object.entries(manifest.exports)) {
    const rel = typeof target === "string" ? target : target.default;
    if (rel.includes("*")) continue;
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `export "${name}" points at missing ${rel}`);
  }
});

test("every relative import in src, test and scripts resolves", () => {
  const broken = [];
  for (const dir of ["src", "test", "scripts"]) {
    for (const file of walk(path.join(ROOT, dir))) {
      if (file.endsWith(".css")) continue;
      for (const spec of readImports(file)) {
        if (!resolves(file, spec)) broken.push(`${path.relative(ROOT, file)} -> ${spec}`);
      }
    }
  }
  assert.deepEqual(broken, [], "unresolved relative imports:\n" + broken.join("\n"));
});


/** Resolve a relative specifier to a repo-relative path, or null. */
function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, base + ".js", base + ".jsx", base + ".mjs", base + ".css", path.join(base, "index.js")]) {
    if (fs.existsSync(candidate)) return path.relative(ROOT, candidate).split(path.sep).join("/");
  }
  return null;
}

test("layer roots keep only their entry files", () => {
  const hostRoot = walk(path.join(ROOT, "src/host")).filter((file) => path.dirname(file) === path.join(ROOT, "src/host"));
  assert.deepEqual(hostRoot.map((file) => path.basename(file)), [], "src/host/ must hold directories only");

  const clientRoot = fs
    .readdirSync(path.join(ROOT, "src/client"), { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  assert.deepEqual(clientRoot, ["index.jsx"], "src/client/ must hold only the plugin entry");
});

test("client and host never import each other", () => {
  const violations = [];
  for (const [own, forbidden] of [
    ["src/client", "src/host"],
    ["src/host", "src/client"],
    ["src/shared", "src/host"],
    ["src/shared", "src/client"],
  ]) {
    for (const file of walk(path.join(ROOT, own))) {
      if (file.endsWith(".css")) continue;
      for (const spec of readImports(file)) {
        const target = resolveRelative(file, spec);
        if (target?.startsWith(forbidden + "/")) {
          violations.push(`${path.relative(ROOT, file)} -> ${spec}`);
        }
      }
    }
  }
  assert.deepEqual(violations, [], "layer boundary crossed:\n" + violations.join("\n"));
});

test("feature directories carry code, not only stylesheets", () => {
  const features = path.join(ROOT, "src/client/features");
  const styleOnly = fs
    .readdirSync(features, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      const files = walk(path.join(features, name));
      return files.length > 0 && files.every((file) => file.endsWith(".css"));
    });
  assert.deepEqual(styleOnly, [], "feature directories must contain components or helpers");
});

test("shared/ stays platform neutral", () => {
  const shared = path.join(ROOT, "src/shared");
  if (!fs.existsSync(shared)) return;
  const offenders = [];
  for (const file of walk(shared)) {
    const text = fs.readFileSync(file, "utf8");
    if (/(?:from|import)\s*\(?\s*["']node:/.test(text)) offenders.push(path.relative(ROOT, file));
  }
  assert.deepEqual(offenders, [], "shared modules must not import node builtins: " + offenders.join(", "));
});