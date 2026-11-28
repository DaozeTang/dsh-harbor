/**
 * P1 codemod: move the files listed in docs/restructure-plan.md section 5 and
 * recompute every relative import from the file's new location.
 *
 * Two rules learned from the rehearsal in /tmp/harbor-shadow:
 *  - import specifiers are resolved against the OLD graph, then re-emitted
 *    relative to the NEW location of the importing file;
 *  - plain "src/..." string literals keep their existing prefix ("src/",
 *    "../src/") and only the tail is replaced, because tests build paths with
 *    path.join(ROOT, "src/...") and new URL("../src/...", import.meta.url).
 *
 * Usage: node scripts/oneoff/restructure.mjs [--check] [--root <dir>]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MOVE_MAP } from "./restructure-map.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const rootIndex = argv.indexOf("--root");
const ROOT = rootIndex === -1 ? path.resolve(here, "../..") : path.resolve(argv[rootIndex + 1]);
const CHECK = argv.includes("--check");

const oldToNew = new Map();
for (const [from, to] of Object.entries(MOVE_MAP)) {
  if (typeof to === "string") oldToNew.set(from, to);
}

const walk = (dir, out = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|jsx|mjs|css)$/.test(entry.name)) out.push(path.relative(ROOT, full).split(path.sep).join("/"));
  }
  return out;
};

const sourceFiles = [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "test")), ...walk(path.join(ROOT, "scripts"))];
const withSrc = sourceFiles.filter((f) => f.startsWith("src/") || f.startsWith("test/"));

const moves = [...oldToNew].filter(([from, to]) => from !== to);
const missing = moves.filter(([from]) => !fs.existsSync(path.join(ROOT, from))).map(([from]) => from);

if (missing.length > 0) {
  console.error("source files are missing; aborting before any change:\n" + missing.join("\n"));
  process.exit(1);
}

if (!CHECK) {
  for (const [from, to] of moves) {
    const absTo = path.join(ROOT, to);
    fs.mkdirSync(path.dirname(absTo), { recursive: true });
    fs.renameSync(path.join(ROOT, from), absTo);
  }
}

const newPathOf = (old) => oldToNew.get(old) ?? old;

const resolveOld = (spec, oldFile) => {
  const base = path.resolve(ROOT, path.dirname(oldFile), spec);
  const candidates = [base, base + ".js", base + ".jsx", base + ".mjs", base + ".css", path.join(base, "index.js")];
  for (const candidate of candidates) {
    const rel = path.relative(ROOT, candidate).split(path.sep).join("/");
    if (fs.existsSync(path.join(ROOT, newPathOf(rel)))) return rel;
  }
  return null;
};

const SPEC = /((?:import|export)\s[^;]*?from\s*|import\s*\(\s*)(['"])(\.[^'"]+)\2/g;
let rewritten = 0;
const unresolved = [];
for (const oldFile of withSrc) {
  const newFile = newPathOf(oldFile);
  const abs = path.join(ROOT, newFile);
  if (!fs.existsSync(abs)) continue;
  const before = fs.readFileSync(abs, "utf8");
  const after = before.replace(SPEC, (match, head, quote, spec) => {
    const oldTarget = resolveOld(spec, oldFile);
    if (oldTarget === null) {
      unresolved.push(oldFile + " -> " + spec);
      return match;
    }
    const newTarget = newPathOf(oldTarget);
    let rel = path.posix.relative(path.posix.dirname(newFile), newTarget);
    if (!rel.startsWith(".")) rel = "./" + rel;
    rewritten += 1;
    return head + quote + rel + quote;
  });
  if (after !== before && !CHECK) fs.writeFileSync(abs, after);
}

const STR = /(['"`])((?:\.\.\/)*)(src\/[^'"`]+)\1/g;
let stringRewrites = 0;
for (const file of [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "test")), ...walk(path.join(ROOT, "scripts"))]) {
  const abs = path.join(ROOT, file);
  const before = fs.readFileSync(abs, "utf8");
  const after = before.replace(STR, (match, quote, prefix, target) => {
    const mapped = newPathOf(target);
    if (mapped === target) return match;
    stringRewrites += 1;
    return quote + prefix + mapped + quote;
  });
  if (after !== before && !CHECK) fs.writeFileSync(abs, after);
}

// Drop directories the move emptied (features/settings only held one stylesheet).
if (!CHECK) {
  const prune = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) prune(path.join(dir, entry.name));
    }
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  };
  prune(path.join(ROOT, "src"));
}

const report = {
  root: ROOT,
  dryRun: CHECK,
  moves: moves.length,
  importsRewritten: rewritten,
  stringsRewritten: stringRewrites,
  unresolved: unresolved.length,
  unresolvedSamples: unresolved.slice(0, 10),
};
console.log(JSON.stringify(report, null, 2));
process.exit(unresolved.length === 0 ? 0 : 1);
