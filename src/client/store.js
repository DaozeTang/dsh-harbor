/**
 * Module-level UI store for the SSH ops panel: connection list, active
 * connection/session, connection form state, and error status. Surface
 * reveal requests (resources page, agent announcements) flow through the
 * registered surface opener; panes share the rest via useSyncExternalStore.
 */
import { useSyncExternalStore } from "react";
import { requestPaneOpen } from "./pane-selection.js";

let snapshot = {
  connections: [],
  activeConnectionId: null,
  features: null,
  // A settings-page "进入项目" request gives the first mounted SSH pane a
  // starting SFTP directory matching the guarded terminal cd.
  projectTarget: null,
  busy: false,
  error: null
};

const listeners = new Set();

function set(patch) {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

export function getHarborUiSnapshot() {
  return snapshot;
}

function subscribeHarborUi(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useHarborUi() {
  return useSyncExternalStore(subscribeHarborUi, getHarborUiSnapshot);
}

export function harborUiSetFeatures(features) {
  set({ features });
}

/**
 * How the current host shows the SSH surface: the official Sidebar focuses
 * its tab. Registered when the Sidebar registration succeeds.
 */
let surfaceOpener = null;

export function harborUiSetSurfaceOpener(opener) {
  surfaceOpener = typeof opener === "function" ? opener : null;
}

/**
 * Ask the host to show the SSH surface. Callers that do not own a pane — the
 * resources page, for one — use this instead of manipulating pane state
 * directly, so a connect from the settings page also reveals the terminal.
 */
export function harborUiRequestSurface() {
  surfaceOpener?.();
}

export function harborUiSetConnections(connections) {
  set({ connections });
}

/**
 * Agent-connected servers must surface themselves: every agent tool now calls
 * the host's visibility contract, which stamps a reveal token on the
 * connection. The token is scoped to the conversation that asked for it: a
 * reveal for chat A must never pop a tab into chat B's pane, and the same
 * token must not re-open a tab on every poll.
 *
 * The announced set is per conversation. The session watcher resets its own
 * set when it unmounts, so returning to a conversation re-checks the host and
 * can reveal a terminal that appeared while the conversation was in the
 * background. The surface itself is opened by the session watcher with
 * `openTabIn(sessionId, ...)`; this function only queues the pane membership.
 *
 * @param {Array<object>} connections - list() entries for one conversation.
 * @param {{sessionId?: string|null}} [options] - the listing conversation.
 * @returns {{connectionId: string, ownerSessionId: string|null}[]} fresh
 *   reveals, oldest connection first; callers open the surface only when this
 *   is non-empty.
 */
/**
 * One entry per conversation: connectionId → the announcement id last acted
 * on. The set used to be keyed by `connectionId:announcementId` and only ever
 * grew — every agent reveal left another string behind for the life of the
 * conversation. The only question ever asked is "is this connection's
 * CURRENT announcement one I already handled", which a per-connection value
 * answers in constant space.
 */
const announcedAgentConnections = new Map();

function announcedFor(sessionId) {
  const key = sessionId ?? "";
  let seen = announcedAgentConnections.get(key);
  if (seen === undefined) {
    seen = new Map();
    announcedAgentConnections.set(key, seen);
  }
  return seen;
}

export function harborUiAnnounceAgentConnections(connections, { sessionId = null } = {}) {
  const seen = announcedFor(sessionId);
  const fresh = [];
  for (const connection of connections) {
    if (connection?.agentRevealId === undefined && connection?.agentSession !== true) continue;
    const owner = connection.agentRevealOwnerSessionId ?? null;
    // A reveal belongs to the conversation that asked for it. An older host
    // may publish no owner: accept it only when the host also says this
    // conversation owns the live agent terminal.
    if (sessionId !== null) {
      if (owner !== null && owner !== sessionId) continue;
      if (owner === null && connection.agentRevealId === undefined && connection.agentSessionMine !== true) continue;
    }
    const announcementId = connection.agentRevealId ?? `agent-session:${owner ?? "any"}`;
    // A NEW reveal id on the same connection is a new event (the host stamps
    // one per reveal); the same id means "already opened for this".
    if (seen.get(connection.connectionId) === announcementId) continue;
    seen.set(connection.connectionId, announcementId);
    fresh.push({ connectionId: connection.connectionId, ownerSessionId: owner ?? sessionId });
  }
  for (const entry of fresh) requestPaneOpen(entry.connectionId, { ownerSessionId: entry.ownerSessionId });
  return fresh;
}

/** Forget one conversation's announcements (session watcher unmount/remount). */
export function harborUiResetAgentAnnouncements(sessionId) {
  announcedAgentConnections.delete(sessionId ?? "");
}

/** Select the active connection (the tab whose terminal/files/tunnels show). */
export function harborUiSetActiveConnection(connectionId) {
  set({ activeConnectionId: connectionId });
}

export function harborUiSetProjectTarget(connectionId, path) {
  set({ projectTarget: connectionId && path ? { connectionId, path } : null });
}

export function harborUiSetBusy(busy) {
  set({ busy });
}

export function harborUiSetError(error) {
  set({ error });
}
