// Command analysis rules: recognize a destructive program, and harden the
// operator's policy input.
//
// Split out of safety.js. Everything here is pure: it inspects text and
// normalizes stored settings, and never decides what to run.

import { ALL_CATEGORY_KEYS } from "./categories.js";
import { canonicalCommandText } from "./canonical.js";

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
export const DELETE_PROGRAM_PATTERN = /(?:^|[^\w-])(?:[~\w.+-]*\/)*(?:rm|unlink|shred|rmdir)(?=$|[\s;&|()<>`])/i;

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
export function unresolvedExpansion(text, depth = 0) {
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

/** Execution policy tiers. "custom" releases only the keys in `allow`. */
export const EXEC_POLICY_MODES = Object.freeze(["standard", "custom", "allowAll"]);

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
