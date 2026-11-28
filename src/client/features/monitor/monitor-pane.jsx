
/**
 * The status tab: one read-only snapshot of the machine, refreshed while the
 * tab is visible.
 *
 * Two rules shape the whole surface:
 * - never invent a number. While the first interval is still open the pane
 *   prints an em dash, and a host that cannot be sampled says why instead of
 *   rendering an empty dashboard;
 * - the SSH connection is a shared, billed resource. Polling stops when the
 *   tab is hidden, the window is hidden, or the operator pauses, and the host
 *   coalesces duplicate requests from two panes anyway.
 */
import * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Badge, Button, Card, EmptyState, ErrorNote, IconButton, Notice, ProgressBar, SegmentedControl, useCopy, toast
} from "../../ui/kit.jsx";
import { installSurfaceStyles } from "../../ui/styles.js";
import { t } from "../../../i18n/core.js";
import CSS from "./monitor.css";
import { formatBytePair, formatBytes, formatClock, formatPercent, formatRate, formatUptime, usageTone } from "./metrics-format.js";
import { CoreBars, Sparkline, Stat } from "./monitor-charts.jsx";
import { hostMethodMissing } from "./errors.js";
import { isMineTerminal } from "../../state/session-terminals.js";

installSurfaceStyles("monitor", CSS);

const INTERVALS = [2000, 5000, 10000];
const INTERVAL_ITEMS = [
  { value: 2000, label: "2s" },
  { value: 5000, label: "5s" },
  { value: 10000, label: "10s" }
];
const INTERVAL_KEY = "dsh-harbor.monitor.v1";
const HISTORY_POINTS = 60;
const DASH = "—";
/** A host that lacks the endpoint is retried on a slow beat, not twice a second. */
const HOST_MISMATCH_RETRY_MS = 30000;

/** Sampling interval, remembered per browser like the terminal appearance. */
function readInterval() {
  try {
    const raw = globalThis.localStorage?.getItem(INTERVAL_KEY);
    if (raw === null || raw === undefined) return INTERVALS[0];
    const stored = JSON.parse(raw)?.intervalMs;
    return INTERVALS.includes(stored) ? stored : INTERVALS[0];
  } catch {
    return INTERVALS[0];
  }
}

function writeInterval(intervalMs) {
  try {
    globalThis.localStorage?.setItem(INTERVAL_KEY, JSON.stringify({ intervalMs }));
  } catch {}
}

/** Append to a bounded trend window. */
function pushPoint(list, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  list.push(value);
  while (list.length > HISTORY_POINTS) list.shift();
}

/** The wording for a host that answered but cannot be sampled. */
function unsupportedText(sample) {
  if (sample.reason === "no-posix-shell") {
    return t("这台设备没有可用的 POSIX shell（exec 通道），读不到系统状态。网络设备（VRP / Comware 这类）属于此列。");
  }
  if (sample.reason === "no-procfs") {
    return t(`这台设备不是 Linux 主机（${sample.platformName ?? "unknown"}），状态采集暂不支持。`);
  }
  return t("这台设备上读不到 /proc 数据，状态采集暂不支持。");
}

function warningText(code) {
  if (code === "incomplete-output") return t("远端输出不完整，部分指标可能缺失。");
  if (code === "truncated-output") return t("采样输出被截断，指标可能缺失。");
  return null;
}

/**
 * The browser half is newer than the host half: the endpoint exists in this
 * bundle but not in the running host process. Only a DSH restart (or a host
 * half reload) can fix it, so the pane says so instead of repeating 404s.
 */
function hostMismatchText() {
  return t("宿主端没有加载状态采样接口（HTTP 404）。插件更新后需要重启 DSH 才能加载新的宿主端代码；重启后点「重试」。");
}

/** The plain-text snapshot the copy button puts on the clipboard. */
function snapshotText(sample, connection) {
  if (sample === null || sample === undefined) return "";
  const host = sample.host ?? {};
  const lines = [];
  const head = [host.hostname ?? connection?.name ?? connection?.host, host.os, host.kernel, host.arch]
    .filter((part) => part !== undefined && part !== null && part !== "")
    .join(" · ");
  if (head !== "") lines.push(head);
  if (sample.cpu !== undefined) {
    const cores = typeof sample.cpu.cores === "number" ? " (" + sample.cpu.cores + ")" : "";
    const load = Array.isArray(sample.cpu.load)
      ? "load " + sample.cpu.load.map((value) => value.toFixed(2)).join(" / ")
      : "";
    lines.push(t("CPU") + " " + formatPercent(sample.cpu.usagePercent, 1) + cores + " " + load);
  }
  (sample.gpu ?? []).forEach((gpu) => {
    const parts = [gpu.name, formatPercent(gpu.utilizationPercent), formatBytePair(gpu.memoryUsedBytes, gpu.memoryTotalBytes)];
    if (gpu.temperatureC !== null) parts.push(gpu.temperatureC + "°C");
    if (gpu.powerW !== null) parts.push(gpu.powerW + " W");
    lines.push(t("GPU") + " " + parts.join(" · "));
  });
  if (sample.memory !== undefined) {
    const memory = sample.memory;
    const used = Math.max(0, memory.totalBytes - memory.availableBytes);
    const swapUsed = Math.max(0, memory.swapTotalBytes - memory.swapFreeBytes);
    lines.push(t("内存") + " " + formatBytePair(used, memory.totalBytes)
      + (memory.swapTotalBytes > 0 ? " · swap " + formatBytePair(swapUsed, memory.swapTotalBytes) : ""));
  }
  if ((sample.disks ?? []).length > 0) {
    lines.push(t("磁盘") + " " + sample.disks.map((disk) => t("挂载于") + " " + disk.mount + " " + formatPercent(disk.usePercent)
      + " (" + formatBytePair(disk.usedBytes, disk.totalBytes) + ")").join(" · "));
  }
  if (sample.diskIo !== null && sample.diskIo !== undefined) {
    lines.push(t("磁盘读写") + " " + formatRate(sample.diskIo.readBytesPerSec) + " / " + formatRate(sample.diskIo.writeBytesPerSec));
  }
  if ((sample.network ?? []).length > 0) {
    lines.push(t("网络") + " " + sample.network.map((iface) => iface.name + " ↓" + formatRate(iface.rxBytesPerSec)
      + " ↑" + formatRate(iface.txBytesPerSec)).join(" · "));
  }
  if (sample.processes !== null && sample.processes !== undefined && sample.processes.top.length > 0) {
    lines.push(t("进程") + " " + sample.processes.top.map((proc) => proc.name + " " + formatPercent(proc.cpuPercent)).join(" · "));
  }
  lines.push(t("采样") + " " + formatClock(sample.sampledAt) + " · " + sample.sampleMs + " ms");
  return lines.join("\n");
}

export function MonitorPane({ api, connection, sessionId, active = true, onOpenTerminal }) {
  const [sample, setSample] = useState(null);
  const [error, setError] = useState(null);
  const [paused, setPaused] = useState(false);
  const [hostMismatch, setHostMismatch] = useState(false);
  const [intervalMs, setIntervalMs] = useState(readInterval);
  const historyRef = useRef(new Map());
  // One request at a time: a 4-s probe on a slow tailnet link must not stack
  // another request every two seconds, and a manual retry must not race one.
  const inFlightRef = useRef(false);
  const copy = useCopy();
  const connectionId = connection?.connectionId ?? null;

  // A different server is a different dashboard: drop the previous one instead
  // of showing its numbers under a new hostname for two seconds.
  useEffect(() => {
    setSample(null);
    setError(null);
    setHostMismatch(false);
  }, [connectionId]);

  const remember = useCallback((id, value) => {
    if (id === null || value?.supported !== true) return;
    const store = historyRef.current;
    let entry = store.get(id);
    if (entry === undefined) {
      entry = { cpu: [], rx: [] };
      store.set(id, entry);
    }
    if (typeof value.cpu?.usagePercent === "number") pushPoint(entry.cpu, value.cpu.usagePercent);
    if (Array.isArray(value.network)) {
      // Warm-up samples have no rate yet; pushing a 0 there would draw a dip
      // the host never observed.
      const rates = value.network.map((iface) => iface.rxBytesPerSec).filter((rate) => typeof rate === "number");
      if (rates.length > 0) pushPoint(entry.rx, rates.reduce((sum, rate) => sum + rate, 0));
    }
  }, []);

  useEffect(() => {
    if (!active || paused || connectionId === null) return undefined;
    let cancelled = false;
    let timer = null;
    const apply = (value) => {
      remember(connectionId, value);
      setSample(value);
      setError(null);
      setHostMismatch(false);
    };
    const fail = (cause) => {
      if (hostMethodMissing(cause)) {
        setHostMismatch(true);
        setError({ code: "host-method-missing", message: hostMismatchText() });
        return;
      }
      setError({ code: cause?.code ?? "monitor-failed", message: cause?.message ?? String(cause) });
    };
    const tick = async () => {
      // An occluded window does not need a probe every two seconds; the next
      // visible tick catches up and the host keeps the sampler warm anyway.
      if (inFlightRef.current) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      inFlightRef.current = true;
      try {
        const value = await api.systemStats(connectionId);
        if (cancelled) return;
        apply(value);
      } catch (cause) {
        if (cancelled) return;
        fail(cause);
      } finally {
        inFlightRef.current = false;
      }
    };
    // A stale host is not asked again until the slow retry beat: the first
    // failure already proved the endpoint is absent.
    if (!hostMismatch) void tick();
    // A 404 is deterministic until the host half is reloaded; retry on a slow
    // beat so a later DSH restart or hot reload heals without a page refresh.
    timer = setInterval(() => { void tick(); }, hostMismatch ? HOST_MISMATCH_RETRY_MS : intervalMs);
    const onVisibility = () => { if (document.visibilityState === "visible") void tick(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      if (timer !== null) clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [api, connectionId, active, paused, intervalMs, hostMismatch, remember]);

  const refreshNow = useCallback(async () => {
    if (connectionId === null) return;
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const value = await api.systemStats(connectionId, true);
      remember(connectionId, value);
      setSample(value);
      setError(null);
      setHostMismatch(false);
    } catch (cause) {
      if (hostMethodMissing(cause)) {
        setHostMismatch(true);
        setError({ code: "host-method-missing", message: hostMismatchText() });
      } else {
        setError({ code: cause?.code ?? "monitor-failed", message: cause?.message ?? String(cause) });
      }
    } finally {
      inFlightRef.current = false;
    }
  }, [api, connectionId, remember]);

  const changeInterval = useCallback((next) => {
    if (!INTERVALS.includes(next)) return;
    setIntervalMs(next);
    writeInterval(next);
  }, []);

  const copySnapshot = useCallback(async () => {
    const text = snapshotText(sample, connection);
    if (text === "") return;
    if (!(await copy(text, t("快照已复制")))) toast(t("复制失败，请手动选择文本。"), { tone: "error" });
  }, [sample, connection, copy]);

  const history = connectionId === null ? undefined : historyRef.current.get(connectionId);
  const cpu = sample?.cpu;
  const memory = sample?.memory;
  const gpus = Array.isArray(sample?.gpu) ? sample.gpu : [];
  const disks = Array.isArray(sample?.disks) ? sample.disks : [];
  const interfaces = Array.isArray(sample?.network) ? sample.network : [];
  const processes = sample?.processes ?? null;
  const backoff = error?.code === "probe-backoff";
  const waiting = sample === null && error === null;
  const hostName = sample?.host?.hostname ?? connection?.name ?? connection?.host ?? DASH;
  const identity = [sample?.host?.os, sample?.host?.kernel, sample?.host?.arch]
    .filter((part) => part !== undefined && part !== null && part !== "")
    .join(" · ");
  // One ownership rule for the whole panel: the pane resolver, the close-tab
  // action and this counter must agree on whose terminal is whose.
  const terminalCount = (connection?.terminals ?? []).filter((terminal) => isMineTerminal(terminal, sessionId)).length;
  const warnings = (sample?.warnings ?? []).map(warningText).filter((text) => text !== null);

  let status = "";
  if (paused) status = t("已暂停");
  else if (backoff) status = error.message;
  else if (sample !== null) status = t("采样") + " " + formatClock(sample.sampledAt) + " · " + sample.sampleMs + " ms";
  else if (error !== null) status = error.message;

  return (
    <div className="hb-monitor hb-scroll" data-dsh-harbor-monitor="true">
      <header className="hb-monitor__head">
        <div className="hb-monitor__identity">
          <div className="hb-monitor__host hb-truncate" title={hostName}>{hostName}</div>
          {identity !== "" && <div className="hb-monitor__sub hb-truncate" title={identity}>{identity}</div>}
          {typeof sample?.host?.uptimeSeconds === "number" && (
            <div className="hb-monitor__sub">{t("在线")} {formatUptime(sample.host.uptimeSeconds)}</div>
          )}
        </div>
        <div className="hb-monitor__actions">
          {paused && <Badge tone="warn">{t("已暂停")}</Badge>}
          <IconButton icon="refresh-outline" label={t("刷新")} size="sm" disabled={connectionId === null} onClick={() => { void refreshNow(); }} />
          <IconButton
            icon={paused ? "play-outline" : "pause-outline"}
            label={paused ? t("继续采样") : t("暂停采样")}
            size="sm"
            active={paused}
            onClick={() => setPaused((value) => !value)}
          />
        </div>
      </header>

      {error !== null && !backoff && (
        <ErrorNote action={<Button variant="ghost" size="sm" onClick={() => { void refreshNow(); }}>{t("重试")}</Button>}>
          {error.message}
        </ErrorNote>
      )}

      {waiting && (
        <div className="hb-liststate"><span className="hb-spinner" aria-hidden="true" />{t("正在采样…")}</div>
      )}

      {sample !== null && sample.supported !== true && (
        <EmptyState
          icon="gauge-outline"
          title={t("这台设备暂不支持状态采集")}
          text={unsupportedText(sample)}
          action={typeof onOpenTerminal === "function"
            ? <Button variant="secondary" size="sm" onClick={onOpenTerminal}>{t("切到终端查看")}</Button>
            : undefined}
        />
      )}

      {warnings.map((text) => <Notice key={text}>{text}</Notice>)}

      {sample !== null && sample.supported === true && (
        <div className="hb-monitor__cards">
          {cpu !== undefined && (
            <Card
              className="hb-monitor__card"
              title={t("CPU")}
              action={
                <span className="hb-monitor__metricrow">
                  <span className="hb-monitor__spark-sm">
                    <Sparkline values={history?.cpu ?? []} max={100} height={16} className="hb-spark--sm" label={t("CPU 占用趋势")} />
                  </span>
                  <span className="hb-monitor__metric hb-mono">{formatPercent(cpu.usagePercent, 1)}</span>
                </span>
              }
            >
              <div className="hb-monitor__row">
                <span className="hb-quiet">{t("负载")}</span>
                <span className="hb-mono">
                  {Array.isArray(cpu.load) ? cpu.load.map((value) => value.toFixed(2)).join(" / ") : DASH}
                </span>
                <span className="hb-spacer" />
                <span className="hb-mono">{typeof cpu.cores === "number" ? cpu.cores : DASH} {t("核")}</span>
              </div>
              <CoreBars values={cpu.perCore ?? []} />
              {cpu.model !== null && cpu.model !== undefined && (
                <div className="hb-quiet hb-truncate" title={cpu.model}>{cpu.model}</div>
              )}
              {sample.warmingUp === true && (
                <div className="hb-quiet">{t("采样间隔尚未完成，占用率与速率稍后出现。")}</div>
              )}
            </Card>
          )}

          {gpus.length > 0 && (
            <Card
              className="hb-monitor__card"
              title={t("GPU")}
              action={gpus.length > 1 ? <Badge tone="neutral">{gpus.length}</Badge> : undefined}
            >
              {gpus.map((gpu) => {
                const ratio = gpu.memoryTotalBytes !== null && gpu.memoryUsedBytes !== null && gpu.memoryTotalBytes > 0
                  ? (gpu.memoryUsedBytes / gpu.memoryTotalBytes) * 100
                  : null;
                return (
                  <div className="hb-monitor__gpu" key={gpu.index}>
                    <div className="hb-monitor__row">
                      <span className="hb-truncate" title={gpu.name}>{gpu.name}</span>
                      <span className="hb-spacer" />
                      <span className="hb-mono">{formatPercent(gpu.utilizationPercent)}</span>
                    </div>
                    {ratio !== null && (
                      <ProgressBar value={gpu.memoryUsedBytes} max={gpu.memoryTotalBytes} tone={usageTone(ratio)} label={t("显存")} />
                    )}
                    <div className="hb-monitor__row hb-quiet">
                      <span className="hb-mono">{formatBytePair(gpu.memoryUsedBytes, gpu.memoryTotalBytes)}</span>
                      <span className="hb-spacer" />
                      {gpu.temperatureC !== null && <span className="hb-mono">{gpu.temperatureC}°C</span>}
                      {gpu.powerW !== null && <span className="hb-mono">{gpu.powerW} W</span>}
                    </div>
                  </div>
                );
              })}
            </Card>
          )}

          {memory !== undefined && (
            <Card
              className="hb-monitor__card"
              title={t("内存")}
              action={
                <span className="hb-monitor__metric hb-mono">
                  {formatPercent(memory.totalBytes > 0 ? ((memory.totalBytes - memory.availableBytes) / memory.totalBytes) * 100 : null)}
                </span>
              }
            >
              <ProgressBar
                value={Math.max(0, memory.totalBytes - memory.availableBytes)}
                max={memory.totalBytes}
                tone={usageTone(memory.totalBytes > 0 ? ((memory.totalBytes - memory.availableBytes) / memory.totalBytes) * 100 : null)}
                label={t("内存")}
              />
              <div className="hb-monitor__row">
                <span className="hb-quiet">{t("已用")}</span>
                <span className="hb-mono">{formatBytePair(memory.totalBytes - memory.availableBytes, memory.totalBytes)}</span>
                <span className="hb-spacer" />
                <span className="hb-quiet">{t("缓存")}</span>
                <span className="hb-mono">{formatBytes(memory.cachedBytes)}</span>
              </div>
              <div className="hb-monitor__row">
                <span className="hb-quiet">Swap</span>
                <span className="hb-mono">
                  {memory.swapTotalBytes > 0
                    ? formatBytePair(memory.swapTotalBytes - memory.swapFreeBytes, memory.swapTotalBytes)
                    : t("未启用")}
                </span>
              </div>
            </Card>
          )}

          <Card className="hb-monitor__card" title={t("磁盘")}>
            {disks.length === 0 && <div className="hb-quiet">{t("没有可读取的挂载点。")}</div>}
            {disks.map((disk) => (
              <div className="hb-monitor__disk" key={disk.mount}>
                <div className="hb-monitor__row">
                  <span className="hb-mono hb-truncate" title={disk.device + " · " + disk.mount}>{disk.mount}</span>
                  <span className="hb-spacer" />
                  <span className="hb-quiet hb-mono">{formatBytePair(disk.usedBytes, disk.totalBytes)}</span>
                  <span className="hb-mono">{formatPercent(disk.usePercent)}</span>
                </div>
                <ProgressBar
                  value={disk.usedBytes}
                  max={disk.totalBytes}
                  tone={usageTone(disk.usePercent)}
                  label={disk.mount + " " + formatPercent(disk.usePercent)}
                />
              </div>
            ))}
            {sample.diskIo !== null && sample.diskIo !== undefined && (
              <div className="hb-monitor__row hb-quiet">
                <span>{t("读写")}</span>
                <span className="hb-mono">{t("读")} {formatRate(sample.diskIo.readBytesPerSec)}</span>
                <span className="hb-mono">{t("写")} {formatRate(sample.diskIo.writeBytesPerSec)}</span>
              </div>
            )}
          </Card>

          <Card className="hb-monitor__card" title={t("网络")}>
            {interfaces.length === 0 && <div className="hb-quiet">{t("没有网络接口数据。")}</div>}
            {interfaces.map((iface) => (
              <div className="hb-monitor__row" key={iface.name}>
                <span className="hb-mono hb-truncate">{iface.name}</span>
                <span className="hb-spacer" />
                <span className="hb-mono">↓ {formatRate(iface.rxBytesPerSec)}</span>
                <span className="hb-quiet hb-mono">↑ {formatRate(iface.txBytesPerSec)}</span>
              </div>
            ))}
            <Sparkline values={history?.rx ?? []} label={t("接收速率趋势")} />
          </Card>

          <Card className="hb-monitor__card" title={t("进程")} action={<span className="hb-quiet">{t("按 CPU 排序")}</span>}>
            {processes === null || processes.top.length === 0 ? (
              <div className="hb-quiet">{t("这台设备的 ps 读不到进程占用。")}</div>
            ) : (
              processes.top.map((proc) => (
                <div className="hb-monitor__row" key={proc.pid}>
                  <span className="hb-truncate" title={proc.name + " · " + proc.pid}>{proc.name}</span>
                  <span className="hb-spacer" />
                  <span className="hb-quiet hb-mono hb-monitor__num">{proc.pid}</span>
                  <span className="hb-mono hb-monitor__num">{formatPercent(proc.cpuPercent)}</span>
                  <span className="hb-quiet hb-mono hb-monitor__num">{formatPercent(proc.memPercent)}</span>
                </div>
              ))
            )}
            {processes !== null && processes.total !== null && (
              <div className="hb-monitor__row hb-quiet">
                <span>{t("线程")} {processes.total}</span>
                <span className="hb-spacer" />
                <span>{t("运行中")} {processes.running ?? DASH}</span>
              </div>
            )}
            <div className="hb-quiet">{t("进程 CPU 占比是生命周期平均（ps），不是瞬时值。")}</div>
          </Card>

          <Card className="hb-monitor__card" title={t("连接")}>
            <Stat label={t("服务器")} value={connection?.name ?? connection?.host ?? DASH} />
            <Stat
              label={t("地址")}
              mono
              value={connection === undefined || connection === null
                ? DASH
                : connection.username + "@" + connection.host + ":" + connection.port}
            />
            <Stat label={t("本对话终端")} value={String(terminalCount)} />
            <Stat label={t("采样往返")} mono value={sample.sampleMs + " ms"} />
          </Card>
        </div>
      )}

      <footer className="hb-monitor__foot">
        <span className="hb-monitor__dot" data-paused={paused ? "true" : "false"} aria-hidden="true" />
        <span className="hb-quiet hb-truncate">{status}</span>
        <span className="hb-spacer" />
        <SegmentedControl
          className="hb-monitor__interval"
          value={intervalMs}
          onChange={changeInterval}
          items={INTERVAL_ITEMS}
          label={t("采样间隔")}
        />
        <IconButton icon="copy-outline" label={t("复制快照")} size="sm" disabled={sample === null || sample.supported !== true} onClick={() => { void copySnapshot(); }} />
      </footer>
    </div>
  );
}
