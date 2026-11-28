/**
 * Downloads: the verified streaming path, resumable checkpoints and their
 * local staging area.
 *
 * A restartable download is staged in browser-private storage and committed to
 * the chosen destination only after its checksum matches, so an interrupted
 * transfer never leaves a half-written file in the user's folder. The checks
 * live in the sibling checkpoint module; this hook only drives them.
 */
import { useEffect, useRef, useState } from "react";
import { confirmAction } from "../../../ui/kit.jsx";
import {
  checkpointDestination, checkpointFile, createDownloadCheckpoint, deleteDownloadCheckpoint,
  listDownloadCheckpoints, withDownloadLock
} from "../download-checkpoints.js";
import {
  attachFileController, beginFileTask, releaseFileController, updateFileTask
} from "../file-transfers.js";
import { streamDownload } from "../stream-download.js";
import { joinPath } from "../path-utils.js";
import { t } from "../../../../i18n/core.js";

export function useDownloads({ api, connectionId, cwd, selected, favoritesStorageKey, setBusy, setError }) {
  const [persistDownloads, setPersistDownloads] = useState(false);
  const [checkpoints, setCheckpoints] = useState([]);
  // The list may only commit for the server that asked for it: the key is
  // compared after each await, so a late answer cannot overwrite a newer one.
  const favoritesKeyRef = useRef(favoritesStorageKey);
  favoritesKeyRef.current = favoritesStorageKey;

  const updateTask = (id, patch) => updateFileTask(connectionId, id, patch);
  const addTask = (task) => beginFileTask(connectionId, task);

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
    attachFileController(connectionId, task, controller);
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
      releaseFileController(connectionId, task);
      void refreshCheckpoints();
    }
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
      attachFileController(connectionId, task, controller);
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
        releaseFileController(connectionId, task);
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

  const discardCheckpoint = async (checkpoint) => {
    const confirmed = await confirmAction({
      message: t("删除本地未完成的下载？"),
      confirmLabel: t("清理"),
      danger: true
    });
    if (!confirmed) return;
    void withDownloadLock(checkpoint.id, () => deleteDownloadCheckpoint(checkpoint.id))
      .then(() => refreshCheckpoints())
      .catch((err) => setError(err.message));
  };

  const canResumeDownloads = typeof globalThis.showSaveFilePicker === "function";

  return { persistDownloads, setPersistDownloads, checkpoints, canResumeDownloads, download, resumeCheckpoint, discardCheckpoint };
}
