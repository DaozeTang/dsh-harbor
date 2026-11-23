/**
 * ssh2 is CommonJS: Node's ESM interop binds `default` to the exports object
 * captured when the CJS file is first evaluated, and that is not a stable value
 * on a host that reloads plugins.
 *
 * DSH's HMR re-evaluates a plugin when its package is updated: it evicts the
 * plugin's cached modules, then imports the entry again. A dependency such as
 * ssh2 lives in `require.cache` across that swap, and a reload that runs while
 * the dependency is being re-evaluated can hand the plugin a partially
 * initialized exports object — one without `Client`. The captured binding then
 * stays broken for the life of the process, and every connection attempt dies
 * with a bare TypeError "Client is not a constructor" until DSH restarts.
 *
 * So the constructor is resolved through require() at the moment a connection
 * is built instead of once at module load: require() always observes the
 * finished `module.exports`, a partial capture therefore heals by itself on the
 * next attempt, and a genuinely broken install fails with a message that names
 * ssh2 instead of V8's generic TypeError.
 */
import { createRequire } from "node:module";

/** Anchored at this module so ssh2 resolves from the plugin's own install. */
const requireFromHarbor = createRequire(import.meta.url);

/**
 * The Client constructor carried by one ssh2 export object.
 *
 * Both shapes are accepted because either can arrive here: the CommonJS
 * `module.exports` require() returns, and an ESM interop namespace whose only
 * meaningful member is `default`.
 * @param ssh2 Value returned by loading the ssh2 package.
 * @returns The constructor, or undefined when the value carries none.
 */
function clientOf(ssh2) {
  if (typeof ssh2?.Client === "function") return ssh2.Client;
  if (typeof ssh2?.default?.Client === "function") return ssh2.default.Client;
  return undefined;
}

/**
 * Resolve ssh2's Client constructor at call time.
 * @param load Loader used to read the ssh2 package; overridable for tests.
 * @returns The ssh2 Client class.
 * @throws TypeError naming the real problem when ssh2 (or its Client) is missing.
 */
export function resolveSsh2Client(load = requireFromHarbor) {
  let ssh2;
  try {
    ssh2 = load("ssh2");
  } catch (error) {
    const detail = error?.message === void 0 ? String(error) : error.message;
    throw new TypeError(`harbor: ssh2 could not be loaded from this installation (${detail})`);
  }
  const Client = clientOf(ssh2);
  if (Client === undefined) {
    throw new TypeError("harbor: the installed ssh2 package carries no Client constructor; reinstall dsh-harbor so its ssh2 dependency is complete");
  }
  return Client;
}

/**
 * Build one ssh2 client for a connection attempt.
 * @param load Loader used to read the ssh2 package; overridable for tests.
 * @returns A fresh ssh2 Client instance.
 */
export function createSsh2Client(load = requireFromHarbor) {
  const Client = resolveSsh2Client(load);
  return new Client();
}
