// The file-transfer registry: a transfer must outlive the pane that started
// it. HarborPanel keys HarborFiles by connection id, so switching server tabs
// remounts the pane — while the task list and its AbortControllers lived in
// component state, that remount aborted every running upload and left a
// partial file on the remote host.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attachFileController, beginFileTask, beginFileUpload, cancelFileTask, clearFileUploadConflict,
  clearFinishedFileTasks, endFileUpload, getFileTransfers, releaseFileController,
  setFileUploadConflict, subscribeFileTransfers, updateFileTask
} from "../../../../src/client/features/files/file-transfers.js";

test("the snapshot is stable between changes and scoped to one connection", () => {
  const id = beginFileTask("snap", { name: "a.bin", kind: "upload", status: "running", sent: 0, total: 10 });
  const first = getFileTransfers("snap");
  assert.equal(getFileTransfers("snap"), first, "an unchanged registry returns the same snapshot");
  updateFileTask("snap", id, { sent: 4 });
  const second = getFileTransfers("snap");
  assert.notEqual(second, first, "a change invalidates the snapshot");
  assert.equal(second.tasks[0].sent, 4);
  assert.deepEqual(getFileTransfers("other").tasks, [], "another connection has its own list");
});

test("a transfer keeps running when the pane unsubscribes", () => {
  const id = beginFileTask("detach", { name: "big.iso", kind: "download", status: "running", sent: 0, total: 100 });
  const controller = new AbortController();
  attachFileController("detach", id, controller);
  let notifications = 0;
  const unsubscribe = subscribeFileTransfers("detach", () => { notifications += 1; });
  updateFileTask("detach", id, { sent: 50 });
  assert.equal(notifications, 1, "a mounted pane is notified");
  unsubscribe();
  updateFileTask("detach", id, { sent: 75 });
  assert.equal(controller.signal.aborted, false, "unmounting never aborts a transfer");
  assert.equal(getFileTransfers("detach").tasks[0].sent, 75, "progress recorded while unmounted is still there");
  cancelFileTask("detach", id);
  assert.equal(controller.signal.aborted, true, "an explicit cancel still works");
  releaseFileController("detach", id);
  assert.doesNotThrow(() => cancelFileTask("detach", id), "cancelling a settled task is a no-op");
});

test("one upload slot per connection, released by its owner only", () => {
  const mine = new AbortController();
  const theirs = new AbortController();
  assert.equal(beginFileUpload("slot", mine), true);
  assert.equal(getFileTransfers("slot").uploading, true);
  assert.equal(beginFileUpload("slot", theirs), false, "a second batch is refused while one runs");
  assert.equal(beginFileUpload("slot-2", theirs), true, "another connection is unaffected");
  endFileUpload("slot", theirs);
  assert.equal(getFileTransfers("slot").uploading, true, "a foreign release does not free the slot");
  endFileUpload("slot", mine);
  assert.equal(getFileTransfers("slot").uploading, false);
});

test("the name-conflict prompt survives a remount", () => {
  const conflict = { path: "/tmp/a", canOverwrite: true, moreFiles: false, cancel: () => {}, choose: () => {} };
  setFileUploadConflict("conflict", conflict);
  assert.equal(getFileTransfers("conflict").conflict, conflict, "the pending prompt is readable after a remount");
  clearFileUploadConflict("conflict");
  assert.equal(getFileTransfers("conflict").conflict, null);
});

test("clearing finished work keeps every running task", () => {
  const running = beginFileTask("clear", { name: "run", kind: "upload", status: "running" });
  const done = beginFileTask("clear", { name: "done", kind: "download", status: "done" });
  const failed = beginFileTask("clear", { name: "failed", kind: "download", status: "failed" });
  clearFinishedFileTasks("clear");
  assert.deepEqual(getFileTransfers("clear").tasks.map((task) => task.id), [running]);
  assert.equal(getFileTransfers("clear").tasks.some((task) => task.id === done || task.id === failed), false);
});

test("the list stays bounded without evicting running work", () => {
  const running = beginFileTask("cap", { name: "run", kind: "upload", status: "running" });
  for (let index = 0; index < 60; index += 1) {
    beginFileTask("cap", { name: `f${index}`, kind: "download", status: "done" });
  }
  const { tasks } = getFileTransfers("cap");
  assert.equal(tasks.length, 50, "finished history is capped");
  assert.equal(tasks.some((task) => task.id === running), true, "the running transfer is never evicted");
});