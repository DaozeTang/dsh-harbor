/**
 * Build the browser half as one CommonJS bundle wrapped in the ModuleLoader
 * registration contract the Web shell expects.
 *
 * react stays external (the shell's platform table supplies it); xterm, the
 * fit/search addons and the plugin's own CSS are inlined, so a plugin install
 * needs no extra module row. CSS is imported as text and installed at runtime
 * by ui/styles.js — the host owns the page, so the plugin must add exactly one
 * <style> tag and nothing else.
 */
import { build } from "esbuild";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cjsOut = resolve(rootDir, "lib/client.cjs");
const clientOut = resolve(rootDir, "lib/client.js");
const manifest = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8"));

const worker = await build({
  entryPoints: [resolve(rootDir, "src/client/features/terminal-display/highlight-worker.js")],
  bundle: true, write: false, platform: "browser", format: "iife", target: "es2022", minify: true
});

await build({
  entryPoints: [resolve(rootDir, "src/client/index.jsx")],
  outfile: cjsOut,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  bundle: true,
  sourcemap: false,
  loader: { ".css": "text" },
  define: {
    __DSH_HARBOR_VERSION__: JSON.stringify(manifest.version),
    __DSH_HIGHLIGHT_WORKER_SOURCE__: JSON.stringify(worker.outputFiles[0].text)
  },
  external: ["react", "react/*", "react-dom", "react-dom/*", "@deepseek-ai/*"],
  logLevel: "info"
});

const raw = readFileSync(cjsOut, "utf8");
const indented = raw.split("\n").map((line) => {
  const normalized = line.trimEnd();
  return normalized ? "\t\t" + normalized : "";
}).join("\n");
const wrapped =
  "window.__ModuleLoader__.load({\n\tid: \"dsh-harbor\",\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n" +
  indented +
  "\n\t\treturn module.exports;\n\t}\n});\n";
writeFileSync(clientOut, wrapped, "utf8");
rmSync(cjsOut, { force: true });
console.log("build-client: wrote " + clientOut + " (" + wrapped.length + " bytes)");
