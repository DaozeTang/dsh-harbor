// Wire payloads are base64, and "base64" used to be taken on faith.
//
// `Buffer.from(text, "base64")` never throws: it skips unknown characters and
// stops at the first pad. Every caller that decoded a wire field therefore
// trusted a payload it had not checked — a corrupted keystroke frame was typed
// into a live operator shell, and a corrupted file frame was written over a
// remote file as garbage. The catch in sessions.write() that reported
// "input is not valid base64" could never run.
import assert from "node:assert/strict";
import HarborService from "../src/index.js";
import { decodeBase64Bytes, decodeData, encodeData } from "../src/host/service/text.js";

// ── the decoder refuses what it cannot decode ──────────────────────────────
{
  assert.equal(decodeData(encodeData("l")), "l");
  assert.equal(decodeData(encodeData("中")), "中", "multi-byte text round-trips");
  assert.equal(decodeData(""), "", "an empty payload decodes to empty text");
  assert.deepEqual([...decodeBase64Bytes(Buffer.from([0, 1, 254, 255]).toString("base64"))], [0, 1, 254, 255]);

  assert.throws(() => decodeData("not base64!"), /not valid base64/);
  assert.throws(() => decodeData("abc"), /not valid base64/, "unpadded base64 is not canonical base64");
  assert.throws(() => decodeData("aGk==\n"), /not valid base64/, "a newline is not part of the wire payload");
  assert.equal(decodeData("aGk="), "hi", "three characters and one pad is canonical");
  assert.throws(() => decodeData("a==="), /not valid base64/, "a malformed pad run is rejected");
  assert.throws(() => decodeData("aGk=="), /not valid base64/, "a length that cannot be a frame is rejected");
  assert.throws(() => decodeData("-_-_"), /not valid base64/, "url-safe base64 is a different alphabet");
  assert.throws(() => decodeBase64Bytes(undefined), /not valid base64/, "a missing frame is not an empty frame");
  assert.throws(() => decodeBase64Bytes(42), /not valid base64/);
}

// ── sessions.write: a malformed keystroke frame never reaches the shell ────
{
  const service = Object.create(HarborService.prototype);
  const writes = [];
  const session = {
    id: "pty-1",
    connectionId: "c1",
    ownerSessionId: "conv-a",
    exited: null,
    stream: { write(text) { writes.push(text); } }
  };
  service.sessions = new Map([[session.id, session]]);
  service.connections = new Map([["c1", { id: "c1" }]]);

  const result = await service.write({ sessionId: session.id, data: "!!! not base64 !!!" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "bad-data", "the documented error code is the one that comes back");
  assert.deepEqual(writes, [], "nothing is typed into the operator's shell");
  assert.equal(session.userOwned, undefined, "a rejected frame is not a human takeover");

  const ok = await service.write({ sessionId: session.id, data: encodeData("ls") });
  assert.equal(ok.ok, true, ok.error?.message);
  assert.deepEqual(writes, ["ls"]);
}

// ── sftpWriteFile: a malformed frame never reaches the remote file ─────────
{
  const service = Object.create(HarborService.prototype);
  service.config = {};
  const calls = [];
  const sftp = new Proxy({}, {
    get(_target, key) {
      return (...args) => {
        calls.push([String(key), ...args.filter((value) => typeof value !== "function")]);
        throw new Error("the filesystem must not be touched before the payload is decoded");
      };
    }
  });
  service.connections = new Map([["c1", { id: "c1", sftp }]]);

  const result = await service.sftpWriteFile({ connectionId: "c1", path: "/etc/motd", data: "###" });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /not valid base64/);
  assert.deepEqual(calls, [], "a rejected payload never opens, writes or renames anything");
}

console.log("wire data: non-canonical base64 is refused before it is typed or written");