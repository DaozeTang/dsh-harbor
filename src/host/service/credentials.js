/**
 * Shared credential records and their dual-factor auth assembly.
 */
import { randomUUID } from "node:crypto";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { fail } from "../envelope.js";
import { t } from "../../i18n/core.js";
import { sharedCredentialRefs } from "./models.js";

/**
 * Assemble the wire `auth` object from a primary factor plus an optional
 * opposite-kind secondary factor (dual-factor devices such as firewalls or
 * switches configured with `AuthenticationMethods password,publickey`, or
 * the reverse, require both factors on the SAME connection). For a password
 * primary the secondary is a key and takes the shared passphrase slot; for a
 * key primary the secondary is a plain password.
 */
function assembleAuth(authKind, primaryValue, { secondaryValue, passphraseValue, secondaryPassphraseValue } = {}) {
  const primary = authKind === "password"
    ? { kind: "password", password: primaryValue }
 : { kind: "key", privateKey: primaryValue, ...(passphraseValue === undefined ? {} : { passphrase: passphraseValue }) };
  if (secondaryValue === undefined) return primary;
  const secondary = authKind === "password"
    ? { kind: "key", privateKey: secondaryValue, ...(secondaryPassphraseValue === undefined ? {} : { passphrase: secondaryPassphraseValue }) }
 : { kind: "password", password: secondaryValue };
  return { ...primary, secondary };
}

export const withCredentials = (Base) => class extends Base {
  /**
   * Resolve a credential's primary factor plus its optional opposite-kind
   * secondary (dual-factor auth) from a refs triple. The passphrase slot is
   * shared: it holds the primary key's passphrase for key-primary records
   * and the secondary key's passphrase for password-primary records. The
   * secondary is optional — an unconfigured slot yields a single-factor auth.
   */
  async resolveCredentialAuth(refs, authKind) {
    const primary = await this.ctx.credentials.resolve(credentialRef(authKind === "password" ? refs.password : refs.privateKey));
    if (primary === undefined) return undefined;
    const passphrase = authKind === "key"
      ? await this.ctx.credentials.resolve(credentialRef(refs.passphrase))
 : undefined;
    const secondary = await this.ctx.credentials.resolve(credentialRef(authKind === "password" ? refs.privateKey : refs.password));
    const secondaryPassphrase = authKind === "password"
      ? await this.ctx.credentials.resolve(credentialRef(refs.passphrase))
 : undefined;
    return assembleAuth(authKind, primary.value, {
      passphraseValue: passphrase?.value,
      secondaryValue: secondary?.value,
      secondaryPassphraseValue: secondaryPassphrase?.value
    });
  }

  requireCredentialTable() {
    if (this.credentialTable === null) throw new Error("SSH credential storage is not ready");
    return this.credentialTable;
  }

  async credentialPublic(credentialId, record) {
    const refs = sharedCredentialRefs(credentialId);
    const primaryRef = record.authKind === "password" ? refs.password : refs.privateKey;
    const secondaryRef = record.authKind === "password" ? refs.privateKey : refs.password;
    const [primary, passphrase, secondary] = await Promise.all([
      this.ctx.credentials.describe(credentialRef(primaryRef)),
      this.ctx.credentials.describe(credentialRef(refs.passphrase)),
      this.ctx.credentials.describe(credentialRef(secondaryRef))
    ]);
    return { credentialId, name: record.name, authKind: record.authKind, credentialConfigured: primary.configured, passphraseConfigured: passphrase.configured, secondaryConfigured: secondary.configured };
  }

  async credentialList() {
    try {
      const credentials = await Promise.all([...this.requireCredentialTable().entries()].map(async ([id, record]) => await this.credentialPublic(id, record)));
      credentials.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
      return { ok: true, value: { credentials } };
    } catch (error) { return { ok: false, error: fail("credential-list-failed", error.message) }; }
  }

  async credentialSave(request) {
    try {
      const table = this.requireCredentialTable();
      const credentialId = request.credentialId ?? randomUUID();
      const previous = table.get(credentialId);
      if (request.credentialId !== undefined && previous === undefined) return { ok: false, error: fail("no-credential", `SSH credential "${credentialId}" does not exist`) };
      const now = new Date().toISOString();
      const record = { name: request.name.trim(), authKind: request.authKind, createdAt: previous?.createdAt ?? now, updatedAt: now };
      await table.put(credentialId, record);
      return { ok: true, value: { credential: await this.credentialPublic(credentialId, record), credentialRefs: sharedCredentialRefs(credentialId) } };
    } catch (error) { return { ok: false, error: fail("credential-save-failed", error.message) }; }
  }

  async credentialDelete(request) {
    try {
      const table = this.requireCredentialTable();
      if (table.get(request.credentialId) === undefined) return { ok: true, value: { deleted: false } };
      const usedBy = [...this.requireProfileTable().entries()].find(([, profile]) => profile.credentialId === request.credentialId || profile.proxyJump?.some((hop) => hop.credentialId === request.credentialId));
      if (usedBy) return { ok: false, error: fail("credential-in-use", t("此凭据仍被 SSH 资源或跳板机引用；请先改用其他凭据")) };
      await Promise.all(Object.values(sharedCredentialRefs(request.credentialId)).map(async (ref) => await this.ctx.credentials.unset(credentialRef(ref))));
      await table.delete(request.credentialId);
      return { ok: true, value: { deleted: true } };
    } catch (error) { return { ok: false, error: fail("credential-delete-failed", error.message) }; }
  }
};
