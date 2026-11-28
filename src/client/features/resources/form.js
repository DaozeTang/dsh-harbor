/**
 * Pure form and credential helpers for the resource settings page.
 *
 * Kept out of the components so the editor, the shared-credential editor
 * and the legacy-profile migration use one definition each.
 */
import { t } from "../../../i18n/core.js";

const LEGACY_PROFILES_KEY = "dsh-harbor.server-profiles.v1";

// Evaluated per render: a module-level object would freeze the labels in
// whatever language was active at import time.
export const hostKeyModeLabels = () => ({
  "accept-new": t("默认（首次信任，变化才拒）"),
  verify: t("严格（拒绝未知主机）"),
  off: t("关闭校验（不推荐）")
});

export const hostKeyModeOptions = () => Object.entries(hostKeyModeLabels()).map(([value, label]) => ({ value, label }));

export function emptyForm(defaultUsername) {
  return {
    profileId: undefined,
    name: "",
    host: "",
    port: "22",
    username: (defaultUsername ?? "").trim() || "root",
    authKind: "password",
    hostKeyMode: "accept-new",
    agentForward: false,
    groupId: "",
    credentialId: "",
    defaultProjectPath: "",
    loginCommand: "",
    execPolicy: "",
    proxyJump: [],
    secret: "",
    passphrase: "",
    secondary: "",
    clearSecret: false,
    clearPassphrase: false,
    clearSecondary: false
  };
}

export function profileToForm(profile) {
  return {
    ...emptyForm(),
    profileId: profile.profileId,
    name: profile.name,
    host: profile.host,
    port: String(profile.port),
    username: profile.username,
    authKind: profile.authKind,
    hostKeyMode: profile.hostKeyMode ?? "accept-new",
    agentForward: profile.agentForward === true,
    groupId: profile.groupId ?? "",
    credentialId: profile.credentialId ?? "",
    defaultProjectPath: profile.defaultProjectPath ?? "",
    loginCommand: profile.loginCommand ?? "",
    execPolicy: profile.execPolicy ?? "",
    proxyJump: (profile.proxyJump ?? []).map((hop) => ({ ...hop, authKind: hop.authKind ?? "credential", password: "", privateKey: "", passphrase: "" }))
  };
}

export async function credentialWrite(credentials, ref, value) {
  const response = await credentials.set(ref, value);
  if (response && !response.ok) throw new Error(response.error?.message ?? t("无法保存凭据"));
}

export async function credentialUnset(credentials, ref) {
  const response = await credentials.unset(ref);
  if (response && !response.ok) throw new Error(response.error?.message ?? t("无法清除凭据"));
}

export function readLegacyProfiles() {
  try {
    const value = JSON.parse(localStorage.getItem(LEGACY_PROFILES_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((profile) => profile && typeof profile.host === "string" && typeof profile.username === "string");
  } catch {
    return [];
  }
}

/** Migrate only non-secret coordinates from older browser-local profiles. */
export async function migrateLegacyProfiles(api) {
  const legacy = readLegacyProfiles().filter((p) => String(p.host ?? "").trim() !== "");
  if (legacy.length === 0) return false;
  const remaining = [];
  for (const profile of legacy) {
    try {
      await api.profileSave({
        name: String(profile.name || profile.host).trim() || "SSH server",
        host: String(profile.host).trim(),
        port: Number(profile.port) || 22,
        username: String(profile.username).trim(),
        authKind: profile.authKind === "key" ? "key" : "password"
      });
    } catch {
      remaining.push(profile);
    }
  }
  try {
    if (remaining.length === 0) localStorage.removeItem(LEGACY_PROFILES_KEY);
    else localStorage.setItem(LEGACY_PROFILES_KEY, JSON.stringify(remaining));
  } catch {}
  return true;
}
