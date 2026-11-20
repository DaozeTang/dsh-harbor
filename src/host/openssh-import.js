import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { homedir, hostname as localHostname, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isEncryptedPrivateKey } from "../shared/private-key.js";

export const SSH_IMPORT_LIMIT = 500;
const CONFIG_BYTES = 1024 * 1024;
// An IdentityFile is copied into the credential store, so bound the read: real
// private keys are a few KB, and a mistyped path must not turn a preview into a
// multi-megabyte read.
const KEY_BYTES = 256 * 1024;
// OpenSSH caps how many identity files one connection tries; keeping the same
// bound stops a pathological config from fanning a preview out into thousands
// of filesystem probes.
const MAX_IDENTITY_FILES = 16;
const PATH_LIMIT = 4096;

function matcher(pattern) {
  const rule = pattern.toLowerCase();
  return {
    test(value) {
      const name = value.toLowerCase();
      let at = 0;
      let next = 0;
      let star = -1;
      let retry = 0;
      while (at < name.length) {
        if (rule[next] === "*") {
          star = next++;
          retry = at;
        } else if (rule[next] === "?" || rule[next] === name[at]) {
          at++;
          next++;
        } else if (star !== -1) {
          next = star + 1;
          at = ++retry;
        } else {
          return false;
        }
      }
      return /^\**$/.test(rule.slice(next));
    }
  };
}

async function readConfig(file, state, depth = 0) {
  if (depth > 8 || ++state.files > 128) throw new Error("SSH configuration includes too many files");
  const handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  let text;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > state.remaining) throw new Error("SSH configuration exceeds the input limit");
    const buffer = Buffer.alloc(info.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > info.size) throw new Error("SSH configuration changed while reading");
    state.remaining -= bytesRead;
    text = buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
  let hostSection = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const option = /^([a-z][a-z0-9]*)\s*(?:=\s*|\s+)(.+)$/i.exec(line);
    if (!option) continue;
    const key = option[1].toLowerCase();
    const args = (option[2].match(/"(?:[^"\\]|\\.)*"|[^\s"#]+|#/g) ?? []);
    const comment = args.indexOf("#");
    if (comment !== -1) args.length = comment;
    const values = args.map((value) => value.replace(/^"(.*)"$/, "$1"));
    if (key === "host") hostSection = true;
    if (key === "match") throw new Error("SSH configurations containing Match are not supported");
    if (key !== "include") {
      if (key === "host") {
        const positive = values.filter((value) => !value.startsWith("!")).map(matcher);
        const negative = values.filter((value) => value.startsWith("!")).map((value) => matcher(value.slice(1)));
        state.options.push({ key, values, matches: (name) => positive.some((rule) => rule.test(name)) && !negative.some((rule) => rule.test(name)) });
      } else {
        state.options.push({ key, values });
      }
      continue;
    }
    if (hostSection) throw new Error("Conditional SSH Include is not supported");
    for (const value of values) {
      const path = resolve(state.directory, value.replace(/^~[/\\]/, state.home + "/"));
      const folder = dirname(path);
      const pattern = basename(path);
      if (/[*?[\]]/.test(folder) || /[[\]]/.test(pattern)) throw new Error("Unsupported SSH Include pattern");
      const paths = /[*?]/.test(pattern)
        ? (await readdir(folder).catch((error) => { if (error.code === "ENOENT") return []; throw error; }))
 .filter((name) => (!name.startsWith(".") || pattern.startsWith(".")) && matcher(pattern).test(name)).sort().map((name) => join(folder, name))
 : [path];
      for (const included of paths) {
        state.options.push({ key: "include-start", values: [] });
        try { await readConfig(included, state, depth + 1); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        state.options.push({ key: "include-end", values: [] });
      }
    }
  }
}

/**
 * Expand one IdentityFile value the way OpenSSH does for an imported key.
 *
 * OpenSSH expands a leading ~ and the documented tokens (ssh_config(5)), then
 * opens relative paths against the process working directory. An import runs
 * from an arbitrary directory, so a relative path is resolved against the
 * user's home instead — the only location that stays meaningful across runs and
 * where nearly every real config keeps its keys. Paths using ~user, %C, %j or
 * %k are not resolvable without more context and return null (reported as a
 * missing key) rather than a guessed path.
 */
function expandIdentityPath(value, context) {
  let path = value.trim();
  if (path === "" || path.toLowerCase() === "none") return null;
  path = path.replace(/%([%CdhijklLnpru])/g, (match, token) => {
    switch (token) {
      case "%": return "%";
      case "d": return context.home;
      case "h": return context.host;
      case "i": return context.uid;
      case "L": return context.localHost.split(".")[0];
      case "l": return context.localHost;
      case "n": return context.alias;
      case "p": return String(context.port);
      case "r": return context.username;
      case "u": return context.localUser;
      default: return match;
    }
  });
  if (path === "~") path = context.home;
  else if (path.startsWith("~/") || path.startsWith("~\\")) path = join(context.home, path.slice(2));
  if (path.startsWith("~")) return null;
  const absolute = isAbsolute(path) ? path : join(context.home, path);
  return absolute.length > PATH_LIMIT ? null : absolute;
}

/** Classify a private key's content without ever leaving the host process. */
export function inspectPrivateKeyText(text) {
  const key = (text ?? "").trim();
  if (key === "") return "invalid";
  const begin = key.match(/^-----BEGIN ([A-Z ]*PRIVATE KEY)-----/);
  const end = key.match(/-----END ([A-Z ]*PRIVATE KEY)-----$/);
  if (!begin || !end || begin[1] !== end[1]) return "invalid";
  const body = key.slice(begin[0].length, key.length - end[0].length);
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return "invalid";
  const wellFormed = lines.every((line) => /^[A-Za-z0-9+/]+={0,2}$/.test(line) || /^[A-Za-z][A-Za-z0-9-]*:\s*\S/.test(line));
  if (!wellFormed) return "invalid";
  return isEncryptedPrivateKey(key) ? "passphrase" : "ready";
}

/**
 * Read one IdentityFile for import. The returned text is the secret itself and
 * is only used by the service to write the profile's credential ref; previews
 * carry the status alone. Statuses: ready | passphrase | missing | unreadable |
 * invalid.
 */
export async function readIdentityPrivateKey(file) {
  if (typeof file !== "string" || file === "") return { status: "missing", text: null };
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size === 0) return { status: "invalid", text: null };
    if (info.size > KEY_BYTES) return { status: "invalid", text: null };
    const buffer = Buffer.alloc(info.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > info.size) return { status: "invalid", text: null };
    const text = buffer.toString("utf8", 0, bytesRead);
    const status = inspectPrivateKeyText(text);
    return { status, text: status === "invalid" ? null : text };
  } catch (error) {
    const missing = error?.code === "ENOENT" || error?.code === "ENOTDIR";
    return { status: missing ? "missing" : "unreadable", text: null };
  } finally {
    if (handle !== undefined) await handle.close().catch(() => {});
  }
}

/** First usable key among one host's IdentityFile values, in OpenSSH order. */
async function resolveIdentityKey(values, context, cache) {
  const candidates = [];
  for (const value of values.slice(0, MAX_IDENTITY_FILES)) {
    const path = expandIdentityPath(value, context);
    if (path !== null && !candidates.includes(path)) candidates.push(path);
  }
  let fallback = null;
  for (const path of candidates) {
    let status = cache.get(path);
    if (status === undefined) {
      status = (await readIdentityPrivateKey(path)).status;
      cache.set(path, status);
    }
    if (status === "ready" || status === "passphrase") return { path, status };
    if (fallback === null) fallback = { path, status };
  }
  return fallback ?? { path: null, status: "missing" };
}

export async function scanOpenSshConfig({ home = homedir(), username = userInfo().username } = {}) {
  const directory = join(home, ".ssh");
  const state = { home, directory, files: 0, remaining: CONFIG_BYTES, options: [] };
  try { await readConfig(join(directory, "config"), state); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }

  const aliases = new Map();
  for (const { key, values } of state.options) {
    if (key !== "host") continue;
    for (const name of values) {
      if (/^[\w.:@-]{1,120}$/.test(name) && !aliases.has(name.toLowerCase())) aliases.set(name.toLowerCase(), name);
    }
  }
  if (aliases.size > SSH_IMPORT_LIMIT) throw new Error("SSH configuration contains more than 500 hosts");

  const keyCache = new Map();
  const localHost = localHostname();
  const localUser = userInfo().username;
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "";
  const entries = [];
  for (const name of aliases.values()) {
    const settings = new Map();
    const identityFiles = [];
    let active = true;
    const includeScopes = [];
    for (const { key, values, matches } of state.options) {
      if (key === "include-start") {
        includeScopes.push(active);
      } else if (key === "include-end") {
        active = includeScopes.pop();
      } else if (key === "host") {
        active = matches(name);
      } else if (active && values.length) {
        // IdentityFile accumulates: every active value is tried, in order.
        if (key === "identityfile") identityFiles.push(...values);
        if (!settings.has(key)) settings.set(key, values[0]);
      }
    }

    const host = (settings.get("hostname") ?? name).replaceAll("%h", name);
    const user = settings.get("user") ?? username;
    const rawPort = settings.get("port") ?? "22";
    const port = /^\d+$/.test(rawPort) ? Number(rawPort) : 0;
    const validPort = Number.isInteger(port) && port >= 1 && port <= 65535;
    const jump = settings.get("proxyjump") ?? "none";
    const hops = jump.toLowerCase() === "none" ? [] : jump.split(",");
    const proxy = settings.get("proxycommand");
    const issues = [];
    if (!host || host.length > 255 || /[%\s]/.test(host)) issues.push("HostName");
    if (!user || user.length > 128 || /[%\s]/.test(user)) issues.push("User");
    if (!validPort) issues.push("Port");
    if (proxy && proxy.toLowerCase() !== "none") issues.push("ProxyCommand");
    if (settings.get("canonicalizehostname") && settings.get("canonicalizehostname").toLowerCase() !== "no") issues.push("CanonicalizeHostname");
    if (hops.length > 8 || hops.some((hop) => !/^[\w.-]+$/.test(hop))) issues.push("ProxyJump");
    // Keep the historical authKind rule (a configured IdentityFile implies key
    // auth), and additionally report whether that key can actually be imported.
    const authKind = settings.has("identityfile") ? "key" : "password";
    const identity = authKind === "key"
      ? await resolveIdentityKey(identityFiles, { home, alias: name, host, username: user, port: validPort ? port : 22, localHost, localUser, uid }, keyCache)
      : { path: null, status: null };
    entries.push({
      name,
      host,
      username: user,
      port: validPort ? port : 22,
      hops,
      issues,
      unsupported: issues.length > 0,
      authKind,
      keyPath: identity.path,
      keyStatus: identity.status
    });
  }
  return entries;
}
