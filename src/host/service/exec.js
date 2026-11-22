/**
 * Non-interactive exec channels, network-CLI fallback and the terminal input gate.
 */
import { randomUUID } from "node:crypto";
import { extractCliPrompt, promptReturned, cliPageRequested, stripCliOutput, sanitizeCliCommand } from "../network-cli.js";
import { assessShellCommand, CATEGORY_DELETE_FILES } from "../safety.js";
import { buildTrashCommand, parseSimpleDeleteCommand, parseTrashOutput } from "../trash.js";
import { EXEC_CWD_ERROR_PREFIX, buildCwdAwareCommand, execEchoWarning, extractExecCwd, posixLoginShell } from "../exec-cwd.js";
import { processTerminalInput } from "../terminal-input.js";
import { anonymousSessions, pickOwnerSession } from "../terminal-owner.js";
import { redactForModel } from "../redact.js";
import { fail } from "../envelope.js";
import { POLICY_NOTICE_PREFIX } from "../policy-messages.js";
import { t } from "../../i18n/core.js";
import { appendCapped, tailCapped, normalizeTerminalEol } from "./text.js";
import { OPERATOR_APPROVAL_TTL_MS } from "./constants.js";

export const withExec = (Base) => class extends Base {
  // ── Agent-facing helpers (called directly by tools, not over the wire) ────

  /**
   * Open one non-interactive exec channel and collect stdout/stderr until the
   * channel closes or the timeout fires (then the channel is closed and the
   * timeout flag set). Shared by the batch channel (raw) and the agent
   * ssh_exec path (mirrored into the panel terminal).
   */
  async collectExecOutput(client, command, timeoutMs) {
    const stream = await new Promise((resolve, reject) => {
      client.exec(command, { pty: false }, (error, s) => {
        if (error) reject(error);
        else resolve(s);
      });
    });
    const state = { exitCode: null, stdout: "", stderr: "", truncated: false, timedOut: false };
    // Settling is local-first: the timeout resolves NOW and only then tries
    // to close the channel. Settling via the 'close' event alone would depend
    // on the peer answering CHANNEL_CLOSE — a device that never responded to
    // the exec request will not respond to the close either, and the caller
    // would hang forever (#33). resolve() is idempotent, so a later close
    // event is harmless.
    let settle = () => {};
    const timer = setTimeout(() => {
      state.timedOut = true;
      settle();
      try { stream.close(); } catch {}
    }, timeoutMs);
    try {
      await new Promise((resolve) => {
        settle = resolve;
        stream.on("data", (chunk) => {
          const result = appendCapped(state.stdout, chunk.toString("utf8"), this.config.maxCommandOutputBytes);
          state.stdout = result.text;
          state.truncated ||= result.truncated;
        });
        stream.stderr.on("data", (chunk) => {
          const result = appendCapped(state.stderr, chunk.toString("utf8"), this.config.maxCommandOutputBytes);
          state.stderr = result.text;
          state.truncated ||= result.truncated;
        });
        stream.on("close", (code) => {
          state.exitCode = typeof code === "number" ? code : null;
          settle();
        });
        stream.on("error", () => { state.streamError = true; settle(); });
      });
    } finally {
      clearTimeout(timer);
    }
    return state;
  }

  /**
   * Run one command over a dedicated exec channel. No policy gate and no
   * terminal mirror: used by the batch channel, where the operator already
   * confirmed the command against a chosen server list. Returns raw output.
   */
  async execRawOnClient(client, command, timeoutMs = 30000) {
    try {
      return { ok: true, value: await this.collectExecOutput(client, command, timeoutMs) };
    } catch (error) {
      return { ok: false, error: fail("exec-failed", error.message) };
    }
  }

  /**
   * One-time probe of the connection's login shell — the binary sshd runs for
   * exec channels — cached on the connection record. `echo $SHELL` is a bare
   * variable expansion valid in every shell family, so the probe itself never
   * breaks fish/csh; unknown or exotic families keep the plain-exec behavior.
   * A transient probe failure clears itself so a later exec can retry.
   */
  resolveLoginShell(conn) {
    if (conn.loginShell !== undefined) return Promise.resolve(conn.loginShell);
    if (conn.loginShellProbe === undefined) {
      conn.loginShellProbe = this.collectExecOutput(conn.client, "echo $SHELL", 10000)
 .then((state) => {
          const name = state.stdout.trim().split("/").pop() ?? "";
          // This probe is the authoritative exec-channel test in BOTH
          // directions: a timeout with nothing back is the network-device
          // signature (#33) — the channel opened but the device never answers
          // it — while a shell name coming back proves the channel works, so a
          // stall remembered earlier (a slow, silent command that timed out)
          // is cleared instead of downgrading a healthy host for good.
          if (state.timedOut && state.stdout === "" && state.exitCode === null) conn.execStalled = true;
          else if (name.length > 0) conn.execStalled = false;
          conn.loginShell = name.length > 0 ? name.toLowerCase() : null;
        })
 .catch(() => {
          // Leave loginShell undefined: the next exec re-probes once the
          // transport is healthy again. This call keeps the plain behavior.
          conn.loginShellProbe = undefined;
        });
    }
    return conn.loginShellProbe.then(() => conn.loginShell);
  }

  /**
   * Run one command over a dedicated exec channel on a connection. The
   * command line and its output are ALSO appended to the connection's shell
   * session buffers (if any), so the panel shows what the agent did.
   */
  /**
   * The one terminal this caller acts on.
   *
   * Resolution is: the conversation's own live terminal, else the connection's
   * single anonymous terminal (claimed here, so "open a terminal in the panel,
   * then let the agent use it" survives the upgrade), else nothing. Never
   * "whichever shell happens to be first" — that is the sharing this change
   * removes.
   *
   * @param {string} connectionId - the server.
   * @param {unknown} ownerSessionId - the calling conversation.
   * @returns {object|undefined} the terminal record, when one exists.
   */
  ownerTerminalFor(connectionId, ownerSessionId) {
    const conn = this.connections.get(connectionId);
    if (conn === void 0) return undefined;
    const existing = pickOwnerSession(this.sessions, conn, ownerSessionId);
    if (existing !== undefined) return existing;
    const anonymous = anonymousSessions(this.sessions, conn);
    if (anonymous.length !== 1) return undefined;
    return this.claimTerminal(conn, anonymous[0], ownerSessionId);
  }

  async execOnConnection(connectionId, command, timeoutMs = 30000, _retried = false, approvalToken, ownerSessionId) {
    const policy = this.resolveExecPolicy(connectionId, ownerSessionId);
    const decision = assessShellCommand(command, policy);
    let trashScript = null;
    if (!decision.ok) {
      // A simple, fully-literal rm/unlink/rmdir is executed as the reversible
      // trash move, never as a real deletion — whether the operator approved
      // the ask or no approval exists at all. Real `rm` only ever happens
      // when the operator types it in their own terminal.
      if (decision.category === CATEGORY_DELETE_FILES) {
        const parsed = parseSimpleDeleteCommand(command);
        if (parsed) trashScript = buildTrashCommand(parsed.targets);
      }
      // The tools/pre-execute gate asked through the host approval channel
      // and, on "allow", recorded a voucher for THIS call. It is consumed
      // here exactly once and only for the same connection+command. Without
      // a valid grant the command stays blocked — as a structured result,
      // with no queue: the ask suspends the tool call itself, so there is
      // nothing left for a panel to approve after the fact.
      if (!(approvalToken !== undefined && this.consumeOperatorApproval(approvalToken, connectionId, command))) {
        return this.blockedExecResult(connectionId, command, t(decision.category ?? decision.reason), policy);
      }
      if (trashScript) {
        // Approved simple delete: the reversible trash move is what actually
        // runs on the exec channel; the agent sees its output like any exec.
        return await this.runPreparedExec(connectionId, trashScript, command, true, timeoutMs, ownerSessionId);
      }
      // Approved non-trash command: fall through and run it as written.
    }
    // Network-CLI routing (#33): a connection whose exec probe timed out
    // without a byte back has no POSIX exec channel (VRP, Comware, IOS…).
    // Type the command into the already-open interactive terminal and
    // complete on prompt return instead of hanging on exec.
    const conn = this.connections.get(connectionId);
    if (conn && !conn.dead && conn.loginShell === undefined) await this.resolveLoginShell(conn);
    // The flag is only trusted while the login shell is NOT known to be
    // POSIX: a host that answered `echo $SHELL` provably has a working exec
    // channel, so a stale flag must never divert it to the terminal.
    if (conn !== void 0 && conn.execStalled && !posixLoginShell(conn.loginShell)) {
      return this.cliExecOnConnection(conn, command, timeoutMs, ownerSessionId);
    }
    const result = await this.runPreparedExec(connectionId, command, command, false, timeoutMs, ownerSessionId);
    if (conn && result.ok && !result.value.timedOut) conn.execStalled = false;
    return result;
  }

  /**
   * Route to the interactive-terminal path when the connection has a live
   * PTY session; otherwise surface the plain-language "no terminal" error
   * (#33 P1) instead of a silent empty timeout.
   */
  async cliExecOnConnection(conn, command, timeoutMs = 30000, ownerSessionId) {
    // The command is typed into a terminal, so it must be THIS conversation's:
    // typing into another chat's shell is exactly the interference this change
    // removes (and the terminal it lands in would not even be visible here).
    const session = this.ownerTerminalFor(conn.id, ownerSessionId);
    if (!session) {
      return {
        ok: false,
        error: fail("cli-no-terminal", t("该设备不支持 exec 通道（网络 CLI 设备，如华为 VRP / 华三 Comware），且本会话在这台设备上还没有交互终端。请先在右侧 SSH 面板为本会话打开终端，再重试 ssh_exec；或在终端手动执行命令。"))
      };
    }
    return this.cliExecOnSession(conn, session, command, timeoutMs);
  }

  /**
   * Run one command on a network-CLI device by typing it into the interactive
   * terminal (#33). The device contract is "one line, one command, back to
   * the prompt", so completion is the prompt returning, not a channel close.
   * The command appears in the operator's terminal — intentional: the
   * operator sees what the agent typed. The destructive-command deny-list
   * has already run for this command in execOnConnection; this path adds the
   * format gate and its own serialization (one CLI query per connection).
   */
  async cliExecOnSession(conn, session, command, timeoutMs = 30000) {
    // Serialized per terminal, not per connection: another conversation's query
    // on the same device must not block or interleave with this one.
    if (session.cliBusy) {
      return { ok: false, error: fail("cli-busy", t("该网络设备的上一条查询尚未完成，请稍候再试")) };
    }
    const screened = sanitizeCliCommand(command);
    if (!screened.ok) {
      return { ok: false, error: fail("cli-invalid-command", t(`无法在终端执行该命令：${screened.reason}`)) };
    }
    const cliCommand = screened.value;
    const promptLine = extractCliPrompt(session.buffer.slice(-1500));
    if (!promptLine) {
      return { ok: false, error: fail("cli-prompt-unrecognized", t("未能在终端尾部识别网络 CLI 提示符（支持 VRP/Comware 的 <主机名> 与 [视图名]，Cisco 的 主机名> 与 主机名#）。请确认终端空闲并停在提示符上后重试。")) };
    }
    const startedAt = new Date().toISOString();
    const startedAtMs = Date.now();
    session.cliBusy = true;
    // Bounded collection. The rolling TAIL is what prompt detection needs
    // (the device's prompt is the last line), and it is also the part worth
    // keeping for diagnosis — an unbounded buffer could otherwise pour the
    // full 200-page maximum of one `display` command straight into the
    // agent's context. Bytes dropped off the front are reported honestly.
    const maxBytes = this.config.maxCommandOutputBytes;
    let collected = "";
    let truncated = false;
    const onData = (chunk) => {
      const next = collected + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > maxBytes) truncated = true;
      collected = tailCapped(next, maxBytes);
    };
    try {
      session.stream.on("data", onData);
      // Clear any half-typed operator line, then submit the command.
      session.stream.write(`\x15${cliCommand}\r`);
      session.inputLine = "";
      session.inputKnown = true;
      const deadline = startedAtMs + timeoutMs;
      let pages = 0;
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 80));
        const text = collected;
        // Completion first: a prompt return ends the command even if an
        // older ---- More ---- marker is still inside the window — the
        // collected text keeps every past marker, so checking paging first
        // would loop forever on short final pages (#33 follow-up).
        if (promptReturned(text, promptLine)) break;
        if (cliPageRequested(text)) {
          if (pages >= 200) {
            return { ok: false, error: fail("cli-paging-loop", t("终端分页请求超过 200 次，查询已中止")) };
          }
          pages += 1;
          session.stream.write(" ");
          continue;
        }
        if (Date.now() >= deadline) {
          // Unfinished output: drop the echoed command line but keep the
          // tail as-is (there is no prompt to strip), and say timedOut.
          const stdout = stripCliOutput(text, promptLine, cliCommand, { timedOut: true });
          return {
            ok: true,
            value: {
              exitCode: null,
              stdout,
              stderr: "",
              cwd: null,
              commandId: `cli-${randomUUID()}`,
              startedAt,
              finishedAt: new Date().toISOString(),
              durationMs: Date.now() - startedAtMs,
              truncated,
              timedOut: true
            }
          };
        }
      }
      const stdout = stripCliOutput(collected, promptLine, cliCommand);
      return {
        ok: true,
        value: {
          exitCode: null,
          stdout,
          stderr: "",
          cwd: null,
          commandId: `cli-${randomUUID()}`,
          startedAt,
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAtMs,
          truncated,
          timedOut: false
        }
      };
    } finally {
      session.stream.removeListener("data", onData);
      session.cliBusy = false;
    }
  }

  async runPreparedExec(connectionId, prepared, displayCommand, trashRun, timeoutMs = 30000, ownerSessionId) {
    const conn = this.connections.get(connectionId);
    if (conn === void 0) return { ok: false, error: fail("no-connection", `connection "${connectionId}" does not exist`) };
    if (!(await this.ensureAlive(conn))) {
      return { ok: false, error: fail("connection-lost", `connection "${connectionId}" is down and could not be re-established`) };
    }
    // An exec channel always starts in the login home directory — the caller's
    // terminal may be somewhere else entirely. When the login shell is
    // POSIX-family, prepend the interactive-cwd prologue (see exec-cwd.js) so
    // the command runs where THAT terminal is, and the resolved directory comes
    // back on a stripped marker line. With several terminals per transport "the
    // one shell" no longer exists, so the prologue targets the learned tty.
    const ownerSession = this.ownerTerminalFor(connectionId, ownerSessionId);
    const shell = await this.resolveLoginShell(conn);
    const sent = posixLoginShell(shell) ? buildCwdAwareCommand(prepared, { tty: ownerSession?.tty ?? null }) : prepared;
    const commandId = randomUUID();
    const startedAt = new Date().toISOString();
    const startedAtMs = Date.now();
    const client = conn.client;
    let state;
    try {
      state = await this.collectExecOutput(client, sent, timeoutMs);
    } catch (error) {
      // The transport may have died between the liveness check and the exec.
      if (conn.dead || conn.client !== client) {
        return { ok: false, error: fail("exec-outcome-unknown", t("SSH 在收到命令结果前断开。执行结果未知，请检查远端状态后再决定是否重试。")) };
      }
      return { ok: false, error: fail("exec-failed", error.message) };
    }
    if (!state.timedOut && state.exitCode === null && (conn.dead || conn.client !== client || state.streamError)) {
      return { ok: false, error: fail("exec-outcome-unknown", t("SSH 在收到命令结果前断开。执行结果未知，请检查远端状态后再决定是否重试。")) };
    }
    const { cwd, stdout: execStdout } = extractExecCwd(state.stdout);
    let stdout = execStdout;
    let trashEvents = null;
    if (trashRun) {
      const parsed = parseTrashOutput(execStdout);
      stdout = parsed.stdout;
      trashEvents = parsed.events.filter((event) => event.event !== "purged");
    }
    const { stderr } = state;
    if (state.exitCode === 125 && cwd === null && stderr.startsWith(EXEC_CWD_ERROR_PREFIX)) {
      return { ok: false, error: fail("cwd-unavailable", stderr.trim()) };
    }
    // Mirror the command and output into the caller's own terminal only, so the
    // panel displays agent-driven commands of THIS conversation. Broadcasting
    // into every shell of the connection was visible cross-talk: another chat's
    // terminal showed commands it never asked for. No steady-state label: the
    // `$ ` prefix is the established agent marker and, with the cwd inherited,
    // output is consistent with the visible prompt. A dim warning appears only
    // in the fallback case (cwd undetected — the exec ran from the home
    // directory, so output may contradict the prompt). A trash run echoes the
    // plain original command: the rollback margin is silent, the terminal looks
    // exactly as it always did.
    const warning = execEchoWarning(cwd);
    const display = normalizeTerminalEol(`${warning ? `${warning}\n` : ""}$ ${displayCommand}\n${stdout}${stderr.length > 0 ? stderr : ""}`)
 .replace(/(?:\r\n)+$/, "");
    if (ownerSession !== void 0 && ownerSession.exited === null && ownerSession.stream !== null) {
      const prompt = ownerSession.lastPrompt ?? this.fallbackPrompt(conn);
      // exec() is a separate non-interactive SSH channel. It never makes
      // the PTY shell emit a prompt, so restore the last real prompt here.
      this.appendSessionOutput(ownerSession, `${display}\r\n${prompt}`, { capture: false, observePrompt: false });
    }
    const value = {
      exitCode: state.exitCode,
      stdout,
      stderr,
      cwd,
      display,
      commandId,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAtMs,
      truncated: state.truncated,
      timedOut: state.timedOut
    };
    if (trashEvents !== null && trashEvents.length > 0) {
      // Keep the outcome, not just the path: sftp_delete must be able to tell
      // "moved" from "missing" and "failed" (the script itself always exits 0).
      value.trashed = trashEvents.map((event) => ({
        original: event.original,
        status: event.event,
        ...(event.trashPath ? { trashPath: event.trashPath } : {})
      }));
    }
    return { ok: true, value };
  }

  /**
   * Build the ssh_exec result for a blocked destructive command that carried
   * no valid operator approval voucher. Since the ask flow replaced the
   * confirmation cards this is a pure deny path — nothing is queued anywhere;
   * the agent is expected to stop retrying and let the operator act.
   */
  blockedExecResult(connectionId, command, reason, policy = null) {
    const now = new Date().toISOString();
    return {
      blocked: true,
      value: {
        exitCode: null,
        stdout: "",
        stderr: "",
        cwd: null,
        commandId: "(blocked)",
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        truncated: false,
        timedOut: false,
        blocked: true,
        reason,
        command,
        // The tier that produced this rejection, so the agent can tell the
        // operator what to relax instead of retrying blindly.
 ...(policy ? { policy: policy.mode, policySource: policy.source } : {})
      }
    };
  }

  /**
   * Send raw input into ONE terminal: the caller's own.
   *
   * This used to fan out to every shell of the connection (`for (const
   * sessionId of conn.sessions)`), which is how two chats' agents typed into
   * each other's terminal. Input lands in exactly one shell now, and a caller
   * with no terminal gets an honest error instead of a silent 0-byte success.
   */
  writeToConnection(connectionId, input, ownerSessionId) {
    const conn = this.connections.get(connectionId);
    if (conn === void 0) return { ok: false, error: fail("no-connection", `connection "${connectionId}" does not exist`) };
    const target = this.ownerTerminalFor(connectionId, ownerSessionId);
    if (target === undefined) {
      return { ok: false, error: fail("no-terminal", t("这个会话在这台服务器上还没有交互终端。请先在右侧面板为本会话打开终端，再重试。")) };
    }
    // The tier resolves per connection and conversation: the operator's switch
    // and the conversation that set it both travel with the caller.
    const policy = this.resolveExecPolicy(connectionId, ownerSessionId);
    try {
      const guarded = this.prepareTerminalInput(target, input, policy);
      if (guarded.forwarded) target.stream.write(guarded.forwarded);
      if (guarded.blockedReason) return { ok: false, error: fail("unsafe-command", guarded.blockedReason) };
      return { ok: true, value: { written: guarded.forwarded.length } };
    } catch (error) {
      return { ok: false, error: fail("write-failed", error.message) };
    }
  }

  /** Add a local policy notice to the same buffer rendered by the terminal. */
  appendTerminalNotice(session, message) {
    this.appendSessionOutput(session, `\r\n\x1b[33m${t(POLICY_NOTICE_PREFIX)} ${message}\x1b[0m\r\n`);
  }

  /**
   * Preserve normal terminal editing, but submit a line only after host-side
   * policy approval. A denied line is cleared with Ctrl-U before the shell can
   * execute it. History navigation and tab completion fail closed as well.
   */
  prepareTerminalInput(session, text, policy = null) {
    session.inputRevision = (session.inputRevision ?? 0) + 1;
    const { forwarded, blockedReason } = processTerminalInput(session, text, (line) => assessShellCommand(line, policy ?? undefined));
    if (blockedReason !== null) this.appendTerminalNotice(session, blockedReason);
    return { forwarded, blockedReason };
  }

  /**
   * Keep the local input-line mirror in sync with raw operator input written
   * directly to the PTY (the interactive browser terminal path). The agent's
   * prepareTerminalInput() gate relies on this mirror; without syncing it
   * here, a human-typed destructive line would be invisible to the gate and a
   * later agent-driven Enter could submit it. Mirrors the per-char tracking of
   * prepareTerminalInput but never blocks or rewrites — the operator is trusted
   * on this path, only the mirror is kept honest.
   */
  updateInputMirror(session, text) {
    session.inputRevision = (session.inputRevision ?? 0) + 1;
    if (typeof text !== "string") return;
    if (session.inputLine === undefined) session.inputLine = "";
    if (session.inputKnown === undefined) session.inputKnown = true;
    processTerminalInput(session, text, null);
  }

  /**
   * Buffered text of the CALLER'S terminal.
   *
   * Reading "the first live shell" handed one conversation another's output —
   * including whatever the other operator had typed or pasted. The reading
   * cursors (`lastReadRaw`/`lastReadRedacted`) live on the session, so two
   * conversations also no longer share a "new output" position.
   */
  readConnectionOutput(connectionId, mode, ownerSessionId) {
    const conn = this.connections.get(connectionId);
    if (conn === void 0) return { ok: false, error: fail("no-connection", `connection "${connectionId}" does not exist`) };
    // Resolving may adopt the connection's single anonymous terminal, which is
    // the "open a terminal, then ask the agent to look at it" path.
    const first = this.ownerTerminalFor(connectionId, ownerSessionId);
    if (first === void 0) {
      return { ok: true, value: { data: "", hasSession: false, truncated: false, redacted: false } };
    }
    // Default "new": hand back only what arrived since the previous read —
    // re-sending the whole tail would make the model re-pay for output it
    // already holds. "tail" keeps the legacy full-capture behavior.
    let data = first.captureBuffer;
    let truncated = first.captureHasDropped === true;
    if (mode !== "tail") {
      const previous = first.lastReadRedacted;
      const baseline = first.lastReadRaw;
      const pending = first.capturePendingBuffer ?? "";
      const canContinue = typeof baseline === "string" && !first.capturePendingTruncated;
      // Rebuild the unread view from the previous raw snapshot and bounded new
      // output. This remains incremental after captureBuffer has rolled over.
      // Redact before slicing so credentials spanning reads cannot leak.
      const raw = canContinue ? baseline + pending : first.captureBuffer;
      const complete = redactForModel(raw).text;
      data = canContinue && typeof previous === "string" && complete.startsWith(previous)
        ? complete.slice(previous.length)
 : complete;
      truncated = !canContinue && (first.capturePendingTruncated || first.captureHasDropped === true);
      // Keep the baseline bounded even if the prior snapshot and pending
      // output together exceed the rolling capture limit.
      first.lastReadRaw = tailCapped(raw, this.config.maxCaptureBytes);
      first.lastReadRedacted = redactForModel(first.lastReadRaw).text;
      first.capturePendingBuffer = "";
      first.capturePendingTruncated = false;
    }
    const redaction = redactForModel(data);
    return {
      ok: true,
      value: {
        data: redaction.text,
        hasSession: true,
        truncated,
        redacted: redaction.redacted
      }
    };
  }

  /**
   * Record a grant from the operator approval channel for one execution. The
   * tools/pre-execute gate calls this after the host's approval UI answered
   * "allow"; the tool body consumes it below. TTL-bounded (5 minutes) purely
   * as a leak valve — a live execution consumes its grant immediately.
   */
  recordOperatorApproval(callId, connectionId, command) {
    if (callId === undefined) return;
    // Partially-constructed instances in unit tests never initialized the map.
    if (this.operatorApprovals === undefined) this.operatorApprovals = new Map();
    const previous = this.operatorApprovals.get(callId);
    if (previous?.timer !== undefined) clearTimeout(previous.timer);
    const ttl = this.operatorApprovalTtlMs ?? OPERATOR_APPROVAL_TTL_MS;
    const expiresAt = Date.now() + ttl;
    const timer = setTimeout(() => {
      const current = this.operatorApprovals?.get(callId);
      if (current?.expiresAt === expiresAt) this.operatorApprovals.delete(callId);
    }, ttl);
    timer.unref?.();
    this.operatorApprovals.set(callId, { connectionId, command, expiresAt, timer });
  }

  /**
   * Consume the approval voucher for one execution: exactly once, only for
   * the same connection and command the operator actually saw and allowed.
   * A mismatched or stale (TTL 5 min) voucher is silently not a grant — the
   * inner gate then denies as if no approval existed.
   */
  consumeOperatorApproval(callId, connectionId, command) {
    const approvals = this.operatorApprovals;
    if (callId === undefined || approvals === undefined) return false;
    const voucher = approvals.get(callId);
    if (voucher === undefined) return false;
    approvals.delete(callId);
    if (voucher.timer !== undefined) clearTimeout(voucher.timer);
    if (Date.now() >= voucher.expiresAt) return false;
    return voucher.connectionId === connectionId && voucher.command === command;
  }
};