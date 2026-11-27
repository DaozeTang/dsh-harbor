/**
 * Saved SSH resources, groups, known hosts, backup and OpenSSH import.
 */
import { createHash, randomUUID } from "node:crypto";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { fail } from "../envelope.js";
import { EXEC_POLICY_MODES } from "../safety.js";
import { t } from "../../i18n/core.js";
import { DEFAULT_HOST_KEY_MODE } from "../hostkey.js";
import { findReusableProfileConnection } from "../profile-connection.js";
import { collectResourceBackup, previewResourceBackup, restoreResourceBackup } from "../resource-backup-store.js";
import { encryptResourceBackup, decryptResourceBackup } from "../resource-backup-crypto.js";
import { readIdentityPrivateKey, scanOpenSshConfig } from "../openssh-import.js";
import { profileCredentialRefs, sharedCredentialRefs, profileJumpPasswordRef, profileJumpPrivateKeyRef, profileJumpPassphraseRef } from "./models.js";

/**
 * Copy the IdentityFile behind one imported resource into this profile's
 * credential slot. The preview already reported whether the key is usable; the
 * file is read again here so the import stores exactly what it described. Never
 * throws: a key failure must not undo (or hide) the saved profile.
 */
async function importIdentityFileKey(credentials, profileId, entry) {
  if (entry.authKind !== "key" || entry.keyPath === null) return {};
  try {
    const key = await readIdentityPrivateKey(entry.keyPath);
    if (key.status !== "ready" && key.status !== "passphrase") return {};
    if (typeof credentials?.set !== "function") return { error: t("当前 DSH 未提供凭据服务，无法保存私钥") };
    const response = await credentials.set(credentialRef(profileCredentialRefs(profileId).privateKey), key.text);
    if (response?.ok === false) return { error: response.error?.message ?? t("无法保存导入的私钥") };
    return { imported: true, passphrase: key.status === "passphrase" };
  } catch (error) {
    return { error: error?.message ?? t("无法保存导入的私钥") };
  }
}

export const withResources = (Base) => class extends Base {
  requireProfileTable() {
    if (this.profileTable === null) throw new Error("SSH resource storage is not ready");
    return this.profileTable;
  }

  requireKnownHostTable() {
    if (this.knownHostTable === null) throw new Error("known-host storage is not ready");
    return this.knownHostTable;
  }

  requireGroupTable() {
    if (this.groupTable === null) throw new Error("SSH resource storage is not ready");
    return this.groupTable;
  }

  groupPublic(groupId, record) {
    const profileCount = [...this.requireProfileTable().entries()].filter(([, profile]) => profile.groupId === groupId).length;
    return { groupId, name: record.name, profileCount };
  }

  async profilePublic(profileId, record) {
    const shared = record.credentialId ? this.requireCredentialTable().get(record.credentialId) : undefined;
    const refs = shared ? sharedCredentialRefs(record.credentialId) : profileCredentialRefs(profileId);
    const primaryRef = record.authKind === "password" ? refs.password : refs.privateKey;
    const secondaryRef = record.authKind === "password" ? refs.privateKey : refs.password;
    const [primary, passphrase, secondary] = await Promise.all([
      this.ctx.credentials.describe(credentialRef(primaryRef)),
      this.ctx.credentials.describe(credentialRef(refs.passphrase)),
      this.ctx.credentials.describe(credentialRef(secondaryRef))
    ]);
    const connected = [...this.connections.values()].some((connection) => connection.profileId === profileId);
    const group = record.groupId === null ? undefined : this.requireGroupTable().get(record.groupId);
    return {
      profileId,
      name: record.name,
      host: record.host,
      port: record.port,
      username: record.username,
      authKind: record.authKind,
      hostKeyMode: record.hostKeyMode ?? DEFAULT_HOST_KEY_MODE,
      agentForward: record.agentForward === true,
      credentialId: shared ? record.credentialId : null,
      credentialName: shared?.name ?? null,
      proxyJump: record.proxyJump ?? [],
      defaultProjectPath: record.defaultProjectPath ?? null,
      loginCommand: record.loginCommand ?? null,
      execPolicy: EXEC_POLICY_MODES.includes(record.execPolicy) ? record.execPolicy : null,
      groupId: group === undefined ? null : record.groupId,
      groupName: group?.name ?? null,
      credentialConfigured: primary.configured,
      passphraseConfigured: passphrase.configured,
      secondaryConfigured: secondary.configured,
      connected
    };
  }

  async profileConnectionStatus() {
    const ids = new Set();
    for (const connection of this.connections.values()) {
      if (connection.profileId && !connection.dead) ids.add(connection.profileId);
    }
    return { ok: true, value: { profileIds: [...ids] } };
  }

  async profileList() {
    try {
      const profiles = await Promise.all(
        [...this.requireProfileTable().entries()].map(async ([profileId, record]) => await this.profilePublic(profileId, record))
 );
      profiles.sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN"));
      return { ok: true, value: { profiles } };
    } catch (error) {
      return { ok: false, error: fail("profile-list-failed", error.message) };
    }
  }

  async resourceBackupExport(request) {
    try {
      const data = await collectResourceBackup(this);
      return { ok: true, value: { archive: await encryptResourceBackup(data, request.password) } };
    } catch { return { ok: false, error: fail("backup-export-failed", t("导出失败，请检查服务器资源和凭据库。")) }; }
  }

  async openSshImport(request) {
    const importing = request.selection !== undefined;
    if (importing && this.openSshImportBusy) {
      return { ok: false, error: fail("ssh-config-busy", t("SSH 配置正在导入。")) };
    }
    if (importing) this.openSshImportBusy = true;
    try {
      const entries = await scanOpenSshConfig();
      const fingerprint = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
      const key = (name) => name.toLowerCase();
      const existing = new Map([...this.requireProfileTable().entries()].map(([profileId, profile]) => [key(profile.name), { ...profile, profileId }]));
      if (!importing) {
        return { ok: true, value: { preview: {
          fingerprint, entries: entries.map((entry) => ({ ...entry, existing: existing.has(key(entry.name)) }))
        } } };
      }
      if (request.selection.fingerprint !== fingerprint) {
        return { ok: false, error: fail("ssh-config-changed", t("SSH 配置或私钥文件已变化，请重新打开导入预览。")) };
      }

      const byName = new Map(entries.map((entry) => [key(entry.name), entry]));
      const available = new Map();
      for (const [name, profile] of existing) {
        const entry = byName.get(name);
        if (entry && !entry.unsupported && profile.host === entry.host && profile.port === entry.port && profile.username === entry.username) {
          available.set(name, profile.profileId);
        }
      }
      const selected = new Set(request.selection.names.map(key));
      const pending = entries.filter((entry) => selected.has(key(entry.name)) && !existing.has(key(entry.name)));
      const skipped = entries.filter((entry) => selected.has(key(entry.name)) && existing.has(key(entry.name))).map((entry) => entry.name);
      const failed = [];
      const details = [];
      const passphraseRequired = [];
      let created = 0;
      let keysImported = 0;
      // Save dependencies first so a missing or failed jump is never imported
      // as an accidental direct connection. Store every hop in configured order.
      while (pending.length) {
        const index = pending.findIndex((entry) => !entry.unsupported
          && new Set(entry.hops.map(key)).size === entry.hops.length
          && entry.hops.every((hop) => key(hop) !== key(entry.name) && available.has(key(hop))));
        if (index < 0) {
          const remaining = new Map(pending.map((entry) => [key(entry.name), entry]));
          for (const entry of pending) {
            const visited = new Set();
            const visiting = new Set();
            const hasCycle = (alias) => {
              if (visiting.has(alias)) return true;
              if (visited.has(alias) || !remaining.has(alias)) return false;
              visiting.add(alias);
              const cycle = remaining.get(alias).hops.some((hop) => hasCycle(key(hop)));
              visiting.delete(alias);
              visited.add(alias);
              return cycle;
            };
            const missing = entry.hops.filter((hop) => !available.has(key(hop)));
            const repeated = new Set(entry.hops.map(key)).size !== entry.hops.length;
            const reason = entry.unsupported ? "unsupported" : repeated ? "repeated" : hasCycle(key(entry.name)) ? "cycle" : "missing";
            details.push({ name: entry.name, reason, items: entry.unsupported ? entry.issues : missing });
            failed.push(entry.name);
          }
          break;
        }
        const [entry] = pending.splice(index, 1);
        const result = await this.profileSave({
          name: entry.name, host: entry.host, port: entry.port, username: entry.username, authKind: entry.authKind,
          groupId: request.selection.groupId,
          proxyJump: entry.hops.map((hop) => ({ profileId: available.get(key(hop)) }))
        });
        if (result.ok) {
          const profileId = result.value.profile.profileId;
          available.set(key(entry.name), profileId);
          created += 1;
          // IdentityFile keys travel with the profile: a configured key path that
          // resolved in the preview is copied into this profile's credential slot
          // so the resource is usable without a second manual step.
          const identity = await importIdentityFileKey(this.ctx?.credentials, profileId, entry);
          if (identity.imported) {
            keysImported += 1;
            if (identity.passphrase) passphraseRequired.push(entry.name);
          } else if (identity.error !== undefined) {
            details.push({ name: entry.name, reason: "key", items: [String(identity.error).slice(0, 500)] });
          }
        } else {
          failed.push(entry.name);
          details.push({ name: entry.name, reason: "save", items: [result.error.message.slice(0, 500)] });
        }
      }
      return { ok: true, value: { imported: { created, keysImported, passphraseRequired, skipped, failed, details } } };
    } catch {
      return { ok: false, error: fail("ssh-config-import", t("无法读取或导入 SSH 配置。请检查文件权限、大小以及是否包含暂不支持的 Match 或 Include 规则。")) };
    } finally {
      if (importing) this.openSshImportBusy = false;
    }
  }

  async resourceBackupPreview(request) {
    try {
      const data = await decryptResourceBackup(request.archive, request.password);
      return { ok: true, value: previewResourceBackup(this, data) };
    } catch {
      return { ok: false, error: fail("backup-preview-failed", t("无法预览备份，请检查文件、口令和主机指纹。")) };
    }
  }

  async resourceBackupImport(request) {
    try {
      const data = await decryptResourceBackup(request.archive, request.password);
      return { ok: true, value: await restoreResourceBackup(this, data, { skipDuplicates: request.skipDuplicates }) };
    } catch (error) {
      const message = error?.message === "Import failed and rollback was incomplete; inspect SSH resources and credentials"
        ? t("导入失败且未能完全回滚，请检查服务器资源和凭据。")
 : error?.message === "Backup host fingerprint conflicts with an existing trusted host"
          ? t("备份中的主机指纹与已有信任记录冲突，未导入任何服务器。")
 : t("导入失败，请检查备份文件和口令；现有服务器未被覆盖。");
      return { ok: false, error: fail("backup-import-failed", message) };
    }
  }

  async profileSave(request) {
    try {
      const table = this.requireProfileTable();
      const profileId = request.profileId ?? randomUUID();
      const previous = table.get(profileId);
      if (request.profileId !== undefined && previous === undefined) {
        return { ok: false, error: fail("no-profile", `SSH resource "${profileId}" does not exist`) };
      }
      const now = new Date().toISOString();
      const groupId = request.groupId ?? null;
      if (groupId !== null && this.requireGroupTable().get(groupId) === undefined) {
        return { ok: false, error: fail("no-group", `SSH group "${groupId}" does not exist`) };
      }
      if (request.credentialId !== null && request.credentialId !== undefined) {
        const credential = this.requireCredentialTable().get(request.credentialId);
        if (credential === undefined) return { ok: false, error: fail("no-credential", `SSH credential "${request.credentialId}" does not exist`) };
        if (credential.authKind !== request.authKind) return { ok: false, error: fail("credential-auth-mismatch", t("所选共享凭据的认证方式与服务器不一致")) };
      }
      const proxyJump = request.proxyJump ?? previous?.proxyJump ?? [];
      const defaultProjectPath = Object.hasOwn(request, "defaultProjectPath")
        ? request.defaultProjectPath
 : (previous?.defaultProjectPath ?? null);
      const loginCommand = Object.hasOwn(request, "loginCommand")
        ? request.loginCommand
 : (previous?.loginCommand ?? null);
      const execPolicy = Object.hasOwn(request, "execPolicy")
        ? request.execPolicy
 : (previous?.execPolicy ?? null);
      const seenJumpProfiles = new Set();
      for (const hop of proxyJump) {
        if (hop.profileId) {
          if (hop.profileId === profileId) return { ok: false, error: fail("jump-cycle", t("服务器不能把自己设为跳板机")) };
          if (seenJumpProfiles.has(hop.profileId)) return { ok: false, error: fail("jump-duplicate", t("同一条跳板链不能重复选择同一台服务器")) };
          seenJumpProfiles.add(hop.profileId);
          if (this.requireProfileTable().get(hop.profileId) === undefined) return { ok: false, error: fail("no-profile", `jump-host profile "${hop.profileId}" does not exist`) };
          continue;
        }
        if ((hop.authKind ?? "credential") !== "password" && this.requireCredentialTable().get(hop.credentialId) === undefined) return { ok: false, error: fail("no-credential", `jump-host credential "${hop.credentialId}" does not exist`) };
      }
      const record = {
        name: request.name.trim(),
        host: request.host.trim(),
        port: request.port ?? 22,
        username: request.username.trim(),
        authKind: request.authKind,
        hostKeyMode: request.hostKeyMode ?? DEFAULT_HOST_KEY_MODE,
        agentForward: request.agentForward === true,
        // An explicit null detaches a shared credential and restores the
        // server's legacy dedicated credential slot; only an omitted field
        // preserves old records for backwards-compatible callers.
        credentialId: Object.hasOwn(request, "credentialId") ? request.credentialId : (previous?.credentialId ?? null),
        defaultProjectPath,
        loginCommand,
        execPolicy: EXEC_POLICY_MODES.includes(execPolicy) ? execPolicy : null,
        proxyJump,
        groupId,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now
      };
      await table.put(profileId, record);
      // Remember this username as the new-server default:
      // no manual knob — the next empty form simply starts where the last save
      // ended. Best effort; a settings hiccup must not fail the save.
      try {
        this.defaultUsername = record.username;
        await this.patchSettingsRecord((previous) => ({ ...previous, defaultUsername: record.username }));
      } catch {}
      return {
        ok: true,
        value: {
          profile: await this.profilePublic(profileId, record),
          credentialRefs: { ...(record.credentialId ? sharedCredentialRefs(record.credentialId) : profileCredentialRefs(profileId)), proxyJumpPasswords: (record.proxyJump ?? []).map((_, index) => profileJumpPasswordRef(profileId, index)), proxyJumpPrivateKeys: (record.proxyJump ?? []).map((_, index) => profileJumpPrivateKeyRef(profileId, index)), proxyJumpPassphrases: (record.proxyJump ?? []).map((_, index) => profileJumpPassphraseRef(profileId, index)) }
        }
      };
    } catch (error) {
      return { ok: false, error: fail("profile-save-failed", error.message) };
    }
  }

  async profileDelete(request) {
    try {
      const table = this.requireProfileTable();
      const record = table.get(request.profileId);
      if (record === undefined) return { ok: true, value: { deleted: false } };
      const refs = profileCredentialRefs(request.profileId);
      // Only names derived from this resource id are ever removed. A live SSH
      // transport keeps running; deletion only forgets future quick-connect.
      await Promise.all([...Object.values(refs), ...Array.from({ length: 8 }, (_, index) => [profileJumpPasswordRef(request.profileId, index), profileJumpPrivateKeyRef(request.profileId, index), profileJumpPassphraseRef(request.profileId, index)]).flat()].map(async (ref) => await this.ctx.credentials.unset(credentialRef(ref))));
      await table.delete(request.profileId);
      // A remote-workspace binding without its resource is unmanageable: the
      // editor only lists bindings of an existing resource, so an orphan row
      // would linger forever. Deleting the resource deletes its bindings.
      if (this.remoteWorkspaces !== null) {
        try {
          for (const binding of this.remoteWorkspaces.list()) {
            if (binding.profileId === request.profileId) await this.remoteWorkspaces.remove(binding.workspacePath);
          }
        } catch {}
      }
      return { ok: true, value: { deleted: true } };
    } catch (error) {
      return { ok: false, error: fail("profile-delete-failed", error.message) };
    }
  }

  /**
   * Disconnect every live connection opened for a saved profile. The
   * resources page owns this path so a "已连接" badge always has a matching
   * operator control, including connections re-adopted after a page reload.
   */
  async profileDisconnect(request) {
    try {
      const targets = [...this.connections.values()].filter((connection) => connection.profileId === request.profileId);
      for (const record of targets) await this.disconnect({ connectionId: record.id });
      return { ok: true, value: { disconnected: targets.length } };
    } catch (error) {
      return { ok: false, error: fail("profile-disconnect-failed", error.message) };
    }
  }

  async profileConnect(request) {
    try {
      const record = this.requireProfileTable().get(request.profileId);
      if (record === undefined) return { ok: false, error: fail("no-profile", `SSH resource "${request.profileId}" does not exist`) };
      const reusable = findReusableProfileConnection([...this.connections.values()], request.profileId, {
        reuseExisting: request.reuseExisting,
        hasProxyJumpOverride: request.proxyJumpProfileIds?.length > 0
      });
      if (reusable) {
        const value = { connectionId: reusable.id, host: reusable.host, port: reusable.port, username: reusable.username };
        if (reusable.name !== undefined) value.name = reusable.name;
        return { ok: true, value };
      }
      const refs = record.credentialId ? sharedCredentialRefs(record.credentialId) : profileCredentialRefs(request.profileId);
      const targetAuth = await this.resolveCredentialAuth(refs, record.authKind);
      if (targetAuth === undefined) {
        return { ok: false, error: fail("credential-missing", `SSH resource "${record.name}" has no saved ${record.authKind === "password" ? "password" : "private key"}`) };
      }
      const proxyJump = [];
      const configuredHops = request.proxyJumpProfileIds?.map((profileId) => ({ profileId })) ?? record.proxyJump ?? [];
      const seenHops = new Set();
      for (const [index, hop] of configuredHops.entries()) {
        if (hop.profileId) {
          if (hop.profileId === request.profileId || seenHops.has(hop.profileId)) return { ok: false, error: fail("jump-cycle", t("跳板链不能包含当前服务器或重复服务器")) };
          seenHops.add(hop.profileId);
          const jump = this.requireProfileTable().get(hop.profileId);
          if (jump === undefined) return { ok: false, error: fail("no-profile", `jump-host profile "${hop.profileId}" does not exist`) };
          const jumpRefs = jump.credentialId ? sharedCredentialRefs(jump.credentialId) : profileCredentialRefs(hop.profileId);
          const auth = await this.resolveCredentialAuth(jumpRefs, jump.authKind);
          if (auth === undefined) return { ok: false, error: fail("credential-missing", `jump host "${jump.name}" has no saved credential`) };
          proxyJump.push({ host: jump.host, port: jump.port, username: jump.username, hostKeyMode: jump.hostKeyMode, auth });
          continue;
        }
        if ((hop.authKind ?? "credential") === "password") {
          const secret = await this.ctx.credentials.resolve(credentialRef(profileJumpPasswordRef(request.profileId, index)));
          if (secret === undefined) return { ok: false, error: fail("credential-missing", `jump host "${hop.host}" has no saved password`) };
          proxyJump.push({ host: hop.host, port: hop.port, username: hop.username, hostKeyMode: hop.hostKeyMode, auth: { kind: "password", password: secret.value } });
          continue;
        }
        if (hop.authKind === "key") {
          const privateKey = await this.ctx.credentials.resolve(credentialRef(profileJumpPrivateKeyRef(request.profileId, index)));
          if (privateKey === undefined) return { ok: false, error: fail("credential-missing", `jump host "${hop.host}" has no saved private key`) };
          const passphrase = await this.ctx.credentials.resolve(credentialRef(profileJumpPassphraseRef(request.profileId, index)));
          proxyJump.push({ host: hop.host, port: hop.port, username: hop.username, hostKeyMode: hop.hostKeyMode, auth: { kind: "key", privateKey: privateKey.value, ...(passphrase === undefined ? {} : { passphrase: passphrase.value }) } });
          continue;
        }
        const credential = this.requireCredentialTable().get(hop.credentialId);
        const hopRefs = sharedCredentialRefs(hop.credentialId);
        const auth = await this.resolveCredentialAuth(hopRefs, credential.authKind);
        if (auth === undefined) return { ok: false, error: fail("credential-missing", `jump host "${hop.host}" has no saved credential`) };
        proxyJump.push({ host: hop.host, port: hop.port, username: hop.username, hostKeyMode: hop.hostKeyMode, auth });
      }
      return await this.connectInternal({
        name: record.name,
        host: record.host,
        port: record.port,
        username: record.username,
        hostKeyMode: record.hostKeyMode,
        agentForward: record.agentForward === true,
        readyTimeout: request.readyTimeout,
        retries: request.retries,
        auth: targetAuth,
 ...(proxyJump.length > 0 ? { proxyJump } : {})
      }, request.profileId, { activate: request.activate !== false });
    } catch (error) {
      return { ok: false, error: fail("profile-connect-failed", error.message) };
    }
  }

  async groupList() {
    try {
      const groups = [...this.requireGroupTable().entries()]
 .map(([groupId, record]) => this.groupPublic(groupId, record))
 .sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN"));
      return { ok: true, value: { groups } };
    } catch (error) {
      return { ok: false, error: fail("group-list-failed", error.message) };
    }
  }

  async groupSave(request) {
    try {
      const table = this.requireGroupTable();
      const groupId = request.groupId ?? randomUUID();
      const previous = table.get(groupId);
      if (request.groupId !== undefined && previous === undefined) {
        return { ok: false, error: fail("no-group", `SSH group "${groupId}" does not exist`) };
      }
      const name = request.name.trim();
      if ([...table.entries()].some(([id, group]) => id !== groupId && group.name.localeCompare(name, "zh-Hans-CN", { sensitivity: "accent" }) === 0)) {
        return { ok: false, error: fail("duplicate-group", `SSH group "${name}" already exists`) };
      }
      const now = new Date().toISOString();
      const record = { name, createdAt: previous?.createdAt ?? now, updatedAt: now };
      await table.put(groupId, record);
      return { ok: true, value: { group: this.groupPublic(groupId, record) } };
    } catch (error) {
      return { ok: false, error: fail("group-save-failed", error.message) };
    }
  }

  async groupDelete(request) {
    try {
      const groups = this.requireGroupTable();
      if (groups.get(request.groupId) === undefined) return { ok: true, value: { deleted: false, movedProfiles: 0 } };
      const profiles = this.requireProfileTable();
      let movedProfiles = 0;
      for (const [profileId, profile] of profiles.entries()) {
        if (profile.groupId !== request.groupId) continue;
        movedProfiles += 1;
        await profiles.put(profileId, { ...profile, groupId: null, updatedAt: new Date().toISOString() });
      }
      await groups.delete(request.groupId);
      return { ok: true, value: { deleted: true, movedProfiles } };
    } catch (error) {
      return { ok: false, error: fail("group-delete-failed", error.message) };
    }
  }

  // ── known-hosts management (operator only; NOT exposed as agent tools) ────

  async listKnownHosts() {
    try {
      const hosts = this.knownHosts ? this.knownHosts.list() : [];
      return { ok: true, value: { hosts } };
    } catch (error) {
      return { ok: false, error: fail("known-hosts-list-failed", error.message) };
    }
  }

  async forgetHostKey(request) {
    try {
      if (this.knownHosts === null) {
        return { ok: false, error: fail("known-hosts-not-ready", "known-host storage is not ready") };
      }
      const forgotten = await this.knownHosts.forget(request.host, request.port);
      return { ok: true, value: { forgotten } };
    } catch (error) {
      return { ok: false, error: fail("forget-host-key-failed", error.message) };
    }
  }
};
