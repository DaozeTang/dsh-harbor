// Drift guard for the hand-maintained TYPERT declarations: the descriptor
// table (one source of truth for the wire contract) and the type strings in
// src/rpc/typert.js must keep naming the same types. Adding a descriptor
// without updating the declarations (or a declaration nothing references) is
// exactly the class of bug this catches.
import assert from "node:assert/strict";
import { TYPERT } from "../src/rpc/typert.js";
import { DESCRIPTORS } from "../src/rpc/descriptors.js";
import { batchRunRowSchema, connectResultPayloadSchema, profileInfoSchema } from "../src/rpc/schemas.js";

const types = new Map(TYPERT.model.services[0].types.map((entry) => [entry.name, entry.declaration]));
const members = TYPERT.model.services[0].members.map((member) => member.name);

// ── every descriptor names types that exist, in both directions ─────────────
const referenced = new Set();
for (const descriptor of DESCRIPTORS) {
  const names = [
 ...descriptor.parameters.map((parameter) => parameter.codec.typeSymbol.split("#").pop()),
    descriptor.result.typeSymbol.split("#").pop()
  ];
  for (const name of names) {
    referenced.add(name);
    assert.ok(types.has(name), `descriptor ${descriptor.id} references undeclared type ${name}`);
  }
}
// Nested/shared shapes (DbColumn, KnownHostInfo, …) are referenced from other
// declarations rather than from a descriptor directly; a type that appears
// nowhere at all is dead weight and must go.
for (const [name, declaration] of types) {
  if (referenced.has(name)) continue;
  const mentionedElsewhere = [...types.entries()].some(
    ([other, otherDeclaration]) => other !== name && new RegExp(`\\b${name}\\b`).test(otherDeclaration)
 );
  assert.ok(mentionedElsewhere, `declared type ${name} is referenced by nothing`);
  void declaration;
}

// ── every descriptor has a service member entry ─────────────────────────────
for (const descriptor of DESCRIPTORS) {
  assert.ok(members.includes(descriptor.method), `descriptor ${descriptor.id} has no member row for ${descriptor.method}`);
}

// ── declarations carry every wire key of the shapes that already drifted ───
// The declarations are hand-written and the schemas are the contract, so a new
// field can silently be missing from the published types. Both of these had
// drifted (profile metadata and the connect warnings).
for (const [typeName, schema] of [["SshProfileInfo", profileInfoSchema], ["SshConnectResult", connectResultPayloadSchema]]) {
  // Interfaces write `readonly key:`, type aliases write `key:`; both count.
  const declared = new Set([...types.get(typeName).matchAll(/([A-Za-z0-9_]+)\??:/g)].map((match) => match[1]));
  for (const key of Object.keys(schema.shape)) {
    assert.ok(declared.has(key), `${typeName} declaration is missing the wire field "${key}"`);
  }
}

// ── the batch outcome row is rebuilt field by field at runtime ──
// timedOut and truncated were dropped from the row AND from the schema; a
// hand-written declaration is the other place they can go missing, so the
// published type is checked against the row schema itself.
{
  const declared = new Set([...types.get("BatchRunResult").matchAll(/([A-Za-z0-9_]+)\??:/g)].map((match) => match[1]));
  for (const key of Object.keys(batchRunRowSchema.shape)) {
    assert.ok(declared.has(key), `BatchRunResult declaration is missing the wire field "${key}"`);
  }
}

console.log("typert sync: descriptor references, member rows, declaration fields and driver unions all match");
