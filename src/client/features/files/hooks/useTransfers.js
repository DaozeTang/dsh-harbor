/**
 * Transfers that push bytes OUT of the browser: the upload batch, its conflict
 * prompt, the agent upload tasks the host reports, and the SCP single-file
 * fallback.
 *
 * Transfers are deliberately not component state: this pane is keyed by
 * connection id and remounts on every server switch, and an upload must not
 * die with the tab that started it (see file-transfers.js). The prompt lives in
 * that same registry, so a remount while it is open reopens it instead of
 * stranding the upload on a promise nobody holds.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  attachFileController, beginFileTask, beginFileUpload, cancelFileTask, clearFileUploadConflict,
  clearFinishedFileTasks, endFileUpload, getFileTransfers, releaseFileController, setFileUploadConflict,
  subscribeFileTransfers, updateFileTask
} from "../file-transfers.js";
import { joinPath, nextUploadName } from "../path-utils.js";
import { t } from "../../../../i18n/core.js";

export function useTransfers({ api, connectionId, active, cwd, cwdRef, load, connectionRef, setBusy, setError }) {
  // Transfers are deliberately not component state: this pane is keyed by
  // connection id and remounts on every server switch, and an upload must not
  // die with the tab that started it (see file-transfers.js).
  const subscribeTransfers = useCallback(
    (listener) => subscribeFileTransfers(connectionId, listener),
    [connectionId]
  );
  const transfers = useSyncExternalStore(subscribeTransfers, () => getFileTransfers(connectionId));
  const { tasks, conflict: uploadConflict } = transfers;
  const [conflictApplyAll, setConflictApplyAll] = useState(false);
  const [agentTasks, setAgentTasks] = useState([]);
  const [scpUploadFile, setScpUploadFile] = useState(null);
  const [scpUploadPath, setScpUploadPath] = useState("");
  const [scpDownloadPath, setScpDownloadPath] = useState("");

  const updateTask = (id, patch) => updateFileTask(connectionId, id, patch);
  const addTask = (task) => beginFileTask(connectionId, task);

  useEffect(() => {
    let alive = true;
    setAgentTasks([]);
    if (!active || !connectionId || typeof api.sftpTransferList !== "function") return () => { alive = false; };
    let polling = false;
    const refresh = async () => {
      // A hidden pane or a slow host must not stack transfer-list requests.
      if (polling) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      polling = true;
      try {
        const result = await api.sftpTransferList(connectionId);
        if (alive) setAgentTasks(result.transfers ?? []);
      } catch {
        // Older hosts may not expose the registry.
      } finally {
        polling = false;
      }
    };
    void refresh();
    const timer = setInterval(refresh, 1500);
    return () => { alive = false; clearInterval(timer); };
  }, [api, connectionId, active]);

  const upload = async (fileList) => {
    const files = Array.isArray(fileList) ? fileList : [fileList];
    if (!connectionId || files.length === 0) return;
    const controller = new AbortController();
    // One batch at a time per connection: the directory cache, the conflict
    // prompt and the final refresh are written for a sequential walk.
    if (!beginFileUpload(connectionId, controller)) return;
    setBusy(true);
    setError(null);
    const { signal } = controller;
    let total = files.reduce((sum, file) => sum + file.size, 0);
    const task = addTask({ name: files.length === 1 ? files[0].name : t(`${files.length} 个文件`), kind: "upload", status: "running", sent: 0, total, cancellable: true });
    attachFileController(connectionId, task, controller);
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
        // The prompt lives in the registry, so a remount while it is open
        // reopens it instead of stranding the upload on a promise nobody holds.
        setFileUploadConflict(connectionId, {
          path, canOverwrite, moreFiles,
          cancel: () => controller.abort(),
          choose: (choice, applyAll) => {
            signal.removeEventListener("abort", abort);
            if (applyAll) batchChoice = choice;
            clearFileUploadConflict(connectionId);
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
      releaseFileController(connectionId, task);
      endFileUpload(connectionId, controller);
      clearFileUploadConflict(connectionId);
      setBusy(false);
      if (connectionRef.current === connectionId && changed) void load(cwdRef.current, { preserveError: true });
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

  const cancelAgentTask = (task) => {
    void api.sftpTransferCancel(connectionId, task.id).catch((err) => setError(err.message));
  };

  const discardAgentTask = (task) => {
    void api.sftpTransferDiscard(connectionId, task.id)
      .then(() => setAgentTasks((items) => items.filter((item) => item.id !== task.id)))
      .catch((err) => setError(err.message));
  };

  const cancelTask = (id) => cancelFileTask(connectionId, id);
  const clearFinished = () => clearFinishedFileTasks(connectionId);

  return {
    tasks, uploading: transfers.uploading, uploadConflict, conflictApplyAll, setConflictApplyAll, agentTasks,
    upload, scpUploadFile, setScpUploadFile, scpUploadPath, setScpUploadPath, scpDownloadPath, setScpDownloadPath,
    scpUpload, scpDownload, cancelAgentTask, discardAgentTask, cancelTask, clearFinished
  };
}
