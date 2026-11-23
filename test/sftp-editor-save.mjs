import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { saveEditorFile } from "../src/host/sftp-editor-save.js";

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

test("a file above the editor limit is refused", async () => {
  const { sftp } = fixture();
  const tooBig = Buffer.alloc(10 * 1024 * 1024 + 1);
  await assert.rejects(saveEditorFile(sftp, "/config", Buffer.from("old"), tooBig), /size limit/);
});
