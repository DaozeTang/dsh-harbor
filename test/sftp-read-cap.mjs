/**
 * sftp_read must not let a caller buffer an unbounded remote file, and must
 * never report a truncated read as complete. The RPC schema caps max_bytes,
 * but agent tools call the service directly.
 */
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import HarborService from "../src/index.js";
import { MAX_FILE_READ_BYTES } from "../src/host/service/constants.js";

/**
 * Deliver one chunk per macrotask, the shape a real SFTP read stream has.
 * Chunks arriving back to back in one tick hide the boundary bug: a queued
 * chunk overshoots the budget and makes truncation look detected.
 */
async function* oneChunkPerTick(chunks) {
  for (const chunk of chunks) {
    yield chunk;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function serviceWith(chunks) {
  const service = Object.create(HarborService.prototype);
  service.resolveConnection = () => ({ ok: true, connectionId: "c1", connection: { id: "c1" } });
  service.requireSftp = async () => ({
    ok: true,
    sftp: { createReadStream: () => Readable.from(oneChunkPerTick(chunks)) }
  });
  return service;
}

/** A file split into SFTP-sized chunks, the way a real read stream arrives. */
function fileOfSize(size, chunkSize = 32 * 1024) {
  const chunks = [];
  for (let offset = 0; offset < size; offset += chunkSize) {
    chunks.push(Buffer.alloc(Math.min(chunkSize, size - offset), 1));
  }
  return chunks;
}

// ── a request above the cap is clamped before the host buffers it ──────────
{
  const service = serviceWith([Buffer.alloc(MAX_FILE_READ_BYTES + 1024, 1)]);
  const result = await service.sftpReadFile({ connectionId: "c1", path: "/big", maxBytes: 10 ** 9 });
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(Buffer.from(result.value.data, "base64").length, MAX_FILE_READ_BYTES, "only the capped prefix is returned");
  assert.equal(result.value.truncated, true);
}

// ── a smaller explicit budget is still honoured ────────────────────────────
{
  const service = serviceWith([Buffer.alloc(4096, 1)]);
  const result = await service.sftpReadFile({ connectionId: "c1", path: "/small", maxBytes: 10 });
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(Buffer.from(result.value.data, "base64").length, 10);
  assert.equal(result.value.truncated, true);
  assert.equal(result.value.bytes, 10, "bytes counts the returned content");
}

// ── the exact-multiple regression: a capped read must never look complete ──
// The budget used to be exactly maxBytes, so with 32 KiB chunks the read
// stopped ON the boundary (total === maxBytes) and `total > maxBytes` was
// false: the first 4 MiB of a 5 MiB file came back as a complete file.
{
  const service = serviceWith(fileOfSize(MAX_FILE_READ_BYTES + 1024 * 1024));
  const result = await service.sftpReadFile({ connectionId: "c1", path: "/five-mib", maxBytes: MAX_FILE_READ_BYTES });
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.value.truncated, true, "one byte past the cap proves the file continues");
  assert.equal(Buffer.from(result.value.data, "base64").length, MAX_FILE_READ_BYTES, "exactly the cap is returned");
  assert.equal(result.value.bytes, MAX_FILE_READ_BYTES, "bytes never exceeds the cap either");
}

// ── a file that fits exactly is complete, not truncated ──
{
  const service = serviceWith(fileOfSize(64 * 1024));
  const result = await service.sftpReadFile({ connectionId: "c1", path: "/exact", maxBytes: 64 * 1024 });
  assert.equal(result.value.truncated, false, "the read stops because the file ended, not because of the budget");
  assert.equal(Buffer.from(result.value.data, "base64").length, 64 * 1024);
  assert.equal(result.value.bytes, 64 * 1024);
}

// ── one byte over the cap is already a truncation ──
{
  const service = serviceWith(fileOfSize(64 * 1024 + 1));
  const result = await service.sftpReadFile({ connectionId: "c1", path: "/over", maxBytes: 64 * 1024 });
  assert.equal(result.value.truncated, true);
  assert.equal(Buffer.from(result.value.data, "base64").length, 64 * 1024);
  assert.equal(result.value.bytes, 64 * 1024);
}

// ── several chunks in one tick never exceed the budget ──
{
  const service = Object.create(HarborService.prototype);
  service.resolveConnection = () => ({ ok: true, connectionId: "c1", connection: { id: "c1" } });
  service.requireSftp = async () => ({
    ok: true,
    sftp: {
      createReadStream: () => {
        const stream = new Readable({ read() {} });
        stream.push(Buffer.alloc(1024, 1));
        stream.push(Buffer.alloc(4096, 2));
        stream.push(null);
        return stream;
      }
    }
  });
  const result = await service.sftpReadFile({ connectionId: "c1", path: "/burst", maxBytes: 1024 });
  assert.equal(result.value.truncated, true);
  assert.equal(Buffer.from(result.value.data, "base64").length, 1024);
  assert.equal(result.value.bytes, 1024);
}

// ── a zero budget returns no content and still reports the truncation ──
{
  const service = serviceWith([Buffer.alloc(16, 1)]);
  const result = await service.sftpReadFile({ connectionId: "c1", path: "/zero", maxBytes: 0 });
  assert.equal(result.value.data, "");
  assert.equal(result.value.bytes, 0);
  assert.equal(result.value.truncated, true);
}

console.log("sftp read cap: capped reads are exact, complete reads are complete: passed");
