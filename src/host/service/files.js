/**
 * SFTP/SCP file operations and single-file transfer primitives.
 */
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { joinRemotePath, splitRemotePath } from "../sftp-dir.js";
import { scpCommand, scpDownload, scpUpload } from "../scp.js";
import { saveEditorFile } from "../sftp-editor-save.js";
import { writeRemoteFileAtomic } from "../sftp-write.js";
import { fail } from "../envelope.js";
import { MAX_FILE_READ_BYTES, MAX_COMMAND_OUTPUT_BYTES } from "./constants.js";
import { decodeBase64Bytes, tailCapped } from "./text.js";

/**
 * Release one SCP channel. `end()` sends EOF so the remote `scp -t` exits;
 * `close()` is the fallback for a channel that already errored out. Both are
 * best-effort — a dead transport must not turn cleanup into a thrown error.
 */
function closeScpChannel(stream) {
  if (stream === undefined || stream === null) return;
  try {
    if (stream.destroyed === true) return;
    if (typeof stream.end === "function") stream.end();
    else if (typeof stream.close === "function") stream.close();
  } catch {}
}

export const withFiles = (Base) => class extends Base {
  // ── SFTP (file management) ─────────────────────────────────────────────────

  /**
   * Lazily open (or reuse) the sftp subsystem of a connection.
   *
   * Single flight: the panel lists a directory while an upload starts, two
   * panes poll, a batch fans out — every caller used to see `sftp === null` and
   * open its OWN subsystem channel, and only the last one landed in
   * `connection.sftp`. The others stayed open with no owner and no way to close
   * them, eating into sshd's MaxSessions until the next transport loss. Whoever
   * arrives first opens the channel; everybody else shares it and its failure.
   */
  async requireSftp(connection, retried = false) {
    if (connection.sftp !== null) return { ok: true, sftp: connection.sftp };
    const pending = connection.sftpPending;
    if (pending !== undefined && pending !== null) return pending;
    const opening = this.openSftp(connection, retried);
    connection.sftpPending = opening;
    try {
      return await opening;
    } finally {
      if (connection.sftpPending === opening) connection.sftpPending = null;
    }
  }

  /** Open the SFTP subsystem once (see requireSftp for the sharing contract). */
  async openSftp(connection, retried) {
    if (!(await this.ensureAlive(connection))) {
      return { ok: false, error: fail("connection-lost", `connection "${connection.id}" is down and could not be re-established`) };
    }
    try {
      const sftp = await new Promise((resolve, reject) => {
        connection.client.sftp((error, s) => {
          if (error) reject(error);
          else resolve(s);
        });
      });
      // A subsystem dies independently of the transport: the remote
      // sftp-server exits, sshd evicts the channel, an idle timeout fires.
      // Keeping a dead wrapper in `connection.sftp` made every later SFTP call
      // wait for a reply that can never arrive — the panel just hung with no
      // error, forever, because nothing ever invalidated the cache. Drop it the
      // moment the subsystem ends, and keep an 'error' listener on it so a late
      // error is consumed here instead of becoming an uncaught event.
      const drop = () => {
        if (connection.sftp === sftp) connection.sftp = null;
      };
      sftp.once?.("close", drop);
      sftp.once?.("end", drop);
      sftp.once?.("error", drop);
      // The transport can die while the channel is opening. Caching that
      // wrapper would recreate the same permanent hang the drop handlers
      // above exist to prevent, only with nothing left to ever emit 'close'.
      if (connection.dead === true || connection.closing === true) {
        try { sftp.end?.(); } catch {}
        return { ok: false, error: fail("connection-lost", `connection "${connection.id}" went down while opening its SFTP subsystem`) };
      }
      connection.sftp = sftp;
      return { ok: true, sftp };
    } catch (error) {
      if (!retried && connection.dead && (await this.ensureAlive(connection))) {
        return this.openSftp(connection, true);
      }
      return { ok: false, error: fail("sftp-failed", `could not open SFTP subsystem: ${error.message}`) };
    }
  }

  /** List one remote directory: entries with type, size, mtime, and mode. */
  async sftpList(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const sftp = await this.requireSftp(selected.connection);
    if (!sftp.ok) return sftp;
    const remotePath = request.path || ".";
    try {
      const entries = await this.sftpDeadline(new Promise((resolve, reject) => {
        sftp.sftp.readdir(remotePath, (error, list) => {
          if (error) reject(error);
          else resolve(list);
        });
      }));
      const items = await Promise.all(entries.map(async (entry) => {
        const kind = entry.attrs.mode & 0o170000;
        let isDirectory = kind === 0o040000;
        // readdir reports the link itself, so a directory symlink such as
        // /var/lock appears as a file. Follow it once to give the UI the
        // target's real type; otherwise it tries to download a directory and
        // SFTP servers commonly respond with the opaque "Failure".
        if (kind === 0o120000) {
          const entryPath = remotePath === "/" ? `/${entry.filename}` : `${remotePath.replace(/\/+$/, "")}/${entry.filename}`;
          try {
            const attrs = await this.sftpDeadline(new Promise((resolve, reject) => {
              sftp.sftp.stat(entryPath, (error, value) => (error ? reject(error) : resolve(value)));
            }));
            isDirectory = (attrs.mode & 0o170000) === 0o040000;
          } catch {
            // A broken or inaccessible link remains downloadable as a file;
            // its later operation can then report the server's exact error.
          }
        }
        return {
          name: entry.filename,
          isDirectory,
          size: entry.attrs.size,
          mtime: entry.attrs.mtime * 1000,
          mode: entry.attrs.mode
        };
      }));
      return { ok: true, value: { path: remotePath, entries: items } };
    } catch (error) {
      return { ok: false, error: fail("sftp-list-failed", `${remotePath}: ${error.message}`) };
    }
  }

  /** Stat one remote path. */
  async sftpStat(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const sftp = await this.requireSftp(selected.connection);
    if (!sftp.ok) return sftp;
    try {
      const attrs = await this.sftpDeadline(new Promise((resolve, reject) => {
        sftp.sftp.stat(request.path, (error, a) => {
          if (error) reject(error);
          else resolve(a);
        });
      }));
      return {
        ok: true,
        value: {
          path: request.path,
          isDirectory: (attrs.mode & 0o170000) === 0o040000,
          size: attrs.size,
          mtime: attrs.mtime * 1000,
          mode: attrs.mode
        }
      };
    } catch (error) {
      return { ok: false, error: fail("sftp-stat-failed", `${request.path}: ${error.message}`) };
    }
  }

  /** Read a remote file as base64 (bounded; large files spill a hint). */
  async sftpReadFile(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const sftp = await this.requireSftp(selected.connection);
    if (!sftp.ok) return sftp;
    // The RPC schema caps this, but agent tools call the service directly and
    // the tool schema is advisory. Clamp here so no caller can ask the host to
    // buffer an arbitrarily large file.
    const requestedMax = Number(request.maxBytes);
    const maxBytes = request.maxBytes === undefined || !Number.isFinite(requestedMax)
      ? MAX_FILE_READ_BYTES
      : Math.min(Math.max(0, Math.floor(requestedMax)), MAX_FILE_READ_BYTES);
    // Read ONE byte past the cap: that byte is the only way to tell "the file
    // ends exactly here" from "the file continues". Without it, a file whose
    // size is a multiple of the read chunk size reached the budget exactly, the
    // stream was destroyed, and the caller was told truncated:false about the
    // first half of a 5 MiB file.
    const budget = maxBytes + 1;
    const chunks = [];
    let received = 0;   // bytes seen, at most `budget` (maxBytes + 1)
    let kept = 0;       // bytes of file content returned, at most maxBytes
    try {
      const stream = sftp.sftp.createReadStream(request.path);
      const done = new Promise((resolve, reject) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          // The budget is a transfer budget, not just a memory buffer: a
          // multi-GB file must not stream to completion after the limit.
          try { stream.destroy(); } catch {}
          resolve();
        };
        stream.on("data", (chunk) => {
          // One tick can deliver several chunks, and destroy() does not stop a
          // queued one: a late chunk must never be counted after resolution.
          if (settled) return;
          const room = budget - received;
          if (room <= 0) { finish(); return; }
          const slice = chunk.length <= room ? chunk : chunk.subarray(0, room);
          received += slice.length;
          const take = Math.max(0, Math.min(slice.length, maxBytes - kept));
          if (take > 0) {
            chunks.push(take === slice.length ? slice : slice.subarray(0, take));
            kept += take;
          }
          if (received >= budget) finish();
        });
        stream.on("end", finish);
        stream.on("error", (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        });
      });
      await done;
      const truncated = received > maxBytes;
      const data = Buffer.concat(chunks).toString("base64");
      return { ok: true, value: { path: request.path, data, truncated, bytes: kept } };
    } catch (error) {
      return { ok: false, error: fail("sftp-read-failed", `${request.path}: ${error.message}`) };
    }
  }

  /**
   * Write base64 content to a remote file.
   *
   * Bounded by the configured SFTP deadline (a server that never answers must
   * not hold the RPC open) and atomic (see sftp-write.js): a failed write can
   * leave a temporary file, never a truncated target.
   */
  async sftpWriteFile(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const sftp = await this.requireSftp(selected.connection);
    if (!sftp.ok) return sftp;
    try {
      const buf = decodeBase64Bytes(request.data);
      // The write cancels its own stream on abort/timeout and cleans up the
      // temporary file. Racing the whole operation would report "failed" while
      // the rename could still replace the target. `signal` comes from the
      // agent tool (sftp_write passes the call's AbortSignal); the panel RPC is
      // unary and carries none, so it is simply undefined there.
      const timeoutMs = Math.max(1, this.config?.sftpOperationTimeoutMs ?? 30000);
      await writeRemoteFileAtomic(sftp.sftp, request.path, buf, { signal: request.signal, timeoutMs });
      return { ok: true, value: { path: request.path, bytes: buf.length } };
    } catch (error) {
      return { ok: false, error: fail("sftp-write-failed", `${request.path}: ${error.message}`) };
    }
  }

  async sftpEditorSave(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const sftp = await this.requireSftp(selected.connection);
    if (!sftp.ok) return sftp;
    try {
      const timeoutMs = Math.max(1, this.config?.sftpOperationTimeoutMs ?? 30000);
      const expected = decodeBase64Bytes(request.expected);
      const data = decodeBase64Bytes(request.data);
      const value = await saveEditorFile(sftp.sftp, request.path, expected, data, { timeoutMs });
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: fail("editor-save-failed", error.message) };
    }
  }

  /** Open one non-interactive SCP channel on a live SSH connection. */
  async openScpChannel(connection, command) {
    if (!(await this.ensureAlive(connection))) {
      throw new Error(`connection "${connection.id}" is down and could not be re-established`);
    }
    return new Promise((resolve, reject) => {
      connection.client.exec(command, { pty: false }, (error, stream) => {
        if (error) reject(error);
        else {
          // SCP itself reports startup failures (not installed, exec denied)
          // on stderr rather than through the binary protocol channel.
          stream.scpStderr = "";
          stream.stderr?.on("data", (chunk) => {
            stream.scpStderr = tailCapped(stream.scpStderr + Buffer.from(chunk).toString("utf8"), MAX_COMMAND_OUTPUT_BYTES);
          });
          resolve(stream);
        }
      });
    });
  }

  /** Download one file through SCP when the SSH server has no SFTP subsystem. */
  async scpReadFile(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const requestedMax = Number(request.maxBytes);
    const maxBytes = request.maxBytes === undefined || !Number.isFinite(requestedMax)
      ? MAX_FILE_READ_BYTES
      : Math.min(Math.max(0, Math.floor(requestedMax)), MAX_FILE_READ_BYTES);
    let stream;
    try {
      stream = await this.openScpChannel(selected.connection, scpCommand("f", request.path));
      const result = await scpDownload(stream, maxBytes);
      return {
        ok: true,
        value: { path: request.path, data: result.data.toString("base64"), truncated: result.truncated, bytes: result.bytes }
      };
    } catch (error) {
      return { ok: false, error: fail("scp-read-failed", `${request.path}: ${stream?.scpStderr?.trim() || error.message}`) };
    } finally {
      closeScpChannel(stream);
    }
  }

  /** Upload one file through SCP when the SSH server has no SFTP subsystem. */
  async scpWriteFile(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    let stream;
    try {
      const data = decodeBase64Bytes(request.data);
      stream = await this.openScpChannel(selected.connection, scpCommand("t", request.path));
      const result = await scpUpload(stream, request.path, data);
      return { ok: true, value: { path: request.path, bytes: result.bytes } };
    } catch (error) {
      return { ok: false, error: fail("scp-write-failed", `${request.path}: ${stream?.scpStderr?.trim() || error.message}`) };
    } finally {
      // The remote `scp -t` exits on stdin EOF. Without this the process stays
      // alive after a completed upload, holding one SSH session channel — and
      // sshd's MaxSessions (10 by default) then refuses every later exec,
      // shell and SFTP channel on this connection, which is how ten uploads
      // silently break a server.
      closeScpChannel(stream);
    }
  }

  /** Create a remote directory (mkdir -p semantics via mkdir + stat). */
  async sftpMkdir(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const sftp = await this.requireSftp(selected.connection);
    if (!sftp.ok) return sftp;
    try {
      await this.sftpDeadline(new Promise((resolve, reject) => {
        sftp.sftp.mkdir(request.path, (error) => {
          if (error) reject(error);
          else resolve();
        });
      }));
      return { ok: true, value: { path: request.path } };
    } catch (error) {
      return { ok: false, error: fail("sftp-mkdir-failed", `${request.path}: ${error.message}`) };
    }
  }

  /** Delete a remote file (or empty directory). */
  async sftpDelete(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const sftp = await this.requireSftp(selected.connection);
    if (!sftp.ok) return sftp;
    try {
      // lstat, not stat: the entry's OWN type decides how it is removed, and
      // stat reports the link target's. Deleting a symlink to a directory
      // therefore sent rmdir for a link (ENOTDIR), and a BROKEN symlink could
      // not be deleted at all because stat failed with ENOENT on a path lstat
      // answers for. A symlink is an ordinary non-directory entry here.
      const isDir = await this.sftpDeadline(new Promise((resolve, reject) => {
        sftp.sftp.lstat(request.path, (error, attrs) => {
          if (error) reject(error);
          else resolve((attrs.mode & 0o170000) === 0o040000);
        });
      }));
      await this.sftpDeadline(new Promise((resolve, reject) => {
        const fn = isDir ? sftp.sftp.rmdir : sftp.sftp.unlink;
        fn.call(sftp.sftp, request.path, (error) => {
          if (error) reject(error);
          else resolve();
        });
      }));
      return { ok: true, value: { path: request.path, isDirectory: isDir } };
    } catch (error) {
      return { ok: false, error: fail("sftp-delete-failed", `${request.path}: ${error.message}`) };
    }
  }

  /** Bound a remote SFTP operation without assuming the server will reply. */
  async sftpDeadline(operation) {
    const timeoutMs = Math.max(1, this.config?.sftpOperationTimeoutMs ?? 30000);
    let timer;
    try {
      return await Promise.race([
        operation,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`SFTP operation timed out after ${timeoutMs} ms`)), timeoutMs); })
      ]);
    } finally { clearTimeout(timer); }
  }

  /** Move a single approved target to a unique trash path using SFTP, without a shell. */
  async moveSftpToTrash(connectionId, path) {
    const selected = this.resolveConnection(connectionId);
    if (!selected.ok) return selected;
    let trashPath;
    let renameStarted = false;
    try {
      const prepared = await this.sftpDeadline(this.requireSftp(selected.connection));
      if (!prepared.ok) return prepared;
      const home = await this.sftpDeadline(this.sftpCall(prepared, (cb) => prepared.sftp.realpath(".", cb)));
      if (typeof home !== "string" || !(home.startsWith("/") || /^[A-Za-z]:\//.test(home))) throw new Error("SFTP home directory is not an absolute path");
      if (typeof path !== "string" || !path || /[\\\x00-\x1f\x7f]/.test(path)) throw new Error("Use an SFTP path with forward slashes and no control characters");
      const trashDir = joinRemotePath(home, ".dsh-trash");
      const canonicalHome = posix.resolve("/", home).toLowerCase();
      const source = (/^[A-Za-z]:\//.test(path) ? posix.resolve("/", path) : posix.resolve(canonicalHome, path)).toLowerCase();
      const trash = posix.resolve("/", trashDir).toLowerCase();
      if (source === "/" || source === canonicalHome || trash === source || trash.startsWith(`${source}/`) || source.startsWith(`${trash}/`)) {
        throw new Error("Refusing to move the home directory, its parent, or the trash itself");
      }
      await this.sftpDeadline(this.ensureRemoteDir(prepared, trashDir));
      const label = encodeURIComponent(posix.basename(path)).slice(0, 80) || "item";
      trashPath = joinRemotePath(trashDir, `${label}-${randomUUID()}`);
      renameStarted = true;
      await this.sftpDeadline(this.sftpCall(prepared, (cb) => prepared.sftp.rename(path, trashPath, cb)));
      return { ok: true, value: { trashPath } };
    } catch (error) {
      const outcome = renameStarted ? `; outcome may be unknown, check both ${path} and ${trashPath} before retrying` : "";
      return { ok: false, error: fail("sftp-trash-failed", `Could not confirm remote trash move: ${error.message}${outcome}`) };
    }
  }

  /** Rename a remote file or directory. */
  async sftpRename(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const sftp = await this.requireSftp(selected.connection);
    if (!sftp.ok) return sftp;
    try {
      // POSIX/OpenSSH rename(2) silently replaces an existing destination, so a
      // typo in the rename dialog destroyed a file nobody selected. A rename is
      // "move this name"; replacing content is a separate decision the operator
      // makes by deleting the target first.
      const existing = await this.sftpDeadline(new Promise((resolve) => {
        sftp.sftp.lstat(request.to, (error, attrs) => resolve(error ? null : attrs));
      }));
      if (existing !== null && !(await this.isSameRemoteEntry(sftp, request.from, request.to))) {
        return { ok: false, error: fail("target-exists", `${request.to} already exists; delete it first if you meant to replace it`) };
      }
      await this.sftpDeadline(new Promise((resolve, reject) => {
        sftp.sftp.rename(request.from, request.to, (error) => {
          if (error) reject(error);
          else resolve();
        });
      }));
      return { ok: true, value: { from: request.from, to: request.to } };
    } catch (error) {
      return { ok: false, error: fail("sftp-rename-failed", `${request.from} -> ${request.to}: ${error.message}`) };
    }
  }

  /**
   * Whether a rename's destination is the SAME entry as its source — a
   * case-only rename on a case-insensitive export (`file` -> `File`), a
   * trailing-slash or `.` variation. Only then may rename replace what it found
   * on the destination; a different entry is refused by the caller.
   *
   * SFTP v3 exposes no inode, and the attribute triple (size, mtime, mode) is
   * NOT identity: two unrelated files of equal size, written in the same second
   * with the same permissions compare equal, so the old check let a rename
   * silently destroy a file nobody selected — exactly the loss the caller's
   * "target exists" refusal exists to prevent. Identity comes from the server:
   * `realpath` resolves symlinks, `.`/`..`, duplicate separators and trailing
   * slashes, and two distinct names never collapse into each other.
   */
  async isSameRemoteEntry(sftp, from, to) {
    const [source, destination] = await Promise.all([
      this.remoteCanonicalPath(sftp, from),
      this.remoteCanonicalPath(sftp, to)
    ]);
    if (source === null || destination === null) return false;
    if (source === destination) return true;
    // Different canonical strings. On a case-insensitive export the server
    // answers `lstat`/`realpath` for a spelling that is not stored, and the
    // canonical path keeps the CASE IT WAS ASKED FOR, so the one-entry case
    // also shows up as two different strings. The parent listing settles it:
    // exactly ONE of the two spellings is a real directory entry, which is only
    // possible when they name the same entry. On a case-sensitive export that
    // has BOTH spellings (where this refusal matters most) both are listed, so
    // this returns false.
    if (posix.dirname(source) !== posix.dirname(destination)) return false;
    const fromName = posix.basename(source);
    const toName = posix.basename(destination);
    if (fromName.toLowerCase() !== toName.toLowerCase()) return false;
    let names;
    try {
      const entries = await this.sftpDeadline(this.sftpCall(sftp, (cb) => sftp.sftp.readdir(posix.dirname(source), cb)));
      if (!Array.isArray(entries)) return false;
      names = new Set(entries.map((entry) => entry.filename));
    } catch {
      // The server will not say which spelling is real; refusing is the
      // recoverable answer, replacing a different file is not.
      return false;
    }
    return names.has(fromName) !== names.has(toName);
  }

  /** `realpath` on the remote, or null when the server cannot answer. */
  async remoteCanonicalPath(sftp, path) {
    try {
      const resolved = await this.sftpDeadline(this.sftpCall(sftp, (cb) => sftp.sftp.realpath(path, cb)));
      return typeof resolved === "string" && resolved !== "" ? resolved : null;
    } catch {
      return null;
    }
  }

  // ── Directory batch transfer (SFTP) ────────────────────────────────────────
  // Scheduling policy lives in sftp-dir.js: small files in a bounded pool of
  // 6, files over 512 KiB one at a time, monotone counters, per-file failures
  // collected instead of fatal. These methods only implement the I/O.

  /** Promisified one-shot sftp callback op. */
  sftpCall(sftp, fn) {
    return new Promise((resolve, reject) => fn((error, value) => (error ? reject(error) : resolve(value))));
  }

  /** mkdir -p over SFTP: create each missing segment, verify with stat. */
  async ensureRemoteDir(sftp, dir) {
    if (dir === "/" || dir === "") return;
    try {
      await this.sftpCall(sftp, (cb) => sftp.sftp.mkdir(dir, cb));
      return;
    } catch {
      // Fall through: the directory may already exist, or the parent may be
      // missing — stat decides, recursion creates the parent chain.
    }
    try {
      const attrs = await this.sftpCall(sftp, (cb) => sftp.sftp.stat(dir, cb));
      if ((attrs.mode & 0o170000) === 0o040000) return;
      throw new Error(`${dir} exists and is not a directory`);
    } catch (error) {
      if (/not a directory/.test(error.message)) throw error;
      const { parent } = splitRemotePath(dir);
      await this.ensureRemoteDir(sftp, parent);
      await this.sftpCall(sftp, (cb) => sftp.sftp.mkdir(dir, cb));
    }
  }
};
