
/**
 * End-to-end check of the status sampler against a real SSH transport.
 *
 * The unit tests fake the exec channel, so what remains unproven is the wire:
 * a real ssh2 client, the fixed "sh -c '<script>'" command, the probe script
 * actually running on the far side, and the parser reading its real output.
 *
 * The repo's test sshd serves whatever shell the machine has, so the assertion
 * is platform-aware: on Linux (this project's CI) the sample must be supported
 * and the second sample must carry rates; elsewhere (macOS, where /proc does
 * not exist) the honest "unsupported" envelope is what must come back.
 */
import assert from "node:assert/strict";
import { Client } from "ssh2";
import { startTestSshd } from "../support/start-test-sshd.mjs";
const { default: HarborService } = await import(process.env.DSH_TEST_BUILT_HOST ? "../../lib/index.js" : "../../src/index.js");

const { port, child, ready } = await startTestSshd();

const client = new Client();
try {
  await ready;
  await new Promise((resolve, reject) => {
    client.on("ready", resolve);
    client.on("error", reject);
    client.connect({ host: "127.0.0.1", port, username: "test", password: "test123", readyTimeout: 8000 });
  });

  const service = Object.create(HarborService.prototype);
  service.config = { maxCommandOutputBytes: 64 * 1024 };
  service.agentAutoConnect = false;
  const connection = { id: "local-ssh", host: "127.0.0.1", port, username: "test", client, dead: false, closing: false, sessions: new Set() };
  service.connections = new Map([["local-ssh", connection]]);

  const first = await service.systemStats({ connectionId: "local-ssh" });
  assert.equal(first.ok, true, "a real exec channel answers the probe");
  assert.equal(typeof first.value.sampleMs, "number");
  assert.equal(first.value.supported, process.platform === "linux",
    "the probe is supported exactly where /proc exists");

  if (process.platform === "linux") {
    assert.ok(first.value.cpu, "a Linux host reports CPU counters");
    assert.equal(first.value.warmingUp, true, "the first sample has no interval to diff");
    assert.ok(first.value.host && typeof first.value.host.kernel === "string", "the identity came back from uname");
    assert.ok(first.value.memory && first.value.memory.totalBytes > 0, "meminfo was parsed");
    assert.ok(first.value.disks.length > 0, "the mount table was read");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const second = await service.systemStats({ connectionId: "local-ssh" });
    assert.equal(second.ok, true);
    assert.equal(typeof second.value.cpu.usagePercent, "number", "a second sample produces a real percentage");
    assert.ok(second.value.cpu.usagePercent >= 0 && second.value.cpu.usagePercent <= 100);
    assert.equal(second.value.warmingUp, undefined, "and it is no longer warming up");
  } else {
    assert.equal(first.value.supported, false);
    assert.ok(["no-procfs", "no-posix-shell"].includes(first.value.reason), "the unsupported reason is machine-readable: " + first.value.reason);
    // The pane renders that reason as a sentence, so the code must match one.
    assert.equal(typeof first.value.platformName, "string", "the platform is named (e.g. Darwin), not guessed");
  }
} finally {
  try { client.end(); } catch {}
  try { child.kill(); } catch {}
}

console.log("monitor over SSH: real exec channel, real script output, platform-aware envelope: passed");
