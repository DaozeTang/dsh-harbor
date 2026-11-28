// Integration test for the offline SFTP server in test-sshd.mjs: boot the
// server, drive it with the same ssh2 client the plugin uses, and prove the
// sandbox both serves files and refuses to escape its root.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "ssh2";
import { startTestSshd } from "../../support/start-test-sshd.mjs";
import { uploadPipeline } from "../../../src/host/files/sftp-pipeline.js";
import { saveEditorFile } from "../../../src/host/files/sftp-editor-save.js";
const { default: HarborService } = await import(process.env.DSH_TEST_BUILT_HOST ? "../../../lib/index.js" : "../../../src/index.js");
import { TransferTasks } from "../../../src/host/files/transfer-tasks.js";

const root = mkdtempSync(join(tmpdir(), "dsh-sshd-sftp-test-"));
writeFileSync(join(root, "seed.txt"), "seeded\n");
const { port, child, ready } = await startTestSshd(["--sftp-root", root]);

const call = (target, method, ...args) => new Promise((resolve, reject) => {
  target[method](...args, (error, value) => (error ? reject(error) : resolve(value)));
});

let client;
try {
  await ready;
  client = new Client();
  await new Promise((resolve, reject) => {
    client.on("ready", resolve);
    client.on("error", reject);
    client.connect({ host: "127.0.0.1", port, username: "test", password: "test123", readyTimeout: 8000 });
  });
  const sftp = await call(client, "sftp");

  const payload = Buffer.alloc(512 * 1024);
  for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;
  const input = join(root, "pipeline-source.bin");
  writeFileSync(input, payload);
  await uploadPipeline(sftp, input, "/pipeline-upload.bin");
  assert.deepEqual(await call(sftp, "readFile", "/pipeline-upload.bin"), payload);
  await call(sftp, "unlink", "/pipeline-upload.bin");
  const service = Object.create(HarborService.prototype);
  service.transferTasks = new TransferTasks();
  const connection = { id: "local-ssh", dead: false, client, sessions: new Set(["terminal"]) };
  service.resolveConnection = () => ({ ok: true, connection });
  service.requireSftp = async () => ({ ok: true, sftp });
  service.ctx = { logger: { warn() {} } };
  // The production route is registered with auth: "required"; the DSH
  // WebServer admits a request before it calls the handler. This direct
  // harness therefore calls the handler as an already-admitted request.
  const web = createServer((req, res) => service.handleStreamRoute(req, res));
  await new Promise((resolve) => web.listen(0, "127.0.0.1", resolve));
  try {
    const endpoint = `http://127.0.0.1:${web.address().port}/harbor/stream/file?connectionId=local-ssh&path=%2Fpipeline-source.bin&verify=sha256`;
    const response = await fetch(endpoint);
    assert.equal(response.status, 200);
    assert.equal(Number(response.headers.get("content-length")), payload.length);
    const downloaded = Buffer.from(await response.arrayBuffer());
    const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
    assert.equal(digest(downloaded), digest(payload), "HTTP stream and SFTP source have the same SHA-256");
    assert.equal(response.headers.get("x-content-sha256"), digest(payload), "download advertises the verified remote digest");
    const resumed = await fetch(`${endpoint}&offset=12345&expectedSha256=${digest(payload)}`);
    assert.equal(resumed.status, 200);
    assert.equal(resumed.headers.get("x-download-offset"), "12345");
    assert.deepEqual(Buffer.from(await resumed.arrayBuffer()), payload.subarray(12345));
    const stale = await fetch(`${endpoint}&offset=12345&expectedSha256=${"0".repeat(64)}`);
    assert.equal(stale.status, 409);
    const finished = await fetch(`${endpoint}&offset=${payload.length}&expectedSha256=${digest(payload)}`);
    assert.equal(finished.status, 200);
    assert.equal((await finished.arrayBuffer()).byteLength, 0);
    const uploadUrl = `http://127.0.0.1:${web.address().port}/harbor/stream/file?connectionId=local-ssh&path=%2Fbrowser-upload.bin&overwrite=false`;
    const put = (body) => fetch(uploadUrl, { method: "PUT", body });
    const firstUpload = await put(payload);
    assert.equal(firstUpload.status, 200, JSON.stringify(await firstUpload.json()));
    const conflictingUpload = await put("replacement");
    assert.equal(conflictingUpload.status, 409);
    assert.equal((await conflictingUpload.json()).error.code, "target-exists");
    assert.deepEqual(await call(sftp, "readFile", "/browser-upload.bin"), payload);
    await call(sftp, "unlink", "/browser-upload.bin");
  } finally { await new Promise((resolve) => web.close(resolve)); }
  const uploaded = await service.sftpUploadLocalFile({ localPath: input, remotePath: "/agent-upload.bin" });
  assert.equal(uploaded.ok, true, uploaded.error?.message);
  assert.deepEqual(await call(sftp, "readFile", "/agent-upload.bin"), payload);
  assert.equal((await service.sftpTransferList({ connectionId: "local-ssh" })).value.transfers[0].status, "done");
  await call(sftp, "unlink", "/agent-upload.bin");
  const moved = await service.moveSftpToTrash("local-ssh", "/seed.txt");
  assert.equal(moved.ok, true, moved.error?.message);
  assert.equal(String(await call(sftp, "readFile", moved.value.trashPath)), "seeded\n");
  await call(sftp, "rename", moved.value.trashPath, "/seed.txt");
  await call(sftp, "rmdir", "/.dsh-trash");
  rmSync(input);

  // ── listing: the seeds plus the sandbox shape ─────────────────────────────
  const names = (await call(sftp, "readdir", "/")).map((entry) => entry.filename).sort();
  assert.deepEqual(names, ["binary.bin", "config", "empty.txt", "seed.txt", "welcome.txt"],
    "the root holds our seed plus the server's samples (mounted over the given root)");
  await call(sftp, "mkdir", "/work");
  await call(sftp, "writeFile", "/work/app.conf", "listen 8080\n");
  const savedEditor = await saveEditorFile(sftp, "/work/app.conf", Buffer.from("listen 8080\n"), Buffer.from("listen 8081\n"));
  assert.deepEqual(savedEditor, { bytes: 12 });
  assert.equal(String(await call(sftp, "readFile", "/work/app.conf")), "listen 8081\n");
  await assert.rejects(saveEditorFile(sftp, "/work/app.conf", Buffer.from("listen 8080\n"), Buffer.from("stale")), /changed/);
  const restoredEditor = await service.sftpEditorSave({ connectionId: "local-ssh", path: "/work/app.conf", expected: Buffer.from("listen 8081\n").toString("base64"), data: Buffer.from("listen 8080\n").toString("base64") });
  assert.equal(restoredEditor.ok, true, restoredEditor.error?.message);
  assert.equal(String(await call(sftp, "readFile", "/work/app.conf")), "listen 8080\n");
  // Online editing never leaves a backup next to the file (any platform).
  const nested = (await call(sftp, "readdir", "/work")).map((entry) => entry.filename);
  assert.deepEqual(nested, ["app.conf"], "no backup or temporary file remains after an editor save");

  // ── read / write / stat round trips ──────────────────────────────────────
  const text = String(await call(sftp, "readFile", "/seed.txt"));
  assert.equal(text, "seeded\n");
  const stat = await call(sftp, "stat", "/work/app.conf");
  assert.equal(stat.size, 12);
  assert.ok(stat.isFile());

  await call(sftp, "writeFile", "/binary-ish.dat", Buffer.from([0x00, 0x01, 0xff, 0xfe]));
  const bytes = await call(sftp, "readFile", "/binary-ish.dat");
  assert.deepEqual([...bytes], [0x00, 0x01, 0xff, 0xfe], "binary payloads survive the round trip");

  // Overwrite through the editor path (truncate + write).
  await call(sftp, "writeFile", "/work/app.conf", "listen 9090\nserver_name x;\n");
  assert.equal(String(await call(sftp, "readFile", "/work/app.conf")), "listen 9090\nserver_name x;\n");

  // The size the client reads back is what the editor's conflict guard
  // compares, so client and server must agree on it exactly.
  assert.equal((await call(sftp, "stat", "/work/app.conf")).size, 27);

  // ── rename / remove / rmdir ──────────────────────────────────────────────
  const listed = async (dir) => (await call(sftp, "readdir", dir)).map((entry) => entry.filename);
  await call(sftp, "rename", "/binary-ish.dat", "/moved.dat");
  assert.equal((await listed("/")).includes("moved.dat"), true);
  await call(sftp, "unlink", "/moved.dat");
  assert.equal((await listed("/")).includes("moved.dat"), false);
  await call(sftp, "unlink", "/work/app.conf");
  await call(sftp, "rmdir", "/work");
  assert.equal((await listed("/")).includes("work"), false);

  // ── the sandbox boundary holds ───────────────────────────────────────────
  await assert.rejects(() => call(sftp, "readFile", "/../../etc/passwd"), /(No such file|Permission denied|Failure)/i);
  await assert.rejects(() => call(sftp, "stat", "/../outside"), /No such file|Permission denied|Failure/i);
  const realpath = await call(sftp, "realpath", "/.");
  assert.equal(realpath, "/");
} finally {
  try { client?.end(); } catch {}
  child.kill("SIGTERM");
  rmSync(root, { recursive: true, force: true });
}

console.log("local sshd sftp: listing, read/write/binary round trips, rename/remove and the sandbox boundary all passed");
