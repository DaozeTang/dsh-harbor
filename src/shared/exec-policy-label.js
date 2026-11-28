/**
 * The one name for an execution-policy tier.
 *
 * Both halves print it: the host in approval and refusal copy, the panel in
 * buttons, menus and confirmation titles. An operator who approves
 * "自定义放行" must see the same words in the settings page, so the three
 * strings live here instead of in one copy per half.
 */
import { t } from "../i18n/core.js";

/** Human name for a tier. */
export function execPolicyLabel(mode) {
  if (mode === "custom") return t("自定义放行");
  if (mode === "allowAll") return t("全部放行");
  return t("标准");
}