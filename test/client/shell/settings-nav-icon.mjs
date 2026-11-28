/**
 * The settings-section icon is an optional host capability.
 *
 * The registration must wait for the slot (`slots.inject`) instead of assuming
 * it exists at bundle evaluation time, must survive a host that has no such
 * slot, and must not leave anything behind on teardown. A host without the slot
 * degrades to "section without a glyph" — never to a DOM-injected icon that
 * copies the host's markup.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerSettingsNavIcon } from "../../../src/client/shell/settings-nav-icon.js";

function host({ failInject = false, failRegister = false } = {}) {
  let callback;
  let release;
  let descriptor;
  let component;
  let active = false;
  return {
    slots: {
      inject(name, fn) {
        assert.equal(name, "settings.section.icon");
        if (failInject) throw new Error("unsupported");
        callback = fn;
        return () => { release?.(); release = undefined; };
      },
      register(options, view) {
        if (failRegister) throw new Error("unavailable");
        descriptor = options;
        component = view;
        active = true;
        return () => { active = false; };
      }
    },
    appear() { release = callback(); },
    disappear() { release?.(); release = undefined; },
    get active() { return active; },
    get descriptor() { return descriptor; },
    get component() { return component; }
  };
}

test("the icon appears when the slot arrives and disappears with it", () => {
  const owner = host();
  const icon = () => null;
  const dispose = registerSettingsNavIcon({ slots: owner.slots, component: icon });

  assert.equal(owner.active, false, "nothing is registered before the host provides the slot");
  owner.appear();
  assert.deepEqual(owner.descriptor, { name: "settings.section.icon", id: "harbor-resources" });
  assert.equal(owner.component, icon);
  assert.equal(owner.active, true);

  owner.disappear();
  assert.equal(owner.active, false, "a vanished slot takes the icon with it");

  owner.appear();
  assert.equal(owner.active, true, "a returning slot re-registers");
  dispose();
  assert.equal(owner.active, false, "teardown unregisters");
});

test("a host without the slot degrades quietly", () => {
  const owner = host({ failInject: true });
  const errors = [];
  const dispose = registerSettingsNavIcon({ slots: owner.slots, component: () => null, onError: (error) => errors.push(error.message) });
  assert.deepEqual(errors, ["unsupported"], "the failure is reported once, to the caller's logger");
  assert.equal(typeof dispose, "function");
  dispose();
});

test("a registration failure is reported and leaves no dangling state", () => {
  const owner = host({ failRegister: true });
  const errors = [];
  const dispose = registerSettingsNavIcon({ slots: owner.slots, component: () => null, onError: (error) => errors.push(error.message) });
  owner.appear();
  assert.deepEqual(errors, ["unavailable"]);
  assert.equal(owner.active, false);
  dispose();
  assert.equal(owner.active, false);
});
