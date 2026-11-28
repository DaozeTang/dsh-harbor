import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import HarborService from "../src/index.js";
import { assertSafeEntryName, assertLocalPathInside } from "../src/host/sftp-dir.js";

// A single readdir record is server-controlled: "/" and "\\" can change
// directory level, and "." / ".." are never legitimate leaves.
for (const bad of ["", ".", "..", "a/b", "a\\b", "a\nb", "a\0b"]) {
  assert.throws(() => assertSafeEntryName(bad), /plain file name|empty name|control character/, JSON.stringify(bad));
}
assert.equal(assertSafeEntryName("normal.txt"), "normal.txt", "ordinary names pass through unchanged");
assert.equal(assertSafeEntryName("name with spaces"), "name with spaces");

// The local destination of a download must stay at or below the picked root.
assert.equal(assertLocalPathInside("/tmp/root", "/tmp/root/a/b"), "/tmp/root/a/b");
assert.equal(assertLocalPathInside("/tmp/root", "/tmp/root"), "/tmp/root");
assert.throws(() => assertLocalPathInside("/tmp/root", "/tmp/root/../evil"), /escapes/);
assert.throws(() => assertLocalPathInside("/tmp/root", "/tmp/other"), /escapes/);

// Service-level regression: a malicious server name must fail the transfer
// before anything is created outside the operator-selected directory.
{
  const base = mkdtempSync(join(tmpdir(), "dsh-download-guard-"));
  try {
    const localRoot = join(base, "downloads");
    mkdirSync(localRoot, { recursive: true });
    const service = Object.create(HarborService.prototype);
    const connection = { id: "c1", dead: false, closing: false };
    service.resolveConnection = () => ({ ok: true, connectionId: "c1", connection });
    const raw = {
      stat(_path, cb) { cb(null, { mode: 0o040000 }); },
      readdir(_path, cb) { cb(null, [{ filename: "..\\..\\evil.txt", attrs: { mode: 0o100644, size: 4 } }]); }
    };
    service.requireSftp = async () => ({ ok: true, sftp: raw });
    const result = await service.sftpDownloadDir({ connectionId: "c1", remotePath: "/remote", localPath: localRoot });
    assert.equal(result.ok, false, "a traversal name must fail the whole transfer");
    assert.equal(result.error.code, "sftp-download-dir-failed");
    assert.match(result.error.message, /plain file name/);
    assert.equal(existsSync(join(base, "evil.txt")), false, "nothing may be written outside the chosen directory");
    assert.equal(existsSync(join(localRoot, "..", "evil.txt")), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// A normal tree still downloads, and every write lands under the root.
{
  const base = mkdtempSync(join(tmpdir(), "dsh-download-ok-"));
  try {
    const localRoot = join(base, "downloads");
    mkdirSync(localRoot, { recursive: true });
    const service = Object.create(HarborService.prototype);
    service.resolveConnection = () => ({ ok: true, connectionId: "c1", connection: { id: "c1", dead: false, closing: false } });
    const raw = {
      stat(_path, cb) { cb(null, { mode: 0o040000 }); },
      readdir(_path, cb) { cb(null, [{ filename: "normal.txt", attrs: { mode: 0o100644, size: 2 } }]); }
    };
    service.requireSftp = async () => ({ ok: true, sftp: raw });
    let written = null;
    service.sftpDownloadFile = async (_sftp, remoteFile, localFile) => {
      written = { remoteFile, localFile };
      writeFileSync(localFile, "ok");
    };
    const result = await service.sftpDownloadDir({ connectionId: "c1", remotePath: "/remote", localPath: localRoot });
    assert.equal(result.ok, true, result.error?.message);
    assert.deepEqual(written, { remoteFile: "/remote/normal.txt", localFile: join(localRoot, "normal.txt") });
    assert.equal(existsSync(join(localRoot, "normal.txt")), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// A name that merely LOOKS like a parent reference is an ordinary file.
assert.equal(assertLocalPathInside("/tmp/root", "/tmp/root/..env"), "/tmp/root/..env", "a sibling-looking name is not an escape");

// A symlink that already sits inside the destination tree must not receive the
// download. The lexical name check cannot see it and createWriteStream/mkdir
// follow it, so a remote-controlled tree could land in ~/.ssh.
if (process.platform !== "win32") {
  // ── a symlinked directory below the root aborts before any write ──
  {
    const base = mkdtempSync(join(tmpdir(), "dsh-download-link-dir-"));
    try {
      const localRoot = join(base, "downloads");
      const outside = join(base, "outside");
      mkdirSync(localRoot, { recursive: true });
      mkdirSync(outside, { recursive: true });
      symlinkSync(outside, join(localRoot, "vendor"));
      const service = Object.create(HarborService.prototype);
      service.resolveConnection = () => ({ ok: true, connectionId: "c1", connection: { id: "c1", dead: false, closing: false } });
      const raw = {
        stat(_path, cb) { cb(null, { mode: 0o040000 }); },
        readdir(path, cb) {
          if (path === "/remote") cb(null, [{ filename: "vendor", attrs: { mode: 0o040000, size: 0 } }]);
          else cb(null, [{ filename: "payload.txt", attrs: { mode: 0o100644, size: 7 } }]);
        }
      };
      service.requireSftp = async () => ({ ok: true, sftp: raw });
      const written = [];
      service.sftpDownloadFile = async (_sftp, _remote, localFile) => {
        written.push(localFile);
        writeFileSync(localFile, "attacker");
      };
      const result = await service.sftpDownloadDir({ connectionId: "c1", remotePath: "/remote", localPath: localRoot });
      assert.equal(result.ok, false, "a symlinked directory in the destination tree aborts the batch");
      assert.match(result.error.message, /symbolic link/);
      assert.deepEqual(written, [], "no transfer starts for a tree that escapes");
      assert.equal(existsSync(join(outside, "payload.txt")), false, "nothing is written through the directory link");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  // ── a symlinked FILE for one entry is refused for that entry ──
  {
    const base = mkdtempSync(join(tmpdir(), "dsh-download-link-file-"));
    try {
      const localRoot = join(base, "downloads");
      const outside = join(base, "outside");
      mkdirSync(localRoot, { recursive: true });
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "secret.txt"), "original");
      symlinkSync(join(outside, "secret.txt"), join(localRoot, "passwd.txt"));
      const service = Object.create(HarborService.prototype);
      service.resolveConnection = () => ({ ok: true, connectionId: "c1", connection: { id: "c1", dead: false, closing: false } });
      const raw = {
        stat(_path, cb) { cb(null, { mode: 0o040000 }); },
        readdir(_path, cb) { cb(null, [{ filename: "passwd.txt", attrs: { mode: 0o100644, size: 5 } }]); }
      };
      service.requireSftp = async () => ({ ok: true, sftp: raw });
      const written = [];
      service.sftpDownloadFile = async (_sftp, _remote, localFile) => {
        written.push(localFile);
        writeFileSync(localFile, "attacker");
      };
      const result = await service.sftpDownloadDir({ connectionId: "c1", remotePath: "/remote", localPath: localRoot });
      assert.equal(result.ok, true, result.error?.message);
      assert.equal(result.value.files, 0);
      assert.equal(result.value.failed.length, 1, "the escaping entry is reported, not silently skipped");
      assert.match(result.value.failed[0].error, /symbolic link/);
      assert.deepEqual(written, [], "the linked destination is never opened");
      assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "original", "the link target keeps its content");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
}

// ── a remote symlink entry is reported and never followed ──
{
  const base = mkdtempSync(join(tmpdir(), "dsh-download-remote-link-"));
  try {
    const localRoot = join(base, "downloads");
    mkdirSync(localRoot, { recursive: true });
    const service = Object.create(HarborService.prototype);
    service.resolveConnection = () => ({ ok: true, connectionId: "c1", connection: { id: "c1", dead: false, closing: false } });
    const raw = {
      stat(_path, cb) { cb(null, { mode: 0o040000 }); },
      readdir(_path, cb) {
        cb(null, [
          { filename: "escape", attrs: { mode: 0o120777, size: 0 } },
          { filename: "ok.txt", attrs: { mode: 0o100644, size: 2 } }
        ]);
      }
    };
    service.requireSftp = async () => ({ ok: true, sftp: raw });
    const downloaded = [];
    service.sftpDownloadFile = async (_sftp, remoteFile, localFile) => {
      downloaded.push(remoteFile);
      writeFileSync(localFile, "ok");
    };
    const result = await service.sftpDownloadDir({ connectionId: "c1", remotePath: "/remote", localPath: localRoot });
    assert.equal(result.ok, true, result.error?.message);
    assert.deepEqual(downloaded, ["/remote/ok.txt"], "the regular file downloads, the symlink does not");
    assert.deepEqual(result.value.failed, [{ path: "escape", error: "symbolic links are not followed" }]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

console.log("download path guard: server-controlled names cannot escape the local root");
