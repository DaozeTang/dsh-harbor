/**
 * SSH transport lifecycle: connect, host-key TOFU, keepalive, transparent reconnect.
 */
import net from "node:net";
import { randomUUID } from "node:crypto";
import { fail } from "../envelope.js";
import { t } from "../../i18n/core.js";
import { isTransientConnectError } from "../net-errors.js";
import { isIdentMismatchError, withRepairedBanner } from "../ssh-banner.js";
import { createAuthTracker, makeAuthHandler, classifyConnectFailure, formatConnectFailure, wasAuthCut } from "../ssh-auth.js";
import { applyAgentForwarding } from "../ssh-agent.js";
import { decideHostKey, keyFingerprint, blobAlgorithm, DEFAULT_HOST_KEY_MODE } from "../hostkey.js";
import { noConnectionGuidance } from "../agent-connect.js";
import { sharedCredentialRefs, profileCredentialRefs } from "./models.js";
import { KEEPALIVE_INTERVAL_MS, KEEPALIVE_COUNT_MAX, CONNECT_RETRIES, LEGACY_VRP_ALGORITHMS, isKexMismatchError, RECONNECT_BASE_DELAY_MS, RECONNECT_MAX_DELAY_MS, RECONNECT_WAIT_MS } from "./constants.js";

export const withConnections = (Base) => class extends Base {
  async connect(request) {
    let resolvedRequest = request;
    if (request.credentialId !== undefined) {
      try {
        const credential = this.requireCredentialTable().get(request.credentialId);
        if (credential === undefined) return { ok: false, error: fail("no-credential", `SSH credential "${request.credentialId}" does not exist`) };
        const refs = sharedCredentialRefs(request.credentialId);
        const auth = await this.resolveCredentialAuth(refs, credential.authKind);
        if (auth === undefined) return { ok: false, error: fail("credential-missing", `shared credential "${credential.name}" has no saved ${credential.authKind === "password" ? "password" : "private key"}`) };
        resolvedRequest = { ...request, auth };
      } catch (error) { return { ok: false, error: fail("credential-connect-failed", error.message) }; }
    }
    if (Array.isArray(resolvedRequest.proxyJumpProfileIds) && resolvedRequest.proxyJumpProfileIds.length > 0) {
      try {
        const seen = new Set();
        const proxyJump = [];
        for (const profileId of request.proxyJumpProfileIds) {
          if (seen.has(profileId)) return { ok: false, error: fail("jump-duplicate", t("同一条跳板链不能重复选择同一台服务器")) };
          seen.add(profileId);
          const profile = this.requireProfileTable().get(profileId);
          if (profile === undefined) return { ok: false, error: fail("no-profile", `jump-host profile "${profileId}" does not exist`) };
          const refs = profile.credentialId ? sharedCredentialRefs(profile.credentialId) : profileCredentialRefs(profileId);
          const auth = await this.resolveCredentialAuth(refs, profile.authKind);
          if (auth === undefined) return { ok: false, error: fail("credential-missing", `jump host "${profile.name}" has no saved credential`) };
          proxyJump.push({ host: profile.host, port: profile.port, username: profile.username, hostKeyMode: profile.hostKeyMode, auth });
        }
        return await this.connectInternal({ ...resolvedRequest, proxyJump });
      } catch (error) { return { ok: false, error: fail("profile-jump-connect-failed", error.message) }; }
    }
    return this.connectInternal(resolvedRequest);
  }

  async connectInternal(request, profileId = undefined, { activate = true } = {}) {
    const id = request.name ? `${request.name}-${randomUUID().slice(0, 8)}` : randomUUID();
    const connectConfig = {
      host: request.host,
      port: request.port ?? 22,
      username: request.username,
      readyTimeout: request.readyTimeout ?? 20000,
      keepaliveInterval: request.keepaliveInterval ?? KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: request.keepaliveCountMax ?? KEEPALIVE_COUNT_MAX
    };
    // Dual-factor devices require both factors on the same connection: apply
    // the primary and, when present, the secondary to the ssh2 config so the
    // auth handler can walk password → publickey in either server order.
    if (request.auth.password !== undefined) connectConfig.password = request.auth.password;
    if (request.auth.privateKey !== undefined) connectConfig.privateKey = request.auth.privateKey;
    if (request.auth.passphrase !== void 0) connectConfig.passphrase = request.auth.passphrase;
    if (request.auth.secondary?.kind === "key") {
      connectConfig.privateKey = request.auth.secondary.privateKey;
      if (request.auth.secondary.passphrase !== void 0) connectConfig.passphrase = request.auth.secondary.passphrase;
    } else if (request.auth.secondary?.kind === "password") {
      connectConfig.password = request.auth.secondary.password;
    }
    // Opt-in SSH agent forwarding (jump-host workflows): wire the local agent
    // into the config BEFORE the record exists — a missing agent is an
    // environment problem the user must fix, not a transient failure worth
    // retrying. On success every shell/exec channel on this connection
    // requests forwarding (ssh2 handles the auth-agent channel plumbing), and
    // the agent also becomes an additional auth method for the handshake.
    const agentApplied = applyAgentForwarding(connectConfig, request.agentForward === true);
    if (!agentApplied.ok) {
      return { ok: false, error: fail(agentApplied.error.code, agentApplied.error.message) };
    }
    const record = {
      id,
      client: null,
      hops: [],
      host: connectConfig.host,
      port: connectConfig.port,
      username: connectConfig.username,
      name: request.name,
      profileId,
      sessions: new Set(),
      sftp: null,
      tunnels: new Map(),
      // Transport health / self-healing state: keep the auth config around so
      // a dropped transport can be re-established transparently instead of
      // forcing the user to open a brand-new session.
      connectConfig,
      // Legacy-KEX policy for this connection: an explicit request disables
      // the automatic retry, because the user already told us what to use.
      legacyAlgorithms: request.legacy === true,
      legacyFallback: false,
      // Identification-string repair: ssh2's parser refuses a few banners that
      // OpenSSH accepts, reporting them as a bare "Invalid identification
      // string". Set only after such a real rejection, so a healthy peer never
      // takes that path; `bannerRepairNote` explains what was rewritten.
      bannerRepair: false,
      bannerRepairNote: null,
      // `legacy: false` is an explicit "modern only, do NOT downgrade" — the
      // automatic retry is opt-out, not merely opt-in.
      allowLegacyDowngrade: request.legacy === undefined,
      // Authentication-stage telemetry: which methods were offered, what the
      // server still accepts, whether a keyboard-interactive prompt was
      // served. Feeds the structured connect-failure diagnosis and the
      // one-shot keyboard-interactive → plain-password fallback.
      authTracker: createAuthTracker(),
      kbdFallbackTried: false,
      proxyJump: Array.isArray(request.proxyJump) ? request.proxyJump : [],
      // Host-key TOFU mode for this connection (undefined → accept-new default
      // resolved in attachHostVerifier). Persisted on the record so transparent
      // reconnects re-check with the same policy.
      hostKeyMode: request.hostKeyMode,
      dead: true,
      closing: false,
      connecting: true,
      reconnectTimer: null,
      reconnectAttempts: 0,
      reconnectWaiters: []
    };
    this.connections.set(id, record);
    let connected;
    try {
      connected = await this.connectClient(record, request.retries ?? CONNECT_RETRIES);
    } catch (error) {
      try { record.client?.end(); } catch {}
      for (const hop of record.hops) { try { hop.end(); } catch {} }
      this.connections.delete(id);
      return { ok: false, error: fail("connect-failed", error?.message ?? String(error)) };
    } finally {
      record.connecting = false;
    }
    if (!connected.ok) {
      this.connections.delete(id);
      return connected;
    }
    this.attachTransportHandlers(record);
    const value = {
      connectionId: id,
      host: connectConfig.host,
      port: connectConfig.port,
      username: connectConfig.username
    };
    // See list(): the RPC gateway rejects `undefined` as a JSON value.
    if (request.name !== undefined) value.name = request.name;
    // Surface anything unusual about the handshake to the caller. Both warnings
    // can apply to one connection, so they accumulate rather than overwrite.
    const warnings = [];
    // A downgraded handshake must never be silent: a weakened transport is worse
    // than a slow one, because nobody thinks to upgrade the device afterwards.
    if (record.legacyFallback) {
      value.legacyFallback = true;
      warnings.push("This server offered no modern SSH key exchange; connected with the legacy diffie-hellman-group14-sha1 algorithm. The transport is weaker than the default — upgrade the device firmware when possible.");
    }
    // Nor must a rewritten banner: the peer is off-specification, and the user
    // should know the connection only exists because the line was repaired.
    if (record.bannerRepair) {
      value.bannerRepair = true;
      warnings.push(t(`对端的 SSH 横幅不符合 RFC 4253，ssh2 会直接拒绝这条连接；本次已按规范化后的横幅完成握手。${record.bannerRepairNote ?? ""}`));
    }
    if (warnings.length > 0) value.warning = warnings.join("\n");
    // A newly connected server is the natural target for the conversation,
    // even if the browser has not rendered its PTY yet. Ephemeral batch
    // connections opt out: they are disconnected right after their command and
    // must not steal (or later clear) the operator's active server.
    if (activate) this.activeConnectionId = id;
    return {
      ok: true,
      value
    };
  }

  // ── host-key TOFU ──────────────────────────────────────────────────────────

  /**
   * Build an ssh2 `hostVerifier` (key, verify) => boolean for a host:port.
   * Decides accept/record/reject against the known_hosts store; on rejection
   * stashes a verdict on `state` so the caller surfaces a non-retriable error,
   * and on first-seen acceptance stashes a record-to-persist after `ready`.
   */
  makeHostVerifier(state, host, port, mode) {
    return (key) => {
      try {
        const algorithm = blobAlgorithm(key);
        const presented = keyFingerprint(key);
        const known = this.knownHosts?.get(host, port);
        const verdict = decideHostKey({ mode, known, presentedFingerprint: presented, algorithm });
        if (!verdict.accept) {
          state.hostKeyMismatch = { reason: verdict.reason, host, port, mode, expected: verdict.expected, got: verdict.got ?? presented };
          return false;
        }
        if (verdict.record) {
          state.hostKeyToRecord = { host, port, fingerprint: verdict.record.fingerprint, algorithm: verdict.record.algorithm };
        }
        return true;
      } catch (error) {
        state.hostKeyMismatch = { reason: "verifier-error", host, port, mode, message: error.message };
        return false;
      }
    };
  }

  /** Attach a TOFU verifier to an ssh2 connect config (no-op when off or store not ready). */
  attachHostVerifier(config, state, host, port, mode) {
    const effective = mode ?? DEFAULT_HOST_KEY_MODE;
    if (this.knownHosts === null || effective === "off") return;
    config.hostVerifier = this.makeHostVerifier(state, host, port, effective);
  }

  /** Persist a first-seen host key after a successful handshake. */
  async persistFirstSeenHostKey(state) {
    const pending = state.hostKeyToRecord;
    if (!pending) return;
    state.hostKeyToRecord = null;
    if (this.knownHosts !== null) {
      await this.knownHosts.record(pending.host, pending.port, { fingerprint: pending.fingerprint, algorithm: pending.algorithm });
    }
  }

  /** Turn a stashed host-key verdict into a non-retriable result error. */
  hostKeyError(m) {
    const where = `${m.host}:${m.port}`;
    if (m.reason === "unseen-host") {
      return fail("host-key-unseen", `host key for ${where} is not previously trusted (mode ${m.mode}). Presented SHA256:${m.got}; verify it out of band. Strict mode will not create a trust record; follow your approved process before changing the profile policy.`);
    }
    if (m.reason === "host-key-mismatch") {
      return fail("host-key-mismatch", t(`host key for ${where} changed (mode ${m.mode}). Expected SHA256:${m.expected}; presented SHA256:${m.got}. This may be a man-in-the-middle or a re-provisioned server. Verify it out of band; if legitimate, use "忘记主机指纹" and reconnect.`));
    }
    return fail("host-key-error", `host key verification error for ${where} (mode ${m.mode}): ${m.message ?? m.reason}`);
  }

  /**
   * Establish (or re-establish) the ssh2 transport of a connection record.
   * Transient network failures are retried with backoff; authentication
   * failures are not.
   */
  async connectClient(record, retries = CONNECT_RETRIES) {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (record.closing) {
        return { ok: false, error: fail("connect-cancelled", `connection "${record.id}" was closed`) };
      }
      // Build the jump chain first (if configured): each hop connects through
      // the previous one via forwardOut, producing a stream that becomes the
      // `sock` of the target connection. On failure the whole chain is torn down.
      let sock;
      if (record.proxyJump.length > 0) {
        try {
          const chain = await this.connectChain(record.proxyJump, record.connectConfig.host, record.connectConfig.port);
          // A retry/reconnect builds a brand-new chain; the previous hops have
          // no other owner and would otherwise keep sockets and keepalive
          // timers alive for the rest of the process.
          for (const hop of record.hops) { try { hop.end(); } catch {} }
          record.hops = chain.hops;
          sock = chain.sock;
        } catch (error) {
          lastError = error;
          if (error?.code === "host-key-mismatch" || error?.code === "host-key-unseen" || error?.code === "host-key-error") {
            return { ok: false, error: fail(error.code, error.message) };
          }
          if (attempt >= retries) break;
          await this.sleep(Math.min(2000, 500 * 2 ** attempt));
          continue;
        }
      }
      // A peer whose banner ssh2 refused gets one more attempt with that line
      // normalized first (ssh-banner.js). This is reached only after such a real
      // rejection, so a healthy peer keeps ssh2's own socket handling.
      if (record.bannerRepair) {
        try {
          sock = await this.openRepairedSock(record, sock);
        } catch (error) {
          lastError = error;
          for (const hop of record.hops) { try { hop.end(); } catch {} }
          record.hops = [];
          if (record.closing || attempt >= retries) break;
          await this.sleep(Math.min(2000, 500 * 2 ** attempt));
          continue;
        }
      }
      const client = this.newClient();
      record.client = client;
      try {
        await new Promise((resolve, reject) => {
          // ssh2 can emit several protocol errors while a handshake is dying
          // (observed live: "Connection lost before handshake" twice in a
          // row). The first event settles the wait; the standing error
          // listener must outlive it, because an 'error' emission with zero
          // listeners crashes the whole DSH process. A cancelled connect is
          // broken out of via the close event below.
          let settled = false;
          const onReady = () => { if (!settled) { settled = true; resolve(); } };
          const onError = (cause) => { if (!settled) { settled = true; reject(cause); } };
          const onClose = () => { if (!settled) { settled = true; reject(new Error("connection closed before handshake completed")); } };
          client.once("ready", onReady);
          client.on("error", onError);
          client.once("close", onClose);
          const config = { ...record.connectConfig };
          // Single source of truth for the legacy KEX set: `legacy: true`
          // seeds the flag, an automatic downgrade flips it mid-loop, and this
          // is the only place a handshake's options are assembled (so the two
          // paths can never drift apart).
          if (record.legacyAlgorithms) {
            config.algorithms = { ...(config.algorithms ?? {}), ...LEGACY_VRP_ALGORITHMS };
          }
          // Keyboard-interactive support: only when a saved password exists to
          // answer prompts with, and never on the plain-password fallback
          // attempt (where the device killed the transport mid-prompt).
          const hasPassword = record.connectConfig.password !== undefined;
          config.tryKeyboard = hasPassword && !record.kbdFallbackTried;
          if (config.tryKeyboard) {
            client.on("keyboard-interactive", (name, instructions, instructionsLang, prompts, finish) => {
              record.authTracker.kbdSeen = true;
              finish(prompts.map(() => record.connectConfig.password));
            });
          }
          // ssh2's own default handler walks the same method order; this one
          // additionally records what was tried and what the server accepts,
          // so a failed login produces a diagnosis instead of a bare line.
          config.authHandler = makeAuthHandler(record.authTracker, {
            hasPassword,
            hasPrivateKey: record.connectConfig.privateKey !== undefined,
            // A forwarded agent doubles as an auth source (ssh2's separate
            // "agent" method), so a keyless resource can still log in.
            hasAgent: typeof record.connectConfig.agent === "string",
            tryKeyboard: config.tryKeyboard
          });
          if (sock !== undefined) config.sock = sock;
          this.attachHostVerifier(config, record, record.host, record.port, record.hostKeyMode);
          client.connect(config);
        });
        record.dead = false;
        record.reconnectAttempts = 0;
        await this.persistFirstSeenHostKey(record);
        return { ok: true };
      } catch (error) {
        // Host-key TOFU rejection is never transient: surface it, don't retry.
        if (record.hostKeyMismatch) {
          for (const hop of record.hops) { try { hop.end(); } catch {} }
          record.hops = [];
          return { ok: false, error: this.hostKeyError(record.hostKeyMismatch) };
        }
        lastError = error;
        // A cancelled connect must not spend its remaining retry attempts.
        if (record.closing) break;
        // Tear down hops on failure so the retry starts fresh.
        for (const hop of record.hops) { try { hop.end(); } catch {} }
        record.hops = [];
        // ssh2's ident parser refuses a handful of banners that OpenSSH accepts
        // and reports them as a bare "Invalid identification string" — naming
        // neither the peer nor the offending line. Retry ONCE with that line
        // normalized. Like the KEX downgrade below, this consumes an attempt on
        // purpose and the loop bound is widened, so a caller that passed
        // retries:0 still gets the chance; otherwise the device would look
        // simply unreachable.
        if (!record.bannerRepair && isIdentMismatchError(error)) {
          record.bannerRepair = true;
          this.log(`SSH ${record.host}:${record.port} returned an identification string ssh2 refuses; retrying once with that line normalized so the handshake can proceed.`);
          if (attempt >= retries) retries += 1;
          continue;
        }
        // Only when the user did not ask for legacy explicitly: a shared
        // KEX-less handshake means this peer may be an old VRP switch, so
        // retry ONCE with the legacy algorithm set and remember that we did.
        //
        // This consumes a retry attempt on purpose — but the loop bound is
        // widened by one while the downgrade is still available, so a caller
        // that passed retries:0 (or a small budget) still gets the legacy
        // chance. Otherwise a modern-only handshake failure would be reported
        // for a device the plugin can actually reach.
        if (!record.legacyAlgorithms && record.allowLegacyDowngrade && isKexMismatchError(error)) {
          record.legacyAlgorithms = true;
          record.legacyFallback = true;
          this.log(`SSH ${record.host}:${record.port} offered no modern key exchange; retrying with legacy algorithms (diffie-hellman-group14-sha1). The transport is weaker than the default — reachable, but prefer upgrading the device if you can.`);
          if (attempt >= retries) retries += 1;
          continue;
        }
        // Devices whose firmware aborts the transport while a keyboard-
        // interactive round-trip is in flight get ONE plain-password retry
        // (tryKeyboard off, so the interactive method is never offered). Only
        // fires after auth provably started — otherwise it is a plain network
        // failure and the retry loop's own policy applies.
        if (!record.kbdFallbackTried && wasAuthCut(record.authTracker, error)) {
          record.kbdFallbackTried = true;
          this.log(`SSH ${record.host}:${record.port} dropped the transport during authentication; retrying once with the plain password method only.`);
          if (attempt >= retries) retries += 1;
          continue;
        }
        if (!isTransientConnectError(error) || attempt >= retries) break;
        await this.sleep(Math.min(2000, 500 * 2 ** attempt));
      }
    }
    if (record.closing) {
      return { ok: false, error: fail("connect-cancelled", `connection "${record.id}" was closed`) };
    }
    // Structured diagnosis instead of ssh2's bare one-liner: what stage died,
    // which methods were tried, what the server still accepts, and the next
    // steps worth trying. The code stays `connect-failed` so existing callers
    // (and their matching) are unaffected.
    const diagnosis = classifyConnectFailure(lastError, record.authTracker, {
      hasPassword: record.connectConfig.password !== undefined,
      hasPrivateKey: record.connectConfig.privateKey !== undefined
    });
    return {
      ok: false,
      error: fail("connect-failed", formatConnectFailure(diagnosis, `${record.username}@${record.host}:${record.port}`))
    };
  }

  /**
   * Obtain the transport for a banner-repaired attempt: the peer's
   * identification line has to be read and normalized before ssh2 ever sees it,
   * which means the plugin owns the byte stream instead of ssh2.
   *
   * `upstream` is the jump chain's forwarded stream when there is one — it is
   * spliced the same way, because a hop stream is just as opaque as a socket to
   * whatever the final host writes on it. Otherwise the TCP connection is ours,
   * and a failure here is an ordinary connect failure the caller's retry policy
   * already knows how to classify.
   */
  async openRepairedSock(record, upstream) {
    let sock = upstream;
    if (sock === undefined) {
      const { host, port } = record.connectConfig;
      sock = net.createConnection({ host, port });
      // Standing listener first: an 'error' emission with no listener crashes
      // the DSH process, and pre-handshake failures are surfaced through the
      // banner read below rather than through this socket.
      sock.on("error", () => {});
      await new Promise((resolve, reject) => {
        const onConnect = () => { sock.off("error", onReject); resolve(); };
        const onReject = (error) => reject(error);
        sock.once("connect", onConnect);
        sock.once("error", onReject);
      });
    }
    const { stream, plan } = await withRepairedBanner(sock, {
      // Never outlast the handshake budget the user set for this connection.
      timeoutMs: Math.min(record.connectConfig.readyTimeout ?? 20000, 10000)
    });
    record.bannerRepairNote = plan.reason === "" ? null : plan.reason;
    return stream;
  }

  /**
   * Build one full jump chain: hop clients connected through in order, each
   * forwarding a stream to the next destination, ending with a stream usable
   * as the `sock` of the target connection. Returns the final stream and the
   * list of hop clients (for teardown). Each hop config is an inline object
   * {host, port, username, auth, readyTimeout}.
   */
  async connectChain(proxyJump, targetHost, targetPort) {
    const hops = [];
    let sock;
    for (let index = 0; index < proxyJump.length; index += 1) {
      const hopConfig = proxyJump[index];
      const hopConnectConfig = {
        host: hopConfig.host,
        port: hopConfig.port ?? 22,
        username: hopConfig.username,
        // Jump hosts are ordinary SSH servers; legacy KEX is NOT forced on
        // them, so an old switch as a jump host would need its own explicit
        // `legacy` support. The legacy downgrade applies to the target
        // connection (the one that terminates at the device).
        readyTimeout: hopConfig.readyTimeout ?? 20000
      };
      // Primary + optional secondary factor (dual-factor jump devices): the
      // hop's auth handler walks methods from whatever is configured.
      if (hopConfig.auth?.password !== undefined) hopConnectConfig.password = hopConfig.auth.password;
      if (hopConfig.auth?.privateKey !== undefined) {
        hopConnectConfig.privateKey = hopConfig.auth.privateKey;
        if (hopConfig.auth.passphrase !== void 0) hopConnectConfig.passphrase = hopConfig.auth.passphrase;
      }
      if (hopConfig.auth?.secondary?.kind === "key") {
        hopConnectConfig.privateKey = hopConfig.auth.secondary.privateKey;
        if (hopConfig.auth.secondary.passphrase !== void 0) hopConnectConfig.passphrase = hopConfig.auth.secondary.passphrase;
      } else if (hopConfig.auth?.secondary?.kind === "password") {
        hopConnectConfig.password = hopConfig.auth.secondary.password;
      }
      // Jump hosts get the same keyboard-interactive support as targets: an
      // MFA-prompting bastion is exactly where a saved password answers prompts.
      const hopTracker = createAuthTracker();
      if (hopConnectConfig.password !== undefined) {
        hopConnectConfig.tryKeyboard = true;
        hopConnectConfig.authHandler = makeAuthHandler(hopTracker, {
          hasPassword: true, hasPrivateKey: hopConnectConfig.privateKey !== undefined, tryKeyboard: true
        });
      }
      if (sock !== undefined) hopConnectConfig.sock = sock;
      const hopState = { hostKeyMismatch: null, hostKeyToRecord: null };
      this.attachHostVerifier(hopConnectConfig, hopState, hopConnectConfig.host, hopConnectConfig.port, hopConfig.hostKeyMode);
      const hopClient = this.newClient();
      try {
        await new Promise((resolve, reject) => {
          // Standing error listener for the hop's whole life: ssh2 may emit a
          // second protocol error after the first one settled this promise,
          // and an unhandled 'error' crashes the DSH process.
          let settled = false;
          if (hopConnectConfig.tryKeyboard) {
            hopClient.on("keyboard-interactive", (name, instructions, instructionsLang, prompts, finish) => {
              hopTracker.kbdSeen = true;
              finish(prompts.map(() => hopConnectConfig.password));
            });
          }
          hopClient.once("ready", () => { if (!settled) { settled = true; resolve(); } });
          hopClient.on("error", (cause) => { if (!settled) { settled = true; reject(cause); } });
          hopClient.connect(hopConnectConfig);
        });
        await this.persistFirstSeenHostKey(hopState);
      } catch (error) {
        for (const h of hops) { try { h.end(); } catch {} }
        if (hopState.hostKeyMismatch) {
          const m = hopState.hostKeyMismatch;
          const hostKeyFailure = this.hostKeyError(m);
          const hopError = new Error(`proxyJump hop ${index + 1} (${hopConnectConfig.username}@${hopConnectConfig.host}:${hopConnectConfig.port}): ${hostKeyFailure.message}`);
          hopError.code = hostKeyFailure.code;
          throw hopError;
        }
        throw new Error(`proxyJump hop ${index + 1} (${hopConnectConfig.username}@${hopConnectConfig.host}:${hopConnectConfig.port}): ${error.message}`);
      }
      hops.push(hopClient);
      // forwardOut to the next destination: the next hop, or the final target.
      const next = index + 1 < proxyJump.length ? proxyJump[index + 1] : null;
      const nextHost = next !== null ? next.host : targetHost;
      const nextPort = next !== null ? (next.port ?? 22) : targetPort;
      sock = await new Promise((resolve, reject) => {
        hopClient.forwardOut("127.0.0.1", 0, nextHost, nextPort, (error, stream) => {
          if (error) {
            for (const h of hops) { try { h.end(); } catch {} }
            reject(new Error(`proxyJump hop ${index + 1} forwardOut to ${nextHost}:${nextPort}: ${error.message}`));
          } else {
            resolve(stream);
          }
        });
      });
    }
    return { hops, sock };
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Defensive logging: ctx.logger is not wired in the DSH host, so console
   * output is what reaches ~/.dsh/web.log. Without this, a security-relevant
   * decision (a downgraded SSH handshake) would leave no trace anywhere.
   */
  log(message) {
    try { this.ctx?.logger?.warn?.(message); } catch {}
    try { console.warn("[dsh-harbor]", message); } catch {}
  }

  /** Wire transport-loss handlers to the record's current client. */
  attachTransportHandlers(record) {
    const client = record.client;
    client.on("error", (error) => this.handleTransportLoss(record, client, error));
    client.on("close", () => this.handleTransportLoss(record, client, null));
  }

  /**
   * Stop every listener routed through this SSH connection. Closing a
   * net.Server stops accepting new connections without touching sockets
   * already piped to channels (those die with the SSH client); remote-forward
   * tunnels have no listener — the server side dies with the transport — so
   * only the tcp-connection bridge is detached.
   */
  closeConnectionTunnels(conn) {
    for (const tunnel of conn.tunnels.values()) {
      tunnel.active = false;
      if (tunnel.bridgeInfo?.bridge) {
        try { conn.client?.removeListener("tcp connection", tunnel.bridgeInfo.bridge); } catch {}
      }
      if (tunnel.server) {
        try { tunnel.server.close(() => {}); } catch {}
        // A server-level error during/after close must not find zero
        // listeners — that throws and kills the host (#32).
        try { tunnel.server.on("error", () => {}); } catch {}
      }
    }
    conn.tunnels.clear();
  }

  /**
   * The transport died under us (idle NAT drop, network blip, server reset).
   * Mark the record dead, retire its shell sessions and SFTP channel, then
   * schedule a transparent reconnect so later operations self-heal instead of
   * forcing a brand-new session every time.
   */
  handleTransportLoss(record, client, error) {
    if (record.closing || record.client !== client || record.dead) return;
    record.dead = true;
    const transportCode = typeof error?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code
 : error?.level === "client-timeout" ? "timeout" : error ? "error" : "close";
    this.log(`SSH transport lost: connection=${record.id}, reason=${transportCode}, sessions=${record.sessions.size}`);
    // A session-scoped tier switch is memory-only by design and must not
    // outlive the transport it was made on. The self-healing reconnect below
    // reuses this very record, so clearing it here is what makes the panel's
    // "断开或重连后恢复资源/全局设置" promise true instead of leaving a
    // forgotten allowAll in force after a network blip.
    record.execPolicyOverride = undefined;
    record.sftp = null;
    for (const sessionId of [...record.sessions]) {
      const session = this.sessions.get(sessionId);
      if (session) {
        this.recordExit(session, { code: 1, reason: "transport-lost" });
        session.stream = null;
        this.rememberExit(sessionId, session.exited);
      }
      this.sessions.delete(sessionId);
    }
    record.sessions.clear();
    this.closeConnectionTunnels(record);
    // The jump chain is rebuilt by the reconnect; keeping the old hop clients
    // would leak one SSH transport per hop on every network blip.
    for (const hop of record.hops) { try { hop.end(); } catch {} }
    record.hops = [];
    this.scheduleReconnect(record);
  }

  /** Auto-reconnect a dead record with capped exponential backoff. */
  scheduleReconnect(record) {
    if (record.closing || !record.dead || record.reconnectTimer !== null) return;
    const delay = Math.min(
      RECONNECT_MAX_DELAY_MS,
      RECONNECT_BASE_DELAY_MS * 2 ** Math.min(record.reconnectAttempts, 5)
 );
    record.reconnectAttempts += 1;
    record.reconnectTimer = setTimeout(async () => {
      try {
        record.reconnectTimer = null;
        if (record.closing || !record.dead) return;
        const connected = await this.connectClient(record, 0);
        if (!connected.ok) {
          // A host-key mismatch/unseen must NOT trigger a reconnect storm against
          // a possibly re-provisioned or impersonated server: stop retrying and
          // let the operator decide (forget the key or investigate).
          const code = connected.error?.code;
          if (code === "host-key-mismatch" || code === "host-key-unseen" || code === "host-key-error") {
            for (const waiter of record.reconnectWaiters.splice(0)) waiter(false);
            return;
          }
          this.scheduleReconnect(record);
          return;
        }
        this.attachTransportHandlers(record);
        this.log(`SSH transport restored: connection=${record.id}`);
        for (const tunnel of record.tunnels.values()) {
          if (tunnel.kind === "remote" && tunnel.bridgeInfo?.bridge) {
            record.client.prependListener("tcp connection", tunnel.bridgeInfo.bridge);
          }
          tunnel.active = true;
        }
        const waiters = record.reconnectWaiters.splice(0);
        for (const waiter of waiters) waiter(true);
      } catch (error) {
        // Timer callbacks have no caller to observe a rejection. Stop retries
        // on unexpected failures, including failures in Cordis service proxies.
        record.dead = true;
        try { record.client?.end(); } catch {}
        for (const hop of record.hops ?? []) { try { hop.end(); } catch {} }
        record.hops = [];
        for (const waiter of record.reconnectWaiters.splice(0)) { try { waiter(false); } catch {} }
        try { console.warn("[dsh-harbor] Automatic reconnect stopped after an unexpected error:", error); } catch {}
      }
    }, delay);
  }

  /**
   * Wait until the record's transport is usable. If it is dead, waits for the
   * in-flight reconnect (bounded). Resolves false only when the connection was
   * explicitly closed or reconnect did not complete in time.
   */
  ensureAlive(record, timeoutMs = RECONNECT_WAIT_MS) {
    if (record.closing) return Promise.resolve(false);
    if (!record.dead) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiter = (alive) => {
        clearTimeout(timer);
        resolve(alive);
      };
      const timer = setTimeout(() => {
        const index = record.reconnectWaiters.indexOf(waiter);
        if (index !== -1) record.reconnectWaiters.splice(index, 1);
        resolve(false);
      }, timeoutMs);
      record.reconnectWaiters.push(waiter);
    });
  }

  async disconnect(request) {
    const conn = this.connections.get(request.connectionId);
    if (conn === void 0) return { ok: false, error: fail("no-connection", noConnectionGuidance(request.connectionId, this.savedResourceNameList(), this.agentAutoConnect)) };
    // Explicit disconnect: never auto-reconnect, and stop any in-flight one.
    conn.closing = true;
    if (conn.reconnectTimer !== null) {
      clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = null;
    }
    for (const sessionId of [...conn.sessions]) {
      const session = this.sessions.get(sessionId);
      if (session) {
        this.sessions.delete(sessionId);
        if (session.exited === null && session.stream !== null) {
          this.recordExit(session, { code: 0, reason: "operator-close" });
          try { session.stream.end(); } catch {}
        }
        this.rememberExit(sessionId, session.exited ?? { code: 0 });
      }
    }
    conn.sessions.clear();
    this.closeConnectionTunnels(conn);
    this.connections.delete(request.connectionId);
    if (this.activeConnectionId === request.connectionId) {
      this.activeConnectionId = null;
    }
    try { conn.client.end(); } catch {}
    for (const hop of conn.hops ?? []) { try { hop.end(); } catch {} }
    conn.hops = [];
    return { ok: true, value: { disconnected: true } };
  }

  /**
   * Abort an in-flight profile connect. Safe to call after the connect
   * settled (then it is a no-op); while the handshake is pending, ending the
   * socket breaks the wait immediately.
   */
  async cancelProfileConnect(request) {
    try {
      let cancelled = 0;
      for (const record of this.connections.values()) {
        if (!record.connecting) continue;
        if (request?.profileId !== undefined && record.profileId !== request.profileId) continue;
        record.closing = true;
        cancelled += 1;
        try { for (const hop of record.hops) { hop.end(); } } catch {}
        record.hops = [];
        try { record.client?.end(); } catch {}
      }
      return { ok: true, value: { cancelled } };
    } catch (error) {
      return { ok: false, error: fail("cancel-connect-failed", error.message) };
    }
  }
};