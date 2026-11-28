/**
 * Local, remote and dynamic SOCKS5 port forwarding.
 */
import net from "node:net";
import { randomUUID } from "node:crypto";
import { attachSocks5, SOCKS_HANDSHAKE_TIMEOUT_MS } from "../tunnels/socks5.js";
import { fail } from "../../rpc/envelope.js";

/**
 * A TCP port usable by forwardIn/forwardOut/net.connect: 0 means "let the OS
 * pick" for a listen port. Anything else (absent, a string, negative, 70000)
 * has to be refused before it reaches net.connect, whose ERR_SOCKET_BAD_PORT /
 * ERR_MISSING_ARGS would be thrown from inside ssh2's event dispatch.
 */
function isPortNumber(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 65535;
}

/**
 * The address a local listener actually binds.
 *
 * An absent value, an empty string and whitespace all mean "not given" — and
 * an empty string is NOT the same as 127.0.0.1: `net.Server#listen(port, "")`
 * binds the wildcard address, so a caller (or model) that sends
 * `bind_addr: ""` would turn a loopback forward into a listener on every
 * interface. The exposure gate cannot catch that either, because it judges the
 * request before this layer sees it. Normalizing HERE — the last point before
 * `listen()` — is what makes the gate's "empty means loopback" reading true.
 *
 * @param {unknown} value - requested bind address.
 * @returns {string} a non-empty address safe to pass to listen().
 */
export function normalizeBindAddress(value) {
  const text = value === undefined || value === null ? "" : String(value).trim();
  return text === "" ? "127.0.0.1" : text;
}

export const withTunnels = (Base) => class extends Base {
  // ── Port forwarding (tunnels) ──────────────────────────────────────────────

  /**
   * Start a local port forward: the DSH host listens on bindAddr:bindPort and
   * forwards connections through the SSH connection to remoteHost:remotePort
   * (ssh2 Client.forwardOut semantics). Returns the assigned local endpoint.
   */
  async tunnelStartLocal(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const conn = selected.connection;
    if (!(await this.ensureAlive(conn))) {
      return { ok: false, error: fail("connection-lost", `connection "${conn.id}" is down and could not be re-established`) };
    }
    const tunnelId = `tun-${randomUUID().slice(0, 8)}`;
    const bindAddr = normalizeBindAddress(request.bindAddr);
    const bindPort = request.bindPort ?? 0;
    // The target is validated BEFORE the listener exists, for the same reason
    // the remote forward validates its own: a missing host or an out-of-range
    // port made net.connect/forwardOut throw once per accepted connection,
    // inside the accept callback, while the call had already reported success.
    // The tunnel then looked started and silently failed every connection,
    // with no error anywhere the operator could see.
    if (!isPortNumber(bindPort)) {
      return { ok: false, error: fail("tunnel-invalid-listen-port", `local listen port must be an integer between 0 and 65535, got ${JSON.stringify(request.bindPort ?? null)}`) };
    }
    const targetHost = typeof request.remoteHost === "string" ? request.remoteHost.trim() : "";
    if (targetHost.length === 0) {
      return { ok: false, error: fail("tunnel-invalid-target", "local forward needs a remote_host: the server-side host every accepted connection is forwarded to") };
    }
    const targetPort = request.remotePort;
    if (!isPortNumber(targetPort) || targetPort === 0) {
      return { ok: false, error: fail("tunnel-invalid-target", `local forward needs a remote_port between 1 and 65535, got ${JSON.stringify(targetPort ?? null)}`) };
    }
    try {
      const server = net.createServer((socket) => {
        // A late accept after the transport died must only cost this socket,
        // never the host process. Two guards:
        // 1. ssh2's forwardOut THROWS synchronously ('Not connected') when the
        //    underlying socket is gone instead of reporting through the
        //    callback — uncaught, that throw escapes this event callback and
        //    crashes DSH (#32). The lifecycle paths now close the listener,
        //    but accepts already in flight when a connection drops can still
        //    race in here, so every call site catches.
        // 2. pipe() installs no error handlers: an 'error' event with zero
        //    listeners throws (ECONNRESET from a reset local client is the
        //    classic Windows case, #32). Each side tears the other down.
        if (conn.dead || conn.closing) {
          socket.destroy();
          return;
        }
        // forwardOut is a full SSH round trip, and a local client can reset its
        // connection inside that window. Without a listener installed NOW the
        // 'error' event has zero listeners and Node throws it out of the emit,
        // which DSH's fail-loud handler turns into a process exit — one
        // ordinary RST would take the whole host down (#review P0-2).
        let channel = null;
        let socketFailed = false;
        socket.on("error", () => {
          socketFailed = true;
          channel?.destroy?.();
        });
        try {
          conn.client.forwardOut(bindAddr, bindPort, targetHost, targetPort, (error, late) => {
            // A channel arriving for a socket that is already gone is
            // discarded instead of piped into a dead object.
            if (error || socketFailed || socket.destroyed) {
              socket.destroy();
              late?.destroy?.();
              return;
            }
            channel = late;
            channel.on("error", () => socket.destroy());
            socket.pipe(channel).pipe(socket);
          });
        } catch {
          socket.destroy();
        }
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(bindPort, bindAddr, () => resolve());
      });
      // Post-listen errors (EMFILE on accept storms etc.) must still land on
      // a listener: an 'error' with zero listeners crashes the DSH process.
      server.on("error", () => {});
      const address = server.address();
      const actualPort = typeof address === "object" && address !== null ? address.port : bindPort;
      conn.tunnels.set(tunnelId, {
        id: tunnelId,
        kind: "local",
        bindAddr,
        bindPort: actualPort,
        remoteHost: targetHost,
        remotePort: targetPort,
        server,
        active: true
      });
      // Registered before this check, because the check answers a race that
      // registration creates: if the transport died while listen() was in
      // flight, closeConnectionTunnels() already ran and a listener recorded
      // afterwards would be closed by nobody — the port stays bound, forwards
      // nowhere, and never appears in the panel's list to be stopped.
      if (conn.dead === true || conn.closing === true) {
        conn.tunnels.delete(tunnelId);
        try { server.close(() => {}); } catch {}
        return { ok: false, error: fail("connection-lost", `connection "${conn.id}" went down while starting the local forward`) };
      }
      return {
        ok: true,
        value: {
          tunnelId,
          kind: "local",
          bindAddr,
          bindPort: actualPort,
          remoteHost: targetHost,
          remotePort: targetPort
        }
      };
    } catch (error) {
      return { ok: false, error: fail("tunnel-start-failed", `local ${bindAddr}:${bindPort} -> ${targetHost}:${targetPort}: ${error.message}`) };
    }
  }

  /**
   * Start a remote port forward: the server listens on remoteHost:remotePort
   * and every connection is forwarded back through the SSH connection to
   * targetHost:targetPort on the DSH host (ssh2 Client.forwardIn). The
   * returned bindAddr/bindPort are the endpoint the server actually bound,
   * which differs from the request when it asked for port 0. Requires the
   * server's sshd to allow remote forwards (AllowTcpForwarding); typically
   * needs root or a GatewayPorts-capable sshd.
   */
  async tunnelStartRemote(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const conn = selected.connection;
    if (!(await this.ensureAlive(conn))) {
      return { ok: false, error: fail("connection-lost", `connection "${conn.id}" is down and could not be re-established`) };
    }
    const tunnelId = `tun-${randomUUID().slice(0, 8)}`;
    // remoteHost/remotePort are the endpoint the SERVER listens on (the ssh -R
    // "bind" side) and targetHost/targetPort are the local target. bindAddr/
    // bindPort are accepted only as a fallback for older callers.
    const listenAddr = normalizeBindAddress(request.remoteHost ?? request.bindAddr);
    const listenPort = request.remotePort ?? request.bindPort ?? 0;
    // Both ports are validated HERE, before forwardIn opens anything: the
    // bridge runs inside ssh2's own 'tcp connection' dispatch, where a throw
    // from net.connect (ERR_MISSING_ARGS for an absent port,
    // ERR_SOCKET_BAD_PORT for an out-of-range one) escapes the EventEmitter
    // and takes the host down. The tool schema does not make target_port
    // required, so "remote forward with no target" is an ordinary mistake, not
    // a hostile one — it must cost this call, never the process (#review P0-3).
    if (!isPortNumber(listenPort)) {
      return { ok: false, error: fail("tunnel-invalid-listen-port", `remote listen port must be an integer between 0 and 65535, got ${JSON.stringify(request.remotePort ?? request.bindPort ?? null)}`) };
    }
    const targetHost = request.targetHost === undefined || request.targetHost === null
      ? "127.0.0.1"
      : String(request.targetHost).trim();
    if (targetHost.length === 0) {
      return { ok: false, error: fail("tunnel-invalid-target", "remote forward needs a target_host: the local host the server's connections are forwarded to (default 127.0.0.1)") };
    }
    const targetPort = request.targetPort;
    if (!isPortNumber(targetPort) || targetPort === 0) {
      return { ok: false, error: fail("tunnel-invalid-target", `remote forward needs a target_port between 1 and 65535 (the local service the server's connections are forwarded to), got ${JSON.stringify(targetPort ?? null)}`) };
    }
    let assignedPort = listenPort;
    try {
      await new Promise((resolve, reject) => {
        conn.client.forwardIn(listenAddr, listenPort, (error, port) => {
          if (error) reject(error);
          else {
            // sshd reports the port it actually bound, which matters when the
            // request asked for 0 and is the value the bridge must match.
            if (Number.isInteger(port) && port > 0) assignedPort = port;
            resolve();
          }
        });
      });
      if (!Number.isInteger(assignedPort) || assignedPort <= 0) {
        throw new Error(`the server did not report an assigned listen port for ${listenAddr}:${listenPort}`);
      }
      // Bridge every accepted remote connection to the local target.
      const bridge = (info, accept) => {
        // ssh2 emits 'tcp connection' from its own packet dispatch, so nothing
        // thrown here is caught anywhere: one bad event would end the process.
        // The body therefore never lets an exception out, and a failed bridge
        // costs exactly the one forwarded channel.
        let stream;
        try {
          // sshd reports the address the client connected to, not the wildcard
          // the forward was bound to; match a wildcard bind by port only.
          const addressMatches = listenAddr === "0.0.0.0" || listenAddr === "::" || info?.destIP === listenAddr;
          if (!addressMatches || info?.destPort !== assignedPort) return;
          stream = accept();
          const socket = net.connect(targetPort, targetHost);
          socket.on("error", () => stream.destroy());
          stream.on("error", () => socket.destroy());
          stream.pipe(socket).pipe(stream);
        } catch {
          try { stream?.destroy?.(); } catch {}
        }
      };
      conn.client.prependListener("tcp connection", bridge);
      const bridgeInfo = { kind: "remote", bindAddr: listenAddr, bindPort: assignedPort, bridge };
      conn.tunnels.set(tunnelId, {
        id: tunnelId,
        kind: "remote",
        bindAddr: listenAddr,
        bindPort: assignedPort,
        remoteHost: listenAddr,
        remotePort: assignedPort,
        targetHost,
        targetPort,
        active: true,
        bridgeInfo
      });
      return {
        ok: true,
        value: {
          tunnelId,
          kind: "remote",
          bindAddr: listenAddr,
          bindPort: assignedPort,
          remoteHost: listenAddr,
          remotePort: assignedPort,
          targetHost,
          targetPort
        }
      };
    } catch (error) {
      // A failed forwardIn may still have bound something on the server: undo
      // it best-effort so a retry does not hit "address already in use".
      try { conn.client.unforwardIn?.(listenAddr, assignedPort, () => {}); } catch {}
      return { ok: false, error: fail("tunnel-start-failed", `remote ${listenAddr}:${listenPort}: ${error.message}`) };
    }
  }

  /** Stop a tunnel by id. */
  /**
   * Dynamic SOCKS5 forwarding (the `ssh -D` equivalent): one local listener
   * whose clients choose the destination per connection; each chosen address
   * is opened as a fresh channel on the SSH connection, so the client reaches
   * whatever that server can reach.
   */
  async tunnelStartDynamic(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const conn = selected.connection;
    if (!(await this.ensureAlive(conn))) {
      return { ok: false, error: fail("connection-lost", `connection "${conn.id}" is down and could not be re-established`) };
    }
    const tunnelId = `tun-${randomUUID().slice(0, 8)}`;
    const bindAddr = normalizeBindAddress(request.bindAddr);
    const bindPort = request.bindPort ?? 0;
    const record = { id: tunnelId, kind: "dynamic", bindAddr, bindPort, active: true, connections: 0 };
    try {
      const server = net.createServer((socket) => {
        record.connections += 1;
        attachSocks5(socket, {
          // A client that connects and then says nothing must not hold this
          // socket (and its counter slot) for the life of the process.
          handshakeTimeoutMs: this.config?.socksHandshakeTimeoutMs ?? SOCKS_HANDSHAKE_TIMEOUT_MS,
          // forwardOut throws synchronously ('Not connected') once the
          // transport is gone (#32); routed through the callback it becomes
          // an ordinary SOCKS failure reply instead of a host crash.
          forwardOut: (host, port, callback) => {
            try {
              conn.client.forwardOut("127.0.0.1", 0, host, port, callback);
            } catch (error) {
              callback(error);
            }
          },
          onClose: () => { record.connections = Math.max(0, record.connections - 1); }
        });
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(bindPort, bindAddr, () => resolve());
      });
      // Post-listen errors must not crash the host (see tunnelStartLocal).
      server.on("error", () => {});
      const address = server.address();
      record.bindPort = typeof address === "object" && address !== null ? address.port : bindPort;
      record.server = server;
      conn.tunnels.set(tunnelId, record);
      // Same race as the local forward: a transport lost while listen() was in
      // flight has already run closeConnectionTunnels(), so this listener must
      // close itself instead of staying bound and invisible.
      if (conn.dead === true || conn.closing === true) {
        conn.tunnels.delete(tunnelId);
        try { server.close(() => {}); } catch {}
        return { ok: false, error: fail("connection-lost", `connection "${conn.id}" went down while starting the dynamic forward`) };
      }
      return { ok: true, value: { tunnelId, kind: "dynamic", bindAddr, bindPort: record.bindPort } };
    } catch (error) {
      return { ok: false, error: fail("tunnel-start-failed", error.message) };
    }
  }

  async tunnelStop(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const conn = selected.connection;
    const tunnel = conn.tunnels.get(request.tunnelId);
    if (tunnel === void 0) return { ok: false, error: fail("no-tunnel", `tunnel "${request.tunnelId}" does not exist on this connection`) };
    try {
      if (tunnel.kind === "local" || tunnel.kind === "dynamic") {
        await new Promise((resolve) => {
          // close() only invokes its callback after every accepted socket has
          // ended; destroy them first so a live client cannot leave the Stop
          // button spinning. The timer is a last-resort guard for a socket
          // that Node has already accepted but not yet registered.
          const timer = setTimeout(resolve, 1000);
          timer.unref?.();
          tunnel.server.close(() => {
            clearTimeout(timer);
            resolve();
          });
          tunnel.server.closeAllConnections?.();
        });
      } else {
        if (tunnel.bridgeInfo?.bridge) {
          conn.client.removeListener("tcp connection", tunnel.bridgeInfo.bridge);
        }
        // A closed transport can leave unforwardIn without a callback; the
        // listener is already removed, so the record must not stay stuck.
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 1000);
          timer.unref?.();
          try {
            conn.client.unforwardIn(tunnel.bindAddr, tunnel.bindPort, () => {
              clearTimeout(timer);
              resolve();
            });
          } catch {
            clearTimeout(timer);
            resolve();
          }
        });
      }
      conn.tunnels.delete(request.tunnelId);
      return { ok: true, value: { tunnelId: request.tunnelId, stopped: true } };
    } catch (error) {
      return { ok: false, error: fail("tunnel-stop-failed", error.message) };
    }
  }

  /** List tunnels on a connection. */
  async tunnelList(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const tunnels = [...selected.connection.tunnels.values()].map((t) => {
      const entry = {
        tunnelId: t.id,
        kind: t.kind,
        bindAddr: t.bindAddr,
        bindPort: t.bindPort,
        active: t.active
      };
      // A dynamic (SOCKS5) forward has no remote endpoint; emitting the keys
      // with `undefined` is what the tool's output validator chokes on.
      if (t.remoteHost !== undefined) entry.remoteHost = t.remoteHost;
      if (t.remotePort !== undefined) entry.remotePort = t.remotePort;
      if (t.targetHost !== undefined) entry.targetHost = t.targetHost;
      if (t.targetPort !== undefined) entry.targetPort = t.targetPort;
      if (t.connections !== undefined) entry.connections = t.connections;
      return entry;
    });
    return { ok: true, value: { tunnels } };
  }
};
