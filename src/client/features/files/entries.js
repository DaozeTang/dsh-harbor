/**
 * Pure directory-entry formatting: ls(1)'s first column and the file
 * manager's order, kept free of React so the listing can be reasoned about
 * on its own.
 */

/** ls(1)'s first column: the entry type plus the mode, including setuid/sticky. */
export function modeString(mode) {
  if (typeof mode !== "number" || mode === 0) return "—";
  const kinds = { 0o040000: "d", 0o120000: "l", 0o020000: "c", 0o060000: "b", 0o010000: "p", 0o140000: "s" };
  const masks = [0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001];
  const letters = ["r", "w", "x", "r", "w", "x", "r", "w", "x"];
  const chars = masks.map((mask, index) => (mode & mask ? letters[index] : "-"));
  // setuid/setgid/sticky replace the execute glyph they shadow, the way ls(1)
  // prints them; without this /tmp reads as plain world-writable and hides its
  // sticky bit, which is exactly the bit an operator looks for.
  const special = [0o4000, 0o2000, 0o1000];
  const marks = ["s", "s", "t"];
  special.forEach((mask, index) => {
    if ((mode & mask) === 0) return;
    const at = index * 3 + 2;
    chars[at] = chars[at] === "x" ? marks[index] : marks[index].toUpperCase();
  });
  return (kinds[mode & 0o170000] ?? "-") + chars.join("");
}

/** Directories first, then names in natural order — the order a file manager shows. */
export function compareEntries(left, right) {
  if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
}
