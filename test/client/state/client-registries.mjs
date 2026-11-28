// Client-side module registries outlive panes and pages, so anything they
// keep is kept for the whole page session. These cases pin the two that used
// to grow without bound: the per-conversation agent-announcement memory and
// the per-connection file-transfer entry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { beginFileTask, getFileTransfers, subscribeFileTransfers } from "../../../src/client/features/files/file-transfers.js";
import { harborUiAnnounceAgentConnections, harborUiResetAgentAnnouncements } from "../../../src/client/state/store.js";

test("an empty transfer entry is forgotten when its last pane unmounts", () => {
  const connectionId = "p3-prune-empty";
  const unsubscribe = subscribeFileTransfers(connectionId, () => {});
  const before = getFileTransfers(connectionId);
  unsubscribe();
  const after = getFileTransfers(connectionId);
  assert.notEqual(after, before, "the entry does not survive an unmount with nothing in it");
  assert.equal(after.tasks.length, 0);
});

test("an entry with transfer history survives the remount that shows it", () => {
  const connectionId = "p3-prune-keeps-tasks";
  beginFileTask(connectionId, { name: "a.bin", kind: "upload", status: "done", sent: 4, total: 4 });
  const unsubscribe = subscribeFileTransfers(connectionId, () => {});
  const before = getFileTransfers(connectionId);
  unsubscribe();
  assert.equal(getFileTransfers(connectionId), before, "finished transfers stay visible across a remount");
});

test("the agent-announcement memory is per connection, not a growing log", () => {
  const sessionId = "p3-conversation";
  const announce = (revealId) => harborUiAnnounceAgentConnections(
    [{ connectionId: "p3-conn", agentRevealId: revealId }],
    { sessionId }
  ).length;
  assert.equal(announce("reveal-1"), 1, "the first reveal opens a tab");
  assert.equal(announce("reveal-1"), 0, "the same reveal never opens a second one");
  assert.equal(announce("reveal-2"), 1, "a newer reveal on the same connection is a new event");
  assert.equal(announce("reveal-2"), 0, "and it is remembered in place");
  harborUiResetAgentAnnouncements(sessionId);
  assert.equal(announce("reveal-2"), 1, "a conversation that remounts re-checks the host");
});
