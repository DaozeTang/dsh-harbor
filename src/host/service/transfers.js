/**
 * Directory batch transfers and resumable upload tasks.
 */
import { constants as fsConstants, createReadStream, createWriteStream } from "node:fs";
import { mkdir as fsMkdir, readdir as fsReaddir, rename as fsRename, stat as fsStat, unlink as fsUnlink } from "node:fs/promises";
import { dirname as dirnamePath, join as joinPath, relative as relativePath } from "node:path";
import { pipeline as streamPipeline } from "node:stream/promises";
import { assertLocalPathInside, assertSafeEntryName, planCaseSafeDownloads, runTransferTasks, joinRemotePath, splitRemotePath } from "../sftp-dir.js";
import { assertLocalWriteTarget, canonicalizeLocalPath } from "../local-path-guard.js";
import { uploadPipeline } from "../sftp-pipeline.js";
import { isOwnSiblingTemp, replaceRemoteFile, siblingTempPath } from "../sftp-write.js";
import { hasInteractiveTerminal, scheduleUploadWrite } from "../ssh-upload-scheduling.js";
import { hashTransferStream, transferConnectionIdentity } from "../transfer-tasks.js";
import { fail } from "../envelope.js";
import { SFTP_DIR_FILE_IDLE_TIMEOUT_MS } from "./constants.js";

/**
 * Open flags for a download destination that must never be a symlink. Built
 * once: O_NOFOLLOW does not exist on every platform/Node build, and a numeric
 * `undefined` inside the mask would silently become a bogus flag set.
 */
const NO_FOLLOW_WRITE_FLAGS = typeof fsConstants.O_NOFOLLOW === "number" && fsConstants.O_NOFOLLOW !== 0
  ? fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW
  : undefined;

/**
 * A unique sibling for a download in progress: same directory, so the commit
 * rename() is atomic and cannot cross a filesystem boundary. The name comes
 * from the shared bounded helper, so a long local file name does not fail
 * with ENAMETOOLONG before the first byte is written.
 */
function downloadPartialPath(localFile) {
  return siblingTempPath(localFile, "dl");
}

/**
 * The remote-relative spelling of one walked local entry.
 *
 * `path.relative` uses the host separator, so the conversion exists for
 * Windows — but it used to run unconditionally, and on POSIX a backslash is an
 * ordinary filename byte. A local file named `a\b.txt` was therefore uploaded
 * as `a/b.txt` and a directory `a` appeared on the server: silent relocation,
 * and asymmetric too, because `assertSafeEntryName` refuses a backslash on the
 * way back down. Only a Windows host needs the translation.
 *
 * @param {string} from - absolute local root.
 * @param {string} to - absolute local entry.
 * @returns {string} the "/"-joined remote-relative path.
 */
function remoteRelative(from, to) {
  const rel = relativePath(from, to);
  return process.platform === "win32" ? rel.split("\\").join("/") : rel;
}

export const withTransfers = (Base) => class extends Base {
  /** Pipe one directory-transfer file with cancellation, an idle deadline, and partial-file cleanup. */
  async pipeSftpFile(source, target, signal, cleanupPartial) {
    const controller = new AbortController();
    let timer;
    const abortFromCaller = () => controller.abort(signal.reason ?? new Error("SFTP directory transfer cancelled"));
    const resetIdleTimer = () => {
      if (controller.signal.aborted) return;
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new Error(`SFTP file transfer made no progress for ${SFTP_DIR_FILE_IDLE_TIMEOUT_MS} ms`)), SFTP_DIR_FILE_IDLE_TIMEOUT_MS);
      timer.unref?.();
    };
    const onProgress = () => resetIdleTimer();
    source.on("data", onProgress);
    signal?.addEventListener("abort", abortFromCaller, { once: true });
    resetIdleTimer();
    if (signal?.aborted) abortFromCaller();
    try {
      await streamPipeline(source, target, { signal: controller.signal });
    } catch (error) {
      source.destroy();
      target.destroy();
      if (controller.signal.aborted) {
        const reason = controller.signal.reason instanceof Error ? controller.signal.reason : error;
        try { await cleanupPartial(); } catch (cleanupError) {
          throw new AggregateError([reason, cleanupError], `SFTP transfer cancelled but partial-file cleanup failed: ${cleanupError.message}`);
        }
        throw reason;
      }
      throw error;
    } finally {
      clearTimeout(timer);
      source.removeListener("data", onProgress);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  /** Remove a temporary remote upload without waiting forever on a dead server. */
  removeSftpPartial(sftp, path) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`cleanup timed out for ${path}`)), 2000);
      timer.unref?.();
      try {
        sftp.sftp.unlink(path, (error) => {
          clearTimeout(timer);
          if (error && error.code !== 2 && error.code !== "ENOENT") reject(error);
          else resolve();
        });
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  /** Upload through a unique sibling file, then commit only a completed transfer. */
  async sftpUploadFile(sftp, localFile, remoteFile, signal, connection) {
    const partial = siblingTempPath(remoteFile, "up");
    try {
      const { size } = await fsStat(localFile);
      if ((size >= 256 * 1024 || hasInteractiveTerminal(connection)) && ["open", "write", "close"].every((method) => typeof sftp.sftp[method] === "function")) {
        await uploadPipeline(sftp.sftp, localFile, partial, {
          signal,
 ...(hasInteractiveTerminal(connection) ? { window: 4 } : {}),
          scheduleWrite: (write) => scheduleUploadWrite(connection, signal, () => this.sftpDeadline(write()))
        });
      } else {
        const source = createReadStream(localFile);
        const target = sftp.sftp.createWriteStream(partial);
        await this.pipeSftpFile(source, target, signal, () => {});
      }
      if (signal?.aborted) throw signal.reason ?? new Error("SFTP directory transfer cancelled");
      // One implementation of "extension first, plain rename as the fallback"
      // lives in sftp-write.js; this path, the resumable task below and the
      // streaming PUT all commit through it.
      await replaceRemoteFile(sftp.sftp, partial, remoteFile);
    } catch (error) {
      // A failed commit or cancellation leaves only our unique sibling file.
      try { await this.removeSftpPartial(sftp, partial); } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `SFTP upload failed and partial-file cleanup failed: ${cleanupError.message}`);
      }
      throw error;
    }
  }

  /** Agent upload: a unique remote partial and a verified in-memory checkpoint. */
  async sftpUploadLocalFile(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const conn = selected.connection;
    const tasks = this.transferTasks;
    try { await tasks.load(); } catch (error) { return { ok: false, error: fail("sftp-transfer-journal", error.message) }; }
    tasks.attach(selected.connectionId ?? conn.id, conn);
    const previous = request.resumeId ? tasks.entries.get(request.resumeId) : null;
    if (request.resumeId && (!previous || previous.connectionId !== conn.id || previous.source !== request.localPath || previous.target !== request.remotePath || previous.status === "running" || previous.status === "done")) {
      return { ok: false, error: fail("sftp-resume-invalid", "Resume task not found, already running, or does not match the source and destination") };
    }
    const task = previous ?? tasks.start({ connectionId: conn.id, identity: transferConnectionIdentity(conn), source: request.localPath, target: request.remotePath, partial: siblingTempPath(request.remotePath, "up"), total: 0, digest: "", checkpoint: 0 });
    if (previous) { task.status = "running"; task.error = ""; task.controller = new AbortController(); tasks.ownedIds.add(task.id); }
    const signal = task.controller.signal;
    const relay = () => task.controller.abort(request.signal?.reason);
    if (request.signal?.aborted) relay();
    else request.signal?.addEventListener("abort", relay, { once: true });
    const initialCheckpoint = task.checkpoint;
    try {
      const stat = await fsStat(task.source);
      if (!stat.isFile()) throw new Error("Source is not a file");
      if (!Number.isSafeInteger(stat.size) || stat.size < 0) throw new Error("Source file size is unsupported");
      if (previous && stat.size !== task.total) throw new Error("Source file size changed; resume refused");
      task.total = stat.size;
      const digest = await hashTransferStream(createReadStream(task.source), signal);
      if (previous && task.digest && digest !== task.digest) throw new Error("Source file changed; resume refused");
      task.digest = digest;
      if (tasks.journalPath && !task.identity) throw new Error("Cannot record the transfer safely without the server identity");
      await tasks.persist();
      if (request.remoteWorkspaceRoot !== undefined) {
        await this.assertRemoteWorkspaceTarget(conn, request.remoteWorkspaceRoot, task.target);
        await this.assertRemoteWorkspaceTarget(conn, request.remoteWorkspaceRoot, task.partial);
      }
      let attempts = 0;
      for (;;) {
        if (signal.aborted) throw signal.reason ?? new Error("Upload cancelled");
        const prepared = await this.requireSftp(conn);
        if (!prepared.ok) throw new Error(prepared.error.message);
        const sftp = prepared.sftp;
        // statvfs is optional and does not require an SSH shell. Unsupported
        // servers keep working; a responsive insufficient-space result fails early.
        if (task.checkpoint === 0 && typeof sftp.ext_openssh_statvfs === "function") {
          let stats;
          let timer;
          try {
            const parent = splitRemotePath(task.target).parent || "/";
            stats = await Promise.race([
              this.sftpCall(prepared, (cb) => sftp.ext_openssh_statvfs(parent, cb)),
              new Promise((resolve) => { timer = setTimeout(resolve, 2000); })
            ]);
          } catch { /* Extension unavailable: let the write report real errors. */ }
          finally { clearTimeout(timer); }
          const available = Number(stats?.f_bavail) * Number(stats?.f_frsize);
          if (Number(stats?.f_frsize) > 0 && Number.isFinite(available) && available < task.total) throw new Error(`Remote disk has ${available} bytes available; ${task.total} required`);
        }
        if (task.checkpoint > 0) {
          const remoteStat = await this.sftpCall(prepared, (cb) => sftp.stat(task.partial, cb));
          if (remoteStat.size < task.checkpoint) throw new Error("Remote partial is shorter than the checkpoint; resume refused");
          const localPrefix = await hashTransferStream(createReadStream(task.source, { start: 0, end: task.checkpoint - 1 }), signal);
          const remotePrefix = await hashTransferStream(sftp.createReadStream(task.partial, { start: 0, end: task.checkpoint - 1 }), signal);
          if (localPrefix !== remotePrefix) throw new Error("Remote partial does not match the source; resume refused");
        }
        try {
          await uploadPipeline(sftp, task.source, task.partial, {
            signal,
            start: task.checkpoint,
 ...(hasInteractiveTerminal(conn) ? { window: 4 } : {}),
            onProgress: (sent) => { task.checkpoint = sent; task.sent = sent; },
            scheduleWrite: (write) => scheduleUploadWrite(conn, signal, () => this.sftpDeadline(write()))
          });
          if (await hashTransferStream(createReadStream(task.source), signal) !== task.digest) throw new Error("Source file changed during upload; commit refused");
          if (await hashTransferStream(sftp.createReadStream(task.partial), signal) !== task.digest) throw new Error("Remote file verification failed; commit refused");
          if (signal.aborted) throw signal.reason ?? new Error("Upload cancelled");
          // Point of no return. The commit is a rename: once it is in flight the
          // remote either has the finished file or it does not, and no local
          // cancel can undo that. Marking it keeps cancel()/discard honest — they
          // used to abort here and report "cancelled" for an upload that landed.
          task.committing = true;
          await this.sftpDeadline(replaceRemoteFile(sftp, task.partial, task.target));
          task.committing = false;
          task.status = "done";
          task.sent = task.total;
          return { ok: true, value: { taskId: task.id, source: task.source, target: task.target, bytes: task.total, resumed: initialCheckpoint > 0 || attempts > 0, startOffset: initialCheckpoint } };
        } catch (error) {
          // Past `committing` the rename is already in flight: re-running the
          // upload cannot undo it, and the partial it would resume from may no
          // longer exist (the rename moved it onto the target).
          if (task.committing || signal.aborted || !conn.dead || attempts >= 3) throw error;
          attempts += 1;
          if (!(await this.ensureAlive(conn))) throw error;
        }
      }
    } catch (error) {
      // A failure after the commit started is not a plain failure: the rename
      // either landed (the target now holds the finished file) or it did not,
      // and nothing local can tell which. Reporting "failed" invited a retry
      // onto a target that may already be correct.
      const commitUnknown = task.committing === true && !signal.aborted;
      task.status = signal.aborted ? "cancelled" : "failed";
      task.error = commitUnknown
        ? `${error.message} (the commit rename may already have completed; check the target before retrying)`
        : error.message;
      if (commitUnknown) return { ok: false, error: fail("sftp-upload-commit-unknown", `${task.error} (task ${task.id})`) };
      return { ok: false, error: fail(signal.aborted ? "sftp-upload-cancelled" : "sftp-upload-failed", `${task.error} (task ${task.id})`) };
    } finally {
      request.signal?.removeEventListener("abort", relay);
      // A failed commit must not leave the task permanently uncancellable.
      task.committing = false;
      tasks.prune();
      try { await tasks.persist(); } catch (error) { try { console.warn("[dsh-harbor] Could not save transfer journal:", error.message); } catch {} }
      tasks.releaseIfIdle();
    }
  }

  async sftpTransferList(request) {
    try {
      await this.transferTasks.load();
      this.transferTasks.attach(request.connectionId, this.connections?.get(request.connectionId));
      return { ok: true, value: { transfers: this.transferTasks.list(request.connectionId) } };
    } catch (error) { return { ok: false, error: fail("sftp-transfer-journal", error.message) }; }
  }

  async sftpTransferDiscard(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    let claimedTask;
    let candidate;
    try {
      await this.transferTasks.load();
      this.transferTasks.attach(selected.connectionId, selected.connection);
      const task = this.transferTasks.entries.get(request.id);
      if (!task || task.connectionId !== selected.connectionId || task.status === "running" || task.status === "done") return { ok: false, error: fail("sftp-transfer-invalid", "Transfer not found, active, or on another server") };
      // Shape, not trust: the journal is a local file, and this path is about
      // to be unlinked. A sibling temporary of THIS target, named by us, is
      // the only thing allowed through.
      if (!isOwnSiblingTemp(task.target, task.partial)) return { ok: false, error: fail("sftp-transfer-invalid", "Refusing to remove an unrecognized partial path") };
      candidate = task;
      task.status = "running";
      this.transferTasks.ownedIds.add(task.id);
      await this.transferTasks.persist();
      claimedTask = task;
      const sftp = await this.sftpDeadline(this.requireSftp(selected.connection));
      if (!sftp.ok) throw new Error(sftp.error.message);
      await this.removeSftpPartial(sftp, task.partial);
      this.transferTasks.removedIds.add(task.id);
      this.transferTasks.ownedIds.delete(task.id);
      await this.transferTasks.persist();
      this.transferTasks.entries.delete(task.id);
      return { ok: true, value: { discarded: true } };
    } catch (error) {
      if (claimedTask) {
        claimedTask.status = "failed";
        this.transferTasks.removedIds.delete(claimedTask.id);
        this.transferTasks.ownedIds.add(claimedTask.id);
        try { await this.transferTasks.persist(); } catch {}
      } else if (candidate) {
        candidate.status = "failed";
        this.transferTasks.ownedIds.delete(candidate.id);
      }
      return { ok: false, error: fail("sftp-transfer-discard-failed", error.message) };
    }
  }

  sftpTransferCancel(request) {
    return { ok: true, value: { cancelled: this.transferTasks.cancel(request.id, request.connectionId) } };
  }

  /**
   * Download one remote SFTP file beside its destination, then commit it.
   *
   * The bytes go to a unique sibling and only a COMPLETED transfer replaces
   * `localFile`. Writing straight into the destination truncated whatever was
   * already there before the first new byte arrived, and the cancellation
   * cleanup then unlinked it — so cancelling a tree download (or a mid-transfer
   * I/O error, which is not an abort and ran no cleanup at all) destroyed the
   * operator's previous copy and produced no replacement.
   *
   * The temporary is opened with O_NOFOLLOW where the platform has it; the
   * rename is what makes the destination safe, since it replaces a symlink
   * sitting at `localFile` instead of writing through it.
   */
  async sftpDownloadFile(sftp, remoteFile, localFile, signal) {
    const partial = downloadPartialPath(localFile);
    const source = sftp.sftp.createReadStream(remoteFile);
    const target = NO_FOLLOW_WRITE_FLAGS !== undefined
      ? createWriteStream(partial, { flags: NO_FOLLOW_WRITE_FLAGS })
      : createWriteStream(partial);
    const removePartial = async () => {
      try { await fsUnlink(partial); } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    };
    try {
      // pipeSftpFile owns cancellation and the idle deadline; its cleanup hook
      // removes OUR temporary, never the destination.
      await this.pipeSftpFile(source, target, signal, removePartial);
      // Commit point: the destination keeps its previous content until here.
      await fsRename(partial, localFile);
    } catch (error) {
      source.destroy();
      // Cancellation already cleaned up inside pipeSftpFile; a plain I/O
      // failure does not, so remove the temporary in both cases.
      try { await removePartial(); } catch {}
      throw error;
    }
  }

  /**
   * Recursively list a remote directory; returns [{ rel, path, size, isDirectory }].
   *
   * `entry.filename` and `entry.attrs` are server-controlled. The name must be
   * a plain leaf before it reaches either the remote path join or the host-side
   * relative-path computation: a name containing ".." or a backslash would
   * otherwise become a local path traversal in `sftpDownloadDir`.
   */
  async walkRemoteDir(sftp, root, base = root, out = []) {
    const entries = await this.sftpCall(sftp, (cb) => sftp.sftp.readdir(root, cb));
    for (const entry of entries) {
      const name = assertSafeEntryName(entry.filename);
      const path = joinRemotePath(root, name);
      const rel = relativePath(base, path).split("\\").join("/");
      if (rel === ".." || rel.startsWith("../") || rel.startsWith("/")) {
        throw new Error(`SFTP entry escapes the download root: ${JSON.stringify(name)}`);
      }
      const kind = entry.attrs.mode & 0o170000;
      const isDirectory = kind === 0o040000;
      const isSymlink = kind === 0o120000;
      if (isDirectory) {
        out.push({ rel, path, size: 0, isDirectory: true });
        await this.walkRemoteDir(sftp, path, base, out);
      } else {
        // A symlink is recorded but never followed: sftpDownloadFile opens the
        // target, which may live outside the picked root (e.g. vendor -> /etc).
        // The downloader reports it as skipped, matching the upload walker's
        // explicit "symbolic links are not uploaded" rule.
        out.push({ rel, path, size: entry.attrs.size ?? 0, isDirectory: false, ...(isSymlink ? { symlink: true } : {}) });
      }
    }
    return out;
  }

  /**
   * Upload a local directory tree over SFTP. Small files transfer in a
   * bounded pool; large files one at a time; per-file failures are reported
   * in the result instead of aborting the batch.
   */
  async sftpUploadDir(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const sftp = await this.requireSftp(selected.connection);
    if (!sftp.ok) return sftp;
    const { localPath, remotePath } = request;
    try {
      const rootStat = await fsStat(localPath);
      if (!rootStat.isDirectory()) {
        return { ok: false, error: fail("sftp-upload-dir-failed", `${localPath} is not a directory`) };
      }
      const entries = [];
      // Directories are recorded too (including empty ones): an empty local
      // folder must still appear remotely, and the count is user-visible.
      const localDirs = new Set();
      const skipped = [];
      const walk = async (dir) => {
        for (const entry of await fsReaddir(dir, { withFileTypes: true })) {
          const full = joinPath(dir, entry.filename ?? entry.name);
          const rel = remoteRelative(localPath, full);
          if (entry.isDirectory()) {
            localDirs.add(rel);
            await walk(full);
          } else if (entry.isFile()) {
            const { size } = await fsStat(full);
            entries.push({ full, size });
          } else if (entry.isSymbolicLink()) {
            // Following links would silently duplicate trees or escape the
            // upload root; report them instead of dropping them silently.
            skipped.push({ path: rel, error: "symbolic links are not uploaded" });
          } else {
            skipped.push({ path: rel, error: "not a regular file or directory" });
          }
        }
      };
      await walk(localPath);
      const tasks = entries.map(({ full, size }) => {
        const rel = remoteRelative(localPath, full);
        const destination = joinRemotePath(remotePath, rel);
        return {
          path: rel,
          size,
          run: (signal) => this.sftpUploadFile(sftp, full, destination, signal, selected.connection)
        };
      });
      // Every directory of the tree plus every ancestor of every file,
      // deduplicated, created shallow first so each mkdir sees its parent
      // already in place.
      const remoteDirs = new Set(localDirs);
      for (const task of tasks) {
        // task.path is already the remote spelling, so posix dirname is the
        // only separator handling left to do here.
        let dir = dirnamePath(task.path);
        while (dir !== "." && dir !== "/" && dir !== "") {
          remoteDirs.add(dir);
          dir = dirnamePath(dir);
        }
      }
      const sortedDirs = [...remoteDirs].sort((a, b) => a.length - b.length);
      if (request.remoteWorkspaceRoot !== undefined) {
        // Validate every destination before the first mkdir/write. Checking
        // only the selected root misses a pre-existing remote symlink such as
        // `root/vendor -> /etc`, which could redirect a nested upload outside
        // the binding. Individual transfer steps can still fail later, but an
        // unsafe tree never starts transferring.
        await this.assertRemoteWorkspaceTarget(selected.connection, request.remoteWorkspaceRoot, remotePath);
        for (const dir of sortedDirs) {
          await this.assertRemoteWorkspaceTarget(
            selected.connection,
            request.remoteWorkspaceRoot,
            joinRemotePath(remotePath, dir)
 );
        }
        for (const task of tasks) {
          await this.assertRemoteWorkspaceTarget(
            selected.connection,
            request.remoteWorkspaceRoot,
            joinRemotePath(remotePath, task.path)
 );
        }
      }
      // Deliberately two-phase from here on: everything above proves the whole
      // tree is safe before the first mkdir, and the per-directory / per-file
      // checks below re-run right before each mutation because a remote path can
      // be swapped for a symlink between the two phases. Do not "dedupe" one of
      // the phases away — they answer different questions.
      await this.ensureRemoteDir(sftp, remotePath);
      for (const dir of sortedDirs) {
        const destination = joinRemotePath(remotePath, dir);
        if (request.remoteWorkspaceRoot !== undefined) {
          await this.assertRemoteWorkspaceTarget(selected.connection, request.remoteWorkspaceRoot, destination);
        }
        await this.ensureRemoteDir(sftp, destination);
      }
      if (request.remoteWorkspaceRoot !== undefined) {
        for (const task of tasks) {
          const destination = joinRemotePath(remotePath, task.path);
          const originalRun = task.run;
          task.run = async (signal) => {
            await this.assertRemoteWorkspaceTarget(selected.connection, request.remoteWorkspaceRoot, destination);
            await originalRun(signal);
          };
        }
      }
      const { files, bytes, failures } = await runTransferTasks(tasks, { signal: request.signal });
      return {
        ok: true,
        value: {
          source: localPath,
          target: remotePath,
          directories: remoteDirs.size + 1,
          files,
          bytes,
          failed: [...skipped, ...failures]
        }
      };
    } catch (error) {
      return { ok: false, error: fail("sftp-upload-dir-failed", `${localPath} -> ${remotePath}: ${error.message}`) };
    }
  }

  /**
   * Download a remote directory tree over SFTP with the same scheduling
   * policy as sftpUploadDir.
   */
  async sftpDownloadDir(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const sftp = await this.requireSftp(selected.connection);
    if (!sftp.ok) return sftp;
    const { remotePath, localPath } = request;
    try {
      const rootAttrs = await this.sftpCall(sftp, (cb) => sftp.sftp.stat(remotePath, cb));
      if ((rootAttrs.mode & 0o170000) !== 0o040000) {
        return { ok: false, error: fail("sftp-download-dir-failed", `${remotePath} is not a directory`) };
      }
      await fsMkdir(localPath, { recursive: true });
      // One canonical root for the whole batch. The lexical checks below still
      // prove the RELATIVE name cannot change directory level; this resolves
      // what already exists on disk, so a symlink inside the destination tree
      // (planted by the agent's own bash tool, by an earlier tree, or by
      // anything else on the machine) cannot receive the bytes instead of the
      // directory the operator approved.
      const rootCanonical = await canonicalizeLocalPath(localPath);
      const entries = await this.walkRemoteDir(sftp, remotePath);
      // Case is decided before the first write: on a case-insensitive local
      // filesystem two remote names can share one destination, and two
      // concurrent transfers would each truncate the other's file.
      const plan = planCaseSafeDownloads(entries);
      const directories = plan.directories.length;
      const skipped = entries
        .filter((entry) => entry.symlink === true)
        .map((entry) => ({ path: entry.rel, error: "symbolic links are not followed" }));
      for (const dir of plan.directories) {
        // assertSafeEntryName already rejected server-controlled traversal;
        // this is the invariant every actual filesystem write is checked
        // against, so a future walker change cannot silently reopen it.
        const local = assertLocalPathInside(localPath, joinPath(localPath, dir.rel), "download directory");
        await assertLocalWriteTarget(rootCanonical, local, "download directory");
        await fsMkdir(local, { recursive: true });
      }
      const tasks = plan.files.map((entry) => ({
        path: entry.rel,
        size: entry.size,
        run: async (signal) => {
          const local = assertLocalPathInside(localPath, joinPath(localPath, entry.rel), "download file");
          // Checked per file, not once per tree: a link may appear between the
          // walk and this write. O_NOFOLLOW then covers the last window
          // between this check and the open.
          await assertLocalWriteTarget(rootCanonical, local, "download file");
          await fsMkdir(dirnamePath(local), { recursive: true });
          await this.sftpDownloadFile(sftp, entry.path, local, signal);
          // The commit rename succeeds even when the stream ended early, so a
          // short file would otherwise be reported as a finished download. The
          // walk's size is the only budget we have; a file that GREW while it
          // was being read is normal (logs), a smaller one lost bytes.
          const written = await fsStat(local);
          if (written.size < entry.size) {
            try { await fsUnlink(local); } catch {}
            throw new Error(`incomplete download: the server listed ${entry.size} bytes but ${written.size} were written`);
          }
        }
      }));
      const { files, bytes, failures } = await runTransferTasks(tasks, { signal: request.signal });
      return {
        ok: true,
        value: { source: remotePath, target: localPath, directories: directories + 1, files, bytes, failed: [...skipped, ...plan.blocked, ...failures] }
      };
    } catch (error) {
      return { ok: false, error: fail("sftp-download-dir-failed", `${remotePath} -> ${localPath}: ${error.message}`) };
    }
  }
};
