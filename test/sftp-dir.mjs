// Directory batch transfer: scheduling policy (small files parallel, big
// files exclusive), counters, per-file failure collection — plus the service
// upload/download round trip against an in-memory SFTP server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable, Readable } from "node:stream";
import {
  runTransferTasks,
  joinRemotePath,
  splitRemotePath,
  planCaseSafeDownloads,
  CASE_INSENSITIVE_LOCAL_FS,
  SFTP_DIR_SMALL_CONCURRENCY
} from "../src/host/sftp-dir.js";
import HarborService from "../src/index.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("joinRemotePath and splitRemotePath handle root and nested paths", () => {
  assert.equal(joinRemotePath("/", "etc"), "/etc");
  assert.equal(joinRemotePath("/var/log", "app"), "/var/log/app");
  assert.equal(joinRemotePath("/var/log/", "app"), "/var/log/app");
  assert.deepEqual(splitRemotePath("/var/log"), { parent: "/var", name: "log" });
  assert.deepEqual(splitRemotePath("/etc"), { parent: "/", name: "etc" });
  // An empty base is not "the root": it used to re-root a whole upload at /.
  assert.throws(() => joinRemotePath("", "a.txt"), /remote path must not be empty/);
  assert.throws(() => joinRemotePath("   ", "a.txt"), /remote path must not be empty/);
  assert.throws(() => joinRemotePath(undefined, "a.txt"), /remote path must not be empty/);
});

test("planCaseSafeDownloads refuses the second of two names that differ only in case", () => {
  const entries = [
    { rel: ".", isDirectory: true },
    { rel: "A.txt", isDirectory: false },
    { rel: "a.txt", isDirectory: false },
    { rel: "B.txt", isDirectory: false },
    { rel: "link", isDirectory: false, symlink: true },
    { rel: "Sub/Deep.txt", isDirectory: false },
    { rel: "sub/deep.txt", isDirectory: false }
  ];
  const folded = planCaseSafeDownloads(entries, { caseInsensitive: true });
  assert.deepEqual(folded.directories.map((entry) => entry.rel), ["."], "directories pass through untouched");
  assert.deepEqual(folded.files.map((entry) => entry.rel), ["A.txt", "B.txt", "Sub/Deep.txt"],
    "the FIRST spelling wins; a later one would silently overwrite its file");
  assert.deepEqual(folded.blocked.map((entry) => entry.path), ["a.txt", "sub/deep.txt"]);
  assert.match(folded.blocked[0].error, /case/);
  assert.match(folded.blocked[0].error, /A\.txt/, "the report names the file it collides with");

  const exact = planCaseSafeDownloads(entries, { caseInsensitive: false });
  assert.deepEqual(exact.files.map((entry) => entry.rel), ["A.txt", "a.txt", "B.txt", "Sub/Deep.txt", "sub/deep.txt"],
    "a case-sensitive filesystem keeps both files");
  assert.deepEqual(exact.blocked, []);
  assert.equal(CASE_INSENSITIVE_LOCAL_FS, process.platform === "darwin" || process.platform === "win32");
});

test("runTransferTasks bounds small-file concurrency and keeps big files exclusive", async () => {
  let inFlight = 0;
  let maxSmallInFlight = 0;
  const overlaps = [];
  let bigInFlight = 0;
  const makeTask = (name, size, ms) => ({
    path: name,
    size,
    run: async () => {
      if (size > 512 * 1024) {
        if (bigInFlight > 0) overlaps.push(`big ${name} during big`);
        bigInFlight += 1;
        await sleep(ms);
        bigInFlight -= 1;
        return;
      }
      inFlight += 1;
      maxSmallInFlight = Math.max(maxSmallInFlight, inFlight);
      await sleep(ms);
      inFlight -= 1;
    }
  });
  const tasks = [];
  for (let i = 0; i < 20; i += 1) tasks.push(makeTask(`small-${i}`, 100, 5));
  for (let i = 0; i < 3; i += 1) tasks.push(makeTask(`big-${i}`, 600 * 1024, 5));
  const result = await runTransferTasks(tasks);
  assert.equal(result.files, 23);
  assert.equal(result.bytes, 3 * 600 * 1024 + 20 * 100);
  assert.equal(result.failures.length, 0);
  assert.ok(maxSmallInFlight <= SFTP_DIR_SMALL_CONCURRENCY, `small concurrency ${maxSmallInFlight} exceeds bound`);
  assert.ok(maxSmallInFlight > 1, "small files should overlap each other");
  assert.equal(overlaps.length, 0, "big files must never overlap each other");
});

test("runTransferTasks collects per-task failures without aborting the batch", async () => {
  const result = await runTransferTasks([
    { path: "ok-1", size: 1, run: async () => {} },
    { path: "bad", size: 1, run: async () => { throw new Error("boom"); } },
    { path: "ok-2", size: 2, run: async () => {} }
  ]);
  assert.equal(result.files, 2);
  assert.equal(result.bytes, 3);
  assert.deepEqual(result.failures, [{ path: "bad", error: "boom" }]);
});

// ── in-memory SFTP server for the service round trip ────────────────────────

function makeFakeSftp() {
  const files = new Map();
  const dirs = new Set(["/"]);
  const modeDir = 0o040755;
  const modeFile = 0o100644;
  const sftp = {
    files,
    dirs,
    mkdir(path, cb) {
      if (dirs.has(path)) return cb(new Error("Failure"));
      const { parent } = split(path);
      if (!dirs.has(parent)) return cb(new Error("no such directory"));
      dirs.add(path);
      cb(null);
    },
    stat(path, cb) {
      if (dirs.has(path)) return cb(null, { mode: modeDir, size: 0 });
      if (files.has(path)) return cb(null, { mode: modeFile, size: files.get(path).length });
      cb(new Error("not found"));
    },
    readdir(path, cb) {
      if (!dirs.has(path)) return cb(new Error("not found"));
      const prefix = path === "/" ? "/" : `${path}/`;
      const names = new Map();
      for (const key of dirs) {
        if (key !== "/" && key.startsWith(prefix) && !key.slice(prefix.length).includes("/")) {
          names.set(key.slice(prefix.length), { filename: key.slice(prefix.length), attrs: { mode: modeDir, size: 0 } });
        }
      }
      for (const key of files.keys()) {
        if (key.startsWith(prefix) && !key.slice(prefix.length).includes("/")) {
          names.set(key.slice(prefix.length), { filename: key.slice(prefix.length), attrs: { mode: modeFile, size: files.get(key).length } });
        }
      }
      cb(null, [...names.values()]);
    },
    createWriteStream(path) {
      const chunks = [];
      const ws = new Writable({
        write(chunk, _enc, done) {
          chunks.push(chunk);
          done();
        },
        final(done) {
          files.set(path, Buffer.concat(chunks));
          done();
        }
      });
      return ws;
    },
    createReadStream(path) {
      const data = files.get(path);
      return Readable.from(data === undefined ? [] : [data]);
    },
    rename(from, to, cb) {
      if (!files.has(from)) return cb(new Error("not found"));
      files.set(to, files.get(from));
      files.delete(from);
      cb(null);
    },
    unlink(path, cb) {
      files.delete(path);
      cb(null);
    }
  };
  return sftp;
}

function split(path) {
  const normalized = path.replace(/\/+$/, "") || "/";
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return { parent: "/", name: normalized.slice(index + 1) };
  return { parent: normalized.slice(0, index), name: normalized.slice(index + 1) };
}

function makeService(fakeSftp) {
  const service = Object.create(HarborService.prototype);
  service.activeConnectionId = null;
  service.connections = new Map([["c1", { id: "c1", sftp: fakeSftp, client: null }]]);
  return service;
}

test("sftpUploadDir creates the remote tree and reports per-file failures", async () => {
  const localRoot = await mkdtemp(join(tmpdir(), "dsh-up-"));
  try {
    await mkdir(join(localRoot, "sub"), { recursive: true });
    await writeFile(join(localRoot, "a.txt"), "alpha");
    await writeFile(join(localRoot, "sub", "big.bin"), Buffer.alloc(600 * 1024, 7));
    const fakeSftp = makeFakeSftp();
    const service = makeService(fakeSftp);

    const result = await service.sftpUploadDir({ connectionId: "c1", localPath: localRoot, remotePath: "/opt/app" });
    assert.equal(result.ok, true);
    const value = result.value;
    assert.equal(value.files, 2);
    assert.equal(value.bytes, 600 * 1024 + 5);
    assert.equal(value.failed.length, 0);
    assert.ok(value.directories >= 2, "root and sub are counted");
    assert.deepEqual(fakeSftp.files.get("/opt/app/a.txt").toString(), "alpha");
    assert.equal(fakeSftp.files.get("/opt/app/sub/big.bin").length, 600 * 1024);
  } finally {
    await rm(localRoot, { recursive: true, force: true });
  }
});

test("cancelled upload preserves an existing remote target", async () => {
  const localRoot = await mkdtemp(join(tmpdir(), "dsh-up-cancel-"));
  try {
    const localFile = join(localRoot, "a.txt");
    await writeFile(localFile, "replacement");
    const fakeSftp = makeFakeSftp();
    fakeSftp.files.set("/a.txt", Buffer.from("original"));
    const service = makeService(fakeSftp);
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await assert.rejects(service.sftpUploadFile({ sftp: fakeSftp }, localFile, "/a.txt", controller.signal));
    assert.equal(fakeSftp.files.get("/a.txt").toString(), "original");
    assert.deepEqual([...fakeSftp.files.keys()], ["/a.txt"]);
  } finally {
    await rm(localRoot, { recursive: true, force: true });
  }
});

test("cancelled file transfer waits for partial-file cleanup", async () => {
  const service = makeService(makeFakeSftp());
  const controller = new AbortController();
  const source = Readable.from([Buffer.from("partial")]);
  const target = new Writable({ write() {} });
  let finishCleanup;
  const cleanup = new Promise((resolve) => { finishCleanup = resolve; });
  let settled = false;
  const transfer = service.pipeSftpFile(source, target, controller.signal, () => cleanup)
 .finally(() => { settled = true; });
  controller.abort(new Error("cancelled"));
  await sleep(10);
  assert.equal(settled, false, "transfer must wait until cleanup finishes");
  finishCleanup();
  await assert.rejects(transfer, /cancelled/);
});

test("sftpUploadDir validates every bound destination before creating or uploading anything", async () => {
  const localRoot = await mkdtemp(join(tmpdir(), "dsh-up-bound-"));
  try {
    await mkdir(join(localRoot, "vendor"), { recursive: true });
    await writeFile(join(localRoot, "vendor", "payload.txt"), "must stay inside the workspace");
    const fakeSftp = makeFakeSftp();
    const service = makeService(fakeSftp);
    const checked = [];
    service.assertRemoteWorkspaceTarget = async (_connection, root, target) => {
      checked.push(target);
      if (target === "/srv/app/vendor") {
        throw new Error(`path resolves outside the remote workspace root ${root} through a symbolic link`);
      }
    };

    const result = await service.sftpUploadDir({
      connectionId: "c1",
      localPath: localRoot,
      remotePath: "/srv/app",
      remoteWorkspaceRoot: "/srv/app"
    });
    assert.equal(result.ok, false, "a rejected nested destination aborts the batch");
    assert.deepEqual(checked, ["/srv/app", "/srv/app/vendor"], "root and nested directories are checked before transfer");
    assert.deepEqual([...fakeSftp.dirs], ["/"], "preflight failure does not create the remote root");
    assert.equal(fakeSftp.files.size, 0, "preflight failure does not upload any file");
  } finally {
    await rm(localRoot, { recursive: true, force: true });
  }
});

test("sftpDownloadDir recreates the tree locally", async () => {
  const localRoot = await mkdtemp(join(tmpdir(), "dsh-down-"));
  try {
    const fakeSftp = makeFakeSftp();
    fakeSftp.dirs.add("/data");
    fakeSftp.dirs.add("/data/nested");
    fakeSftp.files.set("/data/one.txt", Buffer.from("first"));
    fakeSftp.files.set("/data/nested/two.txt", Buffer.from("second"));
    const service = makeService(fakeSftp);

    const result = await service.sftpDownloadDir({ connectionId: "c1", remotePath: "/data", localPath: join(localRoot, "out") });
    assert.equal(result.ok, true);
    assert.equal(result.value.files, 2);
    assert.equal(result.value.bytes, 11);
    assert.equal(result.value.failed.length, 0);
    assert.equal(await readFile(join(localRoot, "out", "one.txt"), "utf8"), "first");
    assert.equal(await readFile(join(localRoot, "out", "nested", "two.txt"), "utf8"), "second");
  } finally {
    await rm(localRoot, { recursive: true, force: true });
  }
});

test("a download the server cut short is reported, not counted as a finished file", async () => {
  const localRoot = await mkdtemp(join(tmpdir(), "dsh-down-short-"));
  try {
    const fakeSftp = makeFakeSftp();
    fakeSftp.dirs.add("/data");
    fakeSftp.files.set("/data/ok.txt", Buffer.from("intact"));
    fakeSftp.files.set("/data/short.txt", Buffer.from("0123456789"));
    // The walk lists 10 bytes; the channel then delivers 4 and ends without an
    // error, which is exactly what a transfer killed mid-stream looks like:
    // the commit rename succeeds and the file looks finished.
    const realCreateReadStream = fakeSftp.createReadStream;
    fakeSftp.createReadStream = (remotePath) => (remotePath === "/data/short.txt"
      ? Readable.from([Buffer.from("0123")])
      : realCreateReadStream(remotePath));
    const service = makeService(fakeSftp);

    const result = await service.sftpDownloadDir({ connectionId: "c1", remotePath: "/data", localPath: join(localRoot, "out") });
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(result.value.files, 1, "only the intact file counts as downloaded");
    assert.equal(result.value.failed.length, 1);
    assert.equal(result.value.failed[0].path, "short.txt");
    assert.match(result.value.failed[0].error, /incomplete download/);
    assert.equal(await readFile(join(localRoot, "out", "ok.txt"), "utf8"), "intact");
    // The short bytes are not left behind as if they were the real file.
    await assert.rejects(readFile(join(localRoot, "out", "short.txt")), /ENOENT/);
  } finally {
    await rm(localRoot, { recursive: true, force: true });
  }
});

test("a POSIX filename containing a backslash keeps its name on the way up", async () => {
  // Only Windows uses \ as a separator. The upload walker translated it
  // unconditionally, so a local `a\\b.txt` became `/dest/a/b.txt` and a
  // directory `a` appeared on the server: silent relocation, and asymmetric
  // too, because assertSafeEntryName refuses a backslash on the way back down.
  const localRoot = await mkdtemp(join(tmpdir(), "dsh-up-slash-"));
  try {
    const name = "a\\b.txt";
    await writeFile(join(localRoot, name), "backslash");
    const fakeSftp = makeFakeSftp();
    fakeSftp.dirs.add("/dest");
    const service = makeService(fakeSftp);

    const result = await service.sftpUploadDir({ connectionId: "c1", localPath: localRoot, remotePath: "/dest" });
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(result.value.files, 1);
    assert.equal(result.value.failed.length, 0);
    if (process.platform === "win32") {
      assert.ok(fakeSftp.files.has("/dest/a/b.txt"), "a Windows host still translates its separator");
    } else {
      assert.ok(fakeSftp.files.has(`/dest/${name}`), "the name is uploaded verbatim: " + JSON.stringify([...fakeSftp.files.keys()]));
      assert.equal(fakeSftp.files.get(`/dest/${name}`).toString(), "backslash");
    }
    assert.equal([...fakeSftp.dirs].some((dir) => dir === "/dest/a"), false, "no directory is invented from the file name");
  } finally {
    await rm(localRoot, { recursive: true, force: true });
  }
});

test("a download never maps two remote names onto one local file", async () => {
  const localRoot = await mkdtemp(join(tmpdir(), "dsh-down-case-"));
  try {
    const fakeSftp = makeFakeSftp();
    fakeSftp.dirs.add("/data");
    fakeSftp.files.set("/data/A.txt", Buffer.from("upper"));
    fakeSftp.files.set("/data/a.txt", Buffer.from("lower"));
    const service = makeService(fakeSftp);

    const result = await service.sftpDownloadDir({ connectionId: "c1", remotePath: "/data", localPath: join(localRoot, "out") });
    assert.equal(result.ok, true, result.error?.message);
    if (CASE_INSENSITIVE_LOCAL_FS) {
      assert.equal(result.value.files, 1, "one file, because one local file was written");
      assert.equal(result.value.failed.length, 1, "the loss is reported instead of hidden behind a count");
      assert.equal(result.value.failed[0].path, "a.txt");
      assert.match(result.value.failed[0].error, /case/);
      assert.equal(await readFile(join(localRoot, "out", "A.txt"), "utf8"), "upper");
    } else {
      assert.equal(result.value.files, 2, "a case-sensitive filesystem holds both");
      assert.equal(result.value.failed.length, 0);
    }
  } finally {
    await rm(localRoot, { recursive: true, force: true });
  }
});
