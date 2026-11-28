/**
 * Boot the offline SSH server the integration tests talk to.
 *
 * test-sshd.mjs is a real ssh2 server in a child process: the SFTP test hands
 * it a sandbox root, the monitor test runs the status probe against it. Both
 * used to carry their own copy of this bootstrap — including the Windows
 * URL-pathname note — so a fix to one never reached the other.
 */
import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";

/** One free loopback port; the child has to bind it, so it is released first. */
export function freeLoopbackPort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Start test/support/test-sshd.mjs on a free port.
 * @param {string[]} [args] - extra server arguments, e.g. ["--sftp-root", root].
 * @param {{timeoutMs?: number}} [options] - startup budget.
 * @returns {Promise<{port: number, child: import("node:child_process").ChildProcess, ready: Promise<void>}>}
 *   `ready` resolves once the server prints its listening line; the caller
 *   must still await it and kill `child` in its own cleanup.
 */
export async function startTestSshd(args = [], { timeoutMs = 10000 } = {}) {
  const port = await freeLoopbackPort();
  const child = spawn(process.execPath, [
    // fileURLToPath: `new URL(...).pathname` on Windows is "/D:/…" and the
    // child exits instantly with code 1 (same URL-pathname class as PR #28).
    fileURLToPath(new URL("./test-sshd.mjs", import.meta.url)),
    String(port), ...args
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("test-sshd did not start in time")), timeoutMs);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("listening on")) { clearTimeout(timer); resolve(); }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`test-sshd exited early (${code})`)); });
  });
  return { port, child, ready };
}