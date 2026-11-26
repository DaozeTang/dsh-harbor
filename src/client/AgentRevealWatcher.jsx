/**
 * Session-scoped agent reveal watcher.
 *
 * The plugin root used to poll the host with no session id and then call
 * `sidebarRight.openTab(kind)`, which acts on whichever conversation is on
 * screen. A reveal for chat A could therefore pop an empty Harbor tab in
 * chat B, while A's queued tab expired. This watcher lives in the
 * conversation header (the slot is session-scoped), so it only ever opens
 * the tab for the conversation the host says asked for it.
 *
 * It renders nothing; the effect is the whole component.
 */
import { useEffect, useRef } from "react";
import { startAgentConnectionPoll } from "./agent-connection-poll.js";
import { harborUiAnnounceAgentConnections, harborUiResetAgentAnnouncements } from "./store.js";

export function AgentRevealWatcher({ api, sessionId, openTab }) {
  const openRef = useRef(openTab);
  openRef.current = openTab;

  useEffect(() => {
    if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
    let alive = true;
    const announce = (connections) => {
      if (!alive) return;
      const fresh = harborUiAnnounceAgentConnections(connections, { sessionId });
      // Only a NEW reveal opens/focuses the tab; the poll itself is silent.
      if (fresh.length > 0) openRef.current?.();
    };
    // Catch a reveal that arrived while this conversation was in the
    // background before the first interval tick.
    api.list(sessionId)
      .then((listed) => announce(listed?.connections ?? []))
      .catch(() => {});
    const stop = startAgentConnectionPoll({ list: () => api.list(sessionId) }, announce);
    return () => {
      alive = false;
      stop();
      // Returning to this conversation re-checks the host; a terminal that
      // appeared in the background is still revealable.
      harborUiResetAgentAnnouncements(sessionId);
    };
  }, [api, sessionId]);

  return null;
}
