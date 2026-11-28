/**
 * POSIX single-quote escaping.
 *
 * Lives in shared/ because both halves quote shell arguments: the host builds
 * remote commands, and the snippets feature previews the same commands in the
 * browser. Importing the host's safety module from client code would drag the
 * policy engine into the browser bundle.
 */
export function shellQuote(arg) {
  const text = typeof arg === "string" ? arg : String(arg ?? "");
  return `'${text.replace(/'/g, "'\\''")}'`;
}
