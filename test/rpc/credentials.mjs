// Credential chain: profileSave → credentialRefs → resolve/unset via the host
// credentials service (the "save and connect" path), with the credentials
// provider mocked out. No ssh2 transport, no real credential store.
import assert from "node:assert/strict";
import HarborService from "../../src/index.js";
import { profileSaveRequestSchema } from "../../src/rpc/schemas.js";
import { fakeTable } from "../support/fake-table.mjs";

function makeService() {
  const service = Object.create(HarborService.prototype);
  service.config = { maxBufferBytes: 65536 };
  service.connections = new Map();
  /** credential store keyed by the (branded) credential ref value */
  const store = new Map();
  const key = (ref) => (typeof ref === "string" ? ref : JSON.stringify(ref));
  service.ctx = {
    credentials: {
      async describe(ref) { return { configured: store.has(key(ref)) }; },
      async resolve(ref) { return store.has(key(ref)) ? { value: store.get(key(ref)) } : undefined; },
      async set(ref, value) { store.set(key(ref), value); },
      async unset(ref) { store.delete(key(ref)); },
      unsetCalls: [] 
    }
  };
  // record unset calls for the delete assertions
  const rawUnset = service.ctx.credentials.unset;
  service.ctx.credentials.unset = async (ref) => { service.ctx.credentials.unsetCalls.push(key(ref)); return rawUnset(ref); };
  service.unsetCalls = service.ctx.credentials.unsetCalls;
  service.store = store;
  service.storeKey = key;
  return service;
}

// ── profileSave: fresh save returns non-secret record + derived refs ──
{
  const service = makeService();
  const table = fakeTable();
  service.requireProfileTable = () => table;

  const saved = await service.profileSave({
    name: "  web-1  ", host: " 10.0.0.5 ", username: "root", authKind: "password", defaultProjectPath: "/srv/apps/web-1"
  });
  assert.equal(saved.ok, true);
  const { profile, credentialRefs } = saved.value;
  assert.equal(profile.name, "web-1", "name is trimmed");
  assert.equal(profile.host, "10.0.0.5");
  assert.equal(profile.port, 22, "port defaults to 22");
  assert.equal(profile.defaultProjectPath, "/srv/apps/web-1", "project entry is returned without touching credentials");
  assert.equal(table.entries()[0][1].defaultProjectPath, "/srv/apps/web-1", "project entry persists as ordinary profile metadata");
  assert.equal(table.entries()[0][1].agentForward, false, "agent forwarding defaults to off for records saved without the field");
  // The saved record itself must never carry secret material.
  assert.deepEqual(
    Object.keys(table.entries()[0][1]).sort(),
    ["agentForward", "authKind", "createdAt", "credentialId", "defaultProjectPath", "execPolicy", "groupId", "host", "hostKeyMode", "loginCommand", "name", "port", "proxyJump", "updatedAt", "username"].sort(),
    "stored record holds config only, no password/privateKey field"
 );
  const stem = profile.profileId.replaceAll("-", "").toUpperCase();
  assert.deepEqual(credentialRefs, {
    password: `DSH_HARBOR_${stem}_PASSWORD`,
    privateKey: `DSH_HARBOR_${stem}_PRIVATE_KEY`,
    passphrase: `DSH_HARBOR_${stem}_PASSPHRASE`,
    proxyJumpPasswords: [],
    proxyJumpPrivateKeys: [],
    proxyJumpPassphrases: []
  });
  assert.equal(profile.credentialConfigured, false, "nothing configured yet");

  // Saving over a non-existent profileId is rejected.
  const stale = await service.profileSave({ profileId: "ghost", name: "x", host: "h", username: "u", authKind: "password" });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, "no-profile");
}

// ── save and connect: password profile resolves the saved secret ──
{
  const service = makeService();
  const table = fakeTable();
  service.requireProfileTable = () => table;
  const saved = await service.profileSave({ name: "web-1", host: "10.0.0.5", username: "root", authKind: "password" });
  const profileId = saved.value.profile.profileId;

  await service.ctx.credentials.set(service.storeKey(saved.value.credentialRefs.password), "s3cret");

  let captured = null;
  service.connectInternal = async (request, refProfileId) => {
    captured = { request, refProfileId };
    return { ok: true, value: { connectionId: "new" } };
  };
  const connected = await service.profileConnect({ profileId });
  assert.equal(connected.ok, true);
  assert.equal(captured.refProfileId, profileId);
  assert.equal(captured.request.auth.kind, "password");
  assert.equal(captured.request.auth.password, "s3cret", "resolved secret flows into the connect request");
  assert.equal(captured.request.host, "10.0.0.5");
  assert.equal(captured.request.name, "web-1");
}

// ── save and connect: key profile resolves key + optional passphrase ──
{
  const service = makeService();
  const table = fakeTable();
  service.requireProfileTable = () => table;
  const saved = await service.profileSave({ name: "k8s", host: "10.0.0.9", username: "ops", authKind: "key" });
  const profileId = saved.value.profile.profileId;
  await service.ctx.credentials.set(service.storeKey(saved.value.credentialRefs.privateKey), "-----BEGIN");
  await service.ctx.credentials.set(service.storeKey(saved.value.credentialRefs.passphrase), "hunter2");

  let captured = null;
  service.connectInternal = async (request) => { captured = request; return { ok: true, value: {} }; };
  const connected = await service.profileConnect({ profileId });
  assert.equal(connected.ok, true);
  assert.deepEqual(captured.auth, { kind: "key", privateKey: "-----BEGIN", passphrase: "hunter2" });
}

// ── connect without a saved secret: explicit credential-missing, no connect ──
{
  const service = makeService();
  const table = fakeTable();
  service.requireProfileTable = () => table;
  const saved = await service.profileSave({ name: "empty", host: "h", username: "u", authKind: "password" });
  let called = false;
  service.connectInternal = async () => { called = true; return { ok: true, value: {} }; };
  const result = await service.profileConnect({ profileId: saved.value.profile.profileId });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "credential-missing");
  assert.equal(called, false, "a missing secret must never reach connectInternal");
}

// ── temporary connect: a shared credential is resolved in the service ─────
{
  const service = makeService();
  const credentials = fakeTable();
  service.requireCredentialTable = () => credentials;
  const saved = await service.credentialSave({ name: "shared-password", authKind: "password" });
  const credentialId = saved.value.credential.credentialId;
  await service.ctx.credentials.set(service.storeKey(saved.value.credentialRefs.password), "shared-secret");
  let captured = null;
  service.connectInternal = async (request) => { captured = request; return { ok: true, value: {} }; };
  const connected = await service.connect({ host: "10.0.0.8", username: "root", credentialId });
  assert.equal(connected.ok, true);
  assert.deepEqual(captured.auth, { kind: "password", password: "shared-secret" });
  assert.equal(captured.credentialId, credentialId, "only the credential id crosses the client RPC boundary");
}

// ── profileDelete: clears this profile's own and reserved jump-password refs ──
{
  const service = makeService();
  const table = fakeTable();
  service.requireProfileTable = () => table;
  const saved = await service.profileSave({ name: "gone", host: "h", username: "u", authKind: "key" });
  table.put(saved.value.profile.profileId, { authKind: "key" });
  await service.ctx.credentials.set(service.storeKey(saved.value.credentialRefs.password), "a");
  await service.ctx.credentials.set(service.storeKey(saved.value.credentialRefs.privateKey), "b");
  await service.ctx.credentials.set(service.storeKey(saved.value.credentialRefs.passphrase), "c");

  const deleted = await service.profileDelete({ profileId: saved.value.profile.profileId });
  assert.equal(deleted.ok, true);
  assert.equal(deleted.value.deleted, true);
  assert.equal(table.size(), 0);
  assert.equal(service.unsetCalls.length, 27, "three primary plus eight bounded password/key/passphrase jump refs are unset");
  assert.equal(service.store.size, 0);
  // Other profiles' refs are untouched by construction (names derive from id).
  assert.ok(service.unsetCalls.every((ref) => ref.includes(saved.value.profile.profileId.replaceAll("-", "").toUpperCase())));

  // Deleting a missing profile is a clean no-op.
  const again = await service.profileDelete({ profileId: "nope" });
  assert.equal(again.ok, true);
  assert.equal(again.value.deleted, false);
}

// ── profilePublic: configured flags reflect the store, not the panel ──
{
  const service = makeService();
  const table = fakeTable();
  service.requireProfileTable = () => table;
  const saved = await service.profileSave({ name: "p", host: "h", username: "u", authKind: "password" });
  assert.equal(saved.value.profile.credentialConfigured, false);
  await service.ctx.credentials.set(service.storeKey(saved.value.credentialRefs.password), "pw");
  const listed = await service.profileList();
  assert.equal(listed.ok, true);
  assert.equal(listed.value.profiles[0].credentialConfigured, true);
  assert.equal(listed.value.profiles[0].passphraseConfigured, false);
}

// ── a partial save keeps the stored host-key policy ───────────────────────
// The request schema used to default hostKeyMode to "accept-new", so any caller
// that saved a profile without repeating the field silently downgraded a
// resource pinned to `verify` back to trust-on-first-use.
{
  const parsed = profileSaveRequestSchema.parse({ name: "n", host: "h", username: "u", authKind: "password" });
  assert.equal("hostKeyMode" in parsed, false, "the request schema does not invent a host-key policy");
  assert.equal("agentForward" in parsed, false, "nor an agent-forwarding choice");

  const service = makeService();
  const table = fakeTable();
  service.requireProfileTable = () => table;
  const created = await service.profileSave({ name: "strict", host: "10.0.0.9", username: "root", authKind: "password", hostKeyMode: "verify", agentForward: true });
  assert.equal(created.ok, true);
  const profileId = created.value.profile.profileId;

  const partial = await service.profileSave({ profileId, name: "strict", host: "10.0.0.9", username: "root", authKind: "password" });
  assert.equal(partial.ok, true);
  assert.equal(table.get(profileId).hostKeyMode, "verify", "an omitted hostKeyMode keeps the pinned policy");
  assert.equal(table.get(profileId).agentForward, true, "an omitted agentForward keeps the stored choice");

  const explicit = await service.profileSave({ profileId, name: "strict", host: "10.0.0.9", username: "root", authKind: "password", hostKeyMode: "accept-new", agentForward: false });
  assert.equal(explicit.ok, true);
  assert.equal(table.get(profileId).hostKeyMode, "accept-new", "an explicit value still changes it");
  assert.equal(table.get(profileId).agentForward, false);

  // groupId follows the same "omitted keeps, null clears" rule as the other
  // optional fields; a partial save used to ungroup the server.
  const groupId = "11111111-1111-4111-8111-111111111111";
  const groups = fakeTable();
  groups.put(groupId, { name: "ops" });
  service.requireGroupTable = () => groups;
  const grouped = await service.profileSave({ name: "grouped", host: "10.0.0.10", username: "root", authKind: "password", groupId });
  assert.equal(grouped.ok, true);
  const groupedId = grouped.value.profile.profileId;
  assert.equal(table.get(groupedId).groupId, groupId);
  const partialGroup = await service.profileSave({ profileId: groupedId, name: "grouped", host: "10.0.0.10", username: "root", authKind: "password" });
  assert.equal(partialGroup.ok, true);
  assert.equal(table.get(groupedId).groupId, groupId, "an omitted groupId keeps the group");
  const clearedGroup = await service.profileSave({ profileId: groupedId, name: "grouped", host: "10.0.0.10", username: "root", authKind: "password", groupId: null });
  assert.equal(clearedGroup.ok, true);
  assert.equal(table.get(groupedId).groupId, null, "an explicit null still ungroups");
}

console.log("credentials: save→refs→resolve→unset chain: all cases passed");
