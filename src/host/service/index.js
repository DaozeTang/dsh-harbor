/**
 * Composition root for the Harbor service. Each concern contributes one
 * prototype layer; the final class is the sum of those layers plus the
 * transport interop that stays in src/index.js.
 */
import { HarborServiceBase } from "./harbor-service.js";
import { withConnections } from "./connections.js";
import { withCredentials } from "./credentials.js";
import { withRemoteWorkspaces } from "./remote-workspaces.js";
import { withResources } from "./resources.js";
import { withSettings } from "./settings.js";
import { withSessions } from "./sessions.js";
import { withExec } from "./exec.js";
import { withAgentActions } from "./agent.js";
import { withFiles } from "./files.js";
import { withTransfers } from "./transfers.js";
import { withStreamRoutes } from "./stream-routes.js";
import { withTunnels } from "./tunnels.js";
import { withBatch } from "./batch.js";
import { withSessionLogs } from "./session-logs.js";
import { withMonitor } from "./monitor.js";

const MIXINS = [
  withConnections,
  withCredentials,
  withRemoteWorkspaces,
  withResources,
  withSettings,
  withSessions,
  withExec,
  withAgentActions,
  withFiles,
  withTransfers,
  withStreamRoutes,
  withTunnels,
  withBatch,
  withSessionLogs,
  withMonitor
];

export const HarborServiceCore = MIXINS.reduce((Base, mixin) => mixin(Base), HarborServiceBase);
