
/**
 * Status pane: structure and formatting.
 *
 * The pane itself runs in a browser, so its contract is asserted at the source
 * level — the same style the rest of the client tests use. What matters here:
 * polling is gated on the tab being visible and the window not being hidden,
 * the four states all exist, the surface cannot invent numbers, and the CSS
 * stays inside the host token palette.
 *
 * The formatters are imported for real: they are pure and decide what an
 * operator reads ("1.8 TB", "—", "42 天 3 小时").
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { getLanguage, setLanguage } from "../src/i18n/core.js";
import {
  formatBytePair, formatBytes, formatClock, formatPercent, formatRate, formatUptime, niceCeiling, sparklinePoints, truncateMiddle, usageTone
} from "../src/client/features/monitor/metrics-format.js";
import { hostMethodMissing } from "../src/client/features/monitor/errors.js";

const pane = await readFile(new URL("../src/client/features/monitor/monitor-pane.jsx", import.meta.url), "utf8");
const css = await readFile(new URL("../src/client/features/monitor/monitor.css", import.meta.url), "utf8");
const panel = await readFile(new URL("../src/client/shell/HarborPanel.jsx", import.meta.url), "utf8");
const api = await readFile(new URL("../src/client/core/api.js", import.meta.url), "utf8");
const models = await readFile(new URL("../src/host/service/settings.js", import.meta.url), "utf8");
const harborservice = await readFile(new URL("../src/host/service/harbor-service.js", import.meta.url), "utf8");

// ── the panel owns the tab ─────────────────────────────────────────────────
{
  assert.match(panel, /\{ value: "monitor", icon: "gauge-outline", label: \(\) => t\("状态"\), needsConnection: true, feature: "showMonitor" \}/,
    "the tab sits between terminal and files, and is gated by its own feature switch");
  assert.match(panel, /<MonitorPane[\s\S]{0,220}active=\{view === "monitor"\}/,
    "the pane is told when it is the visible view, so hidden tabs stop polling");
  assert.match(panel, /if \(!paneReady\)\s+return;/, 
    "the empty-connection fallback waits until the pane really has a connection list");
  assert.match(panel, /if \(active === null && \(view === "monitor" \|\| view === "files" \|\| view === "tunnels"\)\) setView\("terminal"\)/,
    "closing the last server leaves the pane on a view that exists");
}

// ── polling is bounded by visibility, pause and the tab itself ─────────────
{
  assert.match(pane, /if \(!active \|\| paused \|\| connectionId === null\) return undefined;/,
    "no timer without a visible tab, an unpaused pane and a connection");
  assert.match(pane, /document\.visibilityState === "hidden"\) return;/,
    "an occluded window does not probe");
  assert.match(pane, /addEventListener\("visibilitychange", onVisibility\)/,
    "coming back to the window refreshes immediately");
  assert.match(pane, /return \(\) => \{[\s\S]{0,200}clearInterval\(timer\)/,
    "leaving the tab releases the timer");
  assert.match(pane, /useEffect\(\(\) => \{\n\s{4}setSample\(null\);\n\s{4}setError\(null\);\n\s{4}setHostMismatch\(false\);\n\s{2}\}, \[connectionId\]\)/,
    "switching servers drops the previous dashboard instead of showing it under a new name");
}

// ── the four states, and no invented numbers ───────────────────────────────
{
  assert.match(pane, /正在采样…/, "loading state");
  assert.match(pane, /这台设备暂不支持状态采集/, "unsupported state");
  assert.match(pane, /<ErrorNote/, "error state");
  assert.match(pane, /已暂停/, "paused state");
  assert.match(pane, /const DASH = "—";/, "unknown values render as an em dash");
  assert.match(pane, /formatPercent\(cpu\.usagePercent, 1\)/, "the headline number goes through the formatter");
  assert.doesNotMatch(pane, /window\.confirm/, "no blocking confirm on a read-only surface");
  assert.doesNotMatch(pane, /0%/, "the pane never hardcodes a zero reading");
}

// ── copy, cadence and the host contract ────────────────────────────────────
{
  assert.match(pane, /INTERVALS = \[2000, 5000, 10000\]/, "three cadences, 2s default");
  assert.match(pane, /localStorage\?\.setItem\(INTERVAL_KEY/, "the cadence is remembered per browser");
  assert.match(pane, /api\.systemStats\(connectionId, true\)/, "refresh bypasses the host cache");
  assert.match(api, /systemStats\(connectionId, refresh\) \{[\s\S]{0,200}this\.call\("systemStats"/, "the api wrapper exposes the sample");
  assert.match(models, /statusTools: this\.featureSettings\?\.statusTools !== false/, "the agent tool has its own switch");
  assert.match(harborservice, /if \(groups\.statusTools\) registerStatusTools\(ctx, this\)/, "the tool is registered behind that switch");
}

// ── the stylesheet stays inside the palette ────────────────────────────────
{
  assert.match(css, /^\.hb-monitor \{/m, "every rule is scoped under the pane root");
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, "no hex colours: the pane follows the host theme");
  assert.doesNotMatch(css, /var\(--(?!hb-|dsw-)/, "only host tokens and hb tokens are referenced");
}

// ── the per-core row stays inside the card ─────────────────────────────────
// A 128-core host painted its bar row past the CPU card's right border: one bar
// per core, a flat 3px gap and a 2px bar floor came to ~637px inside a ~324px
// card, and flex kept the row at that min-content width. It has to shrink.
{
  const charts = await readFile(new URL("../src/client/features/monitor/monitor-charts.jsx", import.meta.url), "utf8");
  const row = css.match(/\.hb-cores \{[^}]*\}/)?.[0] ?? "";
  const bar = css.match(/\.hb-core \{[^}]*\}/)?.[0] ?? "";
  assert.notEqual(row, "", "the per-core row has a rule of its own");
  assert.notEqual(bar, "", "each core bar has a rule of its own");
  assert.doesNotMatch(row, /gap: \d+px;/, "a flat gap cannot fit 128 cores into a sidebar card");
  assert.match(row, /gap: min\(3px, calc\(\d+% \/ var\(--hb-core-count, \d+\)\)\)/,
    "the gap is capped at the designed 3px and shrinks with the core count");
  const budget = Number(row.match(/calc\((\d+)% \/ var\(--hb-core-count/)?.at(1));
  assert.ok(budget > 0 && budget <= 40, "gaps may never take more than a third of the row, so the bars keep the rest");
  assert.match(bar, /min-width: 0;/, "a bar shrinks below 2px instead of pushing the row out of the card");
  assert.doesNotMatch(bar, /min-width: [1-9]/, "a pixel floor on the bars is what made the row wider than the card");
  assert.match(charts, /style=\{\{ "--hb-core-count": String\(values\.length\) \}\}/,
    "the row is handed its own count, which is what the shrink math divides by");
}

// ── formatters ─────────────────────────────────────────────────────────────
{
  const language = getLanguage();
  try {
    setLanguage("zh");
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(812), "812 B");
    assert.equal(formatBytes(1536), "1.5 KB");
    assert.equal(formatBytes(1953000000 * 1024), "1.8 TB");
    assert.equal(formatBytes(Number.NaN), "—", "a missing value is never 0");
    assert.equal(formatBytes(-1), "—");
    assert.equal(formatBytePair(1.8e12, 2e12), "1.6 TB / 1.8 TB", "a pair shares one unit so the halves compare");
    assert.equal(formatBytePair(Number.NaN, 1), "—");
    assert.equal(formatRate(null), "—");
    assert.equal(formatRate(1024), "1.0 KB/s");
    assert.equal(formatPercent(null), "—");
    assert.equal(formatPercent(12.44, 1), "12.4%");
    assert.equal(usageTone(20), "neutral", "a healthy disk is not coloured");
    assert.equal(usageTone(90), "warn");
    assert.equal(usageTone(97), "err");
    assert.equal(usageTone(null), "neutral");

    assert.equal(formatUptime(42), "42 秒");
    assert.equal(formatUptime(3700), "1 小时 1 分");
    assert.equal(formatUptime(400000), "4 天 15 小时");
    assert.equal(formatUptime(undefined), "—");

    assert.equal(formatClock("2026-11-23T10:24:03+08:00"), new Date("2026-11-23T10:24:03+08:00").toTimeString().slice(0, 8));
    assert.equal(formatClock("not a date"), "—");

    const chart = sparklinePoints([0, 50, 100], 100, 24, 100);
    assert.deepEqual(chart.split(" "), ["0.00,24.00", "50.00,12.00", "100.00,0.00"]);
    assert.equal(niceCeiling(1300), 2000, "an auto-scaled axis leaves headroom above the peak");
    assert.equal(niceCeiling(1), 1);
    assert.equal(niceCeiling(0), 1);
    const auto = sparklinePoints([1300, 1300], 100, 20).split(" ");
    assert.equal(auto[0].split(",")[1], "7.00", "a steady 1.3k/s line does not pin to the top of a 2k axis");
    assert.equal(sparklinePoints([], 100, 24, 100), "", "an empty history draws nothing");
    assert.equal(sparklinePoints([5], 100, 24, 100).split(" ").length, 1);

    assert.equal(truncateMiddle("short", 22), "short");
    assert.equal(truncateMiddle("a".repeat(40), 10).length, 10);

    setLanguage("en");
    assert.equal(formatUptime(3700), "1h 1m", "uptime is bilingual through the dictionary");
    assert.equal(formatUptime(400000), "4d 15h");
  } finally {
    setLanguage(language);
  }
}

// ── a host/client build mismatch is not a sampling failure ─────────────────
{
  assert.equal(hostMethodMissing({ code: "gateway/internal", message: "client api: harbor/systemStats failed: transport failure for /api/harbor/systemStats: HTTP 404" }), true,
    "the DSH transport 404 is recognized");
  assert.equal(hostMethodMissing({ code: "not-mounted", message: "harbor Remote method \"systemStats\" is not mounted" }), true);
  assert.equal(hostMethodMissing({ code: "gateway/definition-unavailable", message: "its strict definition was withdrawn" }), true);
  assert.equal(hostMethodMissing({ code: "probe-backoff", message: "采样暂停，4 秒后自动重试" }), false,
    "a host backoff is a normal sampling state");
  assert.equal(hostMethodMissing({ code: "connection-lost", message: "采样过程中连接断开，请稍后重试。" }), false);
  assert.equal(hostMethodMissing(null), false);
  assert.equal(hostMethodMissing(undefined), false);

  assert.match(pane, /hostMethodMissing\(cause\)/, "the pane routes the mismatch through the detector");
  assert.match(pane, /宿主端没有加载状态采样接口（HTTP 404）/, "the pane explains that a restart is required");
  assert.match(pane, /HOST_MISMATCH_RETRY_MS = 30000/, "a stale host is retried on a slow beat");
  assert.match(pane, /hostMismatch \? HOST_MISMATCH_RETRY_MS : intervalMs/, "the slow beat replaces the sampling cadence");
  assert.match(pane, /inFlightRef\.current/, "overlapping polls are suppressed on a slow link");
  assert.match(api, /systemStats\(connectionId, refresh\)/, "the endpoint still carries the refresh flag");
}

console.log("monitor pane: tab wiring, visibility gating, four states, contained core row, token-only CSS and formatters: passed");
