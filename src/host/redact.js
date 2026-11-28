/** Keep credentials out of model-visible SSH tool results. */

/**
 * Name fragments that carry a secret. They are matched INSIDE a longer
 * identifier, which is exactly what `\b` cannot do: `_` is a word character,
 * so `MYSQL_ROOT_PASSWORD=` never satisfied a word boundary and slipped
 * through untouched.
 */
const SECRET_TOKEN = "SECRET|PASSWORD|PASSWD|PASSPHRASE|TOKEN|PRIVATE[_-]?KEY|API[_-]?KEY|ACCESS[_-]?KEY|SIGNING[_-]?KEY|CREDENTIALS?";

/**
 * One credential name: `TOKEN`, `MYSQL_ROOT_PASSWORD`, `s3.secret-key`,
 * `X-Auth-Token`, `AWS_SECRET_ACCESS_KEY`.
 *
 * Both ends of the token must be an identifier boundary of their own (`_`,
 * `.`, `-`, or the ends of the name), so camelCase code (`getSecret()`) and
 * lookalike settings (`TOKENIZERS_PARALLELISM`) keep their text instead of
 * being rewritten into `***` on every render. The quantifiers are bounded so a
 * long line of separators cannot make this pattern backtrack.
 */
const SECRET_NAME = `(?:^|[^A-Za-z0-9_.-])(?:[A-Za-z0-9]{0,64}[_.-]){0,8}(?:${SECRET_TOKEN})(?:[_.-][A-Za-z0-9_.-]{0,64})?`;

/**
 * One value: double- or single-quoted (also unterminated, e.g. a log line
 * truncated mid-secret) or one bare word.
 */
const SECRET_VALUE = `(?:"[^"\\r\\n]*(?:"|(?=\\r|\\n|$))|'[^'\\r\\n]*(?:'|(?=\\r|\\n|$))|[^\\s'"]+)`;

const RULES = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gi, "*** private key redacted ***"],
  [/(authorization\s*[:=]\s*bearer\s+)\S+/gi, "$1***"],
  // sshpass takes its password as a bare flag value, so there is no `NAME=`
  // pair for the rule below to anchor on.
  [/(\bsshpass\b[^\r\n]*?(?:-p|--password)(?:=|\s+|))(\S+)/gi, "$1***"],
  [new RegExp(`(${SECRET_NAME})\\s*[=:]\\s*${SECRET_VALUE}`, "gi"), "$1=***"],
  [/(mysql|postgres(?:ql)?|redis):\/\/[^\s:@/]+:[^@\s/]+(?:@|(?=\s|\/|$))/gi, "$1://***@"],
  [/\bsk-[A-Za-z0-9_-]{12,}\b/g, "sk-***"]
];

export function redactForModel(text) {
  let value = String(text ?? "");
  let redacted = false;
  for (const [pattern, replacement] of RULES) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) redacted = true;
    pattern.lastIndex = 0;
    value = value.replace(pattern, replacement);
  }
  return { text: value, redacted };
}
