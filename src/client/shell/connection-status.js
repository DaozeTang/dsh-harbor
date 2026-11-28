/**
 * The three independent facts the server strip must show:
 *
 * - transport reachability (is the SSH connection alive?),
 * - whether THIS conversation has a terminal on it,
 * - whether the agent is currently operating on it.
 *
 * The old strip folded transport into terminal liveness, so an active
 * connection used only by ssh_exec looked disconnected. Keep the derivation
 * pure and testable; the panel only paints it.
 */
import { hasOwnTerminal } from "../state/session-terminals.js";

export function connectionStatusView(connection, sessionId) {
  if (connection === null || connection === undefined) {
    return { connected: false, hasTerminal: false, agentActive: false };
  }
  return {
    connected: connection.connected !== false,
    hasTerminal: hasOwnTerminal(connection, sessionId),
    agentActive: connection.agentActive === true
  };
}
