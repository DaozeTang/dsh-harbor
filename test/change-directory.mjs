// changeDirectory safety and the cwd-unavailable refusal.
//
// A cd is written into an interactive shell, so it must never run while the
// operator has typed a draft, while the foreground process is busy, or after
// the PTY changed under the probe. `ssh_exec` additionally refuses to run a
// command at all when the working directory cannot be proven.
//
// (The pool-cap and terminalStream cases this file used to share with
// test/review-regressions.mjs live in test/terminal-pool.mjs and
// test/terminal-stream.mjs, which cover them directly.)
import assert from "node:assert/strict";
import HarborService from "../src/index.js";
import { EXEC_CWD_MARKER } from "../src/host/exec-cwd.js";
import { changeDirectoryRequestSchema } from "../src/rpc/schemas.js";

const svc = Object.create(HarborService.prototype);
svc.config = { streamHeartbeatMs: 10, maxBufferBytes: 1024 };
svc.sessions = new Map();
svc.connections = new Map();
const session = { id: "s", connectionId: "c", waiters: [], streamListeners: new Set(), exited: null, inputKnown: true, inputLine: "" };
const writes = [];
session.stream = { write(text) { writes.push(text); } };
const conn = { sessions: new Set(["s"]), client: {}, loginShell: "bash" };
svc.sessions.set("s", session);
svc.connections.set("c", conn);

assert.equal(changeDirectoryRequestSchema.safeParse({ sessionId: "s", path: "/tmp\nfoo" }).success, false,
  "a newline in the path is rejected by the wire schema");

// A cd action must not submit drafts, unknown line state, or a busy shell.
const metadata = EXEC_CWD_MARKER + Buffer.from("/tmp\n").toString("base64") + "\n";
svc.collectExecOutput = async () => ({ exitCode: 0, stdout: metadata });
session.inputLine = "echo ";
assert.equal((await svc.changeDirectory({ sessionId: "s", path: "/tmp" })).ok, false);
assert.equal(writes.length, 0, "a typed draft blocks the cd entirely");
session.inputLine = "";
session.inputKnown = false;
assert.equal((await svc.changeDirectory({ sessionId: "s", path: "/tmp" })).ok, false);
session.inputKnown = true;
svc.collectExecOutput = async () => ({ exitCode: 125, stdout: EXEC_CWD_MARKER + "\n" });
assert.equal((await svc.changeDirectory({ sessionId: "s", path: "/tmp" })).ok, false,
  "an unprovable idle shell is refused");
assert.equal(writes.length, 0);
svc.collectExecOutput = async () => {
  svc.updateInputMirror(session, "echo x\r");
  return { exitCode: 0, stdout: metadata };
};
assert.equal((await svc.changeDirectory({ sessionId: "s", path: "/tmp" })).ok, false,
  "input arriving while the probe awaits cancels the cd");
assert.equal(writes.length, 0);
svc.collectExecOutput = async () => ({ exitCode: 0, stdout: metadata });
assert.equal((await svc.changeDirectory({ sessionId: "s", path: "/tmp/a'b" })).ok, true);
assert.equal(writes.join(""), "cd -- '/tmp/a'\\''b'\r", "the path is shell-quoted, not interpolated");

// The normal ssh_exec path turns a resolver refusal into a real tool error.
const execService = Object.create(HarborService.prototype);
execService.config = { maxBufferBytes: 1024 };
execService.connections = new Map([["c", { client: {}, sessions: new Set(), loginShell: "bash" }]]);
execService.sessions = new Map();
execService.ensureAlive = async () => true;
execService.collectExecOutput = async () => ({
  exitCode: 125,
  stdout: EXEC_CWD_MARKER + "\n",
  stderr: "ssh_exec: interactive shell is busy or non-interactive; command was not executed candidates: bash(999 pgrp=999 tpgid=998)\n",
  truncated: false,
  timedOut: false
});
const refused = await execService.execOnConnection("c", "touch relative-file");
assert.equal(refused.ok, false);
assert.equal(refused.error.code, "cwd-unavailable");

console.log("change directory: draft/busy/race guards, quoting and the exec refusal: passed");
