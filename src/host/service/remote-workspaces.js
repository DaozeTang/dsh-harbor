/**
 * Remote workspace bindings.
 */
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { findReusableProfileConnection } from "../profile-connection.js";
import { normalizeOwner, pickOwnerSession } from "../terminal-owner.js";
import { AUTO_CONNECT_DISABLED_MESSAGE } from "../agent-connect.js";
import { RemoteWorkspacePathError, remoteWorkspacePromptText, normalizeRemoteRoot, resolveRemotePath, isRemotePathInside, workspaceRelativePart, assertNoControlCharacters, REMOTE_WORKSPACE_OFFLINE, REMOTE_WORKSPACE_OUTSIDE } from "../remote-workspace.js";
import { fail } from "../envelope.js";
import { t } from "../../i18n/core.js";

export const withRemoteWorkspaces = (Base) => class extends Base {
  // ── Remote workspaces ──────────────────────────────────────────

  /**
   * The binding that governs one host directory, deepest workspace wins.
   * @param {string|undefined} directory - canonical host path.
   * @returns {{record: object, relative: string}|undefined} binding, if any.
   */
  remoteBindingFor(directory) {
    if (this.remoteWorkspaces === null || typeof directory !== "string") return undefined;
    try {
      return this.remoteWorkspaces.findForPath(directory);
    } catch {
      return undefined;
    }
  }

  /**
   * The committed working directory of one Agent Session. New hosts expose the
   * live projection through `workingDirectory`; older supported hosts only
   * carry the original directory in `session.header.cwd`. Prefer the projection
   * and fall back to the header so a remote workspace never becomes a silent
   * no-op on DSH 0.2.0 or a profile that omits the optional service.
   * @param {object|undefined} session - Agent Session.
   * @returns {string|undefined} absolute host directory.
   */
  sessionDirectory(session) {
    if (session === undefined || session === null) return undefined;
    const directories = this.ctx.get("workingDirectory");
    if (typeof directories?.get === "function") {
      try {
        const current = directories.get(session);
        if (typeof current === "string" && current !== "") return current;
      } catch {}
    }
    return typeof session.header?.cwd === "string" && session.header.cwd !== ""
      ? session.header.cwd
 : undefined;
  }

  /**
   * The committed working directory of the Agent that issued a tool call.
   * Reading a projection (when available) keeps this a pure lookup.
   * @param {object|undefined} exec - tool execution context.
   * @returns {string|undefined} absolute host directory.
   */
  sessionDirectoryOf(exec) {
    return this.sessionDirectory(exec?.agent?.session);
  }

  /**
   * Resolve the nearest existing SFTP path through `realpath`, appending any
   * missing suffix. This closes the symbolic-link escape left by lexical
   * containment: `/root/link/new-file` is checked against the real target of
   * `link`, not the visible spelling under the bound root.
   * @param {object} sftp - raw ssh2 SFTP subsystem.
   * @param {string} target - absolute POSIX path.
   * @returns {Promise<string>} canonical absolute path with the missing suffix.
   */
  async canonicalRemotePath(sftp, target) {
    const suffix = [];
    let candidate = target;
    for (;;) {
      try {
        const resolved = await this.sftpCall(sftp, (cb) => sftp.realpath(candidate, cb));
        return posix.join(resolved, ...suffix.reverse());
      } catch (error) {
        if (suffix.length === 0) {
          const attrs = await this.sftpCall(sftp, (cb) => sftp.lstat(target, cb)).catch(() => undefined);
          if (attrs !== undefined && (attrs.mode & 0o170000) === 0o120000) {
            throw new RemoteWorkspacePathError(
              `refusing to operate through an unresolved symbolic link: ${JSON.stringify(target)}`,
              REMOTE_WORKSPACE_OUTSIDE
 );
          }
        }
        const parent = posix.dirname(candidate);
        if (parent === candidate) throw error;
        suffix.push(posix.basename(candidate));
        candidate = parent;
      }
    }
  }

  /**
   * Verify that the path's real target stays under the binding's real root.
   * The operation still uses the operator-visible spelling; this check only
   * decides whether that spelling is safe to follow.
   * @param {object} connection - live SSH connection record.
   * @param {string} root - bound remote root.
   * @param {string} target - resolved remote path.
   * @returns {Promise<void>} rejects on symlink escape or verification failure.
   */
  async assertRemoteWorkspaceTarget(connection, root, target) {
    const sftp = await this.requireSftp(connection);
    if (!sftp.ok) {
      throw new RemoteWorkspacePathError(
        `remote workspace path could not be verified: ${sftp.error.message}`,
        REMOTE_WORKSPACE_OFFLINE
 );
    }
    let canonicalRoot;
    let canonicalTarget;
    try {
      canonicalRoot = await this.canonicalRemotePath(sftp.sftp, root);
      canonicalTarget = await this.canonicalRemotePath(sftp.sftp, target);
    } catch (error) {
      if (error instanceof RemoteWorkspacePathError) throw error;
      throw new RemoteWorkspacePathError(
        `remote workspace path could not be verified: ${error.message}`,
        REMOTE_WORKSPACE_OFFLINE
 );
    }
    if (!isRemotePathInside(canonicalRoot, canonicalTarget)) {
      throw new RemoteWorkspacePathError(
        `path resolves outside the remote workspace root ${JSON.stringify(root)} through a symbolic link: ${JSON.stringify(target)}`,
        REMOTE_WORKSPACE_OUTSIDE
 );
    }
  }

  /**
   * Resolve one SFTP tool request for the calling session. Unbound sessions
   * keep the historical behaviour (absolute or covering-relative path, current
   * or omitted connection) but still refuse an empty one: `sftp_upload_dir`
   * with `remote_path: ""` used to re-root the tree at `/` on the server.
   * A bound session resolves relative paths under its remote root, defaults to
   * the bound server, refuses escapes, and never silently talks to another
   * server than the one the binding names. A session that sits in a
   * subdirectory of the workspace maps that subdirectory under the remote
   * root, so `.` means the same place on both sides.
   * @param {{connectionId?: string, path: string}} request - tool arguments.
   * @param {object|undefined} exec - tool execution context.
   * @returns {Promise<{connectionId: string|undefined, path: string, bound: boolean}>} resolved target.
   * @throws {RemoteWorkspacePathError} on an escape or an offline binding.
   */
  async resolveRemoteToolPath(request, exec) {
    // The calling conversation owns the terminal this binding reveals, exactly
    // like ssh_connect_profile: a workspace opened by one chat must not take
    // over another chat's terminal on the same server.
    const sessionId = typeof exec?.agent?.id === "string" ? exec.agent.id : undefined;
    const sessionDirectory = this.sessionDirectoryOf(exec);
    const binding = this.remoteBindingFor(sessionDirectory);
    if (binding === undefined) {
      // No binding means "whatever the tool said", and the tool's own docs say
      // an absolute path. An absent or blank one is not an absolute path, and
      // the join/rename below turn it into a filesystem-root destination.
      const path = request?.path;
      if (typeof path !== "string" || path.trim().length === 0) {
        throw new RemoteWorkspacePathError("path must not be empty", REMOTE_WORKSPACE_OUTSIDE);
      }
      assertNoControlCharacters(path);
      return { connectionId: request.connectionId, path, bound: false };
    }
    const record = binding.record;
    const subdirectory = binding.relative === undefined ? workspaceRelativePart(record.workspacePath, sessionDirectory) : binding.relative;
    const base = subdirectory === null || subdirectory === "" ? record.remotePath : `${record.remotePath}/${subdirectory}`;
    let resolvedPath;
    try {
      resolvedPath = resolveRemotePath(base, request.path, record.remotePath);
    } catch (error) {
      throw new RemoteWorkspacePathError(error.message, REMOTE_WORKSPACE_OUTSIDE);
    }
    let connection;
    if (request.connectionId === undefined) {
      connection = await this.requireRemoteWorkspaceConnection(record, sessionId);
    } else {
      const selected = this.connections.get(request.connectionId);
      const reusable = selected === undefined ? null
 : findReusableProfileConnection([selected], record.profileId, { reuseExisting: true });
      if (reusable === null) {
        throw new RemoteWorkspacePathError(
          `this workspace is bound to ${record.remotePath} on another server; omit connection_id or pass a live connection to its saved SSH resource`,
          REMOTE_WORKSPACE_OFFLINE
 );
      }
      connection = await this.revealRemoteWorkspaceConnection(reusable, {
        reused: true,
        sessionId,
        previousActiveConnectionId: this.activeConnectionFor(sessionId)
      });
    }
    await this.assertRemoteWorkspaceTarget(connection, record.remotePath, resolvedPath);
    return { connectionId: connection.id ?? connection.connectionId, path: resolvedPath, bound: true, workspaceRoot: record.remotePath };
  }

  /**
   * Make a workspace connection visibly usable in the right-side panel. A
   * healthy transport without a live PTY is not enough: the operator must see
   * the server the agent is reading or writing.
   * @param {object} connection - live connection record.
   * @param {{reused: boolean, previousActiveConnectionId: string|null}} state - rollback context.
   * @returns {Promise<object>} the same connection after its terminal is open.
   */
  async revealRemoteWorkspaceConnection(connection, state) {
    const connectionId = connection.id ?? connection.connectionId;
    let openedSessionId = null;
    const ownerSessionId = normalizeOwner(state.sessionId);
    const liveSession = pickOwnerSession(this.sessions, connection, ownerSessionId) !== undefined;
    const rollback = async (error) => {
      if (!state.reused) await this.disconnect({ connectionId }).catch(() => {});
      else if (openedSessionId !== null) await this.closeSession({ sessionId: openedSessionId }).catch(() => {});
      this.bindActiveConnection(state.previousActiveConnectionId, ownerSessionId);
      throw new RemoteWorkspacePathError(error.message, REMOTE_WORKSPACE_OFFLINE);
    };
    if (!liveSession) {
      const opened = await this.openSession({ connectionId, openedBy: "agent", sessionId: ownerSessionId ?? undefined });
      if (!opened.ok) return rollback(opened.error);
      if (opened.value.reused !== true) openedSessionId = opened.value.sessionId;
    }
    const selected = await this.selectConnection({ connectionId, sessionId: ownerSessionId ?? undefined });
    if (!selected.ok) return rollback(selected.error);
    connection.agentRevealId = randomUUID();
    if (ownerSessionId !== null) connection.agentRevealOwnerSessionId = ownerSessionId;
    else delete connection.agentRevealOwnerSessionId;
    return connection;
  }

  /**
   * The live connection a binding works through: reuse one that is already up,
   * otherwise honor the binding's auto-connect flag — still inside the
   * operator-wide agentAutoConnect switch, exactly like ssh_connect_profile.
   * Either way the server becomes visible in the right-side panel, so the
   * operator can always see whose files the agent is editing.
   * @param {object} record - binding record.
   * @returns {Promise<object>} live connection record.
   * @throws {RemoteWorkspacePathError} when it cannot be brought up.
   */
  async requireRemoteWorkspaceConnection(record, sessionId) {
    const previousActiveConnectionId = this.activeConnectionFor(sessionId);
    const reusable = findReusableProfileConnection([...this.connections.values()], record.profileId, { reuseExisting: true });
    if (reusable !== null) {
      return this.revealRemoteWorkspaceConnection(reusable, { reused: true, sessionId, previousActiveConnectionId });
    }
    const profile = this.requireProfileTable().get(record.profileId);
    if (profile === undefined) {
      throw new RemoteWorkspacePathError(`the SSH resource bound to this workspace no longer exists`, REMOTE_WORKSPACE_OFFLINE);
    }
    if (record.autoConnect !== true) {
      throw new RemoteWorkspacePathError(`remote workspace is offline: connect ${JSON.stringify(profile.name)} in the SSH panel, or enable auto-connect for this workspace`, REMOTE_WORKSPACE_OFFLINE);
    }
    if (!this.agentAutoConnect) {
      throw new RemoteWorkspacePathError(t(AUTO_CONNECT_DISABLED_MESSAGE), REMOTE_WORKSPACE_OFFLINE);
    }
    const knownConnectionIds = new Set(this.connections.keys());
    const connected = await this.profileConnect({ profileId: record.profileId, reuseExisting: true, sessionId });
    if (!connected.ok) {
      throw new RemoteWorkspacePathError(`remote workspace is offline: ${connected.error.message}`, REMOTE_WORKSPACE_OFFLINE);
    }
    const connection = this.connections.get(connected.value.connectionId);
    if (connection === undefined) {
      throw new RemoteWorkspacePathError("remote workspace connection disappeared while connecting", REMOTE_WORKSPACE_OFFLINE);
    }
    return this.revealRemoteWorkspaceConnection(connection, {
      reused: knownConnectionIds.has(connection.connectionId),
      sessionId,
      previousActiveConnectionId
    });
  }

  /**
   * The prompt paragraph for one Session, empty unless its directory is bound.
   * @param {object|undefined} session - Session whose prompt is assembled.
   * @returns {string} declaration of the remote root and the tools that reach it.
   */
  remoteWorkspacePromptFor(session) {
    if (session === undefined || session === null || this.remoteWorkspaces === null) return "";
    const directory = this.sessionDirectory(session);
    const binding = this.remoteBindingFor(directory);
    if (binding === undefined) return "";
    const profile = this.requireProfileTable().get(binding.record.profileId);
    if (profile === undefined) return "";
    return remoteWorkspacePromptText({
      workspacePath: binding.record.workspacePath,
      remotePath: binding.record.remotePath,
      resourceName: profile.name,
      username: profile.username,
      host: profile.host,
      port: profile.port,
      relative: binding.relative
    });
  }

  /**
   * Bindings the operator may edit, plus the workspace and resource choices to
   * bind them to. Workspace candidates come from DSH's own registry, so the
   * browser never guesses a canonical path.
   */
  async remoteWorkspaceList() {
    if (this.remoteWorkspaces === null) return { ok: false, error: fail("storage-not-ready", "remote workspace storage is not ready") };
    try {
      const connectedProfileIds = new Set([...this.connections.values()].map((connection) => connection.profileId).filter(Boolean));
      const bindings = [];
      for (const record of this.remoteWorkspaces.list()) {
        const profile = this.requireProfileTable().get(record.profileId);
        bindings.push({
          workspacePath: record.workspacePath,
          remotePath: record.remotePath,
          profileId: record.profileId,
          profileName: profile?.name ?? "",
          host: profile?.host ?? "",
          port: profile?.port ?? 22,
          username: profile?.username ?? "",
          autoConnect: record.autoConnect === true,
          connected: connectedProfileIds.has(record.profileId),
 ...(profile === undefined ? { missingResource: true } : {})
        });
      }
      const registry = this.ctx.get("workspaceRegistry");
      const workspaces = (registry?.list?.() ?? []).map((workspace) => ({
        path: workspace.path,
        title: workspace.title ?? workspace.path
      }));
      return { ok: true, value: { bindings, workspaces } };
    } catch (error) {
      return { ok: false, error: fail("remote-workspace-list-failed", error.message) };
    }
  }

  /**
   * Create or replace one binding. The workspace path must be one DSH itself
   * registered (a typo would otherwise bind a directory no session ever uses)
   * and the resource must still exist.
   */
  async remoteWorkspaceSave(request) {
    if (this.remoteWorkspaces === null) return { ok: false, error: fail("storage-not-ready", "remote workspace storage is not ready") };
    try {
      const profile = this.requireProfileTable().get(request.profileId);
      if (profile === undefined) return { ok: false, error: fail("no-profile", `SSH resource "${request.profileId}" does not exist`) };
      const registry = this.ctx.get("workspaceRegistry");
      const known = new Set((registry?.list?.() ?? []).map((workspace) => workspace.path));
      if (known.size > 0 && !known.has(request.workspacePath)) {
        return { ok: false, error: fail("no-workspace", `workspace "${request.workspacePath}" is not registered in DSH`) };
      }
      let remotePath;
      try {
        remotePath = normalizeRemoteRoot(request.remotePath);
      } catch (error) {
        return { ok: false, error: fail(REMOTE_WORKSPACE_OUTSIDE, error.message) };
      }
      const record = await this.remoteWorkspaces.save({
        workspacePath: request.workspacePath,
        profileId: request.profileId,
        remotePath,
        autoConnect: request.autoConnect === true
      });
      return { ok: true, value: { binding: {
        workspacePath: record.workspacePath,
        remotePath: record.remotePath,
        profileId: record.profileId,
        profileName: profile.name,
        host: profile.host,
        port: profile.port,
        username: profile.username,
        autoConnect: record.autoConnect === true,
        connected: [...this.connections.values()].some((connection) => connection.profileId === record.profileId)
      } } };
    } catch (error) {
      return { ok: false, error: fail("remote-workspace-save-failed", error.message) };
    }
  }

  /** Unbind one workspace. Unknown paths are an idempotent no-op. */
  async remoteWorkspaceDelete(request) {
    if (this.remoteWorkspaces === null) return { ok: false, error: fail("storage-not-ready", "remote workspace storage is not ready") };
    try {
      const removed = await this.remoteWorkspaces.remove(request.workspacePath);
      return { ok: true, value: { removed } };
    } catch (error) {
      return { ok: false, error: fail("remote-workspace-delete-failed", error.message) };
    }
  }
};
