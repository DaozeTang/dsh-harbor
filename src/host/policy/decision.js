// The deny-list itself and the allow/deny decision.
//
// Split out of safety.js: this is the only module that knows about policy
// messages and i18n, so the rule engine stays testable without a dictionary.

import { policyBlockedReason } from "./messages.js";
import { t } from "../../i18n/core.js";
import { CATEGORY_DELETE_FILES, CATEGORY_UNRESOLVED_PROGRAM } from "./categories.js";
import { canonicalCommandText } from "./canonical.js";
import {
  DELETE_PROGRAM_PATTERN,
  normalizeExactRules,
  normalizePolicy,
  unresolvedExpansion,
} from "./rules.js";

// The deny-list: pattern, machine-readable key and display string in one
// place, so the custom tier's release set and the i18n surface can never
// drift apart. Order matters only for the reason shown; the custom tier scans
// past released patterns either way.
// i18n-identifier-start (display strings here are i18n keys, passed through t() at the call site)
const IRREVERSIBLE_BLOCK_LIST = [
  [DELETE_PROGRAM_PATTERN, "delete-files", CATEGORY_DELETE_FILES],
  // Deny-list evasion is a real, observed failure mode: an agent whose `rm`
  // was blocked once re-issued the deletion through an equivalent form. These
  // entries cover the high-frequency vectors — batch deletion disguised as
  // find/xargs, and interpreter one-liners that call unlink/rmtree from
  // python/perl/ruby/php/node. A deny-list can never be exhaustive (any
  // script or pipeline can hide a deletion); the recoverable-trash and
  // backup layers are the consequence backstop, this list only narrows it.
  [/\bfind\b[\s\S]*\s-delete\b/i, "bulk-delete", "批量删除文件"],
  [/\bfind\b[\s\S]*\s-exec(?:dir)?\b[\s\S]*\b(?:rm|unlink)\b/i, "bulk-delete", "批量删除文件"],
  [/\bxargs\b[^|;&]*\b(?:rm|unlink)\b/i, "bulk-delete", "批量删除文件"],
  [/\brimraf\b/i, "delete-files", CATEGORY_DELETE_FILES],
  [/\b(?:python3?|perl|ruby|php|node)\b[\s\S]*\b(?:unlink(?:Sync)?|rmtree|rmSync|rimraf|os\.remove|shutil\.rmtree|fs\.rm(?:Sync)?|fs\.unlink(?:Sync)?)\b/i, "bulk-delete", "通过脚本解释器删除文件"],
  [/\b(?:drop\s+(?:database|schema|table|view|user)|truncate\b|delete\s+from\b)\b/i, "db-destroy", "删除数据库数据或对象"],
  [/\b(?:mkfs(?:\.|\b)|dd\b|wipefs\b|fdisk\b|parted\b|sgdisk\b)\b/i, "disk-format", "格式化或改写磁盘"],
  [/\b(?:docker\s+(?:system\s+prune|container\s+prune|image\s+prune|volume\s+prune)|docker\s+(?:rm|rmi|volume\s+rm))\b/i, "docker-destroy", "删除容器、镜像或卷"],
  [/\b(?:kubectl\s+delete|helm\s+uninstall|terraform\s+destroy)\b/i, "deploy-destroy", "销毁已部署资源"],
  // `-[a-z]*f\b` missed the everyday `-fd` form (the \b demands f be last),
  // so the group matches any short-flag cluster containing f, or --force.
  [/\bgit\s+(?:reset\s+--hard|clean\s+(?:-[a-z]*f|--force))/i, "git-destructive", "不可恢复地清理代码工作区"],
  [/\b(?:reboot|shutdown|poweroff|halt)\b/i, "reboot-shutdown", "重启或关闭服务器"]
];
// i18n-identifier-end

const STANDARD_POLICY = Object.freeze({ mode: "standard", allow: Object.freeze([]) });

function blocked(category, categoryKey) {
  return {
    ok: false,
    category,
    categoryKey,
    // Short reason: surfaced when an agent-typed line is blocked (Enter held) and as
    // the card title on ssh_exec/sftp_delete. Kept terse so the key advice
    // (don't retry, don't bypass, a human confirms) is visible at a glance.
    reason: policyBlockedReason(category)
  };
}

/**
 * Return an allow/deny decision for an agent-initiated shell command line.
 * This is a deny-list of explicitly destructive operations, not a diagnostic
 * allow-list; normal DSH approval remains the primary permissions layer.
 *
 * `policy` selects the tier: standard (default, everything blocked for the
 * operator), custom (patterns whose key is in `allow` are released), allowAll
 * (the deny-list stands down entirely — the operator explicitly took the
 * irreversible-delete risk on this connection).
 */
export function assessShellCommand(command, policy = STANDARD_POLICY) {
  if (typeof command !== "string") return blocked(t("命令不是文本"), null);
  const value = command.trim();
  if (!value) return { ok: true };

  const tier = normalizePolicy(policy);
  if (tier.mode === "allowAll") return { ok: true };

  const released = tier.mode === "custom" ? new Set(tier.allow) : null;
  if (released && normalizeExactRules(policy.exact).includes(value)) return { ok: true };
  // Both spellings are scanned: the operator's own text (so nothing that the
  // patterns already caught is lost) and the canonical one (so re-spelling a
  // program cannot hide it). The pattern order still decides the reason.
  const canonical = canonicalCommandText(value);
  const scanned = canonical === value ? [value] : [value, canonical];
  for (const [pattern, categoryKey, category] of IRREVERSIBLE_BLOCK_LIST) {
    if (!scanned.some((text) => pattern.test(text))) continue;
    if (released !== null && released.has(categoryKey)) continue;
    return blocked(category, categoryKey);
  }
  // A program name built from expansion is not a command this list can judge:
  // `a=r;b=m;$a$b -rf /` is `rm -rf /` to the shell and invisible to every
  // pattern above. Fail closed and let the operator read the exact text; the
  // custom tier cannot release this category, because there is nothing
  // recognized to release.
  if (unresolvedExpansion(value) !== null) {
    return blocked(CATEGORY_UNRESOLVED_PROGRAM, "unresolved-program");
  }
  return { ok: true };
}
