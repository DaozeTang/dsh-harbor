/**
 * DSH permission ceiling: the pure mapping plus the service composition.
 *
 * The point of this layer is that Harbor stops being a second, unaware gate:
 * auto review and full access stand its deny-list down, workspace-write keeps
 * a standard ceiling, read-only refuses instead of asking, and an explicit
 * Harbor session switch may only tighten. These assertions pin that contract.
 */
import assert from "node:assert/strict";
import HarborService from "../src/index.js";
import {
  composeExecPolicy,
  dshPolicyRefusal,
  normalizeDshPermission,
  readDshPermission
} from "../src/host/policy/dsh-permission.js";

// ── pure mapping ────────────────────────────────────────────────────────────
const auto = normalizeDshPermission({ preset: "auto", sandbox: "danger-full-access", approval: "ask" });
assert.equal(auto.ceiling, "auto");
assert.equal(auto.source, "dsh-auto");

const full = normalizeDshPermission({ preset: "danger-full-access", sandbox: "danger-full-access", approval: "never" });
assert.equal(full.ceiling, "allowAll");
assert.equal(full.source, "dsh-full-access");

const workspace = normalizeDshPermission({ preset: "workspace-write", sandbox: "workspace-write", approval: "ask" });
assert.equal(workspace.ceiling, "standard");
assert.equal(workspace.source, "dsh-workspace-write");

const readOnly = normalizeDshPermission({ preset: "read-only", sandbox: "read-only", approval: "ask" });
assert.equal(readOnly.ceiling, "readOnly");
assert.equal(readOnly.source, "dsh-read-only");

// Unknown facts must not widen or narrow the historical Harbor behavior.
assert.equal(normalizeDshPermission({ preset: "custom", sandbox: "nonsense", approval: "ask" }), null);
assert.equal(normalizeDshPermission({}), null);
assert.equal(normalizeDshPermission(null), null);

// The DSH identity wins even when the knob projection was unavailable.
assert.equal(normalizeDshPermission({ preset: "auto" }).ceiling, "auto");

// ── composition ─────────────────────────────────────────────────────────────
const globalStandard = { mode: "standard", source: "global", allow: [] };
const sessionStandard = { mode: "standard", source: "session", allow: [] };

const fullPolicy = composeExecPolicy(globalStandard, full);
assert.equal(fullPolicy.mode, "allowAll");
assert.equal(fullPolicy.approval, "never");
assert.equal(fullPolicy.dsh.ceiling, "allowAll");

const tightened = composeExecPolicy(sessionStandard, full);
assert.equal(tightened.mode, "standard", "a Harbor session switch can tighten full access");
assert.equal(tightened.approval, "never");

const workspacePolicy = composeExecPolicy({ mode: "allowAll", source: "global", allow: [] }, workspace);
assert.equal(workspacePolicy.mode, "standard", "workspace-write clamps a loose global tier");
assert.equal(workspacePolicy.approval, "ask");

const readOnlyPolicy = composeExecPolicy({ mode: "allowAll", source: "session", allow: [] }, readOnly);
assert.equal(readOnlyPolicy.mode, "standard");
assert.equal(readOnlyPolicy.approval, "never", "read-only refuses rather than asking");

const autoPolicy = composeExecPolicy(globalStandard, auto);
assert.equal(autoPolicy.mode, "allowAll");
assert.equal(autoPolicy.approval, "never");

assert.equal(composeExecPolicy(globalStandard, null), globalStandard, "no DSH info preserves the same policy object");

// ── tier refusal ────────────────────────────────────────────────────────────
assert.match(dshPolicyRefusal(auto, "standard"), /自动审查/);
assert.match(dshPolicyRefusal(readOnly, "standard"), /只读/);
assert.match(dshPolicyRefusal(workspace, "custom"), /仅工作区写/);
assert.equal(dshPolicyRefusal(workspace, "standard"), null);
assert.equal(dshPolicyRefusal(full, "allowAll"), null);
assert.equal(dshPolicyRefusal(null, "allowAll"), null);

// ── service reads ───────────────────────────────────────────────────────────
function fakeContext({ preset, sandbox, approval, sandboxThrows = false, approvalThrows = false }) {
  const session = { id: "s1" };
  return {
    session,
    get(name) {
      if (name === "sessions") return { get: (id) => id === "s1" ? session : undefined };
      if (name === "permissionPresets") {
        return {
          current: (value) => value?.id === "s1" ? preset : "custom",
          resolve: () => ({ sandbox, approval })
        };
      }
      if (name === "sandboxPolicy") {
        return {
          resolve: ({ session: value }) => {
            if (sandboxThrows) throw new Error("projection not ready");
            return { mode: value?.id === "s1" ? sandbox : "workspace-write" };
          }
        };
      }
      if (name === "approval") {
        if (approvalThrows) throw new Error("approval unavailable");
        return { overrideOf: (value) => value?.id === "s1" ? approval : null, config: { policy: "ask" } };
      }
      return undefined;
    }
  };
}

const readAuto = readDshPermission(fakeContext({ preset: "auto", sandbox: "danger-full-access", approval: "ask" }), { id: "s1" });
assert.equal(readAuto.ceiling, "auto");

const readFallback = readDshPermission(
  fakeContext({ preset: "workspace-write", sandbox: "workspace-write", approval: "ask", sandboxThrows: true, approvalThrows: true }),
  { id: "s1" }
);
assert.equal(readFallback.ceiling, "standard", "the preset bundle is the fallback when a projection fails");
assert.equal(readFallback.approval, "ask");

assert.equal(readDshPermission(undefined, { id: "s1" }), null);
assert.equal(readDshPermission(fakeContext({ preset: "auto", sandbox: "danger-full-access", approval: "ask" }), undefined), null);

// A prototype service with no context keeps the historical policy.
const bare = Object.create(HarborService.prototype);
bare.connections = new Map([["c1", { profileId: null, execPolicyOverrides: new Map() }]]);
bare.profileTable = null;
bare.execPolicy = "standard";
bare.execPolicyAllow = [];
bare.execPolicyExact = [];
assert.equal(bare.resolveExecPolicy("c1", "s1").mode, "standard");
assert.equal(bare.resolveExecPolicy("c1", "s1").dsh, undefined);

// ── service composition and the set guard ───────────────────────────────────
function serviceWith(ctx) {
  const service = Object.create(HarborService.prototype);
  service.ctx = ctx;
  service.connections = new Map([["c1", { profileId: null, execPolicyOverrides: new Map() }]]);
  service.profileTable = null;
  service.execPolicy = "standard";
  service.execPolicyAllow = [];
  service.execPolicyExact = [];
  return service;
}

{
  const service = serviceWith(fakeContext({ preset: "danger-full-access", sandbox: "danger-full-access", approval: "never" }));
  const resolved = service.resolveExecPolicy("c1", "s1");
  assert.equal(resolved.mode, "allowAll", "full access stands the global standard tier down");
  assert.equal(resolved.dsh.source, "dsh-full-access");

  const tightened = service.execPolicySet({ connectionId: "c1", policy: "standard", sessionId: "s1" });
  assert.equal(tightened.ok, true);
  assert.equal(tightened.value.effective, "standard");
  assert.equal(tightened.value.source, "session");
  assert.equal(tightened.value.dsh.ceiling, "allowAll");
  assert.equal(tightened.value.approval, "never");
}
{
  const service = serviceWith(fakeContext({ preset: "workspace-write", sandbox: "workspace-write", approval: "ask" }));
  service.execPolicy = "allowAll";
  const resolved = service.resolveExecPolicy("c1", "s1");
  assert.equal(resolved.mode, "standard", "workspace-write clamps a loose global tier");
  assert.equal(resolved.approval, "ask");

  const blocked = service.execPolicySet({ connectionId: "c1", policy: "allowAll", sessionId: "s1" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, "dsh-policy-locked");
  assert.match(blocked.error.message, /仅工作区写/);

  const tightened = service.execPolicySet({ connectionId: "c1", policy: "standard", sessionId: "s1" });
  assert.equal(tightened.ok, true);
  assert.equal(tightened.value.effective, "standard");
  assert.equal(tightened.value.dsh.ceiling, "standard");
}
{
  const service = serviceWith(fakeContext({ preset: "auto", sandbox: "danger-full-access", approval: "ask" }));
  const resolved = service.resolveExecPolicy("c1", "s1");
  assert.equal(resolved.mode, "allowAll");
  assert.equal(resolved.dsh.ceiling, "auto");

  const blocked = service.execPolicySet({ connectionId: "c1", policy: "standard", sessionId: "s1" });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error.message, /自动审查/);
}
{
  const service = serviceWith(fakeContext({ preset: "read-only", sandbox: "read-only", approval: "ask" }));
  const resolved = service.resolveExecPolicy("c1", "s1");
  assert.equal(resolved.mode, "standard");
  assert.equal(resolved.approval, "never", "read-only refuses instead of asking");

  const blocked = service.execPolicySet({ connectionId: "c1", policy: "standard", sessionId: "s1" });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error.message, /只读/);
}

console.log("dsh-permission: all assertions passed");
