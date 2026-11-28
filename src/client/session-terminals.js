/**
 * Which terminal a pane shows, from its own conversation's point of view.
 *
 * Every conversation owns its own PTY per server, so "the terminal of this
 * connection" is no longer a single answer: the panel must pick ITS one and
 * must not silently display another chat's shell (that is the cross-talk this
 * change removes). Two states are deliberately kept apart, because they call
 * for different UI:
 *
 * - `own`  — this conversation's live terminal; the pane renders it.
 * - `others` — terminals on the same server owned by other conversations. They
 *   are counted and mentioned (so an empty pane is explainable), never rendered
 *   and never typed into.
 *
 * An older host publishes no `terminals` array at all; the pane then falls back
 * to `sessions[0]`, which is exactly what that host meant by "the terminal".
 */

/**
 * @param {object|null|undefined} connection - connection info from `harbor.list`.
 * @param {string|undefined} sessionId - the pane's DSH session id.
 * @returns {{sessionId: string|null, own: object|null, others: object[], total: number}}
 *   the terminal to render, plus what else lives on that server.
 */
/**
 * Whether one terminal belongs to this conversation.
 *
 * The host resolves `mine` for the caller; comparing ownerSessionId as well
 * keeps an older host (and the offline preview) correct when the payload omits
 * the flag. This is the ONE definition: the pane resolver, the close-tab action
 * and the status tab's "terminals of this conversation" counter all use it —
 * the counter used to compare against `undefined` instead of a string, so with
 * no session id at all an anonymous terminal counted as the viewer's own.
 *
 * @param {object|null|undefined} terminal - one entry of connection.terminals.
 * @param {string|undefined} sessionId - the pane's DSH session id.
 * @returns {boolean} true when this conversation owns that terminal.
 */
export function isMineTerminal(terminal, sessionId) {
  if (terminal === null || terminal === undefined) return false;
  return terminal.mine === true
    || (terminal.mine === undefined && typeof sessionId === "string" && terminal.ownerSessionId === sessionId);
}

export function resolvePaneTerminal(connection, sessionId) {
  if (connection === null || connection === undefined) return { sessionId: null, own: null, others: [], total: 0 };
  const terminals = Array.isArray(connection.terminals) ? connection.terminals : null;
  if (terminals === null) {
    // Host without per-conversation terminals: one shell per connection.
    return { sessionId: connection.sessions?.[0] ?? null, own: null, others: [], total: (connection.sessions?.length ?? 0) };
  }
  const live = terminals.filter((terminal) => terminal.alive !== false);
  const own = live.find((terminal) => isMineTerminal(terminal, sessionId)) ?? null;
  const others = live.filter((terminal) => !isMineTerminal(terminal, sessionId));
  return { sessionId: own === null ? null : own.sessionId, own, others, total: live.length };
}

/**
 * Whether a pane shows this conversation's terminal: the status dot and the
 * terminal body both ask this, so an idle server with another chat's shell does
 * not look like "my terminal is up".
 * @param {object|null|undefined} connection - connection info from `harbor.list`.
 * @param {string|undefined} sessionId - the pane's DSH session id.
 * @returns {boolean} true when this conversation has a live terminal there.
 */
export function hasOwnTerminal(connection, sessionId) {
  return resolvePaneTerminal(connection, sessionId).sessionId !== null;
}

/**
 * What closing one pane's server tab must do on the host.
 *
 * Closing a tab used to mean "disconnect", which was safe while a connection
 * belonged to one conversation. With per-conversation terminals two chats can
 * share one transport, and disconnecting would kill the other chat's shell —
 * closing your tab must end YOUR terminal and nothing else. The transport is
 * disconnected only when no conversation has a terminal left on it.
 *
 * @param {object|null|undefined} connection - connection info from `harbor.list`.
 * @param {string|undefined} sessionId - the pane's DSH session id.
 * @returns {"disconnect"|"close-terminal"|"none"} the host action to take.
 */
export function closeTabAction(connection, sessionId) {
  const view = resolvePaneTerminal(connection, sessionId);
  if (view.others.length > 0) return view.sessionId === null ? "none" : "close-terminal";
  return "disconnect";
}
