/**
 * Local-filesystem boundary for Harbor's agent file tools.
 *
 * Harbor's transfer tools are the only agent-reachable primitives that touch
 * the DSH host's own filesystem: `sftp_upload_*` read a local source and
 * `sftp_download_dir` writes a local destination. DSH's file sandbox governs
 * its own read/write/bash tools, not plugin code, so without this module a
 * prompt-injected model could upload ~/.ssh/id_ed25519 to a server and read it
 * back, or drop a remote-controlled tree into ~/.ssh or a LaunchAgents folder.
 *
 * The rule mirrors DSH's workspace-write policy: a path at or below the
 * session workspace is ordinary work; anything else needs the operator's
 * explicit, single-call approval (see the tool layer).
 *
 * Pure path math plus a realpath-based canonicalizer, so the decision cannot
 * be fooled by a symlink inside the workspace that points elsewhere.
 */
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Resolve an agent-supplied local path to an absolute one.
 *
 * A relative path is anchored at the session workspace (which is what a model
 * means by "the project"), not at the host process's cwd; callers pass the
 * returned absolute spelling to the service so the file that was checked is
 * the file that is read or written.
 *
 * @param {unknown} input - tool argument.
 * @param {string|undefined} workspaceRoot - the session workspace, when known.
 * @returns {string} absolute, normalized local path.
 * @throws on a non-string, empty, or NUL-bearing value.
 */
export function resolveLocalAgentPath(input, workspaceRoot) {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error("local_path must be a non-empty string");
  }
  if (input.includes("\0")) throw new Error("local_path must not contain NUL bytes");
  if (isAbsolute(input)) return resolve(input);
  if (typeof workspaceRoot === "string" && isAbsolute(workspaceRoot)) {
    return resolve(workspaceRoot, input);
  }
  return resolve(input);
}

/**
 * Whether `candidate` is `root` itself or lives below it (lexical, both
 * absolute). Only a leading ".." SEGMENT leaves the root: `relative()` yields
 * "..env" for a sibling named `..env`, and the plain `startsWith("..")` test
 * used to refuse that ordinary file name.
 */
export function isLocalPathInside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Canonicalize a local path without requiring it to exist: realpath the
 * nearest existing ancestor and re-append the missing tail. This is what makes
 * a symlink *inside* the workspace that points outside visible to the check,
 * while still allowing a download destination that has not been created yet.
 *
 * @param {string} input - absolute local path.
 * @returns {Promise<string>} canonical absolute path.
 */
export async function canonicalizeLocalPath(input) {
  const absolute = resolve(String(input));
  const suffix = [];
  let probe = absolute;
  for (;;) {
    try {
      const real = await realpath(probe);
      return suffix.length === 0 ? real : resolve(real, ...suffix.reverse());
    } catch (error) {
      const parent = dirname(probe);
      if (parent === probe) throw error;
      suffix.push(basename(probe));
      probe = parent;
    }
  }
}

/**
 * Guard one local write of a directory download: the destination has to stay
 * at or below the canonical download root.
 *
 * The lexical check alone is not a boundary. The destination tree can already
 * contain a symlink (`downloads/vendor -> ~/.ssh`, which the agent can create
 * with DSH's own bash tool and anything else on the machine can create too),
 * and `mkdir` / `createWriteStream` silently follow it — the reviewer's
 * reproduction wrote a server-controlled file into a directory outside the
 * workspace that way. Canonicalizing the destination resolves the links that
 * exist, so containment is decided against the directory that would actually
 * receive the bytes. The caller that opens the file adds O_NOFOLLOW on top, so
 * a link appearing between this check and the open still cannot be followed.
 *
 * Both sides are compared canonically on purpose: on macOS a plain
 * `/var/...` temp root and its canonical `/private/var/...` spelling are the
 * same directory, and mixing the two in one lexical comparison would reject
 * every legitimate destination.
 *
 * @param {string} root - the download root (any spelling; canonicalized here).
 * @param {string} target - the local destination about to be created.
 * @param {string} [description] - label used in the error message.
 * @returns {Promise<string>} the destination path, unchanged.
 * @throws when the canonical destination leaves the root.
 */
export async function assertLocalWriteTarget(root, target, description = "local path") {
  const candidate = resolve(String(target));
  let base;
  try {
    base = await canonicalizeLocalPath(root);
  } catch (error) {
    throw new Error(`${description}: the download root ${root} cannot be resolved (${error.message})`);
  }
  let canonical;
  try {
    canonical = await canonicalizeLocalPath(candidate);
  } catch (error) {
    throw new Error(`${description} cannot be resolved below ${base}: ${candidate} (${error.message})`);
  }
  if (!isLocalPathInside(base, canonical)) {
    throw new Error(`${description} escapes ${base} through a symbolic link: ${candidate} -> ${canonical}`);
  }
  return candidate;
}

/**
 * Decide whether one agent-supplied local path is inside the session
 * workspace, following symlinks on both sides.
 *
 * @param {string} input - absolute local path (see resolveLocalAgentPath).
 * @param {string|undefined} workspaceRoot - session workspace, or undefined.
 * @returns {Promise<{ absolute: string, canonical: string|null, workspaceCanonical: string|null, inside: boolean }>}
 */
export async function inspectLocalAgentPath(input, workspaceRoot) {
  const absolute = resolve(String(input));
  let canonical = null;
  let workspaceCanonical = null;
  try {
    canonical = await canonicalizeLocalPath(absolute);
    if (typeof workspaceRoot === "string" && workspaceRoot.length > 0 && isAbsolute(workspaceRoot)) {
      workspaceCanonical = await canonicalizeLocalPath(workspaceRoot);
    }
  } catch {
    // A path that cannot be canonicalized (permission, detached mount) is
    // treated as outside: the caller asks the operator instead of guessing.
    return { absolute, canonical, workspaceCanonical, inside: false };
  }
  const inside = canonical !== null && workspaceCanonical !== null
    && isLocalPathInside(workspaceCanonical, canonical);
  return { absolute, canonical, workspaceCanonical, inside };
}
