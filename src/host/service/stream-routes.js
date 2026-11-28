/**
 * Plain-HTTP byte routes for streaming downloads and uploads (/harbor/stream).
 */
import { hashTransferStream } from "../files/transfer-tasks.js";
import { replaceRemoteFile, siblingTempPath } from "../files/sftp-write.js";
import { hasInteractiveTerminal, INTERACTIVE_UPLOAD_CHUNK_BYTES, scheduleUploadWrite } from "../files/upload-scheduling.js";
import { STREAM_ROUTE_PREFIX, STREAM_HIGH_WATER_MARK, STREAM_IDLE_TIMEOUT_MS } from "./constants.js";

/**
 * The WebServer route descriptor for the byte plane.
 *
 * `auth: "required"` is explicit on purpose: DSH's WebServer admits every
 * request before it invokes the handler (the connection service owns the
 * Host/Origin + browser-cookie fence through `webserver/authorize`). The
 * handler therefore must not re-implement admission. It used to call
 * `connection.requestRejection`, which DSH removed in v0.2.2-rc.2 — that call
 * threw on every request and made the whole byte plane answer HTTP 400 before
 * a single byte moved.
 *
 * @param {{handleStreamRoute: Function}} service - the Harbor service.
 * @returns the prefix route registration consumed by `webServer.register`.
 */
export function streamRouteDescriptor(service) {
  return {
    kind: "prefix",
    path: STREAM_ROUTE_PREFIX,
    auth: "required",
    handler: (req, res) => service.handleStreamRoute(req, res)
  };
}

export const withStreamRoutes = (Base) => class extends Base {
  // ── Streaming file plane (workbench S6 patch) ──────────────────────────────
  // HTTP byte routes over this service's own connections: callers address an
  // existing connectionId, so profile/credential/connection/host-key lifecycle
  // is fully reused and the ssh2 Client never leaves this class. Errors mirror
  // the typert business envelope ({ok:false,error:{code,message}}) with an HTTP
  // status for the transport-level outcome; success replies are {ok:true,value}.

  /** Route entry: the WebServer has already admitted this request. */
  handleStreamRoute(req, res) {
    let url;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      this.streamJson(res, 400, "bad-request", "invalid request URL");
      return;
    }
    const connectionId = url.searchParams.get("connectionId");
    if (connectionId === null || connectionId === "") {
      this.streamJson(res, 400, "bad-request", "connectionId query parameter is required");
      return;
    }
    if (url.pathname === `${STREAM_ROUTE_PREFIX}/file`) {
      if (req.method === "GET") return this.streamGuard(res, this.streamDownloadFile(req, res, url, connectionId));
      if (req.method === "PUT") return this.streamGuard(res, this.streamUploadFile(req, res, url, connectionId));
    } else if (url.pathname === `${STREAM_ROUTE_PREFIX}/verification` && req.method === "GET") {
      const progress = this.downloadVerifications?.get(url.searchParams.get("id"));
      if (!progress || progress.connectionId !== connectionId) {
        this.streamJson(res, 404, "verification-unavailable", "Download verification is not active");
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ bytes: progress.bytes, total: progress.total }));
      return;
    } else if (url.pathname === `${STREAM_ROUTE_PREFIX}/archive` && req.method === "GET") {
      // SFTP and SSH exec can resolve the same absolute spelling in different
      // filesystem namespaces (for example, a chrooted SFTP account). Until
      // archive generation is implemented solely through the SFTP namespace,
      // never hand an SFTP path to an SSH shell command.
      this.streamJson(res, 501, "archive-unavailable", "archive streaming is disabled until SFTP namespace-safe archiving is available");
      return;
    }
    this.streamJson(res, 405, "method-not-allowed", `${req.method} ${url.pathname} is not served`, { allow: "GET, PUT" });
  }

  /** Last-resort guard: unexpected throw → 502 envelope (or truncated body). */
  streamGuard(res, promise) {
    promise.catch((error) => {
      this.streamJson(res, 502, "stream-failed", error instanceof Error ? error.message : String(error));
    });
  }

  /** Business-envelope JSON reply (only valid before any body byte is sent). */
  streamJson(res, status, code, message, headers = {}) {
    if (res.destroyed || res.headersSent || res.writableEnded) {
      if (!res.destroyed) res.destroy();
      return;
    }
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify({ ok: false, error: { code, message } }));
  }

  /** resolveConnection/requireSftp failure → 404 (gone) or 502 (transport). */
  streamReplyFailure(res, failure) {
    const code = failure?.error?.code ?? "stream-failed";
    const message = failure?.error?.message ?? "streaming file operation failed";
    this.streamJson(res, code === "no-connection" || code === "connection-lost" ? 404 : 502, code, message);
  }

  /** Connection + live SFTP subsystem, or a mapped error reply and null. */
  async streamPrepareSftp(res, connectionId) {
    const selected = this.resolveConnection(connectionId);
    if (!selected.ok) {
      this.streamReplyFailure(res, selected);
      return null;
    }
    const sftp = await this.requireSftp(selected.connection);
    if (!sftp.ok) {
      this.streamReplyFailure(res, sftp);
      return null;
    }
    return { connection: selected.connection, sftp: sftp.sftp };
  }

  /** stat → attrs, or a 404/502 reply and null (not-found by message, sftpList convention). */
  async streamStat(res, sftp, remotePath) {
    try {
      return await new Promise((resolve, reject) => {
        sftp.stat(remotePath, (error, attrs) => (error ? reject(error) : resolve(attrs)));
      });
    } catch (error) {
      this.streamJson(res, /No such file/i.test(error.message) ? 404 : 502, "sftp-stat-failed", `${remotePath}: ${error.message}`);
      return null;
    }
  }

  /**
   * Await the ssh2 stream 'open' event (SFTP ReadStream and WriteStream both
   * emit it) so handle-open failures stay replyable as JSON envelopes.
   * @returns the open error, or null on success.
   */
  streamAwaitOpen(stream) {
    return new Promise((resolve) => {
      let settled = false;
      stream.once("open", () => {
        if (!settled) { settled = true; resolve(null); }
      });
      stream.once("error", (error) => {
        if (!settled) { settled = true; resolve(error); }
      });
    });
  }

  /**
   * Active streaming-upload registry keyed by connectionId. A cancelled PUT can
   * go unobserved by request events (unread body masks the client FIN), so
   * connection teardown sweeps the registry to destroy SFTP write streams and
   * reply 502 — no handler outlives its SSH connection.
   */
  trackStreamUpload(connectionId, entry) {
    this.streamUploads ??= new Map();
    let set = this.streamUploads.get(connectionId);
    if (set === undefined) {
      set = new Set();
      this.streamUploads.set(connectionId, set);
    }
    set.add(entry);
  }

  untrackStreamUpload(connectionId, entry) {
    const set = this.streamUploads?.get(connectionId);
    if (set === undefined) return;
    set.delete(entry);
    if (set.size === 0) this.streamUploads.delete(connectionId);
  }

  sweepStreamUploads(connectionId, reason) {
    const set = this.streamUploads?.get(connectionId);
    if (set === undefined) return;
    this.streamUploads.delete(connectionId);
    for (const entry of [...set]) {
      try {
        entry.cancel(reason);
      } catch {}
    }
  }

  /** GET /harbor/stream/file?connectionId&path — unbounded raw-byte download. */
  async streamDownloadFile(req, res, url, connectionId) {
    const remotePath = url.searchParams.get("path");
    if (remotePath === null || remotePath === "") {
      this.streamJson(res, 400, "bad-path", "path query parameter is required");
      return;
    }
    const prepared = await this.streamPrepareSftp(res, connectionId);
    if (prepared === null) return;
    const attrs = await this.streamStat(res, prepared.sftp, remotePath);
    if (attrs === null) return;
    if ((attrs.mode & 0o170000) === 0o040000) {
      this.streamJson(res, 400, "is-directory", `${remotePath}: this route serves files only`);
      return;
    }
    const offsetText = url.searchParams.get("offset") ?? "0";
    const offset = Number(offsetText);
    if (!/^\d+$/.test(offsetText) || !Number.isSafeInteger(offset) || offset < 0 || offset > attrs.size || (offset > 0 && url.searchParams.get("verify") !== "sha256")) {
      this.streamJson(res, 400, "bad-offset", "Invalid download offset");
      return;
    }
    let digest;
    if (url.searchParams.get("verify") === "sha256") {
      const controller = new AbortController();
      const verificationId = url.searchParams.get("verificationId") ?? "";
      const verifications = this.downloadVerifications ??= new Map();
      const tracked = /^[a-f0-9-]{36}$/.test(verificationId) && verifications.size < 128 && !verifications.has(verificationId);
      const progress = { connectionId, bytes: 0, total: attrs.size };
      if (tracked) verifications.set(verificationId, progress);
      const onClose = () => controller.abort(new Error("Download cancelled"));
      res.once("close", onClose);
      try {
        digest = await hashTransferStream(prepared.sftp.createReadStream(remotePath, { highWaterMark: STREAM_HIGH_WATER_MARK }), controller.signal, undefined, (bytes) => { progress.bytes = bytes; });
      } catch (error) {
        if (!res.destroyed) this.streamJson(res, 502, "sftp-hash-failed", error.message);
        return;
      } finally {
        res.removeListener("close", onClose);
        if (tracked) verifications.delete(verificationId);
      }
      if (res.destroyed) return;
      const expected = url.searchParams.get("expectedSha256");
      if (offset > 0 && (!expected || expected !== digest)) {
        this.streamJson(res, 409, "source-changed", "Remote file changed; resume refused");
        return;
      }
    }
    const stream = prepared.sftp.createReadStream(remotePath, { highWaterMark: STREAM_HIGH_WATER_MARK, ...(offset ? { start: offset } : {}) });
    const openError = await this.streamAwaitOpen(stream);
    if (openError !== null) {
      stream.destroy();
      this.streamJson(res, /No such file/i.test(openError.message) ? 404 : 502, "sftp-read-failed", `${remotePath}: ${openError.message}`);
      return;
    }
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(attrs.size - offset),
      "x-file-size": String(attrs.size),
      "x-download-offset": String(offset),
 ...(digest ? { "x-content-sha256": digest } : {}),
      "cache-control": "no-store, no-transform"
    });
    let destroyed = false;
    const destroy = () => {
      if (destroyed) return;
      destroyed = true;
      stream.destroy();
    };
    // Client abort (fetch AbortController / socket close) ends the response →
    // stop reading upstream immediately: real mid-flight cancellation.
    res.on("close", destroy);
    stream.on("error", (error) => {
      destroy();
      this.ctx.logger.warn(new Error(`harbor stream download failed: ${remotePath}: ${error.message}`));
      // Headers already out: a truncated body is the only honest failure left.
      if (!res.writableEnded) res.destroy();
    });
    stream.pipe(res);
  }

  /**
   * PUT /harbor/stream/file?connectionId&path[&overwrite=false][&onCancel=keep]
   * — unbounded raw-byte upload with OS-level backpressure. Cancel = request
   * socket closing before the body ends: destroy the temporary SFTP stream
   * and remove only that temporary file. The destination is replaced only
   * after the complete upload closes and its rename succeeds.
   */
  async streamUploadFile(req, res, url, connectionId) {
    const remotePath = url.searchParams.get("path");
    if (remotePath === null || remotePath === "") {
      this.streamJson(res, 400, "bad-path", "path query parameter is required");
      return;
    }
    const overwrite = url.searchParams.get("overwrite") !== "false";
    const keepPartial = url.searchParams.get("onCancel") === "keep";
    const partialPath = siblingTempPath(remotePath, "up");
    const prepared = await this.streamPrepareSftp(res, connectionId);
    if (prepared === null) return;
    const targetExists = async () => {
      try {
        await this.sftpDeadline(this.sftpCall(prepared, (cb) => prepared.sftp.lstat(remotePath, cb)));
        return true;
      } catch (error) {
        if (error.code === 2 || error.code === "ENOENT") return false;
        throw error;
      }
    };
    if (!overwrite) {
      if (await targetExists()) {
        this.streamJson(res, 409, "target-exists", `${remotePath}: already exists (overwrite=false)`);
        return;
      }
    }
    // ssh2's automatic close is started in _final, before Writable marks
    // the stream finished. Close explicitly after finish so a fast SFTP
    // server cannot acknowledge close before all stream state is settled.
    const out = prepared.sftp.createWriteStream(partialPath, { highWaterMark: STREAM_HIGH_WATER_MARK, autoClose: false });
    const openError = await this.streamAwaitOpen(out);
    if (openError !== null) {
      out.destroy();
      try { await this.removeSftpPartial(prepared, partialPath); } catch (cleanupError) {
        this.streamJson(res, 502, "sftp-cleanup-failed", `${partialPath}: ${cleanupError.message}`);
        return;
      }
      this.streamJson(res, 502, "sftp-write-failed", `${remotePath}: ${openError.message}`);
      return;
    }
    let bytes = 0;
    let ended = false; // request body fully received
    let settled = false; // success reply sent
    let discarded = false; // cancel path taken
    let pendingWrite = false;
    const uploadAbort = new AbortController();
    // Zombie-upload backstop 1: idle socket. While the request is paused the
    // server cannot see the client's FIN (unread body bytes precede it), so
    // socket inactivity — not request events — bounds a cancelled upload.
    const socket = req.socket;
    const onIdle = () => {
      discard("socket idle timeout");
      try { res.destroy(); } catch {}
    };
    try {
      socket.setTimeout(STREAM_IDLE_TIMEOUT_MS, onIdle);
    } catch {}
    const finalizeIo = () => {
      try {
        socket.setTimeout(0);
        socket.removeListener("timeout", onIdle);
      } catch {}
      this.untrackStreamUpload(connectionId, registryEntry);
    };
    const discard = async (reason) => {
      if (settled || discarded) return;
      discarded = true;
      uploadAbort.abort();
      finalizeIo();
      try { req.pause(); } catch {}
      out.destroy();
      if (!keepPartial) {
        try { await this.removeSftpPartial(prepared, partialPath); } catch (cleanupError) {
          this.streamJson(res, 502, "sftp-cleanup-failed", `${partialPath}: ${cleanupError.message}`);
          return;
        }
      }
      this.streamJson(res, 502, "upload-cancelled", `${remotePath}: ${reason}`);
    };
    // Zombie-upload backstop 2: connection teardown sweeps in-flight uploads
    // (destroy the SFTP write stream + 502 reply), so no paused handler
    // outlives the SSH connection that carried it.
    const registryEntry = { path: remotePath, cancel: (reason) => { void discard(reason); } };
    this.trackStreamUpload(connectionId, registryEntry);
    if (prepared.connection.streamUploadSweepClient !== prepared.connection.client) {
      prepared.connection.streamUploadSweepClient = prepared.connection.client;
      prepared.connection.client.once("close", () => {
        this.sweepStreamUploads(connectionId, "ssh connection closed");
      });
    }
    req.on("aborted", () => discard("client aborted the request"));
    req.on("error", (error) => discard(`request error: ${error.message}`));
    req.on("close", () => {
      if (!ended && !settled) discard("client closed the request early");
    });
    // Full body received but the client vanished before the reply (late
    // abort): still deterministic — cancelled means no file left behind.
    res.on("close", () => {
      if (!settled && !res.writableEnded) discard("client disconnected before completion");
    });
    out.on("error", async (error) => {
      if (settled || discarded) return;
      settled = true;
      finalizeIo();
      try { req.destroy(); } catch {}
      try { await this.removeSftpPartial(prepared, partialPath); } catch (cleanupError) {
        this.streamJson(res, 502, "sftp-cleanup-failed", `${partialPath}: ${cleanupError.message}`);
        return;
      }
      this.streamJson(res, 502, "sftp-write-failed", `${remotePath}: ${error.message}`);
    });
    out.on("finish", () => out.destroy());
    out.on("close", async () => {
      if (settled || discarded) return;
      try {
        if (!ended || !out.writableFinished) throw new Error("SFTP write stream closed before upload completed");
        if (!overwrite) {
          // SFTP v3 RENAME refuses an existing target. The OpenSSH POSIX
          // extension replaces it, so reserve that extension for explicit overwrite.
          try {
            if (await targetExists()) throw Object.assign(new Error("Upload target already exists"), { code: "target-exists" });
            await this.sftpDeadline(this.sftpCall(prepared, (cb) => prepared.sftp.rename(partialPath, remotePath, cb)));
          } catch (error) {
            if (error.code === "target-exists" || !await targetExists()) throw error;
            throw Object.assign(new Error("Upload target already exists"), { code: "target-exists" });
          }
        } else {
          // Explicit overwrite: the shared helper prefers OpenSSH's POSIX rename
          // (which replaces the target) and falls back to plain rename on a
          // server without the extension. The non-overwrite branch above keeps
          // its own "refuse an existing target" rule.
          await this.sftpDeadline(replaceRemoteFile(prepared.sftp, partialPath, remotePath));
        }
      } catch (error) {
        settled = true;
        finalizeIo();
        try { await this.removeSftpPartial(prepared, partialPath); } catch (cleanupError) {
          this.streamJson(res, 502, "sftp-cleanup-failed", `${partialPath}: ${cleanupError.message}`);
          return;
        }
        const conflict = error.code === "target-exists";
        this.streamJson(res, conflict ? 409 : 502, conflict ? "target-exists" : "sftp-rename-failed", `${remotePath}: ${error.message}`);
        return;
      }
      settled = true;
      finalizeIo();
      if (res.destroyed || res.headersSent || res.writableEnded) {
        if (!res.destroyed) res.destroy();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, value: { path: remotePath, bytes } }));
    });
    // Manual pump (instead of pipe) to count bytes and keep backpressure:
    // pause the request while the SFTP window is full, resume on drain.
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (!hasInteractiveTerminal(prepared.connection)) {
        if (!out.write(chunk)) req.pause();
        return;
      }
      req.pause();
      pendingWrite = true;
      void (async () => {
        for (let offset = 0; offset < chunk.length; offset += INTERACTIVE_UPLOAD_CHUNK_BYTES) {
          const part = chunk.subarray(offset, offset + INTERACTIVE_UPLOAD_CHUNK_BYTES);
          await scheduleUploadWrite(prepared.connection, uploadAbort.signal, () => new Promise((resolve, reject) => {
            out.write(part, (error) => error ? reject(error) : resolve());
          }));
        }
      })().then(() => {
        pendingWrite = false;
        if (discarded || settled) return;
        if (ended) out.end();
        else req.resume();
      }).catch((error) => {
        if (!discarded && !settled) out.destroy(error);
      });
    });
    out.on("drain", () => {
      if (!discarded && !ended && !pendingWrite) req.resume();
    });
    req.on("end", () => {
      ended = true;
      if (!discarded && !settled && !pendingWrite) out.end();
    });
  }
};
