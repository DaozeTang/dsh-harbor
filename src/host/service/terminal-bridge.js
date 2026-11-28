/**
 * Bridge between Harbor's SSH PTY sessions and the host's official
 * persistent-terminal registry (`ctx.terminals`).
 *
 * The registry only knows the sessions its registered backends publish, and
 * the official `terminal_*` tools address exactly those sessions. This layer
 * gives one conversation terminal a registry identity: it opens (or adopts)
 * the PTY the panel already shows, waits for the remote shell's first prompt,
 * and exposes the small set of services the backend adapter needs — rendered
 * output, bounded line pages, internal input, signals, exit status and exit
 * waiting. Keeping it here rather than in the backend module means the same
 * rules apply to the backend, the safety gate and the panel bridge.
 */
import { toReadableText } from "../../shared/terminal-text.js";
import { redactForModel } from "../policy/redact.js";
import { normalizeOwner } from "../terminal/owner.js";
import { harborHub } from "../runtime/service-hub.js";

/** How long an agent terminal may take to reach its first prompt. */
const AGENT_STARTUP_TIMEOUT_MS = 15000;
/** Silence that ends startup once the shell has printed something. */
const AGENT_STARTUP_SILENCE_MS = 400;

/** Width and height of an agent-opened SSH terminal. */
const AGENT_TERMINAL_COLS = 120;
const AGENT_TERMINAL_ROWS = 30;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const withTerminalBridge = (Base) => class extends Base {
  /**
   * Registry session id -> backend session wrapper. Created lazily because
   * prototype stubs in the tests never run class field initializers.
   */
  terminalBindings() {
    this._terminalBindings ??= new Map();
    return this._terminalBindings;
  }

  /** The backend wrapper published for one registry session id, if any. */
  bindingForTerminal(registrySessionId) {
    if (typeof registrySessionId !== "string") return undefined;
    return this.terminalBindings().get(registrySessionId);
  }

  /** Publish a wrapper so terminal_send can be gated and panel input can take over. */
  attachTerminalBinding(binding) {
    this.terminalBindings().set(binding.registryId, binding);
    const session = this.sessions?.get(binding.sessionId);
    if (session !== undefined) session.terminalBinding = binding;
  }

  /** Withdraw a wrapper; the PTY may outlive it when the user took over. */
  detachTerminalBinding(binding) {
    if (this.terminalBindings().get(binding.registryId) === binding) this.terminalBindings().delete(binding.registryId);
    const session = this.sessions?.get(binding.sessionId);
    if (session !== undefined && session.terminalBinding === binding) session.terminalBinding = undefined;
  }

  /**
   * Withdraw the registry wrapper attached to one PTY when that PTY goes away
   * (natural exit, operator close, transport loss, plugin unload).
   *
   * SshTerminalSession.close() only covers the registry-initiated path. Every
   * host-side delete path must release this map entry too, or it pins the
   * session record and its output journal (up to maxBufferBytes) for the life
   * of the process, and bindingForTerminal keeps handing the terminal_send
   * gate a mirror that no longer reflects anything.
   *
   * @param {object|undefined} session - PTY session record.
   */
  detachBindingForSession(session) {
    const binding = session?.terminalBinding;
    if (binding === undefined || binding === null) return;
    session.terminalBinding = undefined;
    try { this.detachTerminalBinding?.(binding); } catch {}
  }

  /** A person typed into this PTY in the panel: the agent may only read it now. */
  notePanelInput(sessionId) {
    const session = this.sessions?.get(sessionId);
    if (session === undefined) return;
    // A human keystroke owns the PTY even before terminal_open has minted a
    // registry binding: ssh_connect, ssh_exec and the panel itself open raw
    // PTYs, and the binding is only one of the two records ownership lives in.
    // Without this, an agent terminal could later type over the person's line.
    // A terminal-generated reply also arrives through this write path; treating
    // it as operator activity errs on the safe side (the agent loses write
    // access rather than typing over a person).
    session.userOwned = true;
    session.terminalBinding?.markUserInput?.();
  }

  /** Whether the official registry currently serves SSH sessions. */
  sshTerminalBackendActive() {
    return harborHub().backend !== null;
  }

  /**
   * Create the registry-backed terminal for one tool call: reuse this
   * conversation's live SSH terminal when it already exists, otherwise open
   * (or adopt) the panel PTY and wait for its prompt.
   * @param {{owner: object, signal?: AbortSignal}} request - calling Agent and cancellation.
   * @returns {Promise<{session: object, connectionId: string, host: string, reused: boolean}>}
   */
  async openAgentTerminal(request) {
    const owner = request.owner;
    const ownerSessionId = this.terminalOwner(owner);
    const scope = this.terminalScope;
    const selected = this.resolveConnection(undefined, ownerSessionId);
    if (!selected.ok) throw new Error(`cannot open an SSH terminal: ${selected.error.message}`);
    const existing = this.liveAgentTerminal(ownerSessionId, selected.connectionId);
    if (existing !== undefined) {
      throw new Error(`this conversation already has an SSH terminal on ${selected.connection.name ?? selected.connection.host} (terminal session ${existing.registryId}); use terminal_send with that session id, or close it first`);
    }
    // A PTY the person took over belongs to them: never silently hand it back
    // to the next agent call. A fresh shell is opened instead.
    const taken = this.takenOverTerminal(ownerSessionId, selected.connectionId);
    const opened = await this.openSession({
      connectionId: selected.connectionId,
      cols: AGENT_TERMINAL_COLS,
      rows: AGENT_TERMINAL_ROWS,
      openedBy: "agent",
      sessionId: ownerSessionId ?? undefined,
      forceNew: taken !== undefined
    });
    if (!opened.ok) throw new Error(`cannot open an SSH terminal: ${opened.error.message}`);
    const session = this.sessions.get(opened.value.sessionId);
    const reused = opened.value.reused === true;
    try {
      await this.waitForTerminalReady(session, request.signal);
    } catch (error) {
      // Only a PTY this call opened is ours to clean up. A reused one is the
      // person's panel terminal (or one an earlier call created); closing it
      // because this call was cancelled or slow would kill their shell.
      if (!reused) {
        try { await this.closeTerminalSession(session); } catch {}
      }
      throw error;
    }
    if (scope === "agent") session.terminalScope = "agent";
    return { session, connectionId: selected.connectionId, host: selected.connection.host, reused };
  }

  /** This conversation's live PTY on one connection, if any. */
  liveAgentTerminal(ownerSessionId, connectionId) {
    const owner = normalizeOwner(ownerSessionId);
    for (const binding of this.terminalBindings().values()) {
      if (binding.alive !== true) continue;
      // A terminal the person took over is theirs: it must not block the next
      // agent terminal, and it must never be handed back to the agent.
      if (binding.takenOver === true) continue;
      if (binding.ownerSessionId !== owner) continue;
      if (binding.connectionId !== connectionId) continue;
      return binding;
    }
    return undefined;
  }

  /** An open PTY on that connection that the person has taken over. */
  takenOverTerminal(ownerSessionId, connectionId) {
    const owner = normalizeOwner(ownerSessionId);
    const taken = [];
    for (const binding of this.terminalBindings().values()) {
      if (binding.takenOver !== true) continue;
      if (binding.ownerSessionId !== owner) continue;
      if (binding.connectionId !== connectionId) continue;
      taken.push(binding);
    }
    if (taken.length > 0) return taken[0];
    for (const session of this.sessions?.values?.() ?? []) {
      if (session.userOwned !== true) continue;
      const sessionOwner = normalizeOwner(session.ownerSessionId);
      // An anonymous PTY the person has typed into is theirs too: the agent
      // must not adopt it and start typing over their line. Skip only sessions
      // that provably belong to another conversation.
      if (sessionOwner !== null && sessionOwner !== owner) continue;
      if (session.connectionId !== connectionId) continue;
      if (session.exited !== null) continue;
      return { sessionId: session.id };
    }
    return undefined;
  }

  /**
   * Wait until the remote shell has printed its startup banner and stopped.
   * A prompt is the strongest signal; when the remote shell emits none (network
   * appliances, restricted shells) silence after output is the honest fallback.
   * @param {object} session - live PTY session record.
   * @param {AbortSignal|undefined} signal - cancellation of the unpublished open.
   */
  async waitForTerminalReady(session, signal) {
    const deadline = Date.now() + AGENT_STARTUP_TIMEOUT_MS;
    let lastOffset = this.terminalJournal(session).read().offset;
    let lastChange = Date.now();
    let printed = lastOffset > 0;
    for (;;) {
      signal?.throwIfAborted?.();
      if (session.exited !== null) throw new Error(`the SSH shell exited during startup: ${session.exited.reason ?? "unknown"}`);
      const offset = this.terminalJournal(session).read().offset;
      if (offset !== lastOffset) {
        lastOffset = offset;
        lastChange = Date.now();
        printed = true;
      } else if (printed && Date.now() - lastChange >= AGENT_STARTUP_SILENCE_MS) {
        return;
      }
      if (Date.now() >= deadline) {
        if (printed) return;
        throw new Error("the SSH shell did not print anything within " + AGENT_STARTUP_TIMEOUT_MS + " ms");
      }
      await delay(50);
    }
  }

  /** The bounded append-only journal behind one PTY's stream readers. */
  terminalJournal(session) {
    return this.terminalOutput(session);
  }

  /**
   * Render one session's retained output as model-readable text.
   * Redaction runs before rendering so a secret that spans a redraw boundary
   * cannot come back together after carriage returns are folded.
   * @param {object} session - live or exited PTY session record.
   * @returns {{text: string, redacted: boolean, truncated: boolean}}
   */
  renderTerminalSession(session) {
    const journal = this.terminalJournal(session);
    const available = journal.read();
    const safe = redactForModel(available.data);
    return {
      text: toReadableText(safe.text),
      redacted: safe.redacted,
      truncated: available.startOffset > 0
    };
  }

  /** Raw (unrendered) tail of a session, for prompt detection. */
  terminalSessionTail(session, bytes = 4096) {
    const available = this.terminalJournal(session).read();
    if (available.data.length <= bytes) return available.data;
    return available.data.slice(-bytes);
  }

  /**
   * Write bytes into a PTY on behalf of the agent. Kept separate from the
   * operator's `write` RPC so agent input never marks a terminal as taken over.
   * @param {object} session - live PTY session record.
   * @param {string} text - raw terminal input.
   * @returns {boolean} whether the bytes reached the channel.
   */
  writeTerminalSession(session, text) {
    if (session === undefined || session.exited !== null || session.stream === null) return false;
    try {
      session.stream.write(text);
    } catch {
      return false;
    }
    this.updateInputMirror(session, text);
    return true;
  }

  /** Close one PTY and wait briefly for its exit record. */
  async closeTerminalSession(session) {
    if (session === undefined) return;
    if (session.exited === null) await this.closeSession({ sessionId: session.id });
    const deadline = Date.now() + 3000;
    while (session.exited === null && Date.now() < deadline) await delay(25);
  }
};
