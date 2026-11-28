/**
 * One process-wide hand-off between the two host entry points of Harbor.
 *
 * The bundle mounts `dsh-harbor` at the profile root and mounts
 * `dsh-harbor/terminal-backend` inside the official Persistent terminals
 * group (the group isolates its own `terminals` registry, so a sibling row
 * can never see it). The terminal backend entry therefore cannot receive the
 * service by constructor; both entries import this module, and the root
 * service registers itself here while it is loaded.
 *
 * A Symbol.for registry on globalThis rather than a module-level `let` keeps
 * the hand-off intact even if the two entries are bundled into separate
 * chunks by a future build change.
 */
const HUB_KEY = Symbol.for("dsh-harbor.service-hub");

/** Shared mutable hand-off state for this process. */
export function harborHub() {
  let hub = globalThis[HUB_KEY];
  if (hub === undefined) {
    hub = { service: null, backend: null };
    globalThis[HUB_KEY] = hub;
  }
  return hub;
}

/** Publish the root service for the terminal-backend entry. */
export function publishHarborService(service) {
  harborHub().service = service;
}

/** Withdraw a service only if it is still the published one. */
export function retractHarborService(service) {
  const hub = harborHub();
  if (hub.service === service) hub.service = null;
}

/** The live root service, or null before it loads / after it unloads. */
export function currentHarborService() {
  return harborHub().service;
}

/** Publish the registered SSH terminal backend (null when unmounted). */
export function publishHarborTerminalBackend(backend) {
  harborHub().backend = backend;
}
