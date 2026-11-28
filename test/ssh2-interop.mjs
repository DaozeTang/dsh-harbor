import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveSsh2Client, createSsh2Client } from "../src/host/ssh/client.js";
import HarborService from "../src/index.js";

function quietEnd(client) {
  try { client.end(); } catch {}
}

test("resolves Client from the plain CommonJS exports object", () => {
  class FakeClient {}
  assert.equal(resolveSsh2Client(() => ({ Client: FakeClient })), FakeClient);
  assert.equal(resolveSsh2Client(() => ({ default: { Client: FakeClient } })), FakeClient);
});

test("an exports object captured before Client existed heals on the next attempt", () => {
  // The field failure: a plugin reload observed ssh2's partially initialized
  // module.exports (no Client). A binding captured at module load stayed broken
  // for the life of the host; resolving per call must recover by itself.
  class FakeClient {}
  let moduleExports = {};
  const load = () => moduleExports;
  assert.throws(() => resolveSsh2Client(load), /carries no Client constructor/);
  moduleExports = { Client: FakeClient };
  assert.equal(resolveSsh2Client(load), FakeClient);
});

test("a value with no Client fails with a message that names ssh2, not V8's TypeError", () => {
  assert.throws(() => resolveSsh2Client(() => ({})), (error) => {
    assert.ok(error instanceof TypeError);
    assert.match(error.message, /ssh2/);
    assert.doesNotMatch(error.message, /is not a constructor/);
    return true;
  });
  assert.throws(() => resolveSsh2Client(() => { throw Object.assign(new Error("Cannot find module 'ssh2'"), { code: "MODULE_NOT_FOUND" }); }), /ssh2 could not be loaded from this installation/);
});

test("builds a fresh client from the resolved constructor", () => {
  class FakeClient {
    constructor() { this.kind = "fake"; }
  }
  assert.equal(createSsh2Client(() => ({ Client: FakeClient })).kind, "fake");
});

test("the installed ssh2 package resolves through require() at call time", () => {
  const Client = resolveSsh2Client();
  assert.equal(typeof Client, "function");
  const client = new Client();
  assert.equal(typeof client.connect, "function");
  quietEnd(client);
});

test("HarborService.newClient goes through the runtime resolver", () => {
  const service = Object.create(HarborService.prototype);
  const client = service.newClient();
  assert.equal(client.constructor.name, "Client");
  quietEnd(client);
});

test("the host entry never captures Client from a static ssh2 import", () => {
  const entry = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  assert.doesNotMatch(entry, /import\s+ssh2\s+from\s+["']ssh2["']/);
  assert.doesNotMatch(entry, /const\s*\{\s*Client\s*\}\s*=\s*ssh2/);
  assert.match(entry, /createSsh2Client\(\)/);
  const resolver = readFileSync(new URL("../src/host/ssh/client.js", import.meta.url), "utf8");
  assert.match(resolver, /createRequire\(import\.meta\.url\)/);
  assert.match(resolver, /load\("ssh2"\)/);
  assert.match(resolver, /load = requireFromHarbor/);
});
test("a dependency captured mid-evaluation reproduces the field error, and the resolver recovers", () => {
  // ssh2 is CommonJS. This fixture replaces module.exports after evaluation,
  // which is what a capture taken mid-reload sees. A binding captured at
  // module load stays on the empty object (the reported TypeError); resolving
  // per call reads the finished exports and works.
  const root = mkdtempSync(join(tmpdir(), "harbor-ssh2-capture-"));
  try {
    const packageDir = join(root, "node_modules", "ssh2");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "ssh2", version: "0.0.0", main: "index.js" }));
    writeFileSync(join(packageDir, "index.js"), [
      "module.exports = {};",
      "setTimeout(() => { module.exports = { Client: class Client { connect() {} end() {} } }; }, 20);"
    ].join("\n"));
    const oldScript = join(root, "old.mjs");
    writeFileSync(oldScript, [
      'import ssh2 from "ssh2";',
      "const { Client } = ssh2;",
      "await new Promise((resolve) => setTimeout(resolve, 80));",
      'try { new Client(); console.log("ok"); } catch (error) { console.log(error.message); }'
    ].join("\n"));
    const resolverUrl = pathToFileURL(fileURLToPath(new URL("../src/host/ssh/client.js", import.meta.url))).href;
    const newScript = join(root, "new.mjs");
    writeFileSync(newScript, [
      'import { createRequire } from "node:module";',
      `import { createSsh2Client } from ${JSON.stringify(resolverUrl)};`,
      "const requireHere = createRequire(import.meta.url);",
      'await import("ssh2");',
      "await new Promise((resolve) => setTimeout(resolve, 80));",
      'try { console.log("ok:" + createSsh2Client(requireHere).constructor.name); } catch (error) { console.log(error.message); }'
    ].join("\n"));
    assert.equal(execFileSync(process.execPath, [oldScript], { cwd: root, encoding: "utf8" }).trim(), "Client is not a constructor");
    assert.equal(execFileSync(process.execPath, [newScript], { cwd: root, encoding: "utf8" }).trim(), "ok:Client");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
