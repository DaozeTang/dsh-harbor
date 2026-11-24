/**
 * Build the host faces for Node as ESM.
 *
 * Three artifacts come out of one pass: the plugin entry, the typert manifest
 * the loader discovers through the package's "./typert" export, and the client
 * typert contribution the browser bundle imports. @deepseek-ai/* and ssh2 stay
 * external — they resolve from the profile's node_modules at runtime — while
 * zod is bundled so its dependency tree never enters the desktop install
 * closure.
 */
import { build } from "esbuild";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
rmSync(resolve(rootDir, "lib", "chunks"), { recursive: true, force: true });

await build({
  entryPoints: {
    index: resolve(rootDir, "src/index.js"),
    typert: resolve(rootDir, "src/rpc/typert.js"),
    remote: resolve(rootDir, "src/rpc/remote.js"),
    "terminal-backend": resolve(rootDir, "src/terminal-backend.js")
  },
  outdir: resolve(rootDir, "lib"),
  format: "esm",
  platform: "node",
  target: "node20",
  bundle: true,
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  sourcemap: false,
  banner: { js: "import { createRequire as __dshCreateRequire } from 'node:module'; const require = __dshCreateRequire(import.meta.url);" },
  external: ["@deepseek-ai/*", "ssh2"],
  logLevel: "info"
});

for (const file of ["index.js", "typert.js", "remote.js", "terminal-backend.js"]) {
  const path = resolve(rootDir, "lib", file);
  writeFileSync(path, readFileSync(path, "utf8").replace(/[ \t]+$/gm, ""), "utf8");
}
console.log("build-host: wrote lib/index.js, lib/typert.js, lib/remote.js, lib/terminal-backend.js");
