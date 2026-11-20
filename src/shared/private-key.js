/**
 * Private-key sniffing shared by the browser form and the host-side OpenSSH
 * importer.
 *
 * Both faces must agree on what "encrypted" means: the form gates a pasted key
 * before saving it, and the host decides whether an IdentityFile it is about to
 * copy into the credential store needs a passphrase. Keeping the check here
 * avoids two heuristics drifting apart. Pure JavaScript (atob only, no Node
 * Buffer, no DOM): the host bundle and the browser bundle both import it.
 */

/**
 * Whether a private key is passphrase-protected. OpenSSH-format keys carry the
 * cipher name inside the base64 body ("none" when unencrypted), so decode the
 * header chunk and read it; classic PEM signals encryption with a
 * "Proc-Type: 4,ENCRYPTED" header, PKCS#8 with its BEGIN line. False negatives
 * are acceptable (connect-time diagnosis catches those later); false positives
 * are not (they would block a working key).
 */
export function isEncryptedPrivateKey(secret) {
  const key = (secret ?? "").trim();
  if (!key.startsWith("-----BEGIN")) return false;
  if (key.startsWith("-----BEGIN ENCRYPTED PRIVATE KEY-----")) return true;
  if (/^-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----[\s\S]{0,200}Proc-Type:\s*4,\s*ENCRYPTED/i.test(key)) return true;
  if (!key.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----")) return false;
  const base64 = key.slice("-----BEGIN OPENSSH PRIVATE KEY-----".length).replace(/-----[\s\S]*$/, "").replace(/\s+/g, "");
  let head;
  try { head = atob(base64.slice(0, 96)); } catch { return false; }
  if (!head.startsWith("openssh-key-v1\u0000")) return false;
  const cipherLength = (head.charCodeAt(15) << 24 | head.charCodeAt(16) << 16 | head.charCodeAt(17) << 8 | head.charCodeAt(18)) >>> 0;
  if (cipherLength === 0 || cipherLength > 32) return false;
  return head.slice(19, 19 + cipherLength) !== "none";
}
