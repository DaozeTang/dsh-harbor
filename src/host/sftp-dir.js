/**
 * Directory transfer scheduling for dsh-harbor SFTP batch upload/download.
 *
 * The unit of work is a `{ path, size, run }` task descriptor; this module
 * owns nothing but the scheduling policy:
 *
 *  - small files (<= SFTP_DIR_BIG_FILE_BYTES) run in a bounded worker pool
 *    (SFTP_DIR_SMALL_CONCURRENCY) — directory trees of tiny files are latency-
 *    bound, so parallelism dominates;
 *  - big files run one at a time — each gets the full link budget instead of
 *    six partial streams fighting for it;
 *  - counters advance monotonically (single-threaded JS is the atomicity
 *    boundary), so a caller rendering progress can never observe a torn value;
 *  - per-file failures are collected, never fatal — a batch reports what
 *    transferred and what did not.
 *
 * Pure with respect to I/O: `run` does the actual transfer, everything here
 * is unit-testable with fake tasks.
 */
import { resolve } from "node:path";
import { isLocalPathInside } from "./local-path-guard.js";

/** Max in-flight small-file transfers. */
export const SFTP_DIR_SMALL_CONCURRENCY = 6;
/** Files larger than this take the exclusive lane. */
const SFTP_DIR_BIG_FILE_BYTES = 512 * 1024;

/**
 * Run transfer tasks under the scheduling policy. Returns
 * `{ files, bytes, failures }` where `failures` is `[{ path, error }]`.
 */
export async function runTransferTasks(tasks, {
  smallConcurrency = SFTP_DIR_SMALL_CONCURRENCY,
  bigFileBytes = SFTP_DIR_BIG_FILE_BYTES,
  signal
} = {}) {
  const small = [];
  const big = [];
  let files = 0;
  let bytes = 0;
  const failures = [];
  const throwIfAborted = () => {
    if (!signal?.aborted) return;
    const error = signal.reason instanceof Error ? signal.reason : new Error("SFTP directory transfer cancelled");
    if (!(signal.reason instanceof Error)) error.name = "AbortError";
    throw error;
  };
  const runOne = async (task) => {
    throwIfAborted();
    try {
      await task.run(signal);
      files += 1;
      bytes += task.size;
    } catch (error) {
      failures.push({ path: task.path, error: error?.message ?? String(error) });
    }
  };

  for (const task of tasks) {
    if (task.size > bigFileBytes) big.push(task);
    else small.push(task);
  }

  // Exclusive lane for big files: strictly one in flight.
  const bigLane = (async () => {
    for (const task of big) await runOne(task);
  })();

  // Bounded pool for small files.
  const smallLane = (async () => {
    let index = 0;
    const workerCount = Math.max(1, Math.min(smallConcurrency, small.length));
    const workers = Array.from({ length: workerCount }, async () => {
      for (;;) {
        const current = index;
        index += 1;
        if (current >= small.length) return;
        await runOne(small[current]);
      }
    });
    await Promise.all(workers);
  })();

  const laneResults = await Promise.allSettled([bigLane, smallLane]);
  const rejectedLane = laneResults.find((result) => result.status === "rejected");
  if (rejectedLane !== undefined) throw rejectedLane.reason;
  throwIfAborted();
  return { files, bytes, failures };
}

/**
 * A single `readdir` record is server-controlled. A name that can change
 * directory level is not a plain file name: `/` is a separator on the remote,
 * and `\\` becomes one again after the host-side relative-path normalisation.
 * Any such name would let a compromised or buggy SFTP server write outside the
 * operator's chosen download directory, so downloads refuse the whole tree
 * instead of silently skipping (a skipped entry hides the attack).
 *
 * @param {unknown} name - `entry.filename` from SFTP readdir.
 * @returns {string} the same name when it is a plain leaf.
 * @throws when the name is empty, a dot entry, contains a separator or a control byte.
 */
export function assertSafeEntryName(name) {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("SFTP entry has an empty name");
  }
  if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new Error(`SFTP entry name is not a plain file name: ${JSON.stringify(name)}`);
  }
  if (/[\x00-\x1f\x7f]/.test(name)) {
    throw new Error(`SFTP entry name contains a control character: ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * The local destination of a download must stay at or below the directory the
 * operator picked. `assertSafeEntryName` already blocks server-controlled
 * traversal, but this check is the invariant the filesystem write itself relies
 * on — a future caller that forgets the name check still cannot escape.
 *
 * @param {string} root - the operator-selected local directory.
 * @param {string} target - the local path about to be created.
 * @param {string} [description] - label used in the error.
 * @returns {string} the resolved target path.
 * @throws when `target` is outside `root`.
 */
export function assertLocalPathInside(root, target, description = "local path") {
  const base = resolve(String(root));
  const candidate = resolve(String(target));
  // The containment math has exactly one implementation (local-path-guard.js);
  // this is only the throwing wrapper the transfer paths use.
  if (isLocalPathInside(base, candidate)) return candidate;
  throw new Error(`${description} escapes ${base}: ${candidate}`);
}

/**
 * Posix path join for remote SFTP paths (no Windows semantics).
 *
 * An empty base used to mean "/", so a request with no `remote_path` (or an
 * empty one) quietly re-rooted a whole tree at the remote filesystem root —
 * next to /etc instead of in the operator's home directory. An empty base is
 * not a synonym for either: every caller knows which directory it means, and
 * a caller that does not must fail instead of writing to the filesystem root.
 *
 * @param {string} base - normalized absolute remote directory.
 * @param {string} name - one entry name or a "/"-joined relative path.
 * @returns {string} the joined absolute remote path.
 * @throws when the base is not a non-empty string.
 */
export function joinRemotePath(base, name) {
  if (typeof base !== "string" || base.trim() === "") {
    throw new Error("remote path must not be empty");
  }
  if (base === "/") return `/${name}`;
  return `${base.replace(/\/+$/, "")}/${name}`;
}

/** Local filesystems that fold case: macOS (APFS/HFS+) and Windows. */
export const CASE_INSENSITIVE_LOCAL_FS = process.platform === "darwin" || process.platform === "win32";

/**
 * Decide which entries of one download tree can be written, BEFORE any bytes
 * move.
 *
 * On a case-insensitive local filesystem `A.txt` and `a.txt` are one file. Both
 * transfers used to run in the small-file pool, both opened (and truncated) the
 * same path, and the batch still reported `files: 2` while a single file
 * existed: one remote file's content was silently lost and the count was a lie.
 * The remote side is POSIX, where both names are legal, so the loss cannot be
 * avoided — reporting it is what makes the download honest.
 *
 * @param {{rel: string, isDirectory: boolean, symlink?: boolean}[]} entries - walker output.
 * @param {{caseInsensitive?: boolean}} [options] - local filesystem behaviour.
 * @returns {{directories: object[], files: object[], blocked: {path: string, error: string}[]}}
 */
export function planCaseSafeDownloads(entries, options = {}) {
  const caseInsensitive = options.caseInsensitive ?? CASE_INSENSITIVE_LOCAL_FS;
  const directories = [];
  const files = [];
  const blocked = [];
  const claimed = new Map();
  for (const entry of entries) {
    if (entry.isDirectory === true) {
      directories.push(entry);
      continue;
    }
    if (entry.symlink === true) continue;
    if (caseInsensitive) {
      const key = String(entry.rel).toLowerCase();
      const first = claimed.get(key);
      if (first !== undefined) {
        blocked.push({
          path: entry.rel,
          error: `the local filesystem ignores letter case, so ${JSON.stringify(entry.rel)} would overwrite ${JSON.stringify(first)}; download it separately`
        });
        continue;
      }
      claimed.set(key, entry.rel);
    }
    files.push(entry);
  }
  return { directories, files, blocked };
}

/** Parent directory and final segment of a posix path. */
export function splitRemotePath(path) {
  const normalized = path.replace(/\/+$/, "") || "/";
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return { parent: "/", name: normalized.slice(index + 1) };
  return { parent: normalized.slice(0, index), name: normalized.slice(index + 1) };
}
