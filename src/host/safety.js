/**
 * Host-enforced SSH command policy.
 *
 * DSH owns normal approval/access-mode handling. The plugin therefore only
 * stops a conversational agent from issuing explicitly destructive commands;
 * routine SSL, package, service, and configuration operations stay available.
 * A user who deliberately types a high-risk command into the right-side SSH
 * terminal is not intercepted by this agent-command guard.
 */
import { policyBlockedReason } from "./policy-messages.js";
import { t } from "../i18n/core.js";

/**
 * Stable identifier for the file-deletion category. The trash rewrite keys on
 * this (not on the display string) so editing the human-facing message can
 * never silently disable the rewrite.
 */
export const CATEGORY_DELETE_FILES = "删除文件或目录"; // i18n-identifier

/**
 * Machine-readable category keys. They key the operator's custom-tier allow
 * set (persisted in harbor_settings); the display strings above remain the
 * i18n surface and never travel through storage. A released category stops
 * matching its own patterns but scanning continues, so a line that also hits
 * an unreleased category stays blocked.
 */
export const ALL_CATEGORY_KEYS = Object.freeze([
  "delete-files",
  "bulk-delete",
  "db-destroy",
  "disk-format",
  "docker-destroy",
  "deploy-destroy",
  "git-destructive",
  "reboot-shutdown"
]);

/**
 * One representative display string per category key, for the operator's
 * custom-tier checklist. The strings are i18n identifiers (translated via t()
 * with existing dictionary entries); several deny-list patterns share a key,
 * and the label chosen here is the umbrella wording.
 */
// i18n-identifier-start (labels are i18n keys; the panel translates them)
export const CATEGORY_LABELS = Object.freeze({
  "delete-files": "删除文件或目录",
  "bulk-delete": "批量删除文件",
  "db-destroy": "删除数据库数据或对象",
  "disk-format": "格式化或改写磁盘",
  "docker-destroy": "删除容器、镜像或卷",
  "deploy-destroy": "销毁已部署资源",
  "git-destructive": "不可恢复地清理代码工作区",
  "reboot-shutdown": "重启或关闭服务器"
});
// i18n-identifier-end

/**
 * One canonical spelling for shell quoting and escaping, for the deny-list scan
 * only. The gate still executes the operator's exact text, and the trash
 * rewrite keeps its own stricter literal parser (trash.js).
 *
 * Matching the raw text is trivially evaded by re-spelling the same command:
 * `\rm`, `'rm'`, `r''m`, `r"m"`, `$'\x72m'` and `sh -c "rm ..."` all run the
 * same deletion, yet none of them contains the byte sequence " rm". This
 * collapses those spellings to what the shell would actually run: single
 * quotes verbatim, double quotes with only their four escapes, `$'...'`
 * ANSI-C escapes decoded, backslash escapes resolved, a trailing backslash-newline
 * continuation dropped. Anything it cannot resolve stays as written — the raw
 * spelling is scanned next to the canonical one, so a match in either blocks.
 *
 * @param {unknown} command - one shell command line.
 * @returns {string} the canonical spelling to scan.
 */
export function canonicalCommandText(command) {
  const text = String(command ?? "");
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) { out += text.slice(i); break; }
      out += text.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const c = text[j];
        if (c === "\\") {
          const next = text[j + 1];
          if (next === undefined) { j = n; break; }
          // Inside double quotes only these four escapes are consumed; any
          // other backslash is a literal byte the shell passes through.
          if (next === '"' || next === "\\" || next === "$" || next === "`") { out += next; j += 2; continue; }
          out += `\\${next}`;
          j += 2;
          continue;
        }
        if (c === '"') { closed = true; j += 1; break; }
        out += c;
        j += 1;
      }
      i = j;
      if (!closed) break;
      continue;
    }
    if (ch === "$" && text[i + 1] === "'") {
      // ANSI-C quoting ($'...'): bash-level escapes, so \x72 / \162 are "r".
      let j = i + 2;
      let body = "";
      let closed = false;
      while (j < n) {
        const c = text[j];
        if (c === "\\") { body += c + (text[j + 1] ?? ""); j += 2; continue; }
        if (c === "'") { closed = true; j += 1; break; }
        body += c;
        j += 1;
      }
      if (!closed) { out += text.slice(i); break; }
      out += decodeAnsiCString(body);
      i = j;
      continue;
    }
    if (ch === "\\") {
      const next = text[i + 1];
      if (next === undefined) { out += ch; i += 1; continue; }
      if (next === "\n") { i += 2; continue; } // line continuation
      out += next;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const ANSI_C_SIMPLE_ESCAPES = new Map([
  ["a", "\x07"], ["b", "\b"], ["e", "\x1b"], ["E", "\x1b"], ["f", "\f"],
  ["n", "\n"], ["r", "\r"], ["t", "\t"], ["v", "\v"],
  ["\\", "\\"], ["'", "'"], ['"', '"'], ["?", "?"]
]);

/** Decode the body of one `$'...'` literal; unrecognised escapes keep their backslash. */
function decodeAnsiCString(body) {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") { out += ch; continue; }
    const next = body[i + 1];
    if (next === undefined) { out += ch; break; }
    const simple = ANSI_C_SIMPLE_ESCAPES.get(next);
    if (simple !== undefined) { out += simple; i += 1; continue; }
    if (next === "x") {
      const hex = /^[0-9a-fA-F]{1,2}/.exec(body.slice(i + 2));
      if (hex !== null) { out += String.fromCharCode(Number.parseInt(hex[0], 16)); i += 1 + hex[0].length; continue; }
    }
    if (next >= "0" && next <= "7") {
      const octal = /^[0-7]{1,3}/.exec(body.slice(i + 1));
      if (octal !== null) { out += String.fromCharCode(Number.parseInt(octal[0], 8) & 0xff); i += octal[0].length; continue; }
    }
    if (next === "c" && body[i + 2] !== undefined) {
      out += String.fromCharCode(body[i + 2].toUpperCase().charCodeAt(0) & 0x1f);
      i += 2;
      continue;
    }
    out += `\\${next}`;
    i += 1;
  }
  return out;
}

/**
 * A delete program anywhere in the line: at the start, after an operator
 * (`;`, `&&`, `|`, a newline, a backtick, `(`), after a wrapper (`sh -c`,
 * `sudo`, `xargs`) or as the argument of a path-qualified invocation
 * (`/bin/rm`, `./rm`, `~/bin/rm`).
 *
 * The two boundaries are deliberate. Before the program, `[^\w-]` keeps
 * ordinary words out (`confirm`, `format`, `terraform`) and `-` keeps the
 * everyday `docker run --rm` flag out. After it, the program must END the
 * shell word (end of line, whitespace, an operator or a bracket) — a plain
 * `\b` also matched `rm.conf` and `rm.exe`, turning ordinary file names
 * into blocked deletions.
 */
const DELETE_PROGRAM_PATTERN = /(?:^|[^\w-])(?:[~\w.+-]*\/)*(?:rm|unlink|shred|rmdir)(?=$|[\s;&|()<>`])/i;

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

/** Execution policy tiers. "custom" releases only the keys in `allow`. */
export const EXEC_POLICY_MODES = Object.freeze(["standard", "custom", "allowAll"]);

export const STANDARD_POLICY = Object.freeze({ mode: "standard", allow: Object.freeze([]) });

/**
 * Harden untrusted policy input into a safe decision object. Anything that is
 * not a known mode falls back to standard; unknown category keys are dropped
 * so a stale or hand-edited settings record can never widen the gate.
 */
/**
 * Harden one operator-supplied released-category list: unknown keys are
 * dropped and duplicates collapse. Deliberately separate from normalizePolicy
 * because the list is a STORAGE concept, not a decision one — normalizePolicy
 * clears it for every non-custom tier (right for the decision), and routing
 * the stored checklist through it erased the operator's ticks whenever the
 * tier happened to be standard or allowAll.
 */
export function normalizeAllowList(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((key) => ALL_CATEGORY_KEYS.includes(key)))];
}

// Only literal single commands are eligible for a per-command exception.
export function normalizeExactRules(rules) {
  if (!Array.isArray(rules)) return [];
  return [...new Set(rules.filter((rule) => typeof rule === "string" && rule.length <= 512 && /^[a-zA-Z0-9_./:-]+(?: +[a-zA-Z0-9_./:=,@%+-]+)*$/.test(rule.trim())).map((rule) => rule.trim()))].slice(0, 32);
}

export function normalizePolicy(policy) {
  if (typeof policy === "string") {
    return EXEC_POLICY_MODES.includes(policy) ? { mode: policy, allow: [] } : { mode: "standard", allow: [] };
  }
  if (policy === null || policy === undefined) return { mode: "standard", allow: [] };
  const mode = EXEC_POLICY_MODES.includes(policy.mode) ? policy.mode : "standard";
  if (mode !== "custom") return { mode, allow: [] };
  return { mode, allow: normalizeAllowList(policy.allow) };
}

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
  return { ok: true };
}

/**
 * Whether a blocked command can be safely prefilled into the interactive
 * terminal's input line. Control characters are rejected because Tab would
 * trigger completion, ESC/Ctrl-C would cancel the line, and CR/LF would
 * submit it immediately — the operator must be the one to press Enter.
 */
export function isPrefillable(command) {
  if (typeof command !== "string" || command.length === 0) return false;
  if (command.length > 4096) return false;
  for (let i = 0; i < command.length; i++) {
    const code = command.charCodeAt(i);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

/**
 * POSIX single-quote an argument so it is safe to interpolate into a shell
 * command line (e.g. an SFTP path turned into `rm -rf <quoted>`). Embedded
 * single quotes are escaped with the standard `'\''` sequence.
 */
export function shellQuote(arg) {
  const text = typeof arg === "string" ? arg : String(arg ?? "");
  return `'${text.replace(/'/g, "'\\''")}'`;
}
