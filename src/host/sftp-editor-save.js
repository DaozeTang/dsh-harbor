/**
 * Remote editor saves.
 *
 * SFTP has no atomic compare-and-swap, so a save is bracketed by two reads:
 * the first proves the file still matches what the editor opened, the second
 * proves it did not change while we were checking. A mismatch aborts before
 * the remote file is replaced. The replacement itself goes to a sibling
 * temporary file that is renamed over the target: an interrupted write must not
 * leave a truncated file, because the next save would then fail the check above
 * and the operator's buffer could never be written back. No backup copy is
 * written — version history is the operator's own concern (Git, snapshots,
 * etc.), and a save leaves exactly the same directory contents it found.
 */
import { writeRemoteFileAtomic } from "./sftp-write.js";

const LIMIT = 10 * 1024 * 1024;

async function readBounded(sftp, path, { signal, timeoutMs } = {}) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Editor read cancelled");
  const stream = sftp.createReadStream(path);
  const chunks = [];
  let size = 0;
  let timer;
  const onAbort = () => {
    try { stream.destroy(signal.reason instanceof Error ? signal.reason : new Error("Editor read cancelled")); } catch {}
  };
  if (signal !== undefined) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      try { stream.destroy(new Error(`Remote read did not finish within ${timeoutMs} ms`)); } catch {}
    }, timeoutMs);
    timer.unref?.();
  }
  try {
    for await (const chunk of stream) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Editor read cancelled");
      size += chunk.length;
      if (size > LIMIT) { stream.destroy(); throw new Error("Remote file exceeds the editor size limit"); }
      chunks.push(chunk);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener?.("abort", onAbort);
  }
  return Buffer.concat(chunks);
}

/**
 * Save one editor buffer over its remote file.
 * @param {object} sftp - opened sftp2 session.
 * @param {string} path - remote path being saved.
 * @param {Buffer} expected - bytes the editor opened.
 * @param {Buffer} replacement - bytes to write.
 * @param {{signal?: AbortSignal, timeoutMs?: number}} [options] - cancellation and per-phase budget.
 * @returns {Promise<{bytes: number}>} written byte count.
 */
export async function saveEditorFile(sftp, path, expected, replacement, options = {}) {
  const { signal } = options;
  if (expected.length > LIMIT || replacement.length > LIMIT) throw new Error("File exceeds the editor size limit");
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Editor save cancelled");
  const current = await readBounded(sftp, path, options);
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Editor save cancelled");
  if (!current.equals(expected)) throw new Error("Remote file changed since it was opened; reload before saving");
  const again = await readBounded(sftp, path, options);
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Editor save cancelled");
  if (!again.equals(current)) throw new Error("Remote file changed during save; reload before saving");
  await writeRemoteFileAtomic(sftp, path, replacement, options);
  return { bytes: replacement.length };
}
