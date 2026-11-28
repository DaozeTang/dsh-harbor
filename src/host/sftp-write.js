/**
 * Atomic remote file replacement.
 *
 * A write that goes straight to its target truncates it before the first
 * byte lands: a dropped link, a full disk or a killed process then leaves a
 * file that is neither the old content nor the new one — and the editor's
 * compare-and-swap refuses the next save precisely because the file no longer
 * matches what it opened. Writing a sibling temporary file and renaming it
 * over the target is the same shape the streamed upload path already uses;
 * this module exists so the two small write paths share one implementation.
 */
import { randomUUID } from "node:crypto";

function call(sftp, method, ...args) {
  return new Promise((resolve, reject) => {
    try {
      sftp[method](...args, (error, value) => (error ? reject(error) : resolve(value)));
    } catch (error) { reject(error); }
  });
}

/** Longest single path component the usual POSIX filesystems accept. */
const NAME_MAX = 255;

/**
 * Shorten `text` to at most `maxBytes` UTF-8 bytes, never through a
 * character: truncating a multi-byte name produced a path the server could
 * not open (EILSEQ/ENAMETOOLONG) instead of the short name we meant.
 */
function truncateUtf8(text, maxBytes) {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let cut = text;
  while (cut.length > 1 && Buffer.byteLength(cut) > maxBytes) cut = cut.slice(0, -1);
  return cut;
}

/**
 * A temporary path beside `path`: a rename is only atomic inside one
 * filesystem, so the temporary must live in the target's own directory.
 *
 * The suffix is deliberately short (`.~<tag><10 hex>.tmp`) and the base name
 * absorbs the rest of the 255-byte budget. The old
 * `${path}.dsh-write-<uuid>.tmp` added 51 bytes to the component, so a base
 * name over ~203 bytes failed with ENAMETOOLONG — and a retry failed the same
 * way. `tag` lets a temporary be attributed to the caller that made it.
 */
export function siblingTempPath(path, tag = "dsh") {
  const slash = path.lastIndexOf("/");
  const dir = slash < 0 ? "" : path.slice(0, slash + 1);
  const base = slash < 0 ? path : path.slice(slash + 1);
  const suffix = `.~${tag}${randomUUID().replace(/-/g, "").slice(0, 10)}.tmp`;
  return `${dir}${truncateUtf8(base, NAME_MAX - Buffer.byteLength(suffix))}${suffix}`;
}

/**
 * Whether `path` is a temporary this host created beside `target`.
 *
 * The transfer journal is a local file, and `sftpTransferDiscard` unlinks what
 * it names: a partial must be recognised by SHAPE (same directory, our
 * suffix, a base name that is a prefix of the target) rather than trusted as
 * a path to delete. The legacy `.dsh-upload-<uuid>.tmp` shape is still
 * recognised so a journal written by an older version can be discarded.
 */
export function isOwnSiblingTemp(target, path) {
  if (typeof target !== "string" || typeof path !== "string") return false;
  if (target === "" || path === "") return false;
  const slash = target.lastIndexOf("/");
  const dir = slash < 0 ? "" : target.slice(0, slash + 1);
  const targetName = target.slice(slash + 1);
  if (targetName === "" || !path.startsWith(dir)) return false;
  const name = path.slice(dir.length);
  if (name === targetName) return false;
  const legacy = `${targetName}.dsh-upload-`;
  if (name.startsWith(legacy)) return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i.test(name.slice(legacy.length));
  const own = /^(.*)\.~(?:dsh|up|dl)[0-9a-f]{10}\.tmp$/i.exec(name);
  return own !== null && own[1] !== "" && targetName.startsWith(own[1]);
}

/** Best-effort removal, for cleanup after a failed write. */
export async function removeRemoteQuietly(sftp, path) {
  await call(sftp, "unlink", path).catch(() => {});
}

/**
 * Rename a finished temporary file over its target.
 *
 * SFTP version 3 RENAME refuses an existing target. OpenSSH's POSIX extension
 * replaces it, so the extension goes first and plain rename — the only option
 * on a server without the extension — stays as the fallback, exactly in the
 * order the streamed upload uses. A rename that fails for any other reason
 * leaves the target untouched; the caller then drops the temporary file.
 */
export async function replaceRemoteFile(sftp, tempPath, path) {
  if (typeof sftp.ext_openssh_rename === "function") {
    try {
      await call(sftp, "ext_openssh_rename", tempPath, path);
      return;
    } catch (error) {
      if (error?.message !== "Server does not support this extended request") throw error;
    }
  }
  await call(sftp, "rename", tempPath, path);
}

/**
 * The path a replacement must land on.
 *
 * Renaming over a symlink would replace the link with a regular file: the
 * editor reads through the link and nothing in the UI says it is a link, so a
 * saved dotfile config would silently stop pointing at the file it manages.
 * The temporary file is therefore created beside the link's target and renamed
 * over that.
 */
async function resolvedTarget(sftp, path) {
  try {
    const attrs = await call(sftp, "lstat", path);
    if ((attrs?.mode & 0o170000) !== 0o120000) return path;
    const resolved = await call(sftp, "realpath", path);
    if (typeof resolved === "string" && resolved !== "") return resolved;
  } catch {
    // No lstat/realpath on the server, or the path does not exist yet.
  }
  return path;
}

/** The permission bits of an existing target, so a replacement keeps them. */
async function existingMode(sftp, path) {
  try {
    const attrs = await call(sftp, "stat", path);
    return typeof attrs?.mode === "number" ? attrs.mode & 0o7777 : null;
  } catch {
    return null;
  }
}

/**
 * Write all bytes to a stream, rejecting on abort, timeout or stream error.
 *
 * The old caller raced the whole write against a 30-second timer and returned
 * "failed" while the stream (and its rename) could still complete. Destroying
 * the stream is what makes the timeout and the tool's abort real.
 */
function writeAll(stream, bytes, { signal, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      if (error !== undefined) {
        try { stream.destroy(); } catch {}
        reject(error);
      } else {
        resolve();
      }
    };
    const onAbort = () => finish(signal.reason instanceof Error ? signal.reason : new Error("Remote write cancelled"));
    stream.once("error", (error) => finish(error));
    stream.once("close", () => finish());
    if (signal !== undefined) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => finish(new Error(`Remote write did not finish within ${timeoutMs} ms`)), timeoutMs);
      timer.unref?.();
    }
    try { stream.end(bytes); } catch (error) { finish(error); }
  });
}

/**
 * Replace one remote file with `bytes`, atomically.
 * @param {object} sftp - opened sftp2 session.
 * @param {string} path - remote path to replace (created when missing).
 * @param {Buffer} bytes - complete new content.
 * @param {{signal?: AbortSignal, timeoutMs?: number}} [options] - cancellation and write budget.
 * @returns {Promise<void>} resolves once the target holds the new content.
 */
export async function writeRemoteFileAtomic(sftp, path, bytes, options = {}) {
  const { signal, timeoutMs } = options;
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Remote write cancelled");
  const target = await resolvedTarget(sftp, path);
  const temp = siblingTempPath(target, "dsh");
  // A new file is created with 0666 & ~umask. Writing in place used to keep
  // the target's mode, so an executable script must not quietly lose its +x.
  const mode = await existingMode(sftp, target);
  let stream;
  try {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Remote write cancelled");
    stream = sftp.createWriteStream(temp);
    await writeAll(stream, bytes, { signal, timeoutMs });
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Remote write cancelled");
    // The commit is deliberately outside the transfer budget: once every byte
    // is on the server, a slow rename must not be reported as a failed write
    // that actually replaced the file.
    if (mode !== null) await call(sftp, "chmod", temp, mode).catch(() => {});
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Remote write cancelled");
    await replaceRemoteFile(sftp, temp, target);
  } catch (error) {
    try { stream?.destroy(); } catch {}
    await removeRemoteQuietly(sftp, temp);
    throw error;
  }
}