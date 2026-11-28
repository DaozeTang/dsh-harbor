// Private-key import regressions:
// 1. A key file without an extension ("1" rather than "1.key") must be
//    selectable in every key picker; an accept-extensions filter greys it out.
// 2. Importing ~/.ssh/config must carry each IdentityFile's key into the
//    imported resource's credential slot instead of asking for a manual edit.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import HarborService from "../src/index.js";
import { inspectPrivateKeyText, scanOpenSshConfig } from "../src/host/resources/openssh-import.js";
import { profileCredentialRefs } from "../src/host/service/models.js";
import { openSshImportRequestSchema, openSshImportResultSchema } from "../src/rpc/schemas.js";

// Synthetic key material is enough for shape/encryption classification: the
// importer never decrypts a key, it only decides whether a usable one exists.
const KEY_BODY = ["QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=", "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo="].join("\n");
const PLAIN_KEY = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  KEY_BODY,
  "-----END OPENSSH PRIVATE KEY-----",
  ""
].join("\n");
const ENCRYPTED_KEY = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "Proc-Type: 4,ENCRYPTED",
  "DEK-Info: AES-128-CBC,0123456789ABCDEF0123456789ABCDEF",
  "",
  KEY_BODY,
  "-----END RSA PRIVATE KEY-----",
  ""
].join("\n");
const PUBLIC_KEY = ["ssh-ed25519", "AAAAC3NzaC1lZDI1NTE5AAAAIKgarbageUserKey", "user@example.test"].join(" ") + "\n";

const refKey = (ref) => (typeof ref === "string" ? ref : JSON.stringify(ref));

async function makeHome(config, keys) {
  const home = await mkdtemp(join(tmpdir(), "dsh-key-import-"));
  const ssh = join(home, ".ssh");
  await mkdir(join(ssh, "keys"), { recursive: true });
  for (const [name, text] of Object.entries(keys)) await writeFile(join(ssh, "keys", name), text);
  await writeFile(join(ssh, "config"), config);
  return { home, ssh };
}

const CONFIG = [
  "Host plain",
  "  HostName plain.example.test",
  "  User deploy",
  "  IdentityFile ~/.ssh/keys/1",
  "Host relative",
  "  HostName relative.example.test",
  "  IdentityFile .ssh/keys/2",
  "Host multi",
  "  HostName multi.example.test",
  "  IdentityFile ~/.ssh/keys/absent",
  "  IdentityFile ~/.ssh/keys/3",
  "Host encrypted",
  "  HostName encrypted.example.test",
  "  IdentityFile %d/.ssh/keys/enc",
  "Host public",
  "  HostName public.example.test",
  "  IdentityFile ~/.ssh/keys/public",
  "Host password-only",
  "  HostName password.example.test"
].join("\n");

test("OpenSSH scan classifies IdentityFile keys, including extensionless and relative paths", async (t) => {
  const { home, ssh } = await makeHome(CONFIG, {
    "1": PLAIN_KEY,
    "2": PLAIN_KEY,
    "3": PLAIN_KEY,
    enc: ENCRYPTED_KEY,
    public: PUBLIC_KEY
  });
  t.after(() => rm(home, { recursive: true, force: true }));

  const entries = await scanOpenSshConfig({ home });
  const byName = new Map(entries.map((entry) => [entry.name, entry]));

  assert.equal(byName.get("plain").keyStatus, "ready", "an extensionless key file classifies as usable");
  assert.equal(byName.get("plain").keyPath, join(ssh, "keys", "1"), "~ expands to the home directory");
  assert.equal(byName.get("plain").authKind, "key");

  assert.equal(byName.get("relative").keyStatus, "ready", "a relative IdentityFile resolves against home");
  assert.equal(byName.get("relative").keyPath, join(ssh, "keys", "2"));

  assert.equal(byName.get("multi").keyStatus, "ready", "a later IdentityFile is used when the first one is missing");
  assert.equal(byName.get("multi").keyPath, join(ssh, "keys", "3"));

  assert.equal(byName.get("encrypted").keyStatus, "passphrase", "an encrypted key is still importable, but flagged");
  assert.equal(byName.get("encrypted").keyPath, join(ssh, "keys", "enc"), "%d expands to the home directory");

  assert.equal(byName.get("public").keyStatus, "invalid", "a public key is never stored as a private key");
  assert.equal(byName.get("password-only").keyStatus, null);
  assert.equal(byName.get("password-only").authKind, "password");

  assert.equal(inspectPrivateKeyText(PLAIN_KEY), "ready");
  assert.equal(inspectPrivateKeyText(ENCRYPTED_KEY), "passphrase");
  assert.equal(inspectPrivateKeyText(PUBLIC_KEY), "invalid");
  assert.equal(inspectPrivateKeyText(PLAIN_KEY.replace("-----END OPENSSH PRIVATE KEY-----", "-----END RSA PRIVATE KEY-----")), "invalid");
});

function makeService() {
  const profiles = new Map();
  const store = new Map();
  // Inherit the real prototype so profileSave (called by openSshImport) can
  // resolve profilePublic and the rest of the save path.
  const service = Object.assign(Object.create(HarborService.prototype), {
    profiles,
    store,
    requireProfileTable: () => ({
      get: (id) => profiles.get(id),
      put: (id, record) => { profiles.set(id, record); },
      delete: (id) => { profiles.delete(id); },
      entries: () => [...profiles.entries()]
    }),
    requireGroupTable: () => ({ get: () => undefined }),
    connections: new Map(),
    ctx: {
      credentials: {
        describe: async (ref) => ({ configured: store.has(refKey(ref)) }),
        resolve: async (ref) => store.has(refKey(ref)) ? { value: store.get(refKey(ref)) } : undefined,
        set: async (ref, value) => { store.set(refKey(ref), value); return { ok: true }; },
        unset: async (ref) => { store.delete(refKey(ref)); return { ok: true }; }
      }
    }
  });
  return service;
}

test("OpenSSH import stores each IdentityFile key automatically", async (t) => {
  const { home } = await makeHome(CONFIG, {
    "1": PLAIN_KEY,
    "2": PLAIN_KEY,
    "3": PLAIN_KEY,
    enc: ENCRYPTED_KEY,
    public: PUBLIC_KEY
  });
  const envKey = process.platform === "win32" ? "USERPROFILE" : "HOME";
  const previous = process.env[envKey];
  process.env[envKey] = home;
  t.after(async () => {
    if (previous === undefined) delete process.env[envKey];
    else process.env[envKey] = previous;
    await rm(home, { recursive: true, force: true });
  });

  const service = makeService();
  const call = async (input) => openSshImportResultSchema.parse(
    await HarborService.prototype.openSshImport.call(service, openSshImportRequestSchema.parse(input))
  );

  const { value: { preview } } = await call({});
  const byName = new Map(preview.entries.map((entry) => [entry.name, entry]));
  assert.equal(byName.get("plain").keyStatus, "ready");
  assert.equal(byName.get("encrypted").keyStatus, "passphrase");
  assert.equal(byName.get("public").keyStatus, "invalid");
  const wire = JSON.stringify(preview);
  assert.equal(wire.includes("PRIVATE KEY"), false, "the preview never carries key material");
  assert.equal(wire.includes("Proc-Type"), false, "the preview never carries key material");

  const names = preview.entries.map((entry) => entry.name);
  const imported = (await call({ selection: { fingerprint: preview.fingerprint, groupId: null, names } })).value.imported;
  assert.equal(imported.created, names.length);
  assert.equal(imported.keysImported, 4, "plain + relative + multi + encrypted keys were stored");
  assert.deepEqual(imported.passphraseRequired, ["encrypted"], "only the encrypted key needs a passphrase");
  assert.deepEqual(imported.details, []);

  const byProfileName = new Map([...service.profiles.entries()].map(([id, record]) => [record.name, { id, record }]));
  const keyFor = (name) => service.store.get(refKey(credentialRef(profileCredentialRefs(byProfileName.get(name).id).privateKey)));
  for (const name of ["plain", "relative", "multi"]) {
    assert.equal(keyFor(name), PLAIN_KEY, name + " carries its key into the credential store");
  }
  assert.equal(keyFor("encrypted"), ENCRYPTED_KEY);
  assert.equal(keyFor("public"), undefined, "an invalid key file is not stored");
  assert.equal(keyFor("password-only"), undefined);
  assert.equal(byProfileName.get("plain").record.authKind, "key");

  // Changing a key file after preview means the import would no longer match
  // what the operator saw: refuse and ask for a fresh preview.
  await rm(join(home, ".ssh", "keys", "1"));
  const stale = await call({ selection: { fingerprint: preview.fingerprint, groupId: null, names: ["plain"] } });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, "ssh-config-changed");
});

test("an unavailable credential service leaves the profile but reports the key", async (t) => {
  const { home } = await makeHome(
    ["Host one", "  HostName one.example.test", "  IdentityFile ~/.ssh/keys/1"].join("\n"),
    { "1": PLAIN_KEY }
  );
  const envKey = process.platform === "win32" ? "USERPROFILE" : "HOME";
  const previous = process.env[envKey];
  process.env[envKey] = home;
  t.after(async () => {
    if (previous === undefined) delete process.env[envKey];
    else process.env[envKey] = previous;
    await rm(home, { recursive: true, force: true });
  });

  const service = makeService();
  // Profiling the saved record only needs describe(); the missing set() is what
  // this case exercises.
  service.ctx = { credentials: { describe: async () => ({ configured: false }) } };
  const call = async (input) => openSshImportResultSchema.parse(
    await HarborService.prototype.openSshImport.call(service, openSshImportRequestSchema.parse(input))
  );
  const { value: { preview } } = await call({});
  const imported = (await call({ selection: { fingerprint: preview.fingerprint, groupId: null, names: ["one"] } })).value.imported;
  assert.equal(imported.created, 1, "a key storage failure never removes the saved server");
  assert.equal(imported.keysImported, 0);
  assert.equal(imported.details[0].reason, "key");
});

test("key file pickers do not filter by extension", async () => {
  // The ResourceEditor and SharedCredentialEditor moved out of HarborResources,
  // so assert over every component in the feature directory (fixed sorted
  // order) instead of one file.
  const resourcesDir = new URL("../src/client/features/resources/", import.meta.url);
  const resources = (await Promise.all(
    (await readdir(resourcesDir))
      .filter((name) => name.endsWith(".jsx"))
      .sort()
      .map((name) => readFile(new URL(name, resourcesDir), "utf8"))
  )).join("\n");
  const files = [
    ["../src/client/features/resources/*.jsx", resources],
    ["../src/client/features/connect/connect-dialog.jsx", await readFile(new URL("../src/client/features/connect/connect-dialog.jsx", import.meta.url), "utf8")]
  ];
  for (const [file, source] of files) {
    assert.match(source, /type="file"/, file + " still offers a file picker");
    assert.doesNotMatch(
      source,
      /accept="[^"]*(?:\.pem|\.key|\.ed25519|\.rsa)/,
      file + " must not hide extensionless key files behind an accept filter"
    );
  }
});
