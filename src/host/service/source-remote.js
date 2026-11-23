/**
 * Source-mode Remote markers for endpoints added after a live plugin update.
 *
 * DSH registers this package's generated Typert manifest through
 * @deepseek-ai/dsh-typert-loader, which imports `./typert` once per process and
 * caches the manifest by package name. When DSH's HMR reloads the host half of
 * a plugin after an update, the service class is replaced but the cached
 * manifest is not: every endpoint that existed before keeps working from the
 * stale manifest, while a newly added method is unknown to the Gateway and the
 * browser's POST /api/harbor/<method> answers HTTP 404.
 *
 * The Gateway also has a documented source-mode fallback: a public instance
 * method marked by the Typert `Remote` decorator is claimed and dispatched even
 * without a strict descriptor. Decorators normally run through the class
 * transpiler, so this helper applies the same public decorator to an already
 * built prototype. A fresh boot still uses the generated strict manifest; the
 * marker is only the safety net that keeps a newly added method reachable
 * across a live reload.
 *
 * Mark only endpoints that are new relative to the oldest manifest a process
 * may have cached. A method whose strict definition was withdrawn is
 * deliberately not eligible for source fallback in DSH.
 */
import { Remote } from "@deepseek-ai/dsh-typert-protocol";

/**
 * Attach the Typert Remote marker to one prototype method.
 * @param {object} prototype - class prototype owning (or inheriting) the method.
 * @param {string} method - public instance method name.
 * @returns {boolean} whether the marker was attached.
 */
export function markSourceRemote(prototype, method) {
  if (prototype === null || typeof prototype !== "object") return false;
  const implementation = prototype[method];
  if (typeof implementation !== "function") return false;
  try {
    const initializers = [];
    Remote(implementation, {
      kind: "method",
      name: method,
      static: false,
      private: false,
      addInitializer(initializer) {
        initializers.push(initializer);
      }
    });
    // The decorator initializer runs with `this` bound to a live instance and
    // marks Object.getPrototypeOf(this). A throwaway instance applies the same
    // operation at module load, before any real service exists.
    const probe = Object.create(prototype);
    for (const initializer of initializers) initializer.call(probe);
    return true;
  } catch {
    // A protocol build that rejects this shape still works on a fresh boot;
    // only the live-reload compatibility net is unavailable.
    return false;
  }
}
