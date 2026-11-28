/**
 * Shared execution-policy presentation. Both operator surfaces — the terminal
 * panel's tier pill and the settings page's segment control — must agree on
 * which switches count as loosening, what each tier is called, and what a
 * loosening actually releases: an operator asked a different question in each
 * place cannot tell what they are approving.
 */
import { t } from "../../../i18n/core.js";

/** Loosening is "a larger number"; every tier switch compares against this. */
export const TIER_ORDER = { standard: 0, custom: 1, allowAll: 2 };

// Tier names are shared with the host's approval copy (src/shared); this module
// re-exports them so the panel keeps importing one presentation entry point.
export { execPolicyLabel } from "../../../shared/exec-policy-label.js";

/** What switching to `tier` releases, in the operator's words. */
export function execPolicyLooseningDetail(tier, allowCount) {
  if (tier === "allowAll") {
    return t("将允许 AI 直接执行任何命令——包括不可逆删除、格式化磁盘、重启关机；删除不再进回收站。仅建议用于测试或可丢弃的环境。");
  }
  return t(`将允许 AI 直接执行自定义放行清单中的 ${allowCount} 类命令，以及设置中精确匹配的命令。`);
}
