/**
 * Remote file browser.
 *
 * One pane for the connected server's filesystem: a path bar (up, breadcrumbs,
 * pin, more), one action row (upload, new folder, refresh, search, filter), the
 * listing under them, and every mutation — upload, download, rename, delete,
 * edit — as an operation with visible progress.
 *
 * Filesystem policy lives in the sibling modules (file-editor.js,
 * sftp-favorites.js, remote-file-search.js, download-checkpoints.js) so the
 * decisions stay testable without a DOM; this file is only the surface.
 *
 * Deliberate behaviour that looks surprising:
 * - SFTP is the file manager. Only a failure to OPEN the subsystem falls back
 *   to the SCP pane: a permission or path error must stay visible as an SFTP
 *   error instead of silently changing what the transfer buttons do.
 * - A restartable download is staged in browser-private storage and committed
 *   to the chosen destination only after its checksum matches, so an
 *   interrupted transfer never leaves a half-written file in the user's folder.
 */
import * as React from "react";
import {
  Badge, Button, Card, Checkbox, Dialog, EmptyState, ErrorNote, Field, Icon, IconButton, InputGroup, Menu,
  MenuItem, MenuLabel, MenuSeparator, Notice, Pill, ProgressBar, Section, Spinner, TextArea, TextInput, confirmAction
} from "./ui/kit.jsx";
import { MAX_EDITABLE_BYTES, changedLineRegions, decodeEditableText, encodeEditableText, filterEntries } from "./file-editor.js";
import { favoritesKey, readFavorites, toggleFavorite, writeFavorites } from "./sftp-favorites.js";
import { searchRemoteFiles } from "./remote-file-search.js";
import { streamDownload } from "./stream-download.js";
import {
  checkpointDestination, checkpointFile, createDownloadCheckpoint, deleteDownloadCheckpoint,
  listDownloadCheckpoints, withDownloadLock
} from "./download-checkpoints.js";
import { installSurfaceStyles } from "./ui/styles.js";
import { t } from "../i18n/core.js";
import CSS from "./features/files/files.css";

const { Fragment, useEffect, useRef, useState } = React;

installSurfaceStyles("files", CSS);

function joinPath(base, name) {
  if (base === "/") return `/${name}`;
  return `${base.replace(/\/+$/, "")}/${name}`;
}

function dirnameOf(path) {
  if (path === "/") return "/";
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return "/";
  return path.slice(0, idx);
}

/** The last segment of a path, for chips that must stay narrow. */
function basenameOf(path) {
  const trimmed = String(path).replace(/\/+$/, "");
  if (trimmed === "") return "/";
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** Every ancestor of a path, as breadcrumb steps from "/" to the path itself. */
function crumbsOf(path) {
  const steps = [{ label: "/", path: "/" }];
  let current = "";
  for (const part of String(path).split("/").filter(Boolean)) {
    current += `/${part}`;
    steps.push({ label: part, path: current });
  }
  return steps;
}

function nextUploadName(name, entries) {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  let index = 1;
  while (entries.has(`${stem} (${index})${extension}`)) index++;
  return `${stem} (${index})${extension}`;
}

/** ls(1)'s first column: the entry type plus the mode, including setuid/sticky. */
function modeString(mode) {
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

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Compact modification time. The current year keeps the row narrow; an older
 * entry needs its year, so the date wins over the time of day there.
 */
function formatTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const value = new Date(ms);
  const pad = (part) => String(part).padStart(2, "0");
  if (value.getFullYear() !== new Date().getFullYear()) {
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return `${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

/** Directories first, then names in natural order — the order a file manager shows. */
function compareEntries(left, right) {
  if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
}

export function HarborFiles({ api, connectionId, onCd, initialPath = "/" }) {
  const [cwd, setCwd] = useState("/");
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(null);
  const [listError, setListError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameTo, setRenameTo] = useState("");
  const [transferMode, setTransferMode] = useState("sftp");
  const [scpReason, setScpReason] = useState("");
  const [scpUploadFile, setScpUploadFile] = useState(null);
  const [scpUploadPath, setScpUploadPath] = useState("");
  const [scpDownloadPath, setScpDownloadPath] = useState("");
  const [filter, setFilter] = useState("");
  const [favorites, setFavorites] = useState([]);
  const [favoritesStorageKey, setFavoritesStorageKey] = useState(null);
  const favoritesKeyRef = useRef(favoritesStorageKey);
  favoritesKeyRef.current = favoritesStorageKey;
  const [editing, setEditing] = useState(null);
  const [previewChanges, setPreviewChanges] = useState(false);
  const connectionRef = useRef(connectionId);
  connectionRef.current = connectionId;
  const [editorBusy, setEditorBusy] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [tasks, setTasks] = useState([]);
  const [agentTasks, setAgentTasks] = useState([]);
  const [persistDownloads, setPersistDownloads] = useState(false);
  const [checkpoints, setCheckpoints] = useState([]);
  const taskId = useRef(0);
  const controllers = useRef(new Map());
  const uploadController = useRef(null);
  const [uploadConflict, setUploadConflict] = useState(null);
  const [conflictApplyAll, setConflictApplyAll] = useState(false);
  const searchController = useRef(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchState, setSearchState] = useState(null);
  const [rowMenu, setRowMenu] = useState(null);
  const rowMenuAnchor = useRef(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreAnchorRef = useRef(null);
  const fileInputRef = useRef(null);
  const dirInputRef = useRef(null);
  const scpFileInputRef = useRef(null);

  const updateTask = (id, patch) => setTasks((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));
  const addTask = (task) => {
    const id = ++taskId.current;
    setTasks((items) => [{ ...task, id }, ...items.filter((item, index) => item.status === "running" || index < 49)]);
    return id;
  };
  useEffect(() => () => {
    searchController.current?.abort();
    for (const controller of controllers.current.values()) controller.abort();
  }, []);
  useEffect(() => () => uploadController.current?.abort(), [connectionId]);
  useEffect(() => {
    searchController.current?.abort();
    searchController.current = null;
    setSearchState(null);
  }, [connectionId]);
  useEffect(() => {
    let active = true;
    setAgentTasks([]);
    if (!connectionId || typeof api.sftpTransferList !== "function") return () => { active = false; };
    const refresh = async () => {
      try {
        const result = await api.sftpTransferList(connectionId);
        if (active) setAgentTasks(result.transfers ?? []);
      } catch {
        // Older hosts may not expose the registry.
      }
    };
    void refresh();
    const timer = setInterval(refresh, 1500);
    return () => { active = false; clearInterval(timer); };
  }, [api, connectionId]);

  const refreshCheckpoints = async (identity = favoritesStorageKey) => {
    if (!identity) return;
    try {
      const items = await listDownloadCheckpoints(identity);
      if (favoritesKeyRef.current === identity) setCheckpoints(items);
    } catch {
      if (favoritesKeyRef.current === identity) setCheckpoints([]);
    }
  };
  useEffect(() => { setCheckpoints([]); void refreshCheckpoints(favoritesStorageKey); }, [favoritesStorageKey]);

  const fetchVerifiedDownload = async (query, task, signal) => {
    const id = globalThis.crypto?.randomUUID?.();
    if (!id) return fetch(`/harbor/stream/file?${query}`, { signal });
    query.set("verificationId", id);
    const status = new URLSearchParams({ connectionId: query.get("connectionId"), id });
    const pollController = new AbortController();
    let pending = false;
    updateTask(task, { verification: null });
    const timer = setInterval(async () => {
      if (pending) return;
      pending = true;
      try {
        const response = await fetch(`/harbor/stream/verification?${status}`, { signal: pollController.signal });
        if (!response.ok) return;
        const verification = await response.json();
        if (!pollController.signal.aborted) updateTask(task, { verification });
      } catch {
        // The progress endpoint is optional for the download.
      } finally {
        pending = false;
      }
    }, 400);
    try {
      return await fetch(`/harbor/stream/file?${query}`, { signal });
    } finally {
      clearInterval(timer);
      pollController.abort();
    }
  };

  const resumeCheckpoint = async (checkpoint) => {
    if (typeof globalThis.showSaveFilePicker !== "function") return;
    let destination;
    try {
      destination = await globalThis.showSaveFilePicker({ suggestedName: checkpoint.path.split("/").pop() || "download" });
    } catch (err) {
      if (err?.name !== "AbortError") setError(err?.message ?? String(err));
      return;
    }
    const controller = new AbortController();
    const task = addTask({ name: checkpoint.path.split("/").pop(), kind: "download", status: "running", sent: checkpoint.offset, total: checkpoint.total, cancellable: true, resuming: true });
    controllers.current.set(task, controller);
    try {
      await withDownloadLock(checkpoint.id, async () => {
        const prefix = await checkpointFile(checkpoint.id);
        const makeRequest = async (offset, expectedSha256) => {
          updateTask(task, { resuming: true, speed: 0 });
          const query = new URLSearchParams({ connectionId, path: checkpoint.path, verify: "sha256", offset: String(offset), expectedSha256 });
          const response = await fetchVerifiedDownload(query, task, controller.signal);
          updateTask(task, { resuming: false });
          return response;
        };
        const response = await makeRequest(prefix.size, checkpoint.digest);
        if (!response.ok || response.headers.get("x-content-sha256") !== checkpoint.digest) {
          await response.body?.cancel().catch(() => {});
          throw new Error(t("远程文件已变化或无法续传"));
        }
        updateTask(task, { resuming: false });
        const startedAt = Date.now();
        await streamDownload(response, checkpointDestination(checkpoint.id, destination, controller.signal, checkpoint.digest), controller.signal, (sent, total) => {
          const elapsed = Math.max((Date.now() - startedAt) / 1000, 0.001);
          updateTask(task, { sent, total, speed: (sent - prefix.size) / elapsed });
        }, makeRequest, prefix);
      });
      updateTask(task, { status: "done" });
    } catch (err) {
      const cancelled = controller.signal.aborted || err?.name === "AbortError";
      updateTask(task, { status: cancelled ? "cancelled" : "failed", error: cancelled ? "" : (err?.message ?? String(err)) });
      if (!cancelled) setError(err?.message ?? String(err));
    } finally {
      controllers.current.delete(task);
      void refreshCheckpoints();
    }
  };

  const runSearch = async () => {
    if (!searchQuery.trim()) return;
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    const root = cwd;
    setSearchState({ running: true, root, results: [], errors: [] });
    const result = await searchRemoteFiles((path) => api.sftpList(connectionId, path), root, searchQuery.trim(), { signal: controller.signal });
    if (searchController.current === controller) setSearchState({ ...result, root, running: false });
  };
  // Monotonic sequence: only the latest issued directory listing may commit
  // state, so a slow earlier response cannot overwrite a newer directory.
  const loadSeq = useRef(0);
  // Mirror of cwd for post-operation refreshes: a mutation that finishes after
  // the user navigated elsewhere must refresh the NEW directory, not snap back.
  const cwdRef = useRef("/");
  // The path the newest listing asked for, so a failure can be retried where it
  // happened instead of reloading whichever directory is still current.
  const requestedRef = useRef(initialPath);

  // Favorites are stored per server: the runtime connection id changes every
  // session, so resolve the stable host/port/username key once here.
  useEffect(() => {
    let cancelled = false;
    setFavoritesStorageKey(null);
    (async () => {
      try {
        const value = await api.list();
        if (cancelled) return;
        const connection = (value?.connections ?? []).find((item) => item.connectionId === connectionId);
        const key = favoritesKey(connection);
        setFavoritesStorageKey(key);
        setFavorites(readFavorites(globalThis.localStorage, key));
      } catch {
        // Favorites are cosmetic: a failed lookup simply shows none.
      }
    })();
    return () => { cancelled = true; };
  }, [api, connectionId]);

  const load = async (path, { preserveError = false } = {}) => {
    const seq = ++loadSeq.current;
    requestedRef.current = path;
    setBusy(true);
    setListError(null);
    if (!preserveError) setError(null);
    setSelected(null);
    try {
      const value = await api.sftpList(connectionId, path);
      if (seq !== loadSeq.current) return;
      setEntries(Array.isArray(value?.entries) ? value.entries : []);
      setCwd(value?.path || path);
      cwdRef.current = value?.path || path;
    } catch (err) {
      if (seq !== loadSeq.current) return;
      // SFTP is the normal file manager. Only failure to OPEN its subsystem
      // merits SCP fallback; permission and path errors stay visible as SFTP
      // errors instead of silently changing transfer semantics.
      if (path === "/" && err?.code === "sftp-failed") {
        setTransferMode("scp");
        setScpReason(err.message ?? t("SFTP 子系统不可用"));
        setEntries(null);
        return;
      }
      setListError(err?.message ?? String(err));
      setEntries([]);
    } finally {
      if (seq === loadSeq.current) setBusy(false);
    }
  };

  useEffect(() => {
    setTransferMode("sftp");
    setScpReason("");
    setScpUploadFile(null);
    setScpUploadPath("");
    setScpDownloadPath("");
    if (connectionId) load(initialPath);
  }, [connectionId, initialPath]);

  const goUp = () => {
    if (cwd !== "/") load(dirnameOf(cwd));
  };

  const openEntry = (entry) => {
    if (entry.isDirectory) load(joinPath(cwd, entry.name));
  };

  const download = async (entry) => {
    const target = entry || selected;
    if (!target) return;
    if (typeof globalThis.showSaveFilePicker === "function") {
      let handle;
      try {
        handle = await globalThis.showSaveFilePicker({ suggestedName: target.name });
      } catch (err) {
        if (err?.name !== "AbortError") setError(err?.message ?? String(err));
        return;
      }
      const controller = new AbortController();
      const task = addTask({ name: target.name, kind: "download", status: "running", sent: 0, total: target.size, cancellable: true, verifying: true });
      controllers.current.set(task, controller);
      setError(null);
      try {
        const query = new URLSearchParams({ connectionId, path: joinPath(cwd, target.name), verify: "sha256" });
        const response = await fetchVerifiedDownload(query, task, controller.signal);
        const startedAt = Date.now();
        updateTask(task, { verifying: false });
        let destination = handle;
        let checkpoint;
        if (persistDownloads) {
          const digest = response.headers.get("x-content-sha256");
          const totalHeader = response.headers.get("x-file-size");
          const total = Number(totalHeader);
          if (!response.ok || !favoritesStorageKey || !/^[0-9a-f]{64}$/.test(digest ?? "") || !totalHeader || !/^\d+$/.test(totalHeader) || !Number.isSafeInteger(total) || total < 0) {
            await response.body?.cancel().catch(() => {});
            throw new Error(t("无法创建可恢复的下载任务"));
          }
          checkpoint = await createDownloadCheckpoint({ identity: favoritesStorageKey, path: joinPath(cwd, target.name), digest, total });
          destination = checkpointDestination(checkpoint.id, handle, controller.signal, checkpoint.digest);
        }
        const perform = () => streamDownload(response, destination, controller.signal, (sent, total) => {
          const elapsed = Math.max((Date.now() - startedAt) / 1000, 0.001);
          updateTask(task, { sent, total, speed: sent / elapsed });
        }, async (offset, expectedSha256) => {
          updateTask(task, { verifying: true, resuming: true });
          const next = new URLSearchParams({ connectionId, path: joinPath(cwd, target.name), verify: "sha256", offset: String(offset), expectedSha256 });
          const resumed = await fetchVerifiedDownload(next, task, controller.signal);
          updateTask(task, { verifying: false, resuming: false });
          return resumed;
        });
        if (checkpoint) await withDownloadLock(checkpoint.id, perform);
        else await perform();
        updateTask(task, { status: "done" });
      } catch (err) {
        const cancelled = controller.signal.aborted || err?.name === "AbortError";
        updateTask(task, { status: cancelled ? "cancelled" : "failed", error: cancelled ? "" : (err?.message ?? String(err)) });
        if (!cancelled) setError(err?.message ?? String(err));
      } finally {
        controllers.current.delete(task);
        void refreshCheckpoints();
      }
      return;
    }
    setBusy(true);
    setError(null);
    const task = addTask({ name: target.name, kind: "download", status: "running" });
    try {
      const value = await api.sftpReadFile(connectionId, joinPath(cwd, target.name));
      if (value.truncated) {
        throw new Error(t(`文件超过读取上限（${value.bytes} 字节），未下载`));
      }
      const blob = new Blob([value.data], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = target.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      updateTask(task, { status: "done" });
    } catch (err) {
      updateTask(task, { status: "failed", error: err?.message ?? String(err) });
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const upload = async (fileList) => {
    const files = Array.isArray(fileList) ? fileList : [fileList];
    if (!connectionId || files.length === 0 || uploadController.current) return;
    setBusy(true);
    setError(null);
    const controller = new AbortController();
    uploadController.current = controller;
    const { signal } = controller;
    let total = files.reduce((sum, file) => sum + file.size, 0);
    const task = addTask({ name: files.length === 1 ? files[0].name : t(`${files.length} 个文件`), kind: "upload", status: "running", sent: 0, total, cancellable: true });
    controllers.current.set(task, controller);
    let completedBytes = 0;
    let skipped = 0;
    let changed = false;
    let batchChoice;
    const directories = new Map();
    const list = async (path, refresh = false) => {
      signal.throwIfAborted();
      if (refresh || !directories.has(path)) {
        const { entries: listed } = await api.sftpList(connectionId, path);
        directories.set(path, new Map(listed.map((entry) => [entry.name, entry])));
      }
      signal.throwIfAborted();
      return directories.get(path);
    };
    const choose = async (path, canOverwrite, moreFiles) => {
      if (batchChoice && (batchChoice !== "overwrite" || canOverwrite)) return batchChoice;
      signal.throwIfAborted();
      return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        setConflictApplyAll(false);
        setUploadConflict({
          path, canOverwrite, moreFiles,
          cancel: () => controller.abort(),
          choose: (choice, applyAll) => {
            signal.removeEventListener("abort", abort);
            if (applyAll) batchChoice = choice;
            setUploadConflict(null);
            resolve(choice);
          }
        });
      });
    };
    try {
      for (const [index, file] of files.entries()) {
        const parts = (file.webkitRelativePath || file.name).split("/");
        if (parts.some((part) => !part || part === "." || part === ".." || /[\\\x00]/.test(part))) {
          throw new Error(t("上传文件路径无效"));
        }
        const originalName = parts.pop();
        let dir = cwd;
        for (const part of parts) {
          const items = await list(dir);
          const next = joinPath(dir, part);
          const existing = items.get(part);
          if (existing && (!existing.isDirectory || (existing.mode & 0o170000) === 0o120000)) {
            throw new Error(t(`无法合并目录：${next} 已存在且不是普通目录`));
          }
          if (!existing) {
            await api.sftpMkdir(connectionId, next);
            changed = true;
            items.set(part, { isDirectory: true });
          }
          dir = next;
        }
        let items = await list(dir);
        let name = originalName;
        for (;;) {
          signal.throwIfAborted();
          let overwrite = false;
          const existing = items.get(name);
          if (existing) {
            const canOverwrite = !existing.isDirectory && (existing.mode & 0o170000) !== 0o120000;
            const action = await choose(joinPath(dir, name), canOverwrite, index < files.length - 1);
            if (action === "skip") {
              skipped++;
              total -= file.size;
              updateTask(task, { skipped, total, sent: completedBytes, writing: false });
              break;
            }
            overwrite = action === "overwrite";
            if (!overwrite) name = nextUploadName(originalName, items);
          }
          const remotePath = joinPath(dir, name);
          updateTask(task, { current: name, sent: completedBytes, writing: false });
          try {
            await api.sftpUploadFile(connectionId, remotePath, file, (sent) => {
              updateTask(task, { current: name, sent: completedBytes + sent, writing: sent >= file.size });
            }, signal, { overwrite });
          } catch (error) {
            if (error?.code !== "target-exists") throw error;
            items = await list(dir, true);
            continue;
          }
          items.set(name, { isDirectory: false });
          changed = true;
          completedBytes += file.size;
          updateTask(task, { sent: completedBytes, writing: false });
          break;
        }
      }
      updateTask(task, { status: "done", cancellable: false });
    } catch (err) {
      const cancelled = signal.aborted;
      updateTask(task, { status: cancelled ? "cancelled" : "failed", error: cancelled ? null : (err?.message ?? String(err)), cancellable: false });
      if (!cancelled && connectionRef.current === connectionId) setError(t(`上传失败：${err?.message ?? String(err)}`));
    } finally {
      controllers.current.delete(task);
      uploadController.current = null;
      setUploadConflict(null);
      setBusy(false);
      if (connectionRef.current === connectionId && changed) void load(cwdRef.current, { preserveError: true });
    }
  };

  const doCreate = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.sftpMkdir(connectionId, joinPath(cwd, newName.trim()));
      setNewName("");
      setCreating(false);
      load(cwdRef.current);
    } catch (err) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async (entry) => {
    const confirmed = await confirmAction({
      message: t(`确定删除远程路径 ${joinPath(cwd, entry.name)} ？此操作不可恢复。`),
      confirmLabel: t("删除"),
      danger: true
    });
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      await api.sftpDelete(connectionId, joinPath(cwd, entry.name));
      setSelected(null);
      load(cwdRef.current);
    } catch (err) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const doRename = async () => {
    // The dialog pre-fills the current name, so "unchanged" is a no-op the
    // request must not send (the old inline form started empty instead).
    if (!selected || !renameTo.trim() || renameTo.trim() === selected.name) return;
    // A rename onto an existing name replaced that file silently on POSIX
    // servers. The backend refuses it too, but the dialog can say so before the
    // round trip (and before the operator believes the rename succeeded).
    const nextName = renameTo.trim();
    if ((entries ?? []).some((entry) => entry.name === nextName)) {
      setError(t(`目标名称已存在：${nextName}。请换一个名称，或先删除同名项。`));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.sftpRename(connectionId, joinPath(cwd, selected.name), joinPath(cwd, nextName));
      setRenameTo("");
      setRenaming(false);
      setSelected(null);
      load(cwdRef.current);
    } catch (err) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const scpUpload = async () => {
    if (!scpUploadFile || !scpUploadPath.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const bytes = new Uint8Array(await scpUploadFile.arrayBuffer());
      await api.scpWriteFile(connectionId, scpUploadPath.trim(), bytes);
      setScpUploadFile(null);
    } catch (err) {
      setError(t(`SCP 上传失败：${err?.message ?? String(err)}`));
    } finally {
      setBusy(false);
    }
  };

  const scpDownload = async () => {
    const path = scpDownloadPath.trim();
    if (!path) return;
    setBusy(true);
    setError(null);
    try {
      const value = await api.scpReadFile(connectionId, path);
      if (value.truncated) {
        setError(t(`文件超过读取上限（${value.bytes} 字节），未下载。`));
        return;
      }
      const blob = new Blob([value.data], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = path.split("/").filter(Boolean).at(-1) || "download";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setError(t(`SCP 下载失败：${err?.message ?? String(err)}`));
    } finally {
      setBusy(false);
    }
  };

  const persistFavorites = (next) => {
    setFavorites(next);
    writeFavorites(globalThis.localStorage, favoritesStorageKey, next);
  };
  const pinCurrent = () => persistFavorites(toggleFavorite(favorites, cwd).paths);
  const unpin = (path) => persistFavorites(favorites.filter((item) => item !== path));

  /** Read one remote file into the text editor, refusing binaries and big files. */
  const openEditor = async (entry) => {
    const path = joinPath(cwd, entry.name);
    setBusy(true);
    setError(null);
    try {
      const stat = await api.sftpStat(connectionId, path).catch(() => null);
      if (stat?.size > MAX_EDITABLE_BYTES) {
        setError(t(`文件 ${formatSize(stat.size)} 超过 ${MAX_EDITABLE_BYTES / 1024 / 1024} MB 的编辑上限，请下载后编辑`));
        return;
      }
      const file = await api.sftpReadFile(connectionId, path, MAX_EDITABLE_BYTES + 1);
      const decoded = decodeEditableText(file.data);
      if (!decoded.ok) {
        setError(t(`${entry.name}：${decoded.reason}`));
        return;
      }
      setEditing({
        path,
        text: decoded.text,
        original: decoded.text,
        originalBytes: file.data,
        replaced: decoded.replaced,
        bytes: file.data.length,
        mtime: stat?.mtime ?? entry.mtime ?? null
      });
      setPreviewChanges(false);
    } catch (err) {
      setError(t(`打开失败：${err?.message ?? String(err)}`));
    } finally {
      setBusy(false);
    }
  };

  const saveEditor = async () => {
    if (!editing) return;
    setEditorBusy(true);
    setError(null);
    try {
      const replacement = encodeEditableText(editing.text);
      await api.sftpEditorSave(connectionId, editing.path, editing.originalBytes, replacement);
      if (connectionRef.current !== connectionId) return;
      setEditing(null);
      load(cwdRef.current);
    } catch (err) {
      setError(t(`保存失败：${err?.message ?? String(err)}`));
    } finally {
      setEditorBusy(false);
    }
  };

  const visibleEntries = entries === null ? null : filterEntries(entries, filter);
  const sortedEntries = visibleEntries === null ? null : [...visibleEntries].sort(compareEntries);
  const changes = editing && previewChanges ? changedLineRegions(editing.original, editing.text) : null;
  const isFavorite = favorites.includes(cwd);
  const canResumeDownloads = typeof globalThis.showSaveFilePicker === "function";

  const retryList = () => { void load(requestedRef.current); };
  const chooseFiles = () => fileInputRef.current?.click();
  const chooseFolder = () => dirInputRef.current?.click();
  const closeRowMenu = () => setRowMenu(null);
  const openRowMenu = (event, entry) => {
    rowMenuAnchor.current = event.currentTarget;
    setSelected(entry);
    setRowMenu(entry);
  };
  const startRename = (entry) => {
    setSelected(entry);
    setRenameTo(entry.name);
    setRenaming(true);
  };
  const closeRename = () => setRenaming(false);

  /** One wording for a transfer's state, shared by the local and agent lists. */
  const taskStatus = (task) => {
    if (task.status === "done") return t("已完成");
    if (task.status === "cancelled") return t("已取消");
    if (task.status === "failed") return t("失败");
    if (task.resuming) return t("正在验证并续传…");
    if (task.verifying) return t("正在计算远端校验值…");
    if (task.writing) return t("远端写入中");
    return t("进行中");
  };

  const renderRowMenu = () => {
    if (rowMenu === null) return null;
    const entry = rowMenu;
    return (
      <Menu open anchorRef={rowMenuAnchor} onClose={closeRowMenu} align="end">
        <MenuLabel><span className="hb-files__menuname">{entry.name}</span></MenuLabel>
        {entry.isDirectory && onCd !== undefined && (
          <MenuItem icon="terminal" disabled={busy} onSelect={() => { closeRowMenu(); onCd(joinPath(cwd, entry.name)); }}>
            {t("在右侧终端 cd 到此目录")}
          </MenuItem>
        )}
        {entry.isDirectory && (
          <MenuItem icon="folder-open-outline" onSelect={() => { closeRowMenu(); load(joinPath(cwd, entry.name)); }}>
            {t("进入此目录")}
          </MenuItem>
        )}
        {!entry.isDirectory && (
          <MenuItem icon="download-outline" disabled={busy} onSelect={() => { closeRowMenu(); void download(entry); }}>
            {t("下载")}
          </MenuItem>
        )}
        {!entry.isDirectory && (
          <MenuItem icon="edit-outline" disabled={busy} onSelect={() => { closeRowMenu(); void openEditor(entry); }}>
            {t("在文本编辑器中打开（上限 10 MB）")}
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem icon="list-pen-outline" onSelect={() => { closeRowMenu(); startRename(entry); }}>
          {t("改名")}
        </MenuItem>
        <MenuItem icon="trash-outline" danger disabled={busy} onSelect={() => { closeRowMenu(); void doDelete(entry); }}>
          {t("删除")}
        </MenuItem>
      </Menu>
    );
  };

  if (transferMode === "scp") {
    return (
      <div className="hb-files hb-files__scp">
        <Notice icon="warning-triangle-outline">
          {t("SFTP 子系统不可用，已切换到 SCP 兼容模式。仅支持单文件上传和下载，需填写远端完整路径。")}
        </Notice>
        {scpReason !== "" && <div className="hb-quiet">{scpReason}</div>}
        {error !== null && (
          <ErrorNote action={<IconButton icon="close-outline" size="sm" label={t("关闭")} onClick={() => setError(null)} />}>
            {error}
          </ErrorNote>
        )}
        <Card title={t("上传文件")}>
          <Field label={t("本地文件")}>
            <div className="hb-inline">
              <Button variant="secondary" size="sm" icon="folder-open-outline" onClick={() => scpFileInputRef.current?.click()}>
                {t("选择文件")}
              </Button>
              <span className="hb-quiet hb-truncate">{scpUploadFile === null ? t("未选择文件") : scpUploadFile.name}</span>
            </div>
            <input
              ref={scpFileInputRef}
              type="file"
              hidden
              onChange={(event) => setScpUploadFile(event.target.files?.[0] ?? null)}
            />
          </Field>
          <Field label={t("远端路径")}>
            <TextInput
              value={scpUploadPath}
              onChange={(event) => setScpUploadPath(event.target.value)}
              placeholder={t("远端完整目标路径，例如 /tmp/report.zip")}
              mono
            />
          </Field>
          <div className="hb-inline">
            <span className="hb-spacer" />
            <Button variant="primary" icon="upload-outline" busy={busy} disabled={!scpUploadFile || !scpUploadPath.trim()} onClick={scpUpload}>
              {t("上传")}
            </Button>
          </div>
        </Card>
        <Card title={t("下载文件")}>
          <Field label={t("远端路径")}>
            <TextInput
              value={scpDownloadPath}
              onChange={(event) => setScpDownloadPath(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void scpDownload(); }}
              placeholder={t("远端完整文件路径，例如 /var/log/app.log")}
              mono
            />
          </Field>
          <div className="hb-inline">
            <span className="hb-spacer" />
            <Button variant="primary" icon="download-outline" busy={busy} disabled={!scpDownloadPath.trim()} onClick={scpDownload}>
              {t("下载")}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="hb-files">
      <div className="hb-files__bar">
        <IconButton icon="chevron-up-outline" size="sm" label={t("上级目录")} onClick={goUp} disabled={cwd === "/"} />
        <div className="hb-crumbs" title={cwd} aria-label={t("当前远程路径")}>
          {crumbsOf(cwd).map((crumb, index) => (
            <Fragment key={crumb.path}>
              {index > 0 && <Icon name="chevron-right-outline" size={12} className="hb-files__sep" />}
              <button
                type="button"
                className="hb-crumb"
                title={index === 0 ? t("服务器根目录") : crumb.path}
                onClick={() => { void load(crumb.path); }}
              >
                {index === 0 && <Icon name="server" size={12} />}
                {crumb.label}
              </button>
            </Fragment>
          ))}
        </div>
        {favorites.some((path) => path !== cwd) && (
          <div className="hb-files__favorites" role="group" aria-label={t("收藏的路径")}>
            {favorites.map((path) => (
              path === cwd ? null : (
                <span key={path} className="hb-files__favorite">
                  <Pill icon="folder-close" title={path} onClick={() => { void load(path); }}>{basenameOf(path)}</Pill>
                  <IconButton icon="close-outline" size="sm" label={t(`取消收藏 ${path}`)} onClick={() => unpin(path)} />
                </span>
              )
            ))}
          </div>
        )}
        {busy && <span className="hb-files__busy"><Spinner label={t("加载中…")} /></span>}
        <IconButton
          icon="pin-outline"
          size="sm"
          active={isFavorite}
          label={isFavorite ? t("取消收藏当前目录") : t("收藏当前目录")}
          onClick={pinCurrent}
        />
        {canResumeDownloads && (
          <span className="hb-files__anchor" ref={moreAnchorRef}>
            <IconButton
              icon="ellipsis-outline"
              size="sm"
              label={t("更多")}
              active={moreOpen}
              onClick={() => setMoreOpen(!moreOpen)}
            />
          </span>
        )}
      </div>

      <Menu open={moreOpen} anchorRef={moreAnchorRef} onClose={() => setMoreOpen(false)} align="end">
        <MenuLabel>{t("下载")}</MenuLabel>
        <MenuItem icon="save-outline" checked={persistDownloads} onSelect={() => setPersistDownloads(!persistDownloads)}>
          {t("允许下载跨重启续传")}
        </MenuItem>
        {persistDownloads && (
          <div className="hb-files__menunote">{t("未完成的文件会以明文保存在此浏览器的本地存储中，占用磁盘空间；请在完成后或不再需要时清理。")}</div>
        )}
      </Menu>

      <div className="hb-files__bar hb-files__bar--actions">
        <Button variant="primary" size="sm" icon="upload-outline" onClick={chooseFiles}>{t("上传")}</Button>
        <Button variant="secondary" size="sm" icon="folder-open-outline" title={t("上传目录并合并已有目录")} onClick={chooseFolder}>
          {t("上传目录")}
        </Button>
        <IconButton icon="plus-outline" size="sm" label={t("新建目录")} onClick={() => setCreating(true)} />
        <IconButton icon="refresh-outline" size="sm" label={t("刷新")} onClick={() => { void load(cwd); }} disabled={busy} />
        <IconButton
          icon="search-outline"
          size="sm"
          active={searchOpen}
          label={t("递归搜索文件名")}
          onClick={() => setSearchOpen(!searchOpen)}
        />
        <TextInput
          size="sm"
          className="hb-files__filter"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={t("过滤")}
          title={t("按名称过滤当前目录")}
          aria-label={t("按名称过滤当前目录")}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const files = event.target.files;
            if (files && files.length > 0) void upload([...files]);
            event.target.value = "";
          }}
        />
        <input
          ref={dirInputRef}
          type="file"
          webkitdirectory=""
          hidden
          onChange={(event) => {
            const files = [...event.target.files];
            event.target.value = "";
            void upload(files);
          }}
        />
      </div>

      {error !== null && (
        <ErrorNote action={<IconButton icon="close-outline" size="sm" label={t("关闭")} onClick={() => setError(null)} />}>
          {error}
        </ErrorNote>
      )}

      {searchOpen && (
        <div className="hb-files__search">
          <div className="hb-inline">
            <InputGroup icon="search-outline" className="hb-files__grow">
              <TextInput
                size="sm"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") void runSearch(); }}
                placeholder={t("搜索当前目录下的文件名")}
              />
            </InputGroup>
            <Button variant="secondary" size="sm" disabled={!searchQuery.trim() || searchState?.running === true} onClick={runSearch}>
              {t("搜索")}
            </Button>
            {searchState?.running === true && (
              <Button variant="ghost" size="sm" onClick={() => searchController.current?.abort()}>{t("取消")}</Button>
            )}
            <IconButton icon="close-outline" size="sm" label={t("关闭")} onClick={() => setSearchOpen(false)} />
          </div>
          {searchState !== null && (
            <div className="hb-files__searchbody">
              <div className="hb-quiet">
                {searchState.running ? t("搜索中…") : t(`已搜索 ${searchState.visited} 个目录，找到 ${searchState.results.length} 项`)}
                {searchState.reason === "limit" ? t("（达到上限）") : searchState.reason === "timeout" ? t("（超时，结果不完整）") : searchState.reason === "cancelled" ? t("（已取消）") : ""}
              </div>
              {searchState.errors.length > 0 && (
                <div className="hb-quiet">{t(`有 ${searchState.errors.length} 个目录无法读取，结果可能不完整`)}</div>
              )}
              {searchState.results.length > 0 && (
                <div className="hb-files__results">
                  {searchState.results.map((item) => (
                    <button
                      key={item.path}
                      type="button"
                      className="hb-files__result"
                      title={item.path}
                      onClick={() => { void load(item.isDirectory ? item.path : dirnameOf(item.path)); setSearchOpen(false); }}
                    >
                      <Icon name={item.isDirectory ? "folder-open-outline" : "file"} size={13} />
                      <span className="hb-truncate">{item.path}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {agentTasks.length > 0 && (
        <div className="hb-files__section">
          <Section title={t("AI 上传任务")}>
            <div className="hb-files__tasks">
              {agentTasks.map((task) => (
                <div key={task.id} className="hb-files__task" role="status">
                  <div className="hb-files__taskline">
                    <span className="hb-truncate" title={task.id}>{task.source.split(/[\\/]/).pop()} → {task.target}</span>
                    <span className="hb-spacer" />
                    {task.status === "running" && (
                      <IconButton
                        icon="stop-fill"
                        size="sm"
                        label={t("取消")}
                        onClick={() => { void api.sftpTransferCancel(connectionId, task.id).catch((err) => setError(err.message)); }}
                      />
                    )}
                    {(task.status === "failed" || task.status === "cancelled") && typeof api.sftpTransferDiscard === "function" && (
                      <IconButton
                        icon="trash-outline"
                        size="sm"
                        danger
                        label={t("清理残留")}
                        onClick={() => {
                          void api.sftpTransferDiscard(connectionId, task.id)
                            .then(() => setAgentTasks((items) => items.filter((item) => item.id !== task.id)))
                            .catch((err) => setError(err.message));
                        }}
                      />
                    )}
                  </div>
                  <div className="hb-quiet">
                    {task.status === "running" ? t("进行中") : task.status === "done" ? t("已完成") : task.status === "cancelled" ? t("已取消") : t("失败")}
                    {task.error ? ` · ${task.error}` : ""}
                  </div>
                  {task.status === "running" && (
                    <ProgressBar value={task.sent ?? 0} max={Math.max(task.total ?? 1, 1)} label={task.id} />
                  )}
                  {(task.status === "failed" || task.status === "cancelled") && (
                    <div className="hb-quiet">{t("可使用任务 ID 续传")}：{task.id}</div>
                  )}
                </div>
              ))}
            </div>
          </Section>
        </div>
      )}

      {tasks.length > 0 && (
        <div className="hb-files__section">
          <Section
            title={t("传输任务")}
            action={
              <Button variant="ghost" size="sm" onClick={() => setTasks((items) => items.filter((item) => item.status === "running"))}>
                {t("清除已结束")}
              </Button>
            }
          >
            <div className="hb-files__tasks">
              {tasks.map((task) => (
                <div key={task.id} className="hb-files__task" role="status">
                  <div className="hb-files__taskline">
                    <Badge tone={task.status === "failed" ? "err" : task.status === "done" ? "ok" : "neutral"}>
                      {task.kind === "upload" ? t("上传") : t("下载")}
                    </Badge>
                    <span className="hb-truncate" title={task.name}>{task.name}</span>
                    <span className="hb-spacer" />
                    {task.status === "running" && task.cancellable === true && (
                      <IconButton icon="stop-fill" size="sm" label={t("取消")} onClick={() => controllers.current.get(task.id)?.abort()} />
                    )}
                  </div>
                  <div className="hb-quiet">
                    {taskStatus(task)}
                    {task.skipped > 0 ? ` · ${t(`已跳过 ${task.skipped} 个文件`)}` : ""}
                    {task.error ? ` · ${task.error}` : ""}
                  </div>
                  {task.status === "running" && !task.verifying && !task.resuming && task.kind === "download" && task.speed > 0 && (
                    <div className="hb-quiet hb-numeric">
                      {formatSize(task.sent)}
                      {task.total !== null && task.total !== undefined ? ` / ${formatSize(task.total)}` : ""}
                      {` · ${formatSize(task.speed)}/s`}
                      {task.total !== null && task.total !== undefined && task.sent < task.total
                        ? ` · ${t("剩余约")} ${Math.ceil((task.total - task.sent) / task.speed)}s`
                        : ""}
                    </div>
                  )}
                  {task.status === "running" && (task.verifying || task.resuming ? (
                    <Fragment>
                      <ProgressBar
                        value={task.verification?.total > 0 ? Math.min(task.verification.bytes, task.verification.total) : 0}
                        max={task.verification?.total || 1}
                        label={t("正在计算远端校验值…")}
                      />
                      {task.verification !== undefined && task.verification !== null && (
                        <div className="hb-quiet hb-numeric">{formatSize(task.verification.bytes)} / {formatSize(task.verification.total)}</div>
                      )}
                    </Fragment>
                  ) : task.total !== null && task.total !== undefined ? (
                    <ProgressBar value={task.sent ?? 0} max={Math.max(task.total, 1)} label={task.name} />
                  ) : null)}
                </div>
              ))}
            </div>
          </Section>
        </div>
      )}

      {/* Unfinished downloads live next to the transfer list: they are a
        * transfer state, not a property of the listing. */}
      {checkpoints.length > 0 && (
        <div className="hb-files__section">
          <Section title={t("未完成的下载")}>
            <div className="hb-files__tasks">
              {checkpoints.map((checkpoint) => (
                <div key={checkpoint.id} className="hb-files__task">
                  <div className="hb-files__taskline">
                    <span className="hb-files__grow hb-mono hb-truncate" title={checkpoint.path}>{checkpoint.path}</span>
                    <span className="hb-quiet hb-numeric">{formatSize(checkpoint.offset)} / {formatSize(checkpoint.total)}</span>
                    <IconButton icon="play-outline" size="sm" label={t("续传")} onClick={() => { void resumeCheckpoint(checkpoint); }} />
                    <IconButton
                      icon="trash-outline"
                      size="sm"
                      danger
                      label={t("清理")}
                      onClick={async () => {
                        const confirmed = await confirmAction({
                          message: t("删除本地未完成的下载？"),
                          confirmLabel: t("清理"),
                          danger: true
                        });
                        if (!confirmed) return;
                        void withDownloadLock(checkpoint.id, () => deleteDownloadCheckpoint(checkpoint.id))
                          .then(() => refreshCheckpoints())
                          .catch((err) => setError(err.message));
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </Section>
        </div>
      )}

      <div
        className="hb-filelist hb-scroll hb-files__list"
        onDragOver={(event) => { event.preventDefault(); setDragActive(true); }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragActive(false);
          const files = [...(event.dataTransfer?.files ?? [])];
          if (files.length > 0) void upload(files);
        }}
      >
        {dragActive && <div className="hb-files__drop">{t(`松开鼠标：上传到 ${cwd}`)}</div>}
        {entries === null ? (
          connectionId ? (
            <div className="hb-files__center">
              <Spinner label={t("加载中…")} />
              <span className="hb-quiet">{t("加载中…")}</span>
            </div>
          ) : (
            <EmptyState icon="folder-open-outline" title={t("请连接服务器")} text={t("连接服务器后即可浏览远端文件。")} />
          )
        ) : listError !== null ? (
          <div className="hb-files__center">
            <ErrorNote action={<Button variant="secondary" size="sm" icon="refresh-outline" onClick={retryList}>{t("重试")}</Button>}>
              {listError}
            </ErrorNote>
          </div>
        ) : entries.length === 0 ? (
          <EmptyState
            icon="folder-open-outline"
            title={t("空目录")}
            text={t("把文件拖到这里，或点下面的上传按钮。")}
            action={<Button variant="secondary" size="sm" icon="upload-outline" onClick={chooseFiles}>{t("上传")}</Button>}
          />
        ) : sortedEntries.length === 0 ? (
          <EmptyState
            icon="search-outline"
            title={t("没有匹配的文件")}
            text={t("换个关键词，或清除过滤。")}
            action={<Button variant="secondary" size="sm" onClick={() => setFilter("")}>{t("清除过滤")}</Button>}
          />
        ) : (
          <Fragment>
            {cwd !== "/" && (
              <div
                className="hb-file hb-files__row hb-file--up"
                role="button"
                tabIndex={0}
                title={t("上级目录")}
                onClick={goUp}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); goUp(); } }}
              >
                <span className="hb-file__icon"><Icon name="chevron-up-outline" size={14} /></span>
                <span className="hb-file__name">..</span>
              </div>
            )}
            {sortedEntries.map((entry) => {
              const isSelected = selected?.name === entry.name;
              return (
                <div
                  key={entry.name}
                  className="hb-file hb-files__row"
                  data-selected={isSelected ? "true" : "false"}
                  data-dir={entry.isDirectory ? "true" : "false"}
                  role="button"
                  tabIndex={0}
                  aria-current={isSelected ? "true" : undefined}
                  title={entry.isDirectory ? `${entry.name} · ${t("双击打开")}` : `${entry.name} · ${t("双击下载")}`}
                  onClick={() => setSelected(entry)}
                  onDoubleClick={() => { if (entry.isDirectory) openEntry(entry); else void download(entry); }}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget || event.key !== "Enter") return;
                    event.preventDefault();
                    if (entry.isDirectory) openEntry(entry); else void download(entry);
                  }}
                >
                  <span className="hb-file__icon"><Icon name={entry.isDirectory ? "folder-open-outline" : "file"} size={14} /></span>
                  <span className="hb-file__name">{entry.name}</span>
                  <span className="hb-file__meta">
                    <span>{entry.isDirectory ? "—" : formatSize(entry.size)}</span>
                    <span>{formatTime(entry.mtime)}</span>
                    <span className="hb-files__perm">{modeString(entry.mode)}</span>
                  </span>
                  <span
                    className="hb-files__actions"
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                  >
                    <IconButton
                      icon="ellipsis-outline"
                      size="sm"
                      label={t(`更多操作：${entry.name}`)}
                      onClick={(event) => openRowMenu(event, entry)}
                    />
                  </span>
                </div>
              );
            })}
          </Fragment>
        )}
      </div>

      {renderRowMenu()}

      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title={t("新建目录")}
        description={cwd}
        footer={
          <Fragment>
            <Button variant="secondary" onClick={() => setCreating(false)}>{t("取消")}</Button>
            <Button variant="primary" icon="plus-outline" busy={busy} disabled={!newName.trim()} onClick={doCreate}>{t("创建")}</Button>
          </Fragment>
        }
      >
        <Field label={t("名称")} htmlFor="harbor-files-new-directory">
          <TextInput
            id="harbor-files-new-directory"
            data-modal-autofocus=""
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void doCreate(); }}
            placeholder={t("新目录名")}
          />
        </Field>
      </Dialog>

      <Dialog
        open={renaming && selected !== null}
        onClose={closeRename}
        title={t("改名")}
        description={selected === null ? undefined : joinPath(cwd, selected.name)}
        footer={
          <Fragment>
            <Button variant="secondary" onClick={closeRename}>{t("取消")}</Button>
            <Button
              variant="primary"
              icon="list-pen-outline"
              busy={busy}
              disabled={selected === null || !renameTo.trim() || renameTo.trim() === selected.name}
              onClick={doRename}
            >
              {t("改名")}
            </Button>
          </Fragment>
        }
      >
        <Field label={t("名称")} htmlFor="harbor-files-rename">
          <TextInput
            id="harbor-files-rename"
            data-modal-autofocus=""
            value={renameTo}
            onChange={(event) => setRenameTo(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void doRename(); }}
          />
        </Field>
      </Dialog>

      {editing !== null && (
        <Dialog
          open
          onClose={() => setEditing(null)}
          title={t(`编辑：${editing.path}`)}
          description={
            `${formatSize(editing.bytes)} · UTF-8${editing.replaced ? t(" · 含无法按 UTF-8 解码的字节（保存会按 UTF-8 重写）") : ""}${editing.text !== editing.original ? t(" · 已修改") : ""}`
          }
          width="full"
          footer={
            <Fragment>
              <Button variant="secondary" onClick={() => setEditing(null)}>{t("关闭")}</Button>
              <Button variant="secondary" icon="compare-split-outline" onClick={() => setPreviewChanges(!previewChanges)}>
                {previewChanges ? t("返回编辑") : t("预览修改")}
              </Button>
              <Button
                variant="primary"
                icon="save-outline"
                busy={editorBusy}
                disabled={editing.text === editing.original}
                onClick={saveEditor}
              >
                {editorBusy ? t("保存中…") : t("保存")}
              </Button>
            </Fragment>
          }
        >
          <div className="hb-files__editor">
            {previewChanges && changes !== null ? (
              <div className="hb-files__diff">
                {[changes.left, changes.right].map((part, index) => (
                  <div key={index === 0 ? "before" : "after"} className="hb-files__diffcol">
                    <span className="hb-files__difflabel">{index === 0 ? t("修改前") : t("修改后")}</span>
                    <pre className="hb-files__difftext">
                      {part.before}
                      {part.before !== "" ? "\n" : ""}
                      <span className={index === 0 ? "hb-files__removed" : "hb-files__added"}>{part.changed}</span>
                      {part.after !== "" ? "\n" : ""}
                      {part.after}
                    </pre>
                  </div>
                ))}
              </div>
            ) : (
              <TextArea
                className="hb-files__code"
                data-modal-autofocus=""
                value={editing.text}
                onChange={(event) => setEditing({ ...editing, text: event.target.value })}
                spellCheck={false}
              />
            )}
          </div>
        </Dialog>
      )}

      <Dialog
        open={uploadConflict !== null}
        onClose={() => uploadConflict?.cancel()}
        title={t("上传遇到同名项")}
        closeOnScrim={false}
        footer={uploadConflict === null ? undefined : (
          <div className="hb-files__foot">
            <Button variant="ghost" onClick={() => uploadConflict.cancel()}>{t("取消上传")}</Button>
            <span className="hb-spacer" />
            <Button variant="secondary" onClick={() => uploadConflict.choose("skip", conflictApplyAll)}>{t("跳过")}</Button>
            <Button variant="primary" onClick={() => uploadConflict.choose("rename", conflictApplyAll)}>{t("保留两份")}</Button>
            {uploadConflict.canOverwrite && (
              <Button variant="secondary" onClick={() => uploadConflict.choose("overwrite", conflictApplyAll)}>{t("覆盖")}</Button>
            )}
          </div>
        )}
      >
        {uploadConflict !== null && (
          <div className="hb-files__conflict">
            <code className="hb-files__conflictpath">{uploadConflict.path}</code>
            {uploadConflict.moreFiles === true && (
              <Checkbox checked={conflictApplyAll} onChange={setConflictApplyAll} label={t("对剩余同名项应用此选择")} />
            )}
          </div>
        )}
      </Dialog>
    </div>
  );
}
