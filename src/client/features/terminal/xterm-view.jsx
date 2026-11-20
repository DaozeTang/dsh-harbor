/**
 * One xterm view bound to one host PTY session.
 *
 * Lifetime is deliberately longer than the React tree: the terminal instance
 * (and with it the scrollback) lives in the module-level pool, so switching
 * views, collapsing the sidebar or remounting after a layout change never
 * loses history. The host buffers output while no view is attached and
 * replays it on the next attach.
 *
 * Transport: the Gateway WebSocket stream (typert mode "stream") is the
 * preferred path; the 300ms long-poll is kept as a fallback for carriers that
 * cannot carry the mux. Both feed the same offset-tracking writer, so a
 * mid-stream fallback never duplicates or drops output.
 */
import * as React from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { OutputHighlightAddon } from "../../terminal-display/addon.js";
import { getDisplaySettings } from "../../terminal-display/settings.js";
import { terminalTheme } from "../../terminal-display/theme.js";
import { isMacPlatform, runFind, searchResultLabel, searchShortcutLabel, searchShortcutMatches } from "../../terminal-search.js";
import { createTerminalPool } from "../../terminal-pool.js";
import { createWheelZoom, clampFontSize, loadTerminalFontSize, saveTerminalFontSize } from "../../terminal-zoom.js";
import { installXtermStyles } from "../../terminal-styles.js";
import { IconButton, TextInput } from "../../ui/kit.jsx";
import { t } from "../../../i18n/core.js";

const { useEffect, useRef, useState } = React;

/** One zoom level for the whole workbench; every pooled terminal follows it. */
let terminalFontSize = loadTerminalFontSize();
const fontSizeListeners = new Set();

function applyTerminalFontSize(size) {
  const next = clampFontSize(size);
  if (next === terminalFontSize) return;
  terminalFontSize = next;
  saveTerminalFontSize(next);
  terminalPool.forEachTerm((term) => { term.options.fontSize = next; });
  for (const listener of fontSizeListeners) listener();
}

const terminalPool = createTerminalPool({
  create: () => {
    const term = new Terminal({
      cursorBlink: true,
      fontSize: terminalFontSize,
      fontFamily: 'Menlo, Monaco, "SF Mono", "JetBrains Mono", "Courier New", monospace',
      scrollback: 5000,
      // The search addon gates its match highlights behind this flag; without
      // it every find throws "proposed API" and the reader sees no matches.
      allowProposedApi: true,
      // Some remote commands emit bare LF; treat it as a newline so rows do not
      // continue on the previous column.
      convertEol: true,
      theme: terminalTheme(getDisplaySettings().theme, getDisplaySettings().backgrounds)
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon();
    term.loadAddon(search);
    term.loadAddon(new OutputHighlightAddon());
    return { term, fit, search };
  },
  max: 8
});

/** The pooled terminal for a session, created on first use. */
export function terminalFor(sessionId) {
  return terminalPool.get(sessionId);
}

export function disposeTerminal(sessionId) {
  // The host session is gone: release its xterm instance too.
  terminalPool.drop(sessionId);
}

export function XtermView({ api, sessionId, connectionId }) {
  const containerRef = useRef(null);
  const searchInputRef = useRef(null);
  const entryRef = useRef(null);
  const [closed, setClosed] = useState(() => terminalPool.get(sessionId)?.closed ?? false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState(null);
  const [showJump, setShowJump] = useState(false);

  useEffect(() => {
    installXtermStyles();
    const container = containerRef.current;
    if (!container) return undefined;
    const owner = { sessionId };
    const entry = terminalPool.acquire(sessionId, owner);
    entryRef.current = entry;
    const term = entry.term;
    const fit = entry.fit;

    // (Re)attach: a pooled terminal keeps its DOM element, so move it into this
    // mount's container instead of opening it again. xterm's open() is a no-op
    // once opened; the re-parent plus a full refresh is what redraws it.
    if (entry.reused && term.element) {
      if (term.element.parentElement !== container) container.appendChild(term.element);
      try { term.refresh(0, Math.max(0, term.rows - 1)); } catch {}
    } else {
      term.open(container);
    }

    const viewport = container.querySelector(".xterm-viewport");
    const updateJump = () => {
      if (!viewport) { setShowJump(false); return; }
      setShowJump(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 8);
    };
    viewport?.addEventListener("scroll", updateJump, { passive: true });
    const scrollSubscription = term.onScroll(updateJump);
    updateJump();

    let alive = true;
    let writing = false;
    let pendingInput = "";
    const MAX_PENDING_INPUT = 64 * 1024;

    const flushInput = () => {
      if (!alive || writing || pendingInput.length === 0) return;
      const data = pendingInput;
      pendingInput = "";
      writing = true;
      api.write(sessionId, data).catch(() => {}).finally(() => {
        writing = false;
        flushInput();
      });
    };

    // Keystrokes are coalesced behind one in-flight write: a stalled transport
    // gets one bounded buffer instead of an unbounded promise chain.
    const onData = (data) => {
      if (!alive) return;
      if (pendingInput.length + data.length > MAX_PENDING_INPUT) return;
      pendingInput += data;
      flushInput();
    };
    const inputSubscription = term.onData(onData);

    const search = entry.search;
    const resultsSubscription = search?.onDidChangeResults?.((value) => {
      if (alive) setSearchResults(value);
    });
    const isMac = isMacPlatform(globalThis.navigator?.platform ?? globalThis.navigator?.userAgent);
    const onKeyDown = (event) => {
      if (!searchShortcutMatches(event, isMac)) return;
      event.preventDefault();
      event.stopPropagation();
      setSearchOpen(true);
      setTimeout(() => searchInputRef.current?.focus(), 0);
    };
    container.addEventListener("keydown", onKeyDown, true);

    // Ctrl+wheel / trackpad pinch zooms glyphs, not the page.
    const wheelZoom = createWheelZoom();
    const onWheel = (event) => {
      const step = wheelZoom(event);
      if (step === null) return;
      event.preventDefault();
      event.stopPropagation();
      if (step !== 0) applyTerminalFontSize(terminalFontSize + step);
    };
    container.addEventListener("wheel", onWheel, { capture: true, passive: false });

    // Copy-on-select, terminal-emulator style: settle briefly so a drag does not
    // fire a copy per pixel, and never copy an empty selection over the
    // clipboard.
    let copyTimer = null;
    const selectionSubscription = term.onSelectionChange(() => {
      if (copyTimer !== null) clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        copyTimer = null;
        if (!alive || !term.hasSelection()) return;
        const text = term.getSelection();
        if (text) { try { globalThis.navigator?.clipboard?.writeText?.(text)?.catch?.(() => {}); } catch {} }
      }, 180);
    });

    const controller = new AbortController();
    // Escape codes stay outside the translated text: the terminal draws the
    // colour and the dictionary only ever sees the sentence.
    const noSessionNotice = "\r\n\x1b[31m" + t("[终端会话已失效：DSH 服务已重启或该连接已关闭。请到 设置 → 远程主机 重新连接]") + "\x1b[0m\r\n";
    const exitNotice = (exit) => {
      const message = exit.reason === "transport-lost" ? t("SSH 连接中断，原终端已结束。请打开新终端。")
 : exit.reason === "channel-closed" || exit.reason === "channel-error" ? t("终端通道关闭，远端未返回退出状态。")
 : exit.reason === "operator-close" ? t("终端已关闭。")
 : exit.reason === "remote-signal" ? t("远端终端被信号终止。")
 : t(`远端终端已退出（退出码 ${exit.code}）。`);
      return `\r\n\x1b[90m[${message}]\x1b[0m\r\n`;
    };
    const markClosed = () => {
      terminalPool.setClosed(sessionId, true);
      setClosed(true);
    };
    const showItem = ({ data, exit, startOffset, offset }) => {
      const fresh = entry.consume(data ?? "", startOffset, offset);
      if (fresh) term.write(fresh);
      if (exit !== null) {
        markClosed();
        term.write(exitNotice(exit));
        return true;
      }
      return false;
    };

    const backoff = async (steps) => {
      await new Promise((resolve) => setTimeout(resolve, Math.min(4000, 500 * 2 ** steps)));
    };

    // Preferred path: host push over the Gateway WebSocket mux. The heartbeat
    // resets the error backoff, so a quiet-but-alive terminal never degrades
    // into retries.
    const streamLoop = async () => {
      let errorBackoff = 0;
      while (alive) {
        const stream = await api.streamTerminal(sessionId, controller.signal, entry.offset);
        if (!stream) return false;
        try {
          for await (const item of stream) {
            if (!alive) return true;
            errorBackoff = 0;
            if (showItem(item)) return true;
          }
          // Generator ended without an exit item: the mux dropped the stream
          // (host reload, network blip). Output written meanwhile is buffered
          // host-side and delivered on the next attach.
        } catch (error) {
          if (!alive) return true;
          if (error?.code === "no-session") {
            markClosed();
            term.write(noSessionNotice);
            return true;
          }
        }
        if (!alive) return true;
        await backoff(errorBackoff++);
      }
      return true;
    };

    const pollLoop = async () => {
      let errorBackoff = 0;
      while (alive) {
        try {
          const { data, exit, startOffset, offset } = await api.read(sessionId, 300, entry.offset);
          if (!alive) return;
          errorBackoff = 0;
          if (showItem({ data, exit, startOffset, offset })) return;
        } catch (error) {
          if (!alive) return;
          if (error?.code === "no-session") {
            markClosed();
            term.write(noSessionNotice);
            return;
          }
          await backoff(errorBackoff++);
        }
      }
    };

    const loop = async () => {
      const handled = await streamLoop();
      if (handled || !alive) return;
      await pollLoop();
    };
    void loop();

    // Refit whenever the container gets a new box: sidebar drag-resize,
    // fullscreen switch, tab re-activation, server-tab switch, and the first
    // observe after a remount.
    let lastCols = 0;
    let lastRows = 0;
    const fitNow = () => {
      if (!alive) return;
      try {
        fit.fit();
        if (term.cols > 0 && term.rows > 0 && (term.cols !== lastCols || term.rows !== lastRows)) {
          lastCols = term.cols;
          lastRows = term.rows;
          api.resize(sessionId, term.cols, term.rows).catch(() => {});
        }
      } catch {}
    };
    const raf = requestAnimationFrame(fitNow);
    const resizeObserver = new ResizeObserver(fitNow);
    resizeObserver.observe(container);
    // A font-size change leaves the container box untouched, so the observer
    // stays silent — refit explicitly to resync the PTY grid.
    fontSizeListeners.add(fitNow);

    return () => {
      alive = false;
      controller.abort();
      cancelAnimationFrame(raf);
      pendingInput = "";
      container.removeEventListener("keydown", onKeyDown, true);
      container.removeEventListener("wheel", onWheel, true);
      fontSizeListeners.delete(fitNow);
      if (copyTimer !== null) clearTimeout(copyTimer);
      selectionSubscription.dispose();
      resultsSubscription?.dispose?.();
      search?.clearDecorations?.();
      entryRef.current = null;
      setSearchOpen(false);
      resizeObserver.disconnect();
      viewport?.removeEventListener("scroll", updateJump);
      scrollSubscription?.dispose?.();
      inputSubscription.dispose();
      // Detach only — the pooled terminal survives this unmount, and the host
      // session is untouched either way.
      terminalPool.release(sessionId, owner);
    };
  }, [sessionId, connectionId, api]);

  const runSearch = (backwards) => {
    const search = entryRef.current?.search;
    if (search === undefined || query.trim() === "") return;
    runFind(search, query, { backwards, warn: console.warn });
  };
  const closeSearch = () => {
    setSearchOpen(false);
    setSearchResults(null);
    entryRef.current?.search?.clearDecorations?.();
    containerRef.current?.parentElement?.querySelector("textarea")?.focus?.();
  };
  const isMac = isMacPlatform(globalThis.navigator?.platform ?? globalThis.navigator?.userAgent);

  return (
    <div className="hb-term" data-closed={closed || undefined}>
      <div className="hb-term__host" ref={containerRef} />

      {searchOpen && (
        <div className="hb-findbar" role="search">
          <TextInput
            ref={searchInputRef}
            value={query}
            aria-label={t("在终端里查找")}
            placeholder={t("在终端里查找…")}
            onChange={(event) => {
              setQuery(event.target.value);
              const text = event.target.value.trim();
              const search = entryRef.current?.search;
              if (text !== "" && search !== undefined) runFind(search, text, { warn: console.warn });
              else {
                setSearchResults(null);
                entryRef.current?.search?.clearDecorations?.();
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); runSearch(event.shiftKey); }
              else if (event.key === "Escape") { event.preventDefault(); closeSearch(); }
            }}
          />
          <span className="hb-caption hb-numeric" aria-live="polite" style={{ minWidth: 56, textAlign: "center" }}>
            {searchResultLabel(searchResults, query)}
          </span>
          <IconButton icon="chevron-up-outline" label={t("上一个匹配 (Shift+Enter)")} size="sm" onClick={() => runSearch(true)} />
          <IconButton icon="chevron-down-outline" label={t("下一个匹配 (Enter)")} size="sm" onClick={() => runSearch(false)} />
          <IconButton icon="close-outline" label={t("关闭 (Esc)")} size="sm" onClick={closeSearch} />
        </div>
 )}

      <div className="hb-term__overlay">
        {showJump && (
          <IconButton
            icon="chevron-down-outline"
            label={t("滚动到底部（最新输出）")}
            size="sm"
            onClick={() => {
              entryRef.current?.term?.scrollToBottom();
              setShowJump(false);
            }}
          />
 )}
        {!searchOpen && (
          <IconButton
            icon="search-outline"
            label={t(`在终端里查找（${searchShortcutLabel(isMac)}）`)}
            size="sm"
            onClick={() => {
              setSearchOpen(true);
              setTimeout(() => searchInputRef.current?.focus(), 0);
            }}
          />
 )}
      </div>
    </div>
 );
}