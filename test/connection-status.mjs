// The server strip's three facts are independent: transport reachability,
// this conversation's terminal, and current agent activity. The old dot
// folded transport into terminal liveness, so ssh_exec/sftp on a healthy
// connection looked idle.
import assert from "node:assert/strict";
import { connectionStatusView } from "../src/client/shell/connection-status.js";

const own = { sessionId: "t1", ownerSessionId: "conv-a", openedBy: "agent", alive: true, mine: true };
const other = { sessionId: "t2", ownerSessionId: "conv-b", openedBy: "panel", alive: true, mine: false };

assert.deepEqual(
  connectionStatusView({ connected: true, terminals: [own], sessions: ["t1"] }, "conv-a"),
  { connected: true, hasTerminal: true, agentActive: false },
  "a healthy connection with this conversation's terminal is connected + terminal"
);
assert.deepEqual(
  connectionStatusView({ connected: true, terminals: [own], sessions: ["t1"], agentActive: true }, "conv-a"),
  { connected: true, hasTerminal: true, agentActive: true },
  "agent activity is independent of the other two"
);
assert.deepEqual(
  connectionStatusView({ connected: true, terminals: [other], sessions: ["t2"] }, "conv-a"),
  { connected: true, hasTerminal: false, agentActive: false },
  "another chat's shell is not this conversation's terminal"
);
assert.deepEqual(
  connectionStatusView({ connected: true, terminals: [], sessions: [] }, "conv-a"),
  { connected: true, hasTerminal: false, agentActive: false },
  "ssh_exec/sftp can use a server with no terminal; the transport is still up"
);
assert.deepEqual(
  connectionStatusView({ connected: false, terminals: [own], sessions: ["t1"] }, "conv-a"),
  { connected: false, hasTerminal: true, agentActive: false },
  "a dead transport is reported even while a terminal record remains"
);
assert.deepEqual(
  connectionStatusView({ connected: true, sessions: ["legacy"] }, "conv-a"),
  { connected: true, hasTerminal: true, agentActive: false },
  "an older host with only sessions[] still reports a terminal"
);
assert.deepEqual(
  connectionStatusView(null, "conv-a"),
  { connected: false, hasTerminal: false, agentActive: false },
  "no connection is not a connection"
);

console.log("connection status: transport, terminal and agent activity stay independent");
