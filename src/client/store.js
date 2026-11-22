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

export function subscribeHarborUi(listener) {
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
 * Agent-connected servers must surface themselves: `ssh_connect_profile` opens transport + session on the host, but
 * nothing else happens on screen — the user had to hunt for the terminal, and
 * a second server never appeared beside the first one. Connections whose list
 * metadata carries `agentRevealId` (a saved-resource request) or `agentSession`
 * (a live agent-opened session) are queued for
 * the pane (a new server tab beside the current ones) and the SSH surface is
 * revealed. Idempotent per request id for the page lifetime; after a page
 * reload a re-announcement dedupes into a plain selection pane-side.
 */
const announcedAgentConnections = new Set();

export function harborUiAnnounceAgentConnections(connections) {
  const fresh = [];
  for (const connection of connections) {
    if (connection?.agentRevealId === undefined && connection?.agentSession !== true) continue;
    const ownerSessionId = connection.agentRevealOwnerSessionId ?? null;
    // A reveal belongs to the conversation that asked for it: the same server
    // revealed for chat A must still be able to reveal for chat B later.
    const announcementId = connection.agentRevealId ?? `agent-session:${ownerSessionId ?? "any"}`;
    const key = `${connection.connectionId}:${announcementId}`;
    if (announcedAgentConnections.has(key)) continue;
    announcedAgentConnections.add(key);
    fresh.push({ connectionId: connection.connectionId, ownerSessionId });
  }
  if (fresh.length === 0) return false;
  for (const entry of fresh) requestPaneOpen(entry.connectionId, { ownerSessionId: entry.ownerSessionId });
  harborUiRequestSurface();
  return true;
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
