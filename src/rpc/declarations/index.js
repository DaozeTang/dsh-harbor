// Aggregated declaration list, in the order the manifest publishes them.

import { BATCH_TYPES } from "./batch.js";
import { EXEC_TYPES } from "./exec.js";
import { FILES_TYPES } from "./files.js";
import { MONITOR_TYPES } from "./monitor.js";
import { RESOURCES_TYPES } from "./resources.js";
import { SETTINGS_TYPES } from "./settings.js";
import { SSH_TYPES } from "./ssh.js";
import { TERMINAL_TYPES } from "./terminal.js";
import { TUNNELS_TYPES } from "./tunnels.js";

export const DECLARATIONS = [
  ...BATCH_TYPES,
  ...EXEC_TYPES,
  ...FILES_TYPES,
  ...MONITOR_TYPES,
  ...RESOURCES_TYPES,
  ...SETTINGS_TYPES,
  ...SSH_TYPES,
  ...TERMINAL_TYPES,
  ...TUNNELS_TYPES,
];
