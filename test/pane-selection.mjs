// Pane visibility contract for the split Sidebar. The dock kit renders a
// single-pane root as <TabPanel> and a split root as a <div>, so splitting
// remounts the body of the pane that was already there. The pane's servers must
// survive that remount, a genuinely new pane must start empty, and the last
// pane to close a server must be the one that disconnects it.
import assert from "node:assert/strict";
import {
  adoptIntoView,
  anyViewShowsConnections,
  claimPendingOpens,
  closeInView,
  forgetView,
  openInView,
  paneOpenRequestsRevision,
  reconcileViews,
  requestPaneOpen,
  resetPaneSessions,
  resolvePaneActiveConnection,
  selectInView,
  subscribePaneSessions,
  visiblePaneConnections,
  viewSession
} from "../src/client/state/pane-selection.js";

const connections = [{ connectionId: "a" }, { connectionId: "b" }];

// An unavailable transport is hidden, but reappears if it reconnects.
const transportStates = [{ connectionId: "a", connected: true }, { connectionId: "b", connected: false }];
assert.deepEqual(visiblePaneConnections(transportStates, ["a", "b"]).map((item) => item.connectionId), ["a"]);
transportStates[1].connected = true;
assert.deepEqual(visiblePaneConnections(transportStates, ["a", "b"]).map((item) => item.connectionId), ["a", "b"]);

// ── selection helpers ──
assert.equal(resolvePaneActiveConnection(connections, "a"), "a");
assert.equal(resolvePaneActiveConnection(connections, "b"), "b");
assert.equal(resolvePaneActiveConnection(connections, "gone"), "a");
assert.equal(resolvePaneActiveConnection([], "a"), null);

// ── an unknown view is empty: a freshly split pane shows nothing ──
assert.deepEqual(viewSession("new-pane"), { connectionIds: [], activeConnectionId: null });

// ── opening shows and selects the server in that view only ──
resetPaneSessions();
openInView("tab-left", "a");
assert.deepEqual(viewSession("tab-left"), { connectionIds: ["a"], activeConnectionId: "a" });
assert.deepEqual(viewSession("tab-right"), { connectionIds: [], activeConnectionId: null },
  "a second pane must not inherit the first pane's servers");

// ── requirement 1: a new pane beside a busy pane starts empty ──
adoptIntoView("tab-right", connections);
assert.deepEqual(viewSession("tab-right"), { connectionIds: [], activeConnectionId: null },
  "adoption only ever recovers a cold registry, never a live pane");

// ── the split remount: same view id, state restored, references not doubled ──
// The dock kit unmounts and remounts this body, so the store — not React state —
// is what carries the pane's servers across the split. Re-running the open path
// on remount must stay idempotent instead of adding a second reference.
openInView("tab-left", "a");
assert.deepEqual(viewSession("tab-left").connectionIds, ["a"], "the pane keeps the server it had");
assert.equal(closeInView("tab-left", "a"), true,
  "a remount must not leak a reference that would suppress the final disconnect");

// ── requirement 2: two panes on one server ──
resetPaneSessions();
openInView("tab-left", "a");
openInView("tab-right", "a");
assert.equal(closeInView("tab-left", "a"), false, "the first close keeps the host session alive");
assert.deepEqual(viewSession("tab-left"), { connectionIds: [], activeConnectionId: null });
assert.deepEqual(viewSession("tab-right"), { connectionIds: ["a"], activeConnectionId: "a" },
  "closing a tab in one pane does not disturb the other pane");
assert.equal(closeInView("tab-right", "a"), true, "the last visible pane disconnects the server");

// ── a pane whose host tab record disappears releases its references ──
// Closing the whole SSH tab must not disconnect (documented lifetime), but it
// must not leave a stale reference that blocks a later disconnect either.
resetPaneSessions();
openInView("tab-left", "a");
openInView("tab-right", "a");
forgetView("tab-left");
assert.equal(closeInView("tab-right", "a"), true,
  "a closed view must not keep the connection alive forever");

// ── each pane keeps its own selection over shared servers ──
resetPaneSessions();
openInView("tab-left", "a");
openInView("tab-left", "b");
openInView("tab-right", "b");
selectInView("tab-left", "a");
assert.equal(viewSession("tab-left").activeConnectionId, "a");
assert.equal(viewSession("tab-right").activeConnectionId, "b");

// ── a connection the host dropped leaves every pane ──
reconcileViews([{ connectionId: "b" }]);
assert.deepEqual(viewSession("tab-left").connectionIds, ["b"]);
assert.equal(viewSession("tab-left").activeConnectionId, "b");
assert.deepEqual(viewSession("tab-right").connectionIds, ["b"]);

// ── cold start after a page reload still adopts live connections ──
// Host sessions outlive the browser; without adoption they become zombies no
// pane can disconnect.
resetPaneSessions();
assert.equal(anyViewShowsConnections(), false);
adoptIntoView("tab-left", connections);
assert.deepEqual(viewSession("tab-left"), { connectionIds: ["a", "b"], activeConnectionId: "a" });
assert.equal(anyViewShowsConnections(), true);
adoptIntoView("tab-second", connections);
assert.deepEqual(viewSession("tab-second").connectionIds, [],
  "only a cold registry adopts; a pane opened later starts empty");
adoptIntoView("tab-third", []);
assert.deepEqual(viewSession("tab-third").connectionIds, []);

// ── subscribers are notified so sibling panes re-render ──
// The render snapshot is the view object itself, so its identity must stay put
// for an unchanged view (otherwise useSyncExternalStore would loop) and change
// on every real change.
resetPaneSessions();
let notifications = 0;
const unsubscribe = subscribePaneSessions(() => { notifications += 1; });
const emptySnapshot = viewSession("tab-left");
assert.equal(viewSession("tab-left"), emptySnapshot, "an untouched view keeps its snapshot identity");
openInView("tab-left", "a");
assert.equal(notifications, 1);
const openedSnapshot = viewSession("tab-left");
assert.notEqual(openedSnapshot, emptySnapshot, "a real change replaces the snapshot");
selectInView("tab-left", "a");
assert.equal(notifications, 1, "a no-op selection does not notify");
assert.equal(viewSession("tab-left"), openedSnapshot, "a no-op selection keeps the snapshot");
closeInView("tab-left", "a");
assert.equal(notifications, 2);
assert.notEqual(viewSession("tab-left"), openedSnapshot, "closing replaces the snapshot");
unsubscribe();
openInView("tab-left", "a");
assert.equal(notifications, 2, "an unsubscribed pane stops receiving changes");
resetPaneSessions();

// ── a surface with no pane of its own hands its connect to exactly one pane ──
// The resources page connects servers but owns no pane, so it queues them. If
// every pane claimed the queue the server would appear mirrored everywhere; if
// none did it would never appear at all — which is the bug this replaced.
resetPaneSessions();
const revisionBefore = paneOpenRequestsRevision();
const idleSnapshot = viewSession("tab-left");
requestPaneOpen("x");
assert.notEqual(paneOpenRequestsRevision(), revisionBefore, "queuing advances the revision panes subscribe to");
assert.equal(viewSession("tab-left"), idleSnapshot, "queuing alone does not touch a view snapshot");
assert.deepEqual(claimPendingOpens(), [{ connectionId: "x", adopt: false }], "the first pane to render claims the connection");
assert.deepEqual(claimPendingOpens(), [], "the queue is drained, so a second pane gets nothing");

// Two queued connects both land, and the queue is per-request, not per-pane.
requestPaneOpen("x");
requestPaneOpen("y");
assert.deepEqual(claimPendingOpens(), [{ connectionId: "x", adopt: false }, { connectionId: "y", adopt: false }]);
assert.deepEqual(claimPendingOpens(), []);

// A request that belongs to one conversation must not pop a tab into another
// chat's pane: terminals are per-conversation, so the wrong pane would only
// show "no terminal". An unowned request (the settings page) is claimable by
// any pane, and asks it to adopt the anonymous terminal.
requestPaneOpen("owned", { ownerSessionId: "conv-a" });
requestPaneOpen("shared", { adopt: true });
assert.deepEqual(claimPendingOpens("conv-b"), [{ connectionId: "shared", adopt: true }], "another chat only sees the unowned request");
assert.deepEqual(claimPendingOpens("conv-b"), []);
assert.deepEqual(claimPendingOpens("conv-a"), [{ connectionId: "owned", adopt: false }], "the owning conversation still gets its own");

// A request whose session never mounts expires instead of hijacking a later pane.
const realNow = Date.now;
try {
  requestPaneOpen("stale", { ownerSessionId: "conv-gone" });
  Date.now = () => realNow() + 31000;
  assert.deepEqual(claimPendingOpens("conv-other"), [], "an expired request is dropped, not claimed by a stranger");
  assert.deepEqual(claimPendingOpens("conv-gone"), [], "and the owner cannot claim it either");
} finally {
  Date.now = realNow;
}

// Teardown must not leave a stale request that the next pane would adopt.
requestPaneOpen("z");
resetPaneSessions();
assert.deepEqual(claimPendingOpens(), []);
assert.deepEqual(viewSession("tab-left").connectionIds, []);

console.log("pane selection: split-pane visibility survives remount, new panes start empty, last close disconnects, queued connects land in one pane: passed");

// ── agent-connected servers announce themselves ──────────────────
// ssh_connect_profile opens transport + session host-side; the browser learns
// through list() metadata (agentSession) and must queue the connection for a
// pane and reveal the SSH surface. Announcing is idempotent per connection id
// for the page lifetime — the poll runs every couple of seconds.
{
  const { harborUiAnnounceAgentConnections, harborUiResetAgentAnnouncements } = await import("../src/client/state/store.js");
  resetPaneSessions();
  const listed = [
    { connectionId: "agent-1", agentSession: true },
    { connectionId: "human-1" },
    { connectionId: "agent-2", agentSession: true }
  ];
  const first = harborUiAnnounceAgentConnections(listed);
  assert.deepEqual(first.map((entry) => entry.connectionId), ["agent-1", "agent-2"], "fresh agent connections announce");
  assert.deepEqual(claimPendingOpens(), [{ connectionId: "agent-1", adopt: false }, { connectionId: "agent-2", adopt: false }], "only agent-opened connections are queued, humans never");
  assert.deepEqual(harborUiAnnounceAgentConnections(listed), [], "re-announcing the same connections is a no-op");
  assert.deepEqual(claimPendingOpens(), [], "the dedupe did not re-queue anything");
  assert.deepEqual(harborUiAnnounceAgentConnections([{ connectionId: "agent-1", agentSession: true }]), [], "per-connection memory survives later polls");
  assert.equal(harborUiAnnounceAgentConnections([{ connectionId: "agent-1", agentRevealId: "request-1" }]).length, 1, "a saved-resource request reopens an existing human session");
  assert.deepEqual(claimPendingOpens(), [{ connectionId: "agent-1", adopt: false }]);
  assert.deepEqual(harborUiAnnounceAgentConnections([{ connectionId: "agent-1", agentRevealId: "request-1" }]), [], "the same request is not replayed each poll");
  assert.equal(harborUiAnnounceAgentConnections([{ connectionId: "agent-1", agentRevealId: "request-2" }]).length, 1, "a later request can reopen a closed pane");
  assert.deepEqual(claimPendingOpens(), [{ connectionId: "agent-1", adopt: false }]);
  resetPaneSessions();

  // ── the reveal belongs to one conversation ──────────────────────────────
  // A reveal for chat A must never be queued into chat B's pane; the session
  // watcher that sees it first opens A's tab, not the one currently on screen.
  harborUiResetAgentAnnouncements();
  const foreign = harborUiAnnounceAgentConnections(
    [{ connectionId: "agent-a", agentRevealId: "r-a", agentRevealOwnerSessionId: "conv-a" }],
    { sessionId: "conv-b" }
  );
  assert.deepEqual(foreign, [], "another conversation's reveal is ignored");
  assert.deepEqual(claimPendingOpens(), []);
  const mine = harborUiAnnounceAgentConnections(
    [{ connectionId: "agent-a", agentRevealId: "r-a", agentRevealOwnerSessionId: "conv-a" }],
    { sessionId: "conv-a" }
  );
  assert.deepEqual(mine, [{ connectionId: "agent-a", ownerSessionId: "conv-a" }], "the owning conversation claims it");
  assert.deepEqual(claimPendingOpens(), [{ connectionId: "agent-a", adopt: false }]);
  harborUiResetAgentAnnouncements();

  // A legacy host publishes agentSession but no owner. Only the conversation
  // the host marks mine may claim it.
  const legacyForeign = harborUiAnnounceAgentConnections(
    [{ connectionId: "legacy", agentSession: true, agentSessionMine: false }],
    { sessionId: "conv-b" }
  );
  assert.deepEqual(legacyForeign, [], "a legacy anonymous agent terminal is not stolen");
  const legacyMine = harborUiAnnounceAgentConnections(
    [{ connectionId: "legacy", agentSession: true, agentSessionMine: true }],
    { sessionId: "conv-b" }
  );
  assert.deepEqual(legacyMine, [{ connectionId: "legacy", ownerSessionId: "conv-b" }]);
  assert.deepEqual(claimPendingOpens(), [{ connectionId: "legacy", adopt: false }]);
  harborUiResetAgentAnnouncements();
  resetPaneSessions();
}
