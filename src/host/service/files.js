/**
 * SFTP/SCP file operations and single-file transfer primitives.
 */
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { joinRemotePath, splitRemotePath } from "../sftp-dir.js";
import { scpCommand, scpDownload, scpUpload } from "../scp.js";
import { saveEditorFile } from "../sftp-editor-save.js";
import { fail } from "../envelope.js";
import { MAX_FILE_READ_BYTES, MAX_COMMAND_OUTPUT_BYTES } from "./constants.js";
import { tailCapped } from "./text.js";

export const withFiles = (Base) => class extends Base {
  // ── SFTP (file management) ─────────────────────────────────────────────────

  /** Lazily open (or reuse) the sftp subsystem of a connection. */
  async requireSftp(connection, retried = false) {
    if (connection.sftp !== null) return { ok: true, sftp: connection.sftp };
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
      connection.sftp = sftp;
      return { ok: true, sftp };
    } catch (error) {
      if (!retried && connection.dead && (await this.ensureAlive(connection))) {
        return this.requireSftp(connection, true);
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
      const entries = await new Promise((resolve, reject) => {
        sftp.sftp.readdir(remotePath, (error, list) => {
          if (error) reject(error);
          else resolve(list);
        });
      });
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
            const attrs = await new Promise((resolve, reject) => {
              sftp.sftp.stat(entryPath, (error, value) => (error ? reject(error) : resolve(value)));
            });
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
      const attrs = await new Promise((resolve, reject) => {
        sftp.sftp.stat(request.path, (error, a) => {
          if (error) reject(error);
          else resolve(a);
        });
      });
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
    const maxBytes = request.maxBytes ?? MAX_FILE_READ_BYTES;
    const chunks = [];
    let total = 0;
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
          const remaining = maxBytes - total;
          if (remaining > 0) {
            chunks.push(chunk.length <= remaining ? chunk : chunk.subarray(0, remaining));
          }
          total += chunk.length;
          if (total >= maxBytes) finish();
        });
        stream.on("end", finish);
        stream.on("error", (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        });
      });
      await done;
      const truncated = total > maxBytes;
      const data = Buffer.concat(chunks).toString("base64");
      return { ok: true, value: { path: request.path, data, truncated, bytes: total } };
    } catch (error) {
      return { ok: false, error: fail("sftp-read-failed", `${request.path}: ${error.message}`) };
    }
  }

  /** Write base64 content to a remote file. */
  async sftpWriteFile(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const sftp = await this.requireSftp(selected.connection);
    if (!sftp.ok) return sftp;
    try {
      const buf = Buffer.from(request.data, "base64");
      await new Promise((resolve, reject) => {
        const stream = sftp.sftp.createWriteStream(request.path);
        stream.on("close", resolve);
        stream.on("error", reject);
        stream.end(buf);
      });
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
      const value = await saveEditorFile(sftp.sftp, request.path, Buffer.from(request.expected, "base64"), Buffer.from(request.data, "base64"));
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
    const maxBytes = request.maxBytes ?? MAX_FILE_READ_BYTES;
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
    }
  }

  /** Upload one file through SCP when the SSH server has no SFTP subsystem. */
  async scpWriteFile(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    let stream;
    try {
      const data = Buffer.from(request.data, "base64");
      stream = await this.openScpChannel(selected.connection, scpCommand("t", request.path));
      const result = await scpUpload(stream, request.path, data);
      return { ok: true, value: { path: request.path, bytes: result.bytes } };
    } catch (error) {
      return { ok: false, error: fail("scp-write-failed", `${request.path}: ${stream?.scpStderr?.trim() || error.message}`) };
    }
  }

  /** Create a remote directory (mkdir -p semantics via mkdir + stat). */
  async sftpMkdir(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const sftp = await this.requireSftp(selected.connection);
    if (!sftp.ok) return sftp;
    try {
      await new Promise((resolve, reject) => {
        sftp.sftp.mkdir(request.path, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
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
      const isDir = await new Promise((resolve, reject) => {
        sftp.sftp.stat(request.path, (error, attrs) => {
          if (error) reject(error);
          else resolve((attrs.mode & 0o170000) === 0o040000);
        });
      });
      await new Promise((resolve, reject) => {
        const fn = isDir ? sftp.sftp.rmdir : sftp.sftp.unlink;
        fn.call(sftp.sftp, request.path, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
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
      await new Promise((resolve, reject) => {
        sftp.sftp.rename(request.from, request.to, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      return { ok: true, value: { from: request.from, to: request.to } };
    } catch (error) {
      return { ok: false, error: fail("sftp-rename-failed", `${request.from} -> ${request.to}: ${error.message}`) };
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
