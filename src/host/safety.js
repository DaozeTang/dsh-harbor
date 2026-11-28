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
 * Category for a command whose program name is produced by shell expansion.
 *
 * Deliberately NOT in ALL_CATEGORY_KEYS: the operator's custom allow-list may
 * release a *recognized* risk (a literal delete), never the absence of a
 * decision. `a=r;b=m;$a$b -rf /` is `rm -rf /` to the shell but contains no
 * program name any pattern can match, so it always needs the operator's eyes on
 * the exact text.
 */
export const CATEGORY_UNRESOLVED_PROGRAM = "命令的实际程序名无法静态解析"; // i18n-identifier

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
          // A backslash-newline is a line continuation and the shell DELETES
          // both bytes, inside double quotes as well as outside. Leaving them
          // in made r"\<newline>m" canonicalize to a string that contains no
          // "rm" at all, so the same deletion ran unblocked.
          if (next === "\n") { j += 2; continue; }
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
    // uHHHH / UHHHHHHHH (bash >= 4.2). Missing these left the ANSI-C spelling
    // of "rm" completely undecoded, so the canonical text contained no "rm"
    // and the deletion ran with neither approval nor the reversible rewrite.
    if (next === "u" || next === "U") {
      const hex = new RegExp(`^[0-9a-fA-F]{1,${next === "u" ? 4 : 8}}`).exec(body.slice(i + 2));
      if (hex !== null) {
        const code = Number.parseInt(hex[0], 16);
        if (code <= 0x10ffff) { out += String.fromCodePoint(code); i += 1 + hex[0].length; continue; }
      }
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

/**
 * ── Unverifiable program names ─────────────────────────────────────────────
 *
 * The deny-list recognizes a program by its literal spelling. Parameter
 * expansion defeats that without any exotic syntax: `a=r;b=m;$a$b -rf /`
 * runs `rm -rf /` while no pattern above can see "rm". Fully resolving a
 * shell is out of scope (and a deny-list can never be exhaustive), but the
 * *program word* is a narrower question than a pattern: when it is built from
 * an expansion the line cannot be judged at all, and "cannot judge" must mean
 * "ask the operator", never "allow".
 *
 * This scan finds every simple command in the line (including `$(...)` and
 * backtick bodies) and checks whether its program word is statically known.
 * Expansions in ordinary arguments stay allowed — `ls $HOME` is still a
 * listing, because word splitting cannot turn an argument into a new command.
 * Wrappers that re-parse or forward their arguments (`sudo`, `env`, `xargs`,
 * `sh -c`, `find -exec`, ...) are followed one level so `sudo $a$b` cannot
 * hide behind a statically named wrapper either.
 */
const DYNAMIC_WORD = /[$`]/;
const COMMAND_KEYWORDS = new Set([
  "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "for",
  "case", "esac", "select", "function", "in", "!", "{", "}"
]);
const SHELL_PROGRAMS = new Set(["sh", "bash", "dash", "zsh", "ksh", "mksh", "ash", "busybox-sh"]);
const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/;
const MAX_ANALYSIS_DEPTH = 8;

const SUDO_VALUE_OPTIONS = new Set(["-u", "--user", "-g", "--group", "-p", "--prompt", "-C", "-T", "-R", "-D", "-r", "-t", "-U"]);
const ENV_VALUE_OPTIONS = new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]);
const XARGS_VALUE_OPTIONS = new Set(["-a", "--arg-file", "-d", "--delimiter", "-E", "--eof", "-I", "-L", "--max-lines", "-n", "--max-args", "-P", "--max-procs", "-s", "--max-chars"]);
const TIMEOUT_VALUE_OPTIONS = new Set(["-s", "--signal", "-k", "--kill-after"]);
const NICE_VALUE_OPTIONS = new Set(["-n", "--adjustment", "-c", "-p", "-P", "-u"]);
const STDBUF_VALUE_OPTIONS = new Set(["-i", "-o", "-e"]);
const TIME_VALUE_OPTIONS = new Set(["-f", "--format", "-o", "--output"]);
const CHROOT_VALUE_OPTIONS = new Set(["--userspec", "--groups"]);
const WATCH_VALUE_OPTIONS = new Set(["-n", "--interval"]);

/**
 * Split one command line into simple-command segments without being fooled by
 * separators inside quotes, backticks or `$(...)`.
 */
function commandSegments(text) {
  const segments = [];
  let current = "";
  let i = 0;
  let substitutionDepth = 0;
  const push = () => { segments.push(current); current = ""; };
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") { current += text.slice(i, i + 2); i += 2; continue; }
    if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) { current += text.slice(i); break; }
      current += text.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === '$' && text[i + 1] === "'") {
      let j = i + 2;
      while (j < text.length) {
        if (text[j] === "\\") { j += 2; continue; }
        if (text[j] === "'") { j += 1; break; }
        j += 1;
      }
      current += text.slice(i, j);
      i = j;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "\\") { j += 2; continue; }
        if (text[j] === '"') { j += 1; break; }
        j += 1;
      }
      current += text.slice(i, j);
      i = j;
      continue;
    }
    if (ch === "`") {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "\\") { j += 2; continue; }
        if (text[j] === "`") { j += 1; break; }
        j += 1;
      }
      current += text.slice(i, j);
      i = j;
      continue;
    }
    if (ch === "$" && text[i + 1] === "(") { substitutionDepth += 1; current += "$("; i += 2; continue; }
    if (ch === ")" && substitutionDepth > 0) { substitutionDepth -= 1; current += ch; i += 1; continue; }
    if (substitutionDepth === 0 && (ch === ";" || ch === "&" || ch === "|" || ch === "\n" || ch === "\r")) { push(); i += 1; continue; }
    current += ch;
    i += 1;
  }
  push();
  return segments;
}

/** Bodies of `$(...)` and backtick substitutions, for recursive analysis. */
function substitutionBodies(text) {
  const bodies = [];
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf("$(", i);
    if (start === -1) break;
    let depth = 0;
    let j = start + 1;
    let closed = false;
    while (j < text.length) {
      const ch = text[j];
      if (ch === "\\") { j += 2; continue; }
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) { closed = true; break; }
      }
      j += 1;
    }
    if (!closed) break;
    bodies.push(text.slice(start + 2, j));
    i = j + 1;
  }
  let k = 0;
  while (k < text.length) {
    const start = text.indexOf("`", k);
    if (start === -1) break;
    let j = start + 1;
    let closed = false;
    while (j < text.length) {
      if (text[j] === "\\") { j += 2; continue; }
      if (text[j] === "`") { closed = true; break; }
      j += 1;
    }
    if (!closed) break;
    bodies.push(text.slice(start + 1, j));
    k = j + 1;
  }
  return bodies;
}

/**
 * Words of one segment with quoting and escapes resolved, keeping `$(...)`
 * and backtick bodies in one word: `PATH=$(npm bin):$PATH tool` must not
 * split the substitution's spaces into a fake program token.
 */
function splitWords(text) {
  const words = [];
  let current = "";
  let depth = 0;
  let inBacktick = false;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (ch === "`") { inBacktick = !inBacktick; current += ch; continue; }
    if (!inBacktick) {
      if (ch === "$" && text[index + 1] === "(") { depth += 1; current += "$("; index += 1; continue; }
      if (ch === ")" && depth > 0) { depth -= 1; current += ch; continue; }
      if (depth === 0 && /\s/.test(ch)) {
        if (current !== "") { words.push(current); current = ""; }
        continue;
      }
    }
    current += ch;
  }
  if (current !== "") words.push(current);
  return words;
}

/** Words of one segment with quoting and escapes resolved. */
function segmentWords(segment) {
  return splitWords(canonicalCommandText(segment).trim());
}

/** First word that runs: keywords and leading NAME=value assignments skipped. */
function programIndex(words) {
  let index = 0;
  while (index < words.length && (COMMAND_KEYWORDS.has(words[index]) || ASSIGNMENT_WORD.test(words[index]) || words[index] === "]")) {
    // Loop/case headers contain data (`for f in $LIST`, `case $X in`), not a
    // command: treating the list/subject as a program would prompt on ordinary
    // `for` and `case` scripts. Their bodies are separate segments.
    if (words[index] === "for" || words[index] === "case" || words[index] === "select" || words[index] === "function") return words.length;
    index += 1;
  }
  return index;
}

function basename(word) {
  const slash = word.lastIndexOf("/");
  return slash === -1 ? word : word.slice(slash + 1);
}

function skipOptions(words, valueOptions) {
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    if (word === "--") return index + 1;
    if (!word.startsWith("-")) return index;
    if (word.includes("=")) { index += 1; continue; }
    index += valueOptions.has(word) ? 2 : 1;
  }
  return index;
}

/** Index of the script after `-c` or a combined short cluster such as `-lc`. */
function shellScriptIndex(words) {
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word === "-c" || /^-[A-Za-z]*c[A-Za-z]*$/.test(word)) return index + 1;
  }
  return -1;
}

/**
 * The dynamic token that hides a program, or null when every program this
 * segment can execute is statically named.
 */
function unresolvedProgramAt(words, start, depth) {
  if (start >= words.length) return null;
  const program = words[start];
  if (DYNAMIC_WORD.test(program)) return program;
  const name = basename(program);
  if (depth >= MAX_ANALYSIS_DEPTH) return program;
  const rest = words.slice(start + 1);
  const recurse = (from) => unresolvedProgramAt(rest, from, depth + 1);

  if (name === "eval") return rest.find((word) => DYNAMIC_WORD.test(word)) ?? null;

  if (SHELL_PROGRAMS.has(name)) {
    const at = shellScriptIndex(rest);
    if (at === -1 || at >= rest.length) return null;
    // The -c argument is a whole script, not a single program word: analyze
    // every simple command inside it, so `sh -c 'echo ok; $a$b -rf /'` cannot
    // hide behind the harmless first command.
    return unresolvedExpansion(rest.slice(at).join(" "), depth + 1);
  }

  if (name === "su" || name === "runuser" || name === "flock") {
    for (let index = 0; index < rest.length; index += 1) {
      const word = rest[index];
      if (word === "-c" || word === "--command") {
        return unresolvedExpansion(rest.slice(index + 1).join(" "), depth + 1);
      }
      if (word.startsWith("--command=")) {
        return unresolvedExpansion(rest[index].slice("--command=".length) + " " + rest.slice(index + 1).join(" "), depth + 1);
      }
    }
    return null;
  }

  if (name === "find") {
    const at = rest.findIndex((word) => word === "-exec" || word === "-execdir" || word === "-ok" || word === "-okdir");
    return at === -1 ? null : recurse(at + 1);
  }

  if (name === "xargs") {
    const at = skipOptions(rest, XARGS_VALUE_OPTIONS);
    return at < rest.length ? recurse(at) : null;
  }

  if (name === "timeout") {
    const at = skipOptions(rest, TIMEOUT_VALUE_OPTIONS);
    if (at >= rest.length) return null;
    if (DYNAMIC_WORD.test(rest[at])) return rest[at];
    return recurse(at + 1);
  }

  if (name === "sudo" || name === "doas") {
    const at = skipOptions(rest, SUDO_VALUE_OPTIONS);
    return at < rest.length ? recurse(at) : null;
  }

  if (name === "env") {
    let at = skipOptions(rest, ENV_VALUE_OPTIONS);
    while (at < rest.length && ASSIGNMENT_WORD.test(rest[at])) at += 1;
    return at < rest.length ? recurse(at) : null;
  }

  if (name === "command") {
    if (rest.some((word) => word === "-v" || word === "-V")) return null;
    const at = skipOptions(rest, new Set(["-p"]));
    return at < rest.length ? recurse(at) : null;
  }

  if (name === "exec") {
    const at = skipOptions(rest, new Set(["-a"]));
    return at < rest.length ? recurse(at) : null;
  }

  if (name === "nohup" || name === "setsid") {
    const at = skipOptions(rest, new Set());
    return at < rest.length ? recurse(at) : null;
  }

  if (name === "nice" || name === "ionice" || name === "stdbuf" || name === "time") {
    const valueOptions = name === "nice" ? NICE_VALUE_OPTIONS
      : name === "stdbuf" ? STDBUF_VALUE_OPTIONS
        : name === "time" ? TIME_VALUE_OPTIONS
          : new Set(["-c", "-n", "-p", "-P", "-u"]);
    const at = skipOptions(rest, valueOptions);
    return at < rest.length ? recurse(at) : null;
  }

  if (name === "chroot") {
    const at = skipOptions(rest, CHROOT_VALUE_OPTIONS);
    return at + 1 < rest.length ? recurse(at + 1) : null;
  }

  if (name === "watch") {
    const at = skipOptions(rest, WATCH_VALUE_OPTIONS);
    return at < rest.length ? recurse(at) : null;
  }

  if (name === "busybox" || name === "toybox") {
    const at = skipOptions(rest, new Set());
    if (at >= rest.length || rest[at] === "--list" || rest[at] === "--help") return null;
    return recurse(at);
  }

  if (name === "unshare" || name === "nsenter" || name === "taskset") {
    const candidate = [...rest].reverse().find((word) => !word.startsWith("-"));
    return candidate !== undefined && DYNAMIC_WORD.test(candidate) ? candidate : null;
  }

  return null;
}

/** The dynamic token in one segment, or null. */
function unresolvedInSegment(segment, depth) {
  const words = segmentWords(segment);
  const start = programIndex(words);
  return start < words.length ? unresolvedProgramAt(words, start, depth) : null;
}

/** The dynamic token anywhere in a command line, or null. */
function unresolvedExpansion(text, depth = 0) {
  if (depth > MAX_ANALYSIS_DEPTH) return "nested-substitution";
  for (const segment of commandSegments(text)) {
    const reason = unresolvedInSegment(segment, depth);
    if (reason !== null) return reason;
  }
  for (const body of substitutionBodies(text)) {
    const reason = unresolvedExpansion(body, depth + 1);
    if (reason !== null) return reason;
  }
  return null;
}

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

const STANDARD_POLICY = Object.freeze({ mode: "standard", allow: Object.freeze([]) });

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

/**
 * POSIX single-quote an argument so it is safe to interpolate into a shell
 * command line (e.g. an SFTP path turned into `rm -rf <quoted>`). Embedded
 * single quotes are escaped with the standard `'\''` sequence.
 */
export function shellQuote(arg) {
  const text = typeof arg === "string" ? arg : String(arg ?? "");
  return `'${text.replace(/'/g, "'\\''")}'`;
}
