/**
 * The offline preview is a design-review artifact, not a second UI: it mounts
 * the shipping components against `preview/mock-api.js`. Nothing else checks
 * that mock, so a method it stubs can drift away from the real client API and
 * the preview keeps rendering — silently serving the Proxy's benign `{}` where
 * the screen expected data. That is what happened to two stubs before this
 * guard existed.
 *
 * One-directional on purpose: the mock implements the methods its screens need,
 * and the Proxy default exists for everything else, so listing every real
 * method as "must be stubbed" would fail for legitimate reasons. What must
 * never happen is a stub that names a method `src/client/api.js` does not
 * serve.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HarborApi } from "../src/client/api.js";
import { createMockApi } from "../preview/mock-api.js";

test("every preview stub names a method the client API really serves", () => {
  const served = new Set(Object.getOwnPropertyNames(HarborApi.prototype));
  const stubs = Object.keys(createMockApi());
  assert.ok(stubs.length > 20, `expected the preview to stub real screens, saw ${stubs.length} stubs`);
  const unknown = stubs.filter((name) => !served.has(name));
  assert.deepEqual(unknown, [], `preview/mock-api.js stubs methods src/client/api.js does not serve: ${unknown.join(", ")}`);
});

test("an unstubbed method degrades to the benign default instead of throwing", async () => {
  const api = createMockApi();
  const profiles = await api.profileList();
  assert.ok(Array.isArray(profiles.profiles) && profiles.profiles.length > 0, "a stubbed method returns the screen data");
  assert.deepEqual(await api.notARealMethod(), {}, "an unknown method resolves to {} so a screen under construction still renders");
});
