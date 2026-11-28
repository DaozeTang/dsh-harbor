// Temporary remote paths are the names the server has to accept before any
// byte lands: an over-long component fails with ENAMETOOLONG and a retry fails
// the same way. The suffix is therefore short and the base name is shortened
// to fit, and a partial is recognised by SHAPE before it is ever unlinked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isOwnSiblingTemp, siblingTempPath } from "../../../src/host/files/sftp-write.js";

const bytes = (text) => Buffer.byteLength(text, "utf8");

test("a long base name still yields a valid sibling temporary", () => {
  const target = `/srv/${'a'.repeat(300)}.bin`;
  const temp = siblingTempPath(target, "up");
  assert.ok(temp.startsWith("/srv/"), "the temporary lives in the target's directory");
  const name = temp.slice(temp.lastIndexOf("/") + 1);
  assert.ok(bytes(name) <= 255, `basename is ${bytes(name)} bytes`);
  assert.ok(name.startsWith("a".repeat(100)), "the base name keeps the target's start");
  assert.match(name, /\.~up[0-9a-f]{10}\.tmp$/, "the suffix names the caller and is unique");
  assert.notEqual(siblingTempPath(target, "up"), temp, "each call gets its own token");
});

test("a multi-byte base name is truncated between characters", () => {
  const target = `/srv/${'测'.repeat(200)}.txt`;
  const temp = siblingTempPath(target, "dl");
  const name = temp.slice(temp.lastIndexOf("/") + 1);
  assert.ok(bytes(name) <= 255, `basename is ${bytes(name)} bytes`);
  assert.ok(!name.includes("\uFFFD"), "no replacement character: the cut is on a boundary");
  // Every character of the truncated part is still three bytes wide.
  const base = name.slice(0, name.indexOf(".~dl"));
  assert.equal(bytes(base), base.length * 3, "the base kept whole characters");
});

test("only a sibling temporary of this target is recognised", () => {
  const target = "/srv/report.csv";
  assert.equal(isOwnSiblingTemp(target, siblingTempPath(target, "up")), true);
  assert.equal(isOwnSiblingTemp(target, siblingTempPath(target, "dsh")), true);
  assert.equal(isOwnSiblingTemp(target, "/srv/report.csv"), false, "the target itself is not a temporary");
  assert.equal(isOwnSiblingTemp(target, "/elsewhere/report.csv.~upabcdef0123.tmp"), false, "another directory");
  assert.equal(isOwnSiblingTemp(target, "/srv/other.~upabcdef0123.tmp"), false, "an unrelated base name");
  assert.equal(isOwnSiblingTemp(target, "/srv/report.csv.keep"), false, "an unrelated sibling");
  assert.equal(isOwnSiblingTemp(target, "/srv/report.csv.~upZZZ.tmp"), false, "a token we never mint");
  // Journals written by an older version still carry the old shape.
  assert.equal(isOwnSiblingTemp(target, "/srv/report.csv.dsh-upload-123e4567-e89b-12d3-a456-426614174000.tmp"), true);
  assert.equal(isOwnSiblingTemp(target, "/srv/report.csv.dsh-upload-not-a-uuid.tmp"), false);
});
