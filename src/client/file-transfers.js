/**
 * File-transfer registry, scoped to one connection.
 *
 * An upload or download has to outlive the pane that started it. HarborPanel
 * keys HarborFiles by connection id, so switching server tabs remounts the
 * pane and closing the last tab unmounts it; while the transfer list and its
 * AbortControllers lived in component state, that remount aborted every
 * running transfer — leaving a half-written file on the remote host and, for
 * an upload, no resume path at all. The registry is module-level: only an
 * explicit cancel stops a transfer.
 *
 * The name-conflict prompt lives here for the same reason. It needs an answer
 * from the operator, and a remount used to drop the pending promise: the
 * upload then waited forever while holding the pane's upload slot. Kept in the
 * registry, the dialog simply reappears when the tab does.
 */

const MAX_TASKS = 50;
const registry = new Map();
let nextTaskId = 0;

function entryFor(connectionId) {
  let entry = registry.get(connectionId);
  if (entry === undefined) {
    entry = {
      tasks: [],
      controllers: new Map(),
      upload: null,
      conflict: null,
      snapshot: null,
      listeners: new Set()
    };
    registry.set(connectionId, entry);
  }
  return entry;
}

/** Publish a change: the next getSnapshot() builds a fresh object and notifies. */
function commit(entry) {
  entry.snapshot = null;
  for (const listener of entry.listeners) listener();
}

/**
 * Read one connection's transfer state.
 * @param {string} connectionId - the SSH connection the transfers belong to.
 * @returns {{tasks: Array<object>, uploading: boolean, conflict: object|null}}
 *   stable between changes, so it can be a useSyncExternalStore snapshot.
 */
export function getFileTransfers(connectionId) {
  const entry = entryFor(connectionId);
  if (entry.snapshot === null) {
    entry.snapshot = { tasks: entry.tasks, uploading: entry.upload !== null, conflict: entry.conflict };
  }
  return entry.snapshot;
}

/**
 * Subscribe to one connection's transfer state.
 * @returns {() => void} unsubscribe.
 */
export function subscribeFileTransfers(connectionId, listener) {
  const entry = entryFor(connectionId);
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
    pruneEntry(connectionId, entry);
  };
}

/**
 * Forget a connection's entry once nothing in it can still be observed.
 *
 * The registry is module-level and keyed by connection id; without this every
 * server the operator ever opened left an entry (up to MAX_TASKS finished
 * task objects, its controllers map and its snapshot) behind for the life of
 * the page. An entry with a running transfer, a pending conflict prompt or a
 * live subscription stays. */
function pruneEntry(connectionId, entry) {
  if (entry.listeners.size > 0 || entry.tasks.length > 0 || entry.controllers.size > 0) return;
  if (entry.upload !== null || entry.conflict !== null) return;
  if (registry.get(connectionId) === entry) registry.delete(connectionId);
}

/**
 * Add a transfer to the list and return its task id. Every running task is
 * kept; finished ones are capped so a long batch cannot grow the list forever.
 */
export function beginFileTask(connectionId, task) {
  const entry = entryFor(connectionId);
  const id = ++nextTaskId;
  const tasks = [{ ...task, id }, ...entry.tasks];
  // Cap the list without ever dropping work that is still running: every
  // running transfer survives, and the newest finished ones fill the rest.
  const running = tasks.filter((item) => item.status === "running");
  const budget = Math.max(MAX_TASKS - running.length, 0);
  const keep = new Set([...running, ...tasks.filter((item) => item.status !== "running").slice(0, budget)]);
  entry.tasks = tasks.filter((item) => keep.has(item));
  commit(entry);
  return id;
}

/** Merge a patch into one task; unknown ids are ignored. */
export function updateFileTask(connectionId, id, patch) {
  const entry = entryFor(connectionId);
  let found = false;
  entry.tasks = entry.tasks.map((item) => {
    if (item.id !== id) return item;
    found = true;
    return { ...item, ...patch };
  });
  if (found) commit(entry);
}

/** Drop the finished transfers, keeping everything still running. */
export function clearFinishedFileTasks(connectionId) {
  const entry = entryFor(connectionId);
  const running = entry.tasks.filter((item) => item.status === "running");
  if (running.length === entry.tasks.length) return;
  entry.tasks = running;
  commit(entry);
}

/** Make a task cancellable from the task list (or from anywhere). */
export function attachFileController(connectionId, id, controller) {
  entryFor(connectionId).controllers.set(id, controller);
}

/** Forget a task's controller once it settled. */
export function releaseFileController(connectionId, id) {
  entryFor(connectionId).controllers.delete(id);
}

/** Abort one transfer; a no-op once it settled. */
export function cancelFileTask(connectionId, id) {
  entryFor(connectionId).controllers.get(id)?.abort();
}

/**
 * Claim the connection's single upload slot.
 * @returns {boolean} false when an upload already owns the slot.
 */
export function beginFileUpload(connectionId, controller) {
  const entry = entryFor(connectionId);
  if (entry.upload !== null) return false;
  entry.upload = controller;
  commit(entry);
  return true;
}

/** Release the upload slot (only if this call still owns it). */
export function endFileUpload(connectionId, controller) {
  const entry = entryFor(connectionId);
  if (entry.upload !== controller) return;
  entry.upload = null;
  commit(entry);
}

/** Show the overwrite/rename/skip prompt for one connection. */
export function setFileUploadConflict(connectionId, conflict) {
  const entry = entryFor(connectionId);
  entry.conflict = conflict;
  commit(entry);
}

/** Close the conflict prompt. */
export function clearFileUploadConflict(connectionId) {
  const entry = entryFor(connectionId);
  if (entry.conflict === null) return;
  entry.conflict = null;
  commit(entry);
}