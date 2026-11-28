/**
 * A directory download must never destroy the local file it is replacing.
 *
 * The bytes used to be written straight into the destination, which truncates
 * it before the first new byte arrives; the cancellation cleanup then unlinked
 * it. So "download the latest config directory again" + Stop deleted the local
 * copy while the remote replacement never landed. A plain I/O error was worse:
 * it is not an abort, so no cleanup ran and a truncated file stayed behind.
 *
 * The fix writes a unique sibling and renames on success, so the destination
 * keeps its previous content until the transfer has actually completed.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import HarborService from "../src/index.js";

async function until(predicate, label) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Every temporary file this feature leaves behind, in the download root. */
function leftoverTemps(dir) {
  return readdirSync(dir).filter((name) => name.includes(".dsh-dl-"));
}

/** One-file remote tree whose read stream the test drives by hand. */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "dsh-download-commit-"));
  const localRoot = join(base, "downloads");
  mkdirSync(localRoot, { recursive: true });
  const destination = join(localRoot, "keep.txt");
  writeFileSync(destination, "precious");
  const source = new PassThrough();
  const service = Object.create(HarborService.prototype);
  service.resolveConnection = () => ({ ok: true, connectionId: "c1", connection: { id: "c1", dead: false, closing: false } });
  const raw = {
    stat(_path, callback) { callback(null, { mode: 0o040000 }); },
    readdir(_path, callback) { callback(null, [{ filename: "keep.txt", attrs: { mode: 0o100644, size: 17 } }]); },
    createReadStream() { return source; }
  };
  service.requireSftp = async () => ({ ok: true, sftp: raw });
  return {
    base,
    localRoot,
    destination,
    source,
    run(signal) {
      return service.sftpDownloadDir({ connectionId: "c1", remotePath: "/remote", localPath: localRoot, signal });
    },
    cleanup() { rmSync(base, { recursive: true, force: true }); }
  };
}

// ── cancelling keeps the file that was already there ──
{
  const f = fixture();
  try {
    const controller = new AbortController();
    const pending = f.run(controller.signal);
    await until(() => f.source.listenerCount("data") > 0 || f.source.listenerCount("readable") > 0, "the read stream to be piped");
    f.source.write("brand new content");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(readFileSync(f.destination, "utf8"), "precious", "the destination is untouched while the transfer runs");
    controller.abort();
    const result = await pending;
    assert.equal(readFileSync(f.destination, "utf8"), "precious", "cancelling must not delete the file it was replacing");
    assert.deepEqual(leftoverTemps(f.localRoot), [], "the temporary is removed");
    const surfaced = result.ok === false || (result.value.failed?.length ?? 0) === 1;
    assert.equal(surfaced, true, "the cancellation is reported instead of looking like a completed download");
  } finally {
    f.cleanup();
  }
}

// ── a completed transfer replaces the content and leaves nothing behind ──
{
  const f = fixture();
  try {
    const pending = f.run(undefined);
    await until(() => f.source.listenerCount("data") > 0 || f.source.listenerCount("readable") > 0, "the read stream to be piped");
    f.source.end("brand new content");
    const result = await pending;
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(result.value.files, 1);
    assert.equal(readFileSync(f.destination, "utf8"), "brand new content", "the completed download commits");
    assert.deepEqual(leftoverTemps(f.localRoot), [], "no temporary survives a commit");
  } finally {
    f.cleanup();
  }
}

// ── an I/O failure keeps the previous content instead of a truncated file ──
{
  const f = fixture();
  try {
    const pending = f.run(undefined);
    await until(() => f.source.listenerCount("data") > 0 || f.source.listenerCount("readable") > 0, "the read stream to be piped");
    f.source.write("half a file");
    await new Promise((resolve) => setTimeout(resolve, 30));
    f.source.destroy(new Error("network reset"));
    const result = await pending;
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(result.value.files, 0);
    assert.equal(result.value.failed.length, 1, "the failed entry is reported");
    assert.match(result.value.failed[0].error, /network reset/);
    assert.equal(readFileSync(f.destination, "utf8"), "precious", "a failed transfer never truncates the destination");
    assert.deepEqual(leftoverTemps(f.localRoot), [], "the partial file is removed");
  } finally {
    f.cleanup();
  }
}

// ── a fresh destination is created with the complete file ──
{
  const f = fixture();
  try {
    rmSync(f.destination);
    const pending = f.run(undefined);
    await until(() => f.source.listenerCount("data") > 0 || f.source.listenerCount("readable") > 0, "the read stream to be piped");
    f.source.end("brand new content");
    const result = await pending;
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(readFileSync(f.destination, "utf8"), "brand new content");
    assert.equal(existsSync(f.destination), true);
    assert.deepEqual(leftoverTemps(f.localRoot), []);
  } finally {
    f.cleanup();
  }
}

console.log("download commit: a replacement never destroys the file it replaces");
