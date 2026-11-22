/**
 * Terminal ownership: which DSH conversation owns one PTY.
 *
 * Until 0.2.2 a connection carried ONE interactive terminal that every
 * conversation shared: `writeToConnection` broadcast to every shell of the
 * connection, `readConnectionOutput` took the first live one, and `ssh_exec`
 * mirrored its output into all of them. Two chats running agents against the
 * same server therefore typed into each other's terminal, read each other's
 * output and fought over the process-global `activeConnectionId`.
 *
 * Ownership is the fix. Every live PTY records the DSH SessionId that owns it,
 * and every read, write, mirror, cwd probe and agent-target resolution goes
 * through that one key. The key is a plain string (the SessionId is a branded
 * string on the wire), plus a `null` state for terminals that a caller without
 * a session opened: the settings page, an older panel build, or a terminal
 * that predates the upgrade. Those are "anonymous" and may be adopted exactly
 * once, which is what keeps "open a terminal in the panel, then let the agent
 * type into it" working across the upgrade.
 *
 * Nothing here touches the service: these are pure helpers over plain records
 * so the rules can be unit-tested without an SSH transport.
 */

/** Owner key used for terminals no session claims. Never a real SessionId. */
export const ANONYMOUS_OWNER = "";

/** Longest SessionId this plugin accepts; DSH ids are UUID-shaped. */
const MAX_OWNER_LENGTH = 128;

/** Deepest subagent lineage this resolver walks before giving up. */
const MAX_ANCESTOR_HOPS = 8;

/**
 * Coerce whatever a caller passed into an owner id, or `null` when it cannot
 * be one. Rejecting instead of throwing is deliberate: an older host that
 * passes no session id must degrade to the anonymous path, not fail the call.
 * @param {unknown} value - candidate session id.
 * @returns {string|null} the usable id, or null.
 */
export function normalizeOwner(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_OWNER_LENGTH) return null;
  if (/[\x00-\x1f\x7f]/.test(value)) return null;
  return value;
}

/**
 * Map one owner id onto its index key. Anonymous and unknown collapse into the
 * same bucket on purpose: both mean "no session to attribute this to".
 * @param {unknown} ownerSessionId - owner id or nothing.
 * @returns {string} the index key.
 */
export function ownerKey(ownerSessionId) {
  return normalizeOwner(ownerSessionId) ?? ANONYMOUS_OWNER;
}

/**
 * Record one live terminal under its owner.
 * @param {object} connection - live connection record.
 * @param {string} sessionId - PTY session id.
 * @param {unknown} ownerSessionId - the owning DSH session.
 */
export function indexOwner(connection, sessionId, ownerSessionId) {
  if (connection === undefined || connection === null) return;
  connection.ownerIndex ??= new Map();
  connection.sessions ??= new Set();
  const key = ownerKey(ownerSessionId);
  let owned = connection.ownerIndex.get(key);
  if (owned === undefined) {
    owned = new Set();
    connection.ownerIndex.set(key, owned);
  }
  owned.add(sessionId);
}

/**
 * Forget one terminal. An emptied bucket is deleted so a connection's index
 * cannot grow one entry per session that ever existed.
 * @param {object} connection - live connection record.
 * @param {string} sessionId - PTY session id.
 * @param {unknown} ownerSessionId - the owner it was indexed under.
 */
export function unindexOwner(connection, sessionId, ownerSessionId) {
  const index = connection?.ownerIndex;
  if (!(index instanceof Map)) return;
  const key = ownerKey(ownerSessionId);
  const owned = index.get(key);
  if (owned === undefined) return;
  owned.delete(sessionId);
  if (owned.size === 0) index.delete(key);
}

/**
 * PTY session ids recorded for one owner, oldest first (insertion order).
 *
 * A connection without an index (a test double, or a record restored from a
 * shape that predates ownership) is DERIVED from its own session records
 * instead of being reported as ownerless: an empty answer here silently means
 * "this conversation has no terminal", which is the one failure mode worth
 * being paranoid about.
 *
 * @param {object} connection - live connection record.
 * @param {unknown} ownerSessionId - owner id.
 * @param {Map<string, object>} [sessions] - service session map, for derivation.
 * @returns {string[]} session ids.
 */
export function ownerSessionIds(connection, ownerSessionId, sessions) {
  const key = ownerKey(ownerSessionId);
  const owned = connection?.ownerIndex?.get(key);
  if (owned !== undefined) return [...owned];
  if (!(sessions instanceof Map) || !(connection?.sessions instanceof Set)) return [];
  const derived = [];
  for (const sessionId of connection.sessions) {
    const session = sessions.get(sessionId);
    if (session !== undefined && ownerKey(session.ownerSessionId) === key) derived.push(sessionId);
  }
  return derived;
}

/**
 * A terminal is usable while its channel is open. Exited shells stay in the
 * session map for late readers, so liveness is asked explicitly everywhere.
 * @param {object|undefined} session - session record.
 * @returns {boolean} whether the terminal can still be read or written.
 */
export function isLiveSession(session) {
  return session !== undefined && session !== null && session.exited === null && session.stream !== null;
}

/**
 * Newest live terminal of one owner. Newest first is what the caller wants for
 * every path here: a session that reopened its terminal after an exit must get
 * the replacement, not the tombstone.
 * @param {Map<string, object>} sessions - service session map.
 * @param {object} connection - live connection record.
 * @param {unknown} ownerSessionId - owner id.
 * @returns {object|undefined} the session record, when one is live.
 */
export function pickOwnerSession(sessions, connection, ownerSessionId) {
  const ids = ownerSessionIds(connection, ownerSessionId, sessions);
  for (let index = ids.length - 1; index >= 0; index -= 1) {
    const session = sessions?.get?.(ids[index]);
    if (isLiveSession(session)) return session;
  }
  return undefined;
}

/**
 * Every live terminal no session owns. Adoption requires exactly one, so this
 * returns all of them and lets the caller decide.
 * @param {Map<string, object>} sessions - service session map.
 * @param {object} connection - live connection record.
 * @returns {object[]} anonymous live session records.
 */
export function anonymousSessions(sessions, connection) {
  const result = [];
  for (const sessionId of ownerSessionIds(connection, null, sessions)) {
    const session = sessions?.get?.(sessionId);
    if (isLiveSession(session)) result.push(session);
  }
  return result;
}

/**
 * Delegation depth persisted on a session header. A resumed child may carry
 * only the coarse origin marker, so the marker is treated as "at least one
 * level deep" rather than as "top level".
 * @param {object|undefined} session - DSH session.
 * @returns {number} non-negative depth.
 */
export function delegationDepth(session) {
  const header = session?.header;
  const persisted = header?.delegationDepth;
  if (Number.isSafeInteger(persisted) && persisted > 0) return persisted;
  return header?.origin === "subagent" ? 1 : 0;
}

/**
 * The top-level conversation behind one agent session.
 *
 * A subagent runs as its own DSH session; its terminal belongs to the
 * conversation that delegated it, unless the operator explicitly asked for
 * per-agent terminals. Walking `header.parentSession` up to delegation depth 0
 * is how that conversation is found without the sidebar having to guess.
 *
 * Forks are NOT walked: `parentSession` there means "seeded from", and a fork
 * is a top-level conversation that deserves its own terminal.
 *
 * @param {string} sessionId - the calling agent's session id.
 * @param {object|undefined} session - that session, for lineage.
 * @param {(id: string) => object|undefined} getAgent - live agent lookup.
 * @returns {string|null} the owning conversation id, or null when unknown.
 */
export function conversationOwner(sessionId, session, getAgent) {
  let current = normalizeOwner(sessionId);
  if (current === null) return null;
  let candidate = session;
  let depth = delegationDepth(candidate);
  for (let hop = 0; hop < MAX_ANCESTOR_HOPS && depth > 0; hop += 1) {
    const parentId = normalizeOwner(candidate?.header?.parentSession);
    if (parentId === null) break;
    current = parentId;
    let parent;
    try {
      parent = typeof getAgent === "function" ? getAgent(parentId) : undefined;
    } catch {
      parent = undefined;
    }
    if (parent?.session === undefined) {
      // The parent is gone (or not live in this host): its id is still the most
      // specific owner we can name, and naming it is safer than falling back to
      // the child, which would silently split one conversation's terminal.
      break;
    }
    candidate = parent.session;
    depth = delegationDepth(candidate);
  }
  return current;
}

/**
 * Resolve the terminal owner for one caller.
 * @param {{sessionId?: unknown, session?: object, scope?: string, getAgent?: Function}} options
 *   caller identity, its session, the configured scope and the agent lookup.
 * @returns {string|null} owner id, or null for the anonymous path.
 */
export function resolveTerminalOwner({ sessionId, session, scope, getAgent }) {
  const own = normalizeOwner(sessionId);
  if (own === null) return null;
  if (scope !== "conversation") return own;
  return conversationOwner(own, session, getAgent) ?? own;
}

/**
 * Whether a terminal belongs to the session asking.
 * @param {object} session - PTY session record.
 * @param {unknown} ownerSessionId - caller's owner id.
 * @returns {boolean} true for the caller's own terminal.
 */
export function isOwnedBy(session, ownerSessionId) {
  return ownerKey(session?.ownerSessionId) === ownerKey(ownerSessionId);
}
