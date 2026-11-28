/**
 * Non-interactive exec channels, network-CLI fallback and the terminal input gate.
 */
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { extractCliPrompt, promptReturned, cliPageRequested, stripCliOutput, sanitizeCliCommand } from "../exec/network-cli.js";
import { assessShellCommand, CATEGORY_DELETE_FILES } from "../policy/safety.js";
import { buildTrashCommand, parseSimpleDeleteCommand, parseTrashOutput } from "../files/trash.js";
import { EXEC_CWD_ERROR_PREFIX, buildCwdAwareCommand, censusPidFor, execEchoWarning, extractExecCwd, posixLoginShell } from "../exec/cwd.js";
import { processTerminalInput } from "../terminal/input.js";
import { anonymousSessions, pickOwnerSession } from "../terminal/owner.js";
import { fail } from "../../rpc/envelope.js";
import { t } from "../../i18n/core.js";
import { appendCapped, tailCapped, normalizeTerminalEol } from "./text.js";
import { LOGIN_SHELL_PROBE_RETRY_MS, OPERATOR_APPROVAL_TTL_MS } from "./constants.js";

export const withExec = (Base) => class extends Base {
  // ── Agent-facing helpers (called directly by tools, not over the wire) ────

  /**
   * Open one non-interactive exec channel and collect stdout/stderr until the
   * channel closes or the timeout fires (then the channel is closed and the
   * timeout flag set). Shared by the batch channel (raw) and the agent
   * ssh_exec path (mirrored into the panel terminal).
   */
  async collectExecOutput(client, command, timeoutMs) {
    const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000;
    // One budget covers the whole operation: the channel-open round trip and
    // the command itself. ssh2 puts no timer on the exec request, so a peer
    // that accepts the packet but never opens the channel used to leave this
    // await pending forever — and every caller (ssh_exec, the monitor probe,
    // the login-shell probe, batch) hung on a promise that could never settle.
    const deadline = Date.now() + budget;
    const state = { exitCode: null, stdout: "", stderr: "", truncated: false, timedOut: false };
    const stream = await new Promise((resolve, reject) => {
      let settled = false;
      const openTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(null);
      }, budget);
      const opened = (error, openedStream) => {
        if (settled) {
          // The peer answered after the deadline: the channel belongs to
          // nobody now, so give it back instead of adopting it. destroy() is
          // end+close in ssh2; a bare close() would wait on the same silent
          // peer that just missed the deadline.
          try {
            if (typeof openedStream?.destroy === "function") openedStream.destroy();
            else openedStream?.close?.();
          } catch {}
          return;
        }
        settled = true;
        clearTimeout(openTimer);
        if (error) reject(error);
        else resolve(openedStream);
      };
      try {
        client.exec(command, { pty: false }, opened);
      } catch (error) {
        if (settled) return;
        settled = true;
        clearTimeout(openTimer);
        reject(error);
      }
    });
    if (stream === null || stream === undefined) {
      state.timedOut = true;
      state.openTimedOut = true;
      return state;
    }
    // One decoder per pipe: an SSH packet boundary can fall inside a UTF-8
    // sequence, and decoding each chunk on its own turned both halves into
    // U+FFFD (most visible with Chinese and emoji output).
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const collect = (which, decoder, text) => {
      const result = appendCapped(state[which], text, this.config.maxCommandOutputBytes);
      state[which] = result.text;
      state.truncated ||= result.truncated;
    };
    const flushDecoders = () => {
      collect("stdout", stdoutDecoder, stdoutDecoder.end());
      collect("stderr", stderrDecoder, stderrDecoder.end());
    };
    let settle = () => {};
    let settled = false;
    let timer;
    const onStdout = (chunk) => { collect("stdout", stdoutDecoder, stdoutDecoder.write(chunk)); };
    const onStderr = (chunk) => { collect("stderr", stderrDecoder, stderrDecoder.write(chunk)); };
    const onClose = (code) => {
      state.exitCode = typeof code === "number" ? code : null;
      finish(false);
    };
    const onError = () => { state.streamError = true; finish(true); };
    const cleanup = () => {
      clearTimeout(timer);
      stream.removeListener?.("data", onStdout);
      stream.removeListener?.("close", onClose);
      stream.removeListener?.("error", onError);
      stream.stderr?.removeListener?.("data", onStderr);
    };
    // Settling is local-first. `destroy()` is end+close in ssh2 and is what
    // releases the local channel bookkeeping and both data listeners; a bare
    // close() waits for a peer that just proved it does not answer.
    const finish = (destroy) => {
      if (settled) return;
      settled = true;
      flushDecoders();
      cleanup();
      if (destroy) { try { stream.destroy(); } catch {} }
      settle();
    };
    const finished = new Promise((resolve) => { settle = resolve; });
    stream.on("data", onStdout);
    stream.stderr?.on?.("data", onStderr);
    stream.on("close", onClose);
    stream.on("error", onError);
    const remaining = Math.max(1, deadline - Date.now());
    timer = setTimeout(() => { state.timedOut = true; finish(true); }, remaining);
    await finished;
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
    if (conn.loginShellProbe !== undefined) return conn.loginShellProbe;
    // A silent probe is retried later, not turned into a permanent fact: a
    // slow NFS home or a temporarily full MaxSessions looks exactly like a
    // network device, and caching "no shell" for the record's lifetime routed
    // every later exec through the interactive terminal with no way back.
    if (typeof conn.loginShellRetryAt === "number" && Date.now() < conn.loginShellRetryAt) {
      return Promise.resolve(null);
    }
    const probe = this.collectExecOutput(conn.client, "echo $SHELL", 10000)
      .then((state) => {
        const name = state.stdout.trim().split("/").pop() ?? "";
        // This probe is the authoritative exec-channel test in BOTH directions:
        // a timeout with nothing back may be the network-device signature (#33)
        // — or a healthy host having a bad minute — while a shell name coming
        // back proves the channel works, so a stall remembered earlier is
        // cleared instead of downgrading a healthy host for good.
        if (state.timedOut && state.stdout === "" && state.exitCode === null) {
          conn.execStalled = true;
          // Back off geometrically: a real network device would otherwise get
          // one fresh exec channel every minute for the life of the process.
          const failures = (conn.loginShellProbeFailures ?? 0) + 1;
          conn.loginShellProbeFailures = failures;
          const delay = Math.min(60 * 60 * 1000, LOGIN_SHELL_PROBE_RETRY_MS * 2 ** Math.min(failures - 1, 5));
          conn.loginShellRetryAt = Date.now() + delay;
          return null;
        }
        conn.execStalled = false;
        conn.loginShellProbeFailures = 0;
        conn.loginShellRetryAt = undefined;
        conn.loginShell = name.length > 0 ? name.toLowerCase() : null;
        return conn.loginShell;
      })
      .catch(() => {
        // Leave loginShell undefined: the next exec re-probes once the
        // transport is healthy again. This call keeps the plain behavior.
        return null;
      });
    conn.loginShellProbe = probe;
    const clear = () => { if (conn.loginShellProbe === probe) conn.loginShellProbe = undefined; };
    probe.then(clear, clear);
    return probe;
  }

  /**
   * A real exec channel completed. Whatever made the login-shell probe time
   * out is no longer true, so stop routing this connection to the terminal.
   * The cached shell name is left alone — an empty `$SHELL` is a fact about
   * the server, not a failure — only the probe backoff and the stall flag go.
   */
  markExecChannelHealthy(conn) {
    conn.execStalled = false;
    conn.loginShellProbeFailures = 0;
    conn.loginShellRetryAt = undefined;
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

  async execOnConnection(connectionId, command, timeoutMs = 30000, approvalToken, ownerSessionId) {
    const policy = this.resolveExecPolicy(connectionId, ownerSessionId);
    const decision = assessShellCommand(command, policy);
    let trashScript = null;
    if (!decision.ok) {
      // The pre-execute gate normally settles this, but a direct service call
      // (or a mode switch after the gate) must not consume a stale voucher
      // under a session that can no longer ask for authorization.
      if (policy.approval === "never") {
        return this.blockedExecResult(connectionId, command, t("本次对话的 DSH 权限模式不允许请求授权，危险命令未执行。请勿重试或绕行；请让操作者调整 DSH 权限。"), policy);
      }
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
    if (conn && result.ok && !result.value.timedOut) this.markExecChannelHealthy(conn);
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
    const promptLine = extractCliPrompt(this.terminalOutput(session).tail(1500));
    if (!promptLine) {
      return { ok: false, error: fail("cli-prompt-unrecognized", t("未能在终端尾部识别网络 CLI 提示符（支持 VRP/Comware 的 <主机名> 与 [视图名]，Cisco 的 主机名> 与 主机名#）。请确认终端空闲并停在提示符上后重试。")) };
    }
    const stream = session.stream;
    if (stream === null || stream === undefined || session.exited !== null) {
      return { ok: false, error: fail("cli-terminal-closed", "the SSH terminal channel is closed") };
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
    // One decoder for the whole exchange: an SSH packet boundary inside a
    // multi-byte character would otherwise show up as U+FFFD and break prompt
    // matching on the collected tail.
    const decoder = new StringDecoder("utf8");
    const onData = (chunk) => {
      const next = collected + decoder.write(chunk);
      if (Buffer.byteLength(next, "utf8") > maxBytes) truncated = true;
      collected = tailCapped(next, maxBytes);
    };
    try {
      stream.on("data", onData);
      // Clear any half-typed operator line, then submit the command.
      stream.write(`\x15${cliCommand}\r`);
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
          stream.write(" ");
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
      // The transport-loss path nulls session.stream while this loop runs; the
      // channel captured above is still the object the listener was attached
      // to, so detach from it instead of dereferencing a null field.
      try { stream.removeListener("data", onData); } catch {}
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
    const sent = posixLoginShell(shell) ? buildCwdAwareCommand(prepared, { tty: ownerSession?.tty ?? null, pid: censusPidFor(conn, ownerSession?.tty) }) : prepared;
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
      this.appendSessionOutput(ownerSession, `${display}\r\n${prompt}`, { observePrompt: false });
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
        // operator what to relax instead of retrying blindly. `policyBasis`
        // names the DSH session ceiling when one was applied.
 ...(policy ? { policy: policy.mode, policySource: policy.source } : {}),
 ...(policy?.dsh ? { policyBasis: policy.dsh.source } : {})
      }
    };
  }

  /**
   * Keep the local input-line mirror in sync with raw operator input written
   * directly to the PTY (the interactive browser terminal path). The agent-side
   * gate in tools/ssh-session.js reads this mirror when it evaluates a
   * terminal_send Enter; without syncing it here, a human-typed destructive
   * line would be invisible to the gate and a later agent-driven Enter could
   * submit it. Never blocks or rewrites — the operator is trusted on this path,
   * only the mirror is kept honest.
   */
  updateInputMirror(session, text) {
    session.inputRevision = (session.inputRevision ?? 0) + 1;
    if (typeof text !== "string") return;
    if (session.inputLine === undefined) session.inputLine = "";
    if (session.inputKnown === undefined) session.inputKnown = true;
    processTerminalInput(session, text, null);
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