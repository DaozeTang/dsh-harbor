/**
 * Session log store: one append-only file per SSH session plus a JSON sidecar
 * with its metadata, under a plugin-owned directory. Recording is bounded on
 * purpose — a session stops writing past its cap (and says so) instead of
 * filling the disk, and the store prunes the oldest sessions past the total
 * budget.
 *
 * The store is deliberately transport-free: the service feeds it the same text
 * it hands the terminal journal, so a log is exactly what the panel showed.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

/** Defaults: one session may keep 8 MB, the directory 256 MB. */
export const SESSION_LOG_LIMITS = Object.freeze({
  maxSessionBytes: 8 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  /** Longest prefix of a session that search scans, so one huge log cannot stall the panel. */
  maxSearchBytes: 32 * 1024 * 1024,
  maxSearchHits: 200
});

const META_SUFFIX = ".json";
const LOG_SUFFIX = ".log";

/** Bytes in the UTF-8 sequence introduced by `byte` (1 when it is not a lead byte). */
function sequenceBytes(byte) {
  if (byte < 0x80) return 1;
  if ((byte & 0xe0) === 0xc0) return 2;
  if ((byte & 0xf0) === 0xe0) return 3;
  if ((byte & 0xf8) === 0xf0) return 4;
  return 1;
}

/**
 * Length of the longest prefix of `buf` that ends on a character boundary.
 *
 * A page (or a per-session cap) that lands inside a multi-byte character used
 * to decode that character as U+FFFD and advance past it: the panel showed a
 * replacement glyph, the reader could never see the real bytes, and a resize
 * or a rebuild of the page produced different text for the same offset.
 * Callers hand the whole character to the next page instead.
 */
function utf8PrefixLength(buf) {
  let lead = buf.length;
  while (lead > 0 && (buf[lead - 1] & 0xc0) === 0x80) lead -= 1;
  if (lead === 0) return buf.length;
  const start = lead - 1;
  return start + sequenceBytes(buf[start]) <= buf.length ? buf.length : start;
}

/** Filesystem-safe session id (ids are generated internally, but never trust that here). */
function safeId(sessionId) {
  return String(sessionId).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96);
}

export class SessionLogStore {
  /**
   * @param options - `{ dir, limits? }`; the directory is created lazily.
   */
  constructor({ dir, limits = {} } = {}) {
    this.dir = dir;
    this.limits = { ...SESSION_LOG_LIMITS, ...limits };
    this.entries = new Map();
    this.streams = new Map();
    /** sessionId -> promise settling when the last append reached the file. */
    this.pending = new Map();
    /** sessionId -> in-flight begin(); end() must not race the stream setup. */
    this.beginning = new Map();
    this.ready = null;
  }

  async init() {
    this.ready ??= mkdir(this.dir, { recursive: true }).catch(() => {});
    await this.ready;
  }

  metaPath(sessionId) { return join(this.dir, `${safeId(sessionId)}${META_SUFFIX}`); }
  logPath(sessionId) { return join(this.dir, `${safeId(sessionId)}${LOG_SUFFIX}`); }

  /** Is this session already being recorded (its entry exists)? */
  has(sessionId) {
    return this.entries.has(sessionId);
  }

  /**
   * Open a log for one session. The entry exists as soon as this returns
   * (before the directory or stream is ready), so an append that arrives in
   * the same tick is buffered rather than dropped — callers that record
   * lazily call begin() and append() back to back.
   */
  async begin({ sessionId, connectionId, name, host, port, openedBy, startedAt = new Date().toISOString() }) {
    const entry = {
      sessionId, connectionId: connectionId ?? null, name: name ?? null,
      host: host ?? null, port: port ?? null, openedBy: openedBy ?? null,
      startedAt, endedAt: null, exitCode: null, bytes: 0, truncated: false,
      /** Chunks that arrived before the write stream existed. */
      pending: []
    };
    this.entries.set(sessionId, entry);
    // The stream cannot exist before the directory does, so this awaits. A
    // session that closes inside that window used to find no stream, write its
    // final metadata, and then have begin() create a stream afterwards — one
    // that nothing would ever end (the log file stayed open and the entry was
    // gone, so prune()/removeAll() could not see it either). Publishing the
    // promise lets end() wait instead of racing it.
    const starting = (async () => {
      await this.init();
      // end() already ran: this session is over, do not open anything for it.
      if (this.entries.get(sessionId) !== entry) return;
      const stream = createWriteStream(this.logPath(sessionId), { flags: "a" });
      stream.on("error", () => { /* a broken log must not crash the session */ });
      this.streams.set(sessionId, stream);
      const buffered = entry.pending;
      entry.pending = [];
      if (buffered.length > 0) {
        // Replayed chunks must be covered by flush(): write callbacks fire in
        // order, so awaiting the LAST one also covers every earlier chunk — and
        // a read racing begin() sees the data instead of an empty file.
        this.pending.set(sessionId, new Promise((resolve) => {
          let done = 0;
          const onDone = () => { if (++done >= buffered.length) resolve(); };
          for (const chunk of buffered) {
            try { stream.write(chunk, onDone); } catch { onDone(); }
          }
        }));
      }
    })();
    this.beginning.set(sessionId, starting);
    try {
      await starting;
    } finally {
      if (this.beginning.get(sessionId) === starting) this.beginning.delete(sessionId);
    }
    // Only persist the open-state metadata while the session is still open:
    // writing it after end() removed the entry would overwrite the final
    // sidecar with `endedAt: null`.
    if (this.entries.get(sessionId) === entry) await this.writeMeta(entry).catch(() => {});
    return entry;
  }

  /** Append session output; past the per-session cap the rest is dropped, once. */
  append(sessionId, text) {
    const entry = this.entries.get(sessionId);
    if (entry === undefined) return;
    const stream = this.streams.get(sessionId);
    if (entry.truncated) return;
    const chunk = String(text ?? "");
    if (chunk.length === 0) return;
    const remaining = this.limits.maxSessionBytes - entry.bytes;
    if (remaining <= 0) {
      entry.truncated = true;
      return;
    }
    const bytes = Buffer.from(chunk, "utf8");
    // The cap is a byte budget, so it can land mid-character; cut on a
    // boundary and the last line of a capped log is text, not a replacement
    // glyph (same rule as the page boundaries below).
    const slice = bytes.length > remaining
      ? bytes.subarray(0, utf8PrefixLength(bytes.subarray(0, remaining))).toString("utf8")
 : chunk;
    entry.bytes += Buffer.byteLength(slice, "utf8");
    if (entry.bytes >= this.limits.maxSessionBytes) entry.truncated = true;
    if (stream === undefined) {
      // begin() is still preparing the stream: hold the chunk in order.
      entry.pending.push(slice);
      return;
    }
    try {
      // Reads await this so a live session's newest output is never missed.
      this.pending.set(sessionId, new Promise((resolve) => stream.write(slice, resolve)));
    } catch { /* keep the session alive */ }
  }

  /** Close one session's log and persist its final metadata. */
  async end(sessionId, { exitCode = null, reason } = {}) {
    const starting = this.beginning.get(sessionId);
    if (starting !== undefined) {
      try { await starting; } catch { /* a failed begin leaves nothing to close */ }
    }
    const entry = this.entries.get(sessionId);
    const stream = this.streams.get(sessionId);
    this.streams.delete(sessionId);
    if (stream !== undefined) {
      await new Promise((resolve) => stream.end(resolve));
    }
    this.pending.delete(sessionId);
    if (entry === undefined) return null;
    entry.endedAt = new Date().toISOString();
    entry.exitCode = exitCode;
    if (reason) entry.exitReason = reason;
    this.entries.delete(sessionId);
    await this.writeMeta(entry).catch(() => {});
    return entry;
  }

  /**
   * Persist one sidecar atomically.
   *
   * Two writers can legitimately target one session at the same moment (begin
   * finishing while end() closes it). writeFile is not atomic, so their bytes
   * interleaved into a file that was no longer valid JSON — which list() skips
   * and prune() therefore never reclaims. A temp file plus rename means a
   * reader always sees one complete document.
   */
  async writeMeta(entry) {
    const target = this.metaPath(entry.sessionId);
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(entry), "utf8");
      await rename(temp, target);
    } catch (error) {
      try { await rm(temp, { force: true }); } catch {}
      throw error;
    }
  }

  /** All recorded sessions, newest first (metadata only; the log stays a file). */
  async list() {
    await this.init();
    let names;
    try { names = await readdir(this.dir); } catch { names = []; }
    const byId = new Map();
    for (const name of names) {
      if (!name.endsWith(META_SUFFIX)) continue;
      try {
        const meta = JSON.parse(await readFile(join(this.dir, name), "utf8"));
        if (meta?.sessionId === undefined) continue;
        const { exitReason, ...exposed } = meta;
        void exitReason;
        byId.set(meta.sessionId, {
 ...exposed,
          startedAt: meta.startedAt ?? null,
          endedAt: meta.endedAt ?? null,
          bytes: Number(meta.bytes ?? 0),
          truncated: meta.truncated === true
        });
      } catch {
        // A half-written sidecar is skipped rather than breaking the list.
      }
    }
    // A session still recording has no fresh sidecar yet (its metadata is only
    // written at open and close), so the live entry wins and the panel sees
    // accurate byte counts and truncation while the session runs.
    for (const [sessionId, live] of this.entries) {
      const { pending, ...exposed } = live;
      void pending;
      byId.set(sessionId, { ...exposed });
    }
    return [...byId.values()]
 .sort((left, right) => String(right.startedAt ?? "").localeCompare(String(left.startedAt ?? "")));
  }

  /** Wait for the session's most recent append to hit the file. */
  async flush(sessionId) {
    await this.pending.get(sessionId)?.catch(() => {});
  }

  /** Read one bounded byte snapshot without splitting a UTF-8 sequence. */
  async snapshot(sessionId, maxBytes) {
    await this.flush(sessionId);
    await this.init();
    let file;
    try {
      file = await open(this.logPath(sessionId), "r");
      const { size } = await file.stat();
      if (size > maxBytes) return { ok: false, reason: "too-large" };
      const data = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const result = await file.read(data, offset, size - offset, offset);
        if (result.bytesRead === 0) return { ok: false, reason: "changed" };
        offset += result.bytesRead;
      }
      return { ok: true, data };
    } catch (error) { return { ok: false, reason: error.code === "ENOENT" ? "no-such-log" : "read-failed" }; }
    finally { await file?.close(); }
  }

  /** Read a byte range of one log; callers page with `nextOffset`. */
  async read(sessionId, { offset = 0, maxBytes = 65536 } = {}) {
    await this.flush(sessionId);
    await this.init();
    const path = this.logPath(sessionId);
    let size;
    try { size = (await stat(path)).size; } catch { return { ok: false, reason: "no-such-log" }; }
    const start = Math.max(0, Math.min(Number(offset) || 0, size));
    const length = Math.max(1, Math.min(Number(maxBytes) || 65536, 4 * 1024 * 1024));
    // An empty or fully-consumed log must not reach createReadStream with
    // end < start: Node throws ERR_OUT_OF_RANGE synchronously there, escaping
    // the stream's error event. The empty answer is the correct result anyway.
    if (start >= size) {
      return { ok: true, data: "", startOffset: start, nextOffset: start, eof: true, size };
    }
    const chunks = [];
    await new Promise((resolve) => {
      const stream = createReadStream(path, { start, end: Math.min(size, start + length) - 1 });
      stream.on("data", (chunk) => { chunks.push(chunk); });
      stream.on("error", () => resolve());
      stream.on("end", resolve);
    });
    const buf = Buffer.concat(chunks);
    // Only a page that stops before the end of the file can split a character;
    // when it does, the whole character belongs to the next page.
    const atEof = start + buf.length >= size;
    let end = atEof ? buf.length : utf8PrefixLength(buf);
    // A page shorter than one character would otherwise make no progress at all;
    // the decoding below is the lesser evil for that degenerate request.
    if (end === 0) end = buf.length;
    return {
      ok: true,
      data: buf.subarray(0, end).toString("utf8"),
      startOffset: start,
      nextOffset: start + end,
      eof: start + end >= size,
      size
    };
  }

  /**
   * Case-insensitive substring search over the first `maxSearchBytes` of a log.
   * Line-oriented: a hit reports the line (bounded) and the byte offset of the
   * line's start, so the panel can jump with read().
   */
  async search(sessionId, { query, maxHits = this.limits.maxSearchHits } = {}) {
    const needle = String(query ?? "").toLowerCase();
    if (needle === "") return { ok: true, hits: [], scannedBytes: 0, stoppedEarly: false };
    await this.flush(sessionId);
    await this.init();
    const path = this.logPath(sessionId);
    let size;
    try { size = (await stat(path)).size; } catch { return { ok: false, reason: "no-such-log" }; }
    const limit = Math.min(size, this.limits.maxSearchBytes);
    if (limit === 0) return { ok: true, hits: [], scannedBytes: 0, stoppedEarly: false };
    const hits = [];
    let scanned = 0;
    let pending = "";
    let pendingOffset = 0;
    let stoppedEarly = false;
    const decoder = new StringDecoder("utf8");
    await new Promise((resolve) => {
      const stream = createReadStream(path, { start: 0, end: limit - 1 });
      stream.on("data", (chunk) => {
        scanned += chunk.length;
        pending += decoder.write(chunk);
        let index;
        while ((index = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, index);
          if (line.toLowerCase().includes(needle)) {
            hits.push({ offset: pendingOffset, line: line.slice(0, 500) });
          }
          pendingOffset += Buffer.byteLength(pending.slice(0, index + 1), "utf8");
          pending = pending.slice(index + 1);
          if (hits.length >= maxHits) { stoppedEarly = true; stream.destroy(); resolve(); return; }
        }
      });
      stream.on("error", () => resolve());
      stream.on("close", resolve);
      stream.on("end", () => {
        pending += decoder.end();
        if (pending !== "" && pending.toLowerCase().includes(needle)) {
          hits.push({ offset: pendingOffset, line: pending.slice(0, 500) });
        }
        resolve();
      });
    });
    return { ok: true, hits, scannedBytes: scanned, stoppedEarly };
  }

  /** Stop every live recording; called from the plugin's unload cleanup. */
  async close() {
    const streams = [...this.streams.values()];
    this.streams.clear();
    this.pending.clear();
    this.entries.clear();
    await Promise.all(streams.map((stream) => new Promise((resolve) => {
      try { stream.end(resolve); } catch { resolve(); }
    })));
  }

  /** Delete one log (and its sidecar). */
  async remove(sessionId) {
    this.streams.get(sessionId)?.destroy();
    this.streams.delete(sessionId);
    this.entries.delete(sessionId);
    const existed = await stat(this.logPath(sessionId)).then(() => true, () => false);
    await rm(this.logPath(sessionId), { force: true }).catch(() => {});
    await rm(this.metaPath(sessionId), { force: true }).catch(() => {});
    return { ok: true, deleted: existed };
  }

  /**
   * Delete every recorded session that has finished.
   *
   * A session that is still recording has no sidecar of its own yet — list()
   * merges the open entry — and its stream is the only copy of output the panel
   * is showing. Removing it would delete the log file under a live writer: the
   * session keeps running and appends nothing, silently, for the rest of its
   * life. "Clear all" therefore clears history, not the recording in progress.
   */
  async removeAll() {
    const entries = await this.list();
    const removed = [];
    for (const entry of entries) {
      if (this.entries.has(entry.sessionId)) continue;
      await this.remove(entry.sessionId);
      removed.push(entry.sessionId);
    }
    return { ok: true, deleted: removed.length };
  }

  /**
   * Keep the directory under its total budget by dropping the oldest logs —
   * the most recent recording is always kept, even if it alone exceeds it.
   */
  async prune() {
    const entries = await this.list();
    const total = entries.reduce((sum, entry) => sum + (Number(entry.bytes) || 0), 0);
    let remaining = total;
    const removed = [];
    for (const entry of entries.slice(1)) {
      if (remaining <= this.limits.maxTotalBytes) break;
      // Never reclaim a session that is still recording. prune() runs after
      // every natural exit, so a long-lived session coexists with the pruner
      // for its whole life; treating its merged live entry as history would
      // destroy the write stream (see removeAll).
      if (this.entries.has(entry.sessionId)) continue;
      remaining -= Number(entry.bytes) || 0;
      await this.remove(entry.sessionId);
      removed.push(entry.sessionId);
    }
    return { ok: true, removed, totalBefore: total, totalAfter: Math.max(0, remaining) };
  }
}
