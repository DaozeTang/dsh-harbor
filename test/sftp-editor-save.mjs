import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { saveEditorFile } from "../src/host/files/sftp-editor-save.js";

function fixture() {
  const files = new Map([["/config", Buffer.from("old")]]);
  const sftp = {
    createReadStream(path) { if (!files.has(path)) throw new Error("missing"); return Readable.from([files.get(path)]); },
    createWriteStream(path) {
      const chunks = [];
      return new Writable({
        write(chunk, _, callback) { chunks.push(Buffer.from(chunk)); callback(); },
        final(callback) {
          files.set(path, Buffer.concat(chunks));
          callback();
        }
      });
    },
    stat(path, callback) {
      if (!files.has(path)) callback(Object.assign(new Error("no such file"), { code: 2 }));
      else callback(null, { mode: 0o100644, size: files.get(path).length });
    },
    chmod(_path, _mode, callback) { callback(null); },
    unlink(path, callback) { files.delete(path); callback(null); },
    rename(from, to, callback) {
      if (!files.has(from)) { callback(new Error("no such file")); return; }
      files.set(to, files.get(from));
      files.delete(from);
      callback(null);
    }
  };
  return { files, sftp };
}

test("save replaces the remote file without leaving a backup", async () => {
  const { files, sftp } = fixture();
  const result = await saveEditorFile(sftp, "/config", Buffer.from("old"), Buffer.from("new"));
  assert.deepEqual(result, { bytes: 3 });
  assert.equal(files.get("/config").toString(), "new");
  assert.deepEqual([...files.keys()], ["/config"], "no hidden backup or temporary file is created");
  assert.equal([...files.keys()].some((name) => name.includes("dsh-backup")), false);
});

test("a stale editor buffer is rejected before anything is written", async () => {
  const { files, sftp } = fixture();
  await assert.rejects(saveEditorFile(sftp, "/config", Buffer.from("before-opening"), Buffer.from("new")), /changed/);
  assert.equal(files.get("/config").toString(), "old");
  assert.deepEqual([...files.keys()], ["/config"]);
});

test("a change between the two conflict reads prevents overwriting", async () => {
  const { files, sftp } = fixture();
  const read = sftp.createReadStream;
  let reads = 0;
  sftp.createReadStream = (path) => {
    if (++reads === 2) files.set(path, Buffer.from("other"));
    return read(path);
  };
  await assert.rejects(saveEditorFile(sftp, "/config", Buffer.from("old"), Buffer.from("new")), /changed during save/);
  assert.equal(files.get("/config").toString(), "other");
  assert.equal([...files.keys()].some((name) => name.includes("dsh-backup")), false);
});

test("a write that fails part-way leaves the original file untouched", async () => {
  const { files, sftp } = fixture();
  sftp.createWriteStream = () => new Writable({
    write(_chunk, _encoding, callback) { callback(new Error("connection lost")); }
  });
  await assert.rejects(saveEditorFile(sftp, "/config", Buffer.from("old"), Buffer.from("new")), /connection lost/);
  assert.equal(files.get("/config").toString(), "old", "the target still holds the old bytes");
  assert.deepEqual([...files.keys()], ["/config"], "the temporary file is cleaned up");
});

test("a refused rename keeps the old file and removes the temporary one", async () => {
  const { files, sftp } = fixture();
  sftp.rename = (_from, _to, callback) => callback(new Error("rename refused"));
  await assert.rejects(saveEditorFile(sftp, "/config", Buffer.from("old"), Buffer.from("new")), /rename refused/);
  assert.equal(files.get("/config").toString(), "old");
  assert.deepEqual([...files.keys()], ["/config"], "the temporary file is cleaned up");
});

test("a save through a symlink replaces its target, not the link", async () => {
  const { files, sftp } = fixture();
  files.set("/real", Buffer.from("old"));
  sftp.lstat = (_path, callback) => callback(null, { mode: 0o120777 });
  sftp.realpath = (_path, callback) => callback(null, "/real");
  await saveEditorFile(sftp, "/config", Buffer.from("old"), Buffer.from("new"));
  assert.equal(files.get("/real").toString(), "new", "the link's target holds the new bytes");
  assert.equal([...files.keys()].some((name) => name.includes(".tmp")), false, "no temporary file is left behind");
});

test("an aborted save destroys the stream and leaves the original file", async () => {
  const { files, sftp } = fixture();
  sftp.createWriteStream = () => new Writable({
    write(_chunk, _encoding, callback) { setTimeout(callback, 5); },
    final() { /* never completes: the abort must destroy the stream */ }
  });
  const controller = new AbortController();
  const pending = saveEditorFile(sftp, "/config", Buffer.from("old"), Buffer.from("new"), { signal: controller.signal, timeoutMs: 5000 });
  setTimeout(() => controller.abort(new Error("save cancelled")), 20);
  await assert.rejects(pending, /save cancelled/);
  assert.equal(files.get("/config").toString(), "old", "the target keeps the old bytes");
  assert.deepEqual([...files.keys()], ["/config"], "the temporary file is cleaned up");
});

test("a write timeout destroys the stream instead of reporting a false success", async () => {
  const { files, sftp } = fixture();
  sftp.createWriteStream = () => new Writable({
    write(_chunk, _encoding, callback) { setTimeout(callback, 5); },
    final() { /* never completes: the budget must end the write */ }
  });
  await assert.rejects(
    saveEditorFile(sftp, "/config", Buffer.from("old"), Buffer.from("new"), { timeoutMs: 30 }),
    /did not finish within 30 ms/
  );
  assert.equal(files.get("/config").toString(), "old");
  assert.deepEqual([...files.keys()], ["/config"]);
});

test("a file above the editor limit is refused", async () => {
  const { sftp } = fixture();
  const tooBig = Buffer.alloc(10 * 1024 * 1024 + 1);
  await assert.rejects(saveEditorFile(sftp, "/config", Buffer.from("old"), tooBig), /size limit/);
});
