/**
 * Path string helpers for the remote file browser.
 *
 * Plain arithmetic over "/"-rooted POSIX paths: the pane never runs a shell,
 * so these stay testable without a connection, a DOM or a host.
 */

export function joinPath(base, name) {
  if (base === "/") return `/${name}`;
  return `${base.replace(/\/+$/, "")}/${name}`;
}

export function dirnameOf(path) {
  if (path === "/") return "/";
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return "/";
  return path.slice(0, idx);
}

/** The last segment of a path, for chips that must stay narrow. */
export function basenameOf(path) {
  const trimmed = String(path).replace(/\/+$/, "");
  if (trimmed === "") return "/";
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** Every ancestor of a path, as breadcrumb steps from "/" to the path itself. */
export function crumbsOf(path) {
  const steps = [{ label: "/", path: "/" }];
  let current = "";
  for (const part of String(path).split("/").filter(Boolean)) {
    current += `/${part}`;
    steps.push({ label: part, path: current });
  }
  return steps;
}

export function nextUploadName(name, entries) {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  let index = 1;
  while (entries.has(`${stem} (${index})${extension}`)) index++;
  return `${stem} (${index})${extension}`;
}
