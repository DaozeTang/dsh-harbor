// Drift guard for the wire contract.
//
// The published types, the zod schemas and the implementations are three
// hand-maintained descriptions of the same request and result, and each has
// drifted from the others in production:
//   * the host read a request field the schema stripped (openSession.forceNew),
//   * a result schema demanded a field the host never returned (sftpStat.name),
//   * a handler could be renamed while its descriptor stayed behind.
// Every direction is asserted here instead of being caught in review.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import HarborService from "../src/index.js";
import { DESCRIPTORS } from "../src/rpc/descriptors.js";
import { TYPERT } from "../src/rpc/typert.js";
import { MEMBERS } from "../src/rpc/typert.generated.js";
import { deriveMembers } from "../src/rpc/typert-members.js";
import { openSessionRequestSchema, sftpListResultSchema, sftpStatResultSchema } from "../src/rpc/schemas.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const proto = HarborService.prototype;
const types = new Map(TYPERT.model.services[0].types.map((entry) => [entry.name, entry.declaration]));
const descriptorByMethod = new Map(DESCRIPTORS.map((descriptor) => [descriptor.method, descriptor]));

/** Top-level wire keys of a request/result schema (zod v4 internals). */
function wireFields(schema) {
  if (!schema || typeof schema !== "object" || !schema._def) return null;
  const def = schema._def;
  switch (def.type) {
    case "object":
      return new Set(Object.keys(schema.shape));
    case "intersection": {
      const left = wireFields(def.left);
      const right = wireFields(def.right);
      return left || right ? new Set([...(left ?? []), ...(right ?? [])]) : null;
    }
    case "union": {
      const merged = new Set();
      let any = false;
      for (const option of def.options) {
        const fields = wireFields(option);
        if (fields) { any = true; for (const key of fields) merged.add(key); }
      }
      return any ? merged : null;
    }
    case "optional": case "nullable": case "default": case "readonly": case "pipe":
      return wireFields(typeof schema.unwrap === "function" ? schema.unwrap() : def.innerType);
    default:
      return null;
  }
}

/** The `value` payload of an { ok, value } | { ok, error } result union. */
function resultPayload(schema) {
  if (schema._def?.type !== "union") return null;
  const ok = schema._def.options.find((option) => option.shape?.ok !== undefined);
  return ok?.shape?.value ?? null;
}

/** Every published type reachable from one declaration, concatenated. */
function typeText(name, seen = new Set()) {
  if (name === undefined || seen.has(name)) return "";
  const declaration = types.get(name);
  if (declaration === undefined) return "";
  seen.add(name);
  let text = `${declaration}\n`;
  for (const reference of new Set([...declaration.matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/g)].map((match) => match[1]))) {
    text += typeText(reference, seen);
  }
  return text;
}

// ── every descriptor is implemented ────────────────────────────────────────
for (const descriptor of DESCRIPTORS) {
  assert.equal(typeof proto[descriptor.method], "function", `${descriptor.method}: descriptor has no implementation on the service`);
}

// ── the published types name every wire key, both directions ───────────────
for (const descriptor of DESCRIPTORS) {
  const requestType = descriptor.parameters[0].codec.typeSymbol.split("#").pop();
  const resultType = descriptor.result.typeSymbol.split("#").pop();
  const requestText = typeText(requestType);
  for (const key of wireFields(descriptor.parameters[0].codec.schema) ?? []) {
    assert.match(requestText, new RegExp(`\\b${key}\\b`), `${descriptor.method}: request type ${requestType} never mentions the wire field "${key}"`);
  }
  const payload = resultPayload(descriptor.result.schema);
  if (payload === null) continue;
  const resultText = typeText(resultType);
  for (const key of wireFields(payload) ?? []) {
    assert.match(resultText, new RegExp(`\\b${key}\\b`), `${descriptor.method}: result type ${resultType} never mentions the wire field "${key}"`);
  }
}

// ── the host only reads request fields the wire can carry ──────────────────
// Internal callers pass extra fields the RPC never receives; those are named
// here with the reason, so a genuine drift cannot hide behind the same list.
const INTERNAL_ONLY_REQUEST_FIELDS = new Map([
  ["activate", "batchRun connects a server without stealing the conversation's active target"],
  ["signal", "sftp_write passes the agent tool's AbortSignal; a unary RPC carries none"],
]);
const hostFiles = fs.readdirSync(path.join(ROOT, "src/host/service"))
  .filter((name) => name.endsWith(".js"))
  .map((name) => path.join(ROOT, "src/host/service", name));
hostFiles.push(path.join(ROOT, "src/index.js"));
for (const file of hostFiles) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const starts = [];
  for (const [index, line] of lines.entries()) {
    const match = line.match(/^ {2}(?:async |static )?([A-Za-z_$][\w$]*)\(/);
    if (match) starts.push({ name: match[1], line: index });
  }
  for (const [position, start] of starts.entries()) {
    const descriptor = descriptorByMethod.get(start.name);
    if (descriptor === undefined) continue;
    const end = starts[position + 1]?.line ?? lines.length;
    // Comments describe fields ("no signal crosses the wire") without reading
    // them; only executable text may count as a host read.
    const body = lines
      .slice(start.line, end)
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const fields = wireFields(descriptor.parameters[0].codec.schema);
    if (fields === null) continue;
    for (const match of body.matchAll(/request\.([A-Za-z0-9_]+)/g)) {
      const key = match[1];
      if (fields.has(key) || INTERNAL_ONLY_REQUEST_FIELDS.has(key)) continue;
      assert.fail(`${start.name}: handler reads request.${key}, but the wire schema drops it (${path.relative(ROOT, file)}:${start.line + 1})`);
    }
    // `const { a, b } = request` reads the same fields without the prefix.
    for (const match of body.matchAll(/const \{([^}]*)\} = request/g)) {
      for (const part of match[1].split(",")) {
        const key = part.trim().split(":").pop()?.trim().replace(/\.\.\./, "");
        if (!key || !/^[A-Za-z_$][\w$]*$/.test(key)) continue;
        if (fields.has(key) || INTERNAL_ONLY_REQUEST_FIELDS.has(key)) continue;
        assert.fail(`${start.name}: handler destructures request.${key}, but the wire schema drops it (${path.relative(ROOT, file)}:${start.line + 1})`);
      }
    }
  }
}

// ── the client facade never sends a key the schema strips ──────────────────
const facade = fs.readFileSync(path.join(ROOT, "src/client/core/api.js"), "utf8");
const facadeMethods = new Set();
for (const match of facade.matchAll(/this\.call\("([A-Za-z0-9_]+)"/g)) {
  facadeMethods.add(match[1]);
  assert.ok(descriptorByMethod.has(match[1]), `api.js calls "${match[1]}", which the descriptors do not declare`);
}
for (const match of facade.matchAll(/this\.call\("([A-Za-z0-9_]+)",\s*\{([^}]*)\}/g)) {
  const fields = wireFields(descriptorByMethod.get(match[1]).parameters[0].codec.schema);
  for (const key of new Set([...match[2].matchAll(/(?:^|[,\s])([A-Za-z_$][\w$]*)\s*[,:]/g)].map((entry) => entry[1]))) {
    assert.ok(fields?.has(key) ?? false, `api.js sends ${match[1]}.${key}, but the wire schema drops it`);
  }
}
for (const descriptor of DESCRIPTORS) {
  if (descriptor.method === "terminalStream") continue; // driven by the stream routes, not api.js
  assert.ok(facadeMethods.has(descriptor.method), `descriptor ${descriptor.method} has no client facade method`);
}

// ── the two fields that had drifted keep working end to end ────────────────
assert.equal(
  openSessionRequestSchema.parse({ connectionId: "c1", forceNew: true }).forceNew,
  true,
  "the wire must keep openSession.forceNew: the host honours it when a person took the shell over"
);
// The exact payload sftpStat returns today; the schema used to require `name`
// (an entry field) and every strict client decode of a real result failed.
const statValue = { path: "/etc/motd", isDirectory: false, size: 12, mtime: 1750000000000, mode: 0o100644 };
assert.equal(sftpStatResultSchema.safeParse({ ok: true, value: statValue }).success, true, "sftpStat result must validate the host payload");
assert.equal(sftpStatResultSchema.safeParse({ ok: true, value: { path: "/etc/motd" } }).success, false, "sftpStat must still require the attributes");
// The attributes moved into a shared shape, which must not have cost the
// listing its own `name` field.
const entry = { isDirectory: false, size: 4, mtime: 1750000000000, mode: 0o100644 };
assert.equal(sftpListResultSchema.safeParse({ ok: true, value: { path: "/data", entries: [{ name: "one.txt", ...entry }] } }).success, true, "a listing entry carries name + attributes");
assert.equal(sftpListResultSchema.safeParse({ ok: true, value: { path: "/data", entries: [entry] } }).success, false, "a listing entry still requires name");

// ── the published manifest is generated, never hand edited ─────────────────
// members: the 66 signatures used to be a second hand-maintained copy of the
// descriptors. They are now derived from them (scripts/gen-typert.mjs), so a
// hand edit to the generated file — or a method that changed between sync and
// async without regenerating — must fail here instead of shipping.
assert.deepEqual(
  MEMBERS,
  deriveMembers(DESCRIPTORS, proto),
  "src/rpc/typert.generated.js is stale: run node scripts/gen-typert.mjs"
);
assert.equal(MEMBERS.length, DESCRIPTORS.length, "every descriptor publishes exactly one member");
assert.equal(new Set(MEMBERS.map((member) => member.name)).size, MEMBERS.length, "member names are unique");
assert.equal(
  new Set(TYPERT.model.services[0].types.map((entry) => entry.name)).size,
  TYPERT.model.services[0].types.length,
  "published type names are unique"
);

console.log("rpc contract: handlers, wire keys, host reads, facade calls, generated members and the drifted fields all agree");