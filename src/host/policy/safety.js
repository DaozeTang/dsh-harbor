/**
 * Host-enforced SSH command policy.
 *
 * DSH owns normal approval/access-mode handling. The plugin therefore only
 * stops a conversational agent from issuing explicitly destructive commands;
 * routine SSL, package, service, and configuration operations stay available.
 * A user who deliberately types a high-risk command into the right-side SSH
 * terminal is not intercepted by this agent-command guard.
 */
// The gate is split into categories (keys + labels), canonical spelling,
// rules (patterns + settings normalization) and the decision itself. This
// module keeps the original import path and named exports for every caller.

export {
  ALL_CATEGORY_KEYS,
  CATEGORY_DELETE_FILES,
  CATEGORY_LABELS,
  CATEGORY_UNRESOLVED_PROGRAM,
} from "./categories.js";
export { canonicalCommandText } from "./canonical.js";
export {
  EXEC_POLICY_MODES,
  normalizeAllowList,
  normalizeExactRules,
  normalizePolicy,
} from "./rules.js";
export { assessShellCommand } from "./decision.js";

/**
 * Kept as a re-export so host call sites do not care where the helper lives;
 * the browser needs the same rule without the policy engine behind it.
 */
export { shellQuote } from "../../shared/shell-quote.js";
