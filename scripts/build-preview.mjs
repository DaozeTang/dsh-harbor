/**
 * Offline UI preview: bundle the gallery, copy the host's token sheet, and
 * write two standalone pages (light + dark) plus one page that shows both in
 * iframes — the screenshot target for design review.
 *
 * The token sheet is read from a DeepSeek Harness install (DSH_THEME_CSS_DIR,
 * or the extracted app.asar path this repo's tooling uses) and filtered down
 * to custom properties only, so the preview is faithful without vendoring the
 * host's component CSS.
 */
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readThemeTokens } from "./theme-tokens.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(rootDir, "preview/out");
mkdirSync(outDir, { recursive: true });

// Point this at a DSH install's `@deepseek-ai/dsh-client-ui-theme/src/styles`
// directory to use live tokens. Without it the committed token snapshot in
// preview/theme-fallback.css keeps the harness self-contained.
const THEME_DIRS = [process.env.DSH_THEME_CSS_DIR].filter(Boolean);

function themeDir() {
  for (const dir of THEME_DIRS) if (existsSync(join(dir, "design-platform.css"))) return dir;
  return null;
}

let tokenCSS = "";
const dir = themeDir();
if (dir !== null) {
  // The token sheets scope their palettes by selector (body for light,
  // body[data-ds-dark-theme] for dark); keep those rules instead of flattening
  // them, or the light preview loses every semantic alias.
  tokenCSS = readThemeTokens(dir);
  console.log("preview: tokens from", dir);
} else {
  const fallback = resolve(rootDir, "preview/theme-fallback.css");
  if (!existsSync(fallback)) {
    throw new Error("preview: no DSH_THEME_CSS_DIR and no preview/theme-fallback.css; cannot render a faithful preview");
  }
  console.warn("preview: DSH_THEME_CSS_DIR not set; using the committed token snapshot");
  tokenCSS = readFileSync(fallback, "utf8");
}

for (const entry of ["gallery", "workspace", "settings"]) {
  await build({
    entryPoints: [resolve(rootDir, `preview/${entry}.jsx`)],
    outfile: resolve(outDir, `${entry}.js`),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    loader: { ".css": "text" },
    jsx: "transform",
    define: {
      "process.env.NODE_ENV": '"production"',
      __DSH_HARBOR_VERSION__: JSON.stringify(JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8")).version)
    },
    logLevel: "info"
  });
}

const platform = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";
const page = (theme, entry) => `<!doctype html>
<html lang="zh-CN" data-theme="${theme}" data-platform="${platform}">
<head>
<meta charset="utf-8">
<title>Harbor · ${theme}</title>
<style>${tokenCSS}</style>
<style>
  html { background: #fff; }
  html:has(body[data-ds-dark-theme]) { background: #151517; }
  body { margin: 0; min-height: 100vh; background: var(--dsw-alias-bg-base, #fff); font-family: var(--dsw-font-family, -apple-system, sans-serif); }
  /* Asset capture: ?capture drops the preview chrome so a screenshot of the
     page is a screenshot of the surface alone. ?bare keeps the page layout
     (padding, auto height) and hides only the preview header. */
  html.cap [data-preview-chrome] { display: none; }
  html.bare [data-preview-chrome] { display: none; }
  html.cap #root { max-width: none; }
  html.cap #root > .hb { padding: 0 !important; }
  html.cap [data-preview-chrome] { display: none; }
  /* Capture mode shows one surface at full viewport height: no preview
     header, no fixed frame height, no padding fade at the bottom. */
  html.cap [data-preview-frame] { height: 100vh !important; border: 0 !important; border-radius: 0 !important; }
  html.cap #root > .hb > section.hb { padding: 0 !important; gap: 0 !important; }
  html.cap .hb-page { padding-bottom: 0; }
  #root { max-width: 900px; margin: 0 auto; }
</style>
</head>
<body${theme === "dark" ? " data-ds-dark-theme" : ""}>
<script>
  if (location.search.includes("capture")) document.documentElement.classList.add("cap");
  if (location.search.includes("bare")) document.documentElement.classList.add("bare");
</script>
<div id="root"></div>
<script src="./${entry}.js"></script>
</body>
</html>`;

writeFileSync(resolve(outDir, "light.html"), page("light", "gallery"));
writeFileSync(resolve(outDir, "dark.html"), page("dark", "gallery"));
writeFileSync(resolve(outDir, "workspace-light.html"), page("light", "workspace"));
writeFileSync(resolve(outDir, "workspace-dark.html"), page("dark", "workspace"));
writeFileSync(resolve(outDir, "settings-light.html"), page("light", "settings"));
writeFileSync(resolve(outDir, "settings-dark.html"), page("dark", "settings"));
writeFileSync(resolve(outDir, "index.html"), `<!doctype html>
<html><head><meta charset="utf-8"><title>Harbor preview</title>
<style>html,body{margin:0;height:100%;background:#8a8f98}iframe{border:0;width:50%;height:100vh;display:block}main{display:flex;height:100%}</style>
</head><body><main><iframe src="./light.html"></iframe><iframe src="./dark.html"></iframe></main></body></html>`);

console.log("preview: wrote", outDir);