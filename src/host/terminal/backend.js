/**
 * Official persistent-terminal backend for SSH.
 *
 * The host's terminal registry (`ctx.terminals`) owns identity, authorization
 * and cleanup; this adapter owns the SSH mechanics behind one registry
 * session. A registry session is the SAME PTY the Harbor panel shows — the
 * panel keeps its own stream/resize RPC because the registry contract has no
 * resize — so `terminal_send` types into the shell the person is watching, and
 * the person's first keystroke takes the terminal over exactly as it does for
 * the official local terminal.
 *
 * The registry instance lives inside the Persistent terminals group, which
 * isolates `terminals`; this module is mounted there by the companion row in
 * cordis.patch.yml and reaches the root service through `service-hub.js`.
 */
import { harborHub, currentHarborService } from "../runtime/service-hub.js";
import { endsWithPrompt, promptFromTerminalData, tailUtf8 } from "../service/text.js";
import { toReadableText } from "../../shared/terminal-text.js";

/** Registry type models pass to terminal_open. */
export const HARBOR_SSH_BACKEND_TYPE = "harbor-ssh";

/** Refusal shared with the official local-terminal backend. */
export const SUBAGENT_REFUSAL = "Subagents cannot open Harbor SSH terminals because the conversation's terminal is owned by its main agent; use ssh_exec for a one-shot command instead.";

/** Refusal after the person typed into the terminal. */
export const TAKEN_OVER = "The user has taken over this SSH terminal; read it with terminal_read or open a new terminal.";

/** Silence after a send that counts as the command having finished. */
const PROMPT_SILENCE_MS = 250;
/** Silence after a send that ends the wait even without a visible prompt. */
const IDLE_SILENCE_MS = 3000;
/** Longest one send may wait for its foreground command. */
export const SEND_TIMEOUT_MS = 30000;
/** Poll interval while one send waits for its command to settle. */
const SEND_POLL_MS = 50;
/** Default page size of terminal_read. */
const DEFAULT_READ_LINES = 500;
/** UTF-8 bound on one rendered result. */
const MAX_READ_BYTES = 256 * 1024;
/** UTF-8 bound on the startup screen returned from terminal_open. */
const MAX_MOTD_BYTES = 8 * 1024;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Line page, newest line last, addressed by distance from the newest line. */
function pageLines(lines, request) {
  const total = lines.length;
  const offset = Number.isSafeInteger(request?.offset) ? Math.max(0, request.offset) : 0;
  const requested = Number.isSafeInteger(request?.count) && request.count > 0 ? request.count : DEFAULT_READ_LINES;
  const available = Math.max(0, total - offset);
  const count = Math.min(requested, available);
  const from = total - offset - count;
  const to = total - offset;
  let text = count > 0 ? lines.slice(Math.max(0, from), Math.max(0, to)).join("\n") : "";
  const bounded = tailUtf8(text, MAX_READ_BYTES);
  text = bounded.text;
  return {
    text,
    totalLines: total,
    lineBegin: offset,
    lineEnd: offset + count,
    truncated: bounded.truncated || from > 0 || offset + count < total
  };
}

/** One registry session backed by a Harbor SSH PTY. */
export class SshTerminalSession {
  /**
   * @param {object} options - root service, live PTY record, registry identity.
   */
  constructor({ service, session, registryId, name, connectionId, ownerSessionId, motd, sendTimeoutMs }) {
    this.service = service;
    this.session = session;
    this.registryId = registryId;
    this.sessionId = session.id;
    this.connectionId = connectionId;
    this.ownerSessionId = ownerSessionId;
    this.name = name;
    this.type = HARBOR_SSH_BACKEND_TYPE;
    this.motd = motd ?? "";
    this.takenOver = false;
    this.detached = false;
    this.renderedCursor = 0;
    this.renderTruncated = false;
    this.exitStatus = null;
    // Longest one send may wait. The backend never sets it; the default is the
    // production bound, and the seam exists so a test can watch it expire.
    this.sendTimeoutMs = Number.isFinite(sendTimeoutMs) && sendTimeoutMs > 0 ? sendTimeoutMs : SEND_TIMEOUT_MS;
  }

  /** Whether the registry may still route traffic to this session. */
  get alive() {
    return !this.detached && this.session.exited === null;
  }

  /** Remote shell process id, when the tty census learned it. */
  get pid() {
    return this.remotePid();
  }

  /** The person typed into the panel terminal: the agent may only read now. */
  markUserInput() {
    if (this.takenOver) return;
    this.takenOver = true;
    this.session.userOwned = true;
  }

  /** Start one exclusive send; the registry already fences concurrent sends. */
  startSend(request) {
    if (this.takenOver) throw new Error(TAKEN_OVER);
    if (!this.alive) throw new Error("this SSH terminal is no longer running; open a new terminal with terminal_open");
    const control = { cancelled: false, settled: false };
    let onAbort;
    const operation = {
      done: null,
      readOutput: () => this.consumeDelta(),
      cancel: () => {
        // A settled send is not cancelled — it already finished. Writing ^C
        // then would type into a terminal this call no longer owns: it kills
        // whatever the person (or the next tool call) started in the meantime,
        // and the registry may ask at any point after `done` resolved.
        if (control.cancelled || control.settled) return false;
        control.cancelled = true;
        // The interrupt is queued behind the written input, so it reaches the
        // command that input started — same ordering as the official backend.
        try { this.service.writeTerminalSession(this.session, "\u0003"); } catch {}
        return true;
      }
    };
    // A tool abort must stop the wait here; relying on the registry to call
    // cancel() left the send running to its 30-second deadline on hosts that
    // only abort the signal.
    if (request?.signal !== undefined) {
      if (request.signal.aborted) {
        // Already cancelled: do not write ^C into a terminal this call never
        // touched. runSend sees the flag and stops before sending anything.
        control.cancelled = true;
      } else {
        onAbort = () => operation.cancel();
        request.signal.addEventListener("abort", onAbort, { once: true });
      }
    }
    operation.done = this.runSend(request, control).finally(() => {
      if (onAbort !== undefined) request.signal.removeEventListener("abort", onAbort);
    });
    return operation;
  }

  /** Render a bounded page of the retained screen. */
  read(request = {}) {
    const rendered = this.renderText();
    return pageLines(rendered.split("\n"), request);
  }

  /** Deliver one allowed signal to the remote foreground process group. */
  async signal(signal) {
    if (this.takenOver) throw new Error(TAKEN_OVER);
    if (!this.alive) throw new Error("this SSH terminal is no longer running");
    if (signal === "SIGINT" || signal === "SIGTSTP") {
      if (!this.service.writeTerminalSession(this.session, signal === "SIGINT" ? "\u0003" : "\u001a")) {
        throw new Error("the SSH terminal channel is closed");
      }
    } else {
      // OpenSSH delivers the signal request to the remote session leader; the
      // names travel without the SIG prefix.
      const name = String(signal).replace(/^SIG/, "");
      if (typeof this.session.stream?.signal !== "function") throw new Error("this SSH transport cannot deliver signals");
      this.session.stream.signal(name);
    }
    return { delivered: true, targetPgid: this.remoteProcessGroup() };
  }

  /** Cached top-level process status, as the registry contract requires. */
  status() {
    if (this.exitStatus !== null) return this.exitStatus;
    const exit = this.session.exited;
    if (exit === null) return { kind: "running" };
    return { kind: "exited", exitCode: Number.isInteger(exit.code) ? exit.code : null, signal: null };
  }

  /** Close the PTY, unless the person took it over — then only unbind. */
  async close(_reason) {
    if (this.detached) return;
    this.detached = true;
    this.service.detachTerminalBinding(this);
    if (this.takenOver) {
      this.exitStatus = this.status();
      return;
    }
    await this.service.closeTerminalSession(this.session);
    this.exitStatus = this.status();
  }

  /**
   * One send: write input, then wait for readiness, silence or the deadline.
   *
   * The deadline bounds the whole wait and is checked on EVERY pass. A command
   * that keeps writing (`journalctl -f`, a noisy build) only ever resets
   * `lastChange`; behind the "output stopped" branches the deadline never ran,
   * so one terminal_send could stay open forever.
   */
  async runSend(request, control) {
    try {
      if (control.cancelled) throw new Error("the SSH terminal send was cancelled");
      this.renderedCursor = this.renderText().length;
      this.renderTruncated = false;
      const input = `${request.text}${request.submit ? "\r" : ""}`;
      if (input.length > 0 && !this.service.writeTerminalSession(this.session, input)) {
        throw new Error("the SSH terminal is no longer writing");
      }
      const deadline = Date.now() + this.sendTimeoutMs;
      let lastOffset = this.journalOffset();
      let lastChange = Date.now();
      let waitReason = "timeout";
      for (;;) {
        await delay(SEND_POLL_MS);
        if (control.cancelled) {
          // Stay inside the registry's existing wait-reason vocabulary; the
          // interrupt was already written, so the wait simply ends now.
          waitReason = "inferred_idle";
          break;
        }
        if (this.status().kind === "exited") {
          waitReason = "session_exit";
          break;
        }
        const offset = this.journalOffset();
        if (offset !== lastOffset) {
          // Still printing: this run has not settled yet.
          lastOffset = offset;
          lastChange = Date.now();
        } else {
          const silentFor = Date.now() - lastChange;
          if (!control.cancelled && silentFor >= PROMPT_SILENCE_MS && this.atPrompt()) {
            waitReason = "stdin_read";
            break;
          }
          if (silentFor >= IDLE_SILENCE_MS) {
            waitReason = "inferred_idle";
            break;
          }
        }
        // Bounds every send, streaming or not.
        if (Date.now() >= deadline) break;
      }
      const delta = this.consumeDelta();
      return { viewport: delta.delta, waitReason, sessionStatus: this.status(), truncated: delta.truncated };
    } finally {
      // Anything that runs after this point (a late abort listener, the
      // registry's own cleanup) must see the send as settled.
      control.settled = true;
    }
  }
  /** Output written since the previous operation read. */
  consumeDelta() {
    const rendered = this.service.renderTerminalSession(this.session);
    if (rendered.text.length < this.renderedCursor) {
      this.renderedCursor = 0;
      this.renderTruncated = true;
    }
    const delta = rendered.text.slice(this.renderedCursor);
    this.renderedCursor = rendered.text.length;
    const bounded = tailUtf8(delta, MAX_READ_BYTES);
    return {
      delta: bounded.text,
      truncated: this.renderTruncated || rendered.truncated || bounded.truncated
    };
  }

  /** Rendered retained screen for this PTY, without consuming a cursor. */
  renderText() {
    return this.service.renderTerminalSession(this.session).text;
  }

  /** Whether typing would reach a shell at its prompt right now. */
  atPrompt() {
    const tail = this.service.terminalSessionTail(this.session, 4096);
    if (promptFromTerminalData(tail) !== null) return true;
    // The fallback only looks at the end of the screen. Rendering the whole
    // journal here ran on every 50 ms poll; a 2 MB journal cost ~39 ms per
    // pass. The last 4 KB is all the regex can see anyway.
    const rendered = toReadableText(tail).trimEnd();
    if (rendered.length === 0) return false;
    // The rendered rule lives next to its raw counterpart in service/text.js.
    return endsWithPrompt(rendered);
  }

  /** Current UTF-16 end offset of the session's output journal. */
  journalOffset() {
    try { return this.service.terminalJournal(this.session).read().offset; } catch { return 0; }
  }

  /** Remote shell pid, once the connection's tty census has seen this tty. */
  remotePid() {
    try {
      const tty = this.session.tty;
      if (typeof tty !== "string" || tty === "") return undefined;
      const rows = this.service.connections?.get(this.connectionId)?.ttyCensus ?? [];
      const row = rows.find((candidate) => candidate.tty === tty);
      return Number.isInteger(row?.pid) ? row.pid : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Best local-number answer for `targetPgid`. SSH cannot observe the remote
   * process group from the host; the shell pid is the closest honest value and
   * 0 says "unknown" instead of inventing one.
   */
  remoteProcessGroup() {
    return this.remotePid() ?? 0;
  }
}

/** Registry backend that maps `harbor-ssh` sessions onto Harbor PTYs. */
export class HarborSshBackend {
  /** @param {object} hub - shared service hand-off. */
  constructor(hub = harborHub()) {
    this.hub = hub;
    this.type = HARBOR_SSH_BACKEND_TYPE;
    // owner session id -> queue tail. Spawn both opens and publishes the
    // registry binding, so two concurrent terminal_open calls used to race:
    // both passed liveAgentTerminal(), then both adopted the same PTY and
    // published two registry records. Serializing the whole spawn makes the
    // second call see the first binding and fail with "already has a terminal".
    this.spawnLocks = new Map();
  }

  /**
   * Create (or adopt) the conversation's PTY and publish it as a registry session.
   * @param {object} spec - registry spawn spec.
   * @returns {Promise<SshTerminalSession>}
   */
  async spawn(spec) {
    if (spec.owner?.session?.header?.origin === "subagent") throw new Error(SUBAGENT_REFUSAL);
    const service = this.hub.service ?? currentHarborService();
    if (service === null || service === undefined) {
      throw new Error("Harbor's SSH service is still loading; retry in a moment");
    }
    const ownerKey = service.terminalOwner(spec.owner) ?? "anonymous";
    const previous = this.spawnLocks.get(ownerKey) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const queued = previous.then(() => gate);
    this.spawnLocks.set(ownerKey, queued);
    await previous;
    try {
      const prepared = await service.openAgentTerminal({ owner: spec.owner, signal: spec.signal });
      const session = prepared.session;
      const rendered = service.renderTerminalSession(session).text;
      const motd = tailUtf8(rendered, MAX_MOTD_BYTES).text;
      const binding = new SshTerminalSession({
        service,
        session,
        registryId: String(spec.sessionId),
        name: spec.name,
        connectionId: prepared.connectionId,
        ownerSessionId: service.terminalOwner(spec.owner),
        motd
      });
      service.attachTerminalBinding(binding);
      return binding;
    } finally {
      release();
      if (this.spawnLocks.get(ownerKey) === queued) this.spawnLocks.delete(ownerKey);
    }
  }
}
