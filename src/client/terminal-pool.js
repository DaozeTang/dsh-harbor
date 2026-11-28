/**
 * Keep-alive registry for xterm Terminal instances, keyed by host SSH session
 * id. The right-Sidebar draws only the ACTIVE tab's body, so switching to the
 * Files tab (or closing the SSH tab) unmounts every XtermView; without this
 * pool each unmount destroyed the scrollback, and "reopen restores the
 * terminal" was only true for output the host had buffered since.
 *
 * The pool is pure bookkeeping over factory-created terminals so it runs in
 * Node tests without DOM: `create` returns { term, fit, ...addons } and the
 * pool never touches the DOM itself — mounting/remounting (`term.element` re-parenting)
 * stays in XtermView.
 *
 * Rules:
 * - One pooled entry per session id; `acquire` marks the caller as owner.
 * - If the entry is owned by another LIVE mount (split view / two panes), the
 *   caller gets a fresh unpooled terminal instead of stealing the element;
 *   releasing an unpooled terminal disposes it.
 * - Releasing only clears ownership: scrollback survives tab switches, sidebar
 *   collapse, chat switches, and closing the SSH tab.
 * - Unowned entries beyond `max` are evicted least-recently-used and disposed;
 *   owned entries are never evicted under a live mount.
 * - `drop` forgets a session the host ended (`no-session`, an exit item):
   disposed at once when no mount owns it, otherwise marked dead and
   disposed by the owning mount's release. A dead entry is never reused.
 - `release` matches a lease by session, not just by owner: one mount can
   hold a pooled entry for session A and a lease for session B.
 *
 * Each terminal keeps its last displayed stream offset. Identical new output
 * is retained; only explicitly overlapping offsets are skipped.
 */

/**
 * @param {object} options
 * @param {() => { term: object, fit: object }} options.create builds one terminal + fit addon pair
 * @param {number} [options.max] pooled entries kept before LRU eviction (default 8)
 * @returns {{
 *   acquire: (sessionId: string, owner: object) => {
 *     term: object, fit: object, reused: boolean, pooled: boolean,
 *     offset: number | undefined,
 *     consume: (text: string, startOffset?: number, offset?: number) => string
 *   },
 *   release: (sessionId: string, owner: object) => void,
 *   drop: (sessionId: string) => void,
 *   get: (sessionId: string) => { term: object, fit: object } | undefined,
 *   forEachTerm: (callback: (term: object) => void) => void,
 *   size: () => number,
 *   disposeAll: () => void
 * }}
 */
export function createTerminalPool({ create, max = 8 }) {
  /** sessionId → { term, fit, owner, pooled } in LRU order (Map insertion order). */
  const entries = new Map();
  /** owner → unpooled entry. One mount's private terminal when the pooled one is live-owned elsewhere. */
  const leases = new Map();

  function evictOverflow() {
    for (const [sessionId, entry] of entries) {
      if (entries.size <= max) break;
      if (entry.owner !== null) continue;
      entry.term.dispose();
      entries.delete(sessionId);
    }
  }

  function makeEntry() {
    const built = create();
    return {
      term: built.term,
      fit: built.fit,
      // Anything else the factory attached (the search addon, a future codec)
      // travels with the entry: a pooled terminal keeps every addon it was
      // built with, for every mount that borrows it.
 ...(built.search !== undefined ? { search: built.search } : {}),
      owner: null,
      pooled: true,
      offset: undefined
    };
  }

  /**
   * An unpooled terminal for a mount that cannot borrow the pooled entry
   * (another live mount owns it, or it belongs to a dead PTY that mount is
   * still drawing). A mount that already holds this session's lease reuses
   * it, so a re-run acquire never leaves a second terminal behind.
   */
  function leaseFor(owner, sessionId) {
    const held = leases.get(owner);
    if (held !== undefined && held.sessionId === sessionId) return { entry: held, reused: true };
    const lease = makeEntry();
    lease.pooled = false;
    lease.sessionId = sessionId;
    leases.set(owner, lease);
    return { entry: lease, reused: false };
  }

  /** The face a mount uses: terminal plus the per-session write accounting. */
  function face(entry, reused) {
    return {
      term: entry.term,
      fit: entry.fit,
 ...(entry.search !== undefined ? { search: entry.search } : {}),
      reused,
      pooled: entry.pooled,
      get offset() { return entry.offset; },
      consume(text, startOffset, offset) {
        // Older hosts do not publish offsets: preserve their bytes verbatim.
        if (!Number.isSafeInteger(startOffset) || !Number.isSafeInteger(offset)) return text;
        const overlap = Math.max(0, (entry.offset ?? startOffset) - startOffset);
        entry.offset = Math.max(entry.offset ?? 0, offset);
        return text.slice(overlap);
      }
    };
  }

  return {
    /** Bind one mount to a terminal for `sessionId`; `owner` must be a unique mount token. */
    acquire(sessionId, owner) {
      let existing = entries.get(sessionId);
      if (existing !== undefined && existing.dead && existing.owner !== null) {
        // The host session ended while another mount still draws this
        // terminal. That mount's release will dispose it; this one must not
        // touch the element, so it runs unpooled like any other live split.
        const lease = leaseFor(owner, sessionId);
        return face(lease.entry, lease.reused);
      }
      if (existing !== undefined && existing.dead) {
        // Nobody is drawing it: its scrollback belongs to a dead PTY.
        existing.term.dispose();
        entries.delete(sessionId);
        existing = undefined;
      }
      if (existing === undefined) {
        const entry = makeEntry();
        entry.owner = owner;
        entries.set(sessionId, entry);
        evictOverflow();
        return face(entry, false);
      }
      if (existing.owner === null || existing.owner === owner) {
        // Refresh recency so re-mounts keep their warm entry.
        entries.delete(sessionId);
        entries.set(sessionId, existing);
        existing.owner = owner;
        return face(existing, true);
      }
      // The entry belongs to another live mount: never steal its element.
      // This mount runs on an unpooled terminal that dies with it.
      const lease = leaseFor(owner, sessionId);
      return face(lease.entry, lease.reused);
    },

    /**
     * Detach one mount. A pooled entry keeps its scrollback; an unpooled one
     * is disposed.
     *
     * The lease is matched by session, not just by owner: a mount that holds
     * both a pooled entry (session A) and a lease (session B) used to have its
     * release for A dispose B's terminal and return, leaving A's entry owned
     * by a mount that had already gone — evicted only by LRU, never reused.
     */
    release(sessionId, owner) {
      const lease = leases.get(owner);
      if (lease !== undefined && lease.sessionId === sessionId) {
        lease.term.dispose();
        leases.delete(owner);
        return;
      }
      const entry = entries.get(sessionId);
      if (entry === undefined || entry.owner !== owner) return;
      entry.owner = null;
      if (entry.dead) {
        // The host session died while this mount still owned the terminal;
        // drop() could not dispose it from under a live view and deferred.
        entry.term.dispose();
        entries.delete(sessionId);
        return;
      }
      evictOverflow();
    },

    /**
     * Forget a session the host ended: dispose and drop. Any unpooled lease
     * dies with its own mount.
     *
     * Pass `owner` when the mount that observed the end is still the one
     * holding the entry: it may dispose its own terminal. An entry another
     * live mount still draws must not be disposed under it — that view keeps
     * its final scrollback — so it is marked dead and disposed by its own
     * release. A dead entry is never handed out again either way.
     */
    drop(sessionId, { owner = null } = {}) {
      const entry = entries.get(sessionId);
      if (entry === undefined) return;
      if (entry.owner !== null && entry.owner !== owner) {
        entry.dead = true;
        return;
      }
      entry.term.dispose();
      entries.delete(sessionId);
    },

    get(sessionId) {
      const entry = entries.get(sessionId);
      return entry === undefined ? undefined : { term: entry.term, fit: entry.fit };
    },

    size() {
      return entries.size;
    },

    /** Visit pooled plus split-view terminals; used for visual-only updates. */
    forEachTerm(callback) {
      for (const entry of entries.values()) callback(entry.term);
      for (const lease of leases.values()) callback(lease.term);
    },

    /** Test/plugin-teardown helper: dispose every pooled terminal. */
    disposeAll() {
      for (const entry of entries.values()) entry.term.dispose();
      entries.clear();
      for (const lease of leases.values()) lease.term.dispose();
      leases.clear();
    }
  };
}
