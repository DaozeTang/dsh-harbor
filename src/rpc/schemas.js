/**
 * Zod schemas for the dsh-harbor wire contract. Bundled into both faces:
 * the host typert manifest validates incoming args and outgoing results, and
 * the client contribution validates the same envelope on the browser side.
 *
 * Barrel only: the definitions live in ./schemas/<domain>.js; this module
 * re-exports exactly the public wire names so existing imports keep working.
 */

export {
  okSchema,
  resultSchema,
  sshErrorSchema,
} from "./schemas/common.js";

export {
  authSchema,
} from "./schemas/auth.js";

export {
  connectRequestSchema,
  connectResultPayloadSchema,
  connectResultSchema,
  disconnectRequestSchema,
  disconnectResultSchema,
  forgetHostKeyRequestSchema,
  forgetHostKeyResultSchema,
  listKnownHostsRequestSchema,
  listKnownHostsResultSchema,
  listRequestSchema,
  listResultSchema,
  selectConnectionRequestSchema,
  selectConnectionResultSchema,
} from "./schemas/connections.js";

export {
  cancelProfileConnectRequestSchema,
  cancelProfileConnectResultSchema,
  groupDeleteRequestSchema,
  groupDeleteResultSchema,
  groupListRequestSchema,
  groupListResultSchema,
  groupSaveRequestSchema,
  groupSaveResultSchema,
  openSshImportRequestSchema,
  openSshImportResultSchema,
  profileConnectRequestSchema,
  profileConnectResultSchema,
  profileConnectionStatusResultSchema,
  profileDeleteRequestSchema,
  profileDeleteResultSchema,
  profileDisconnectRequestSchema,
  profileDisconnectResultSchema,
  profileInfoSchema,
  profileListRequestSchema,
  profileListResultSchema,
  profileSaveRequestSchema,
  profileSaveResultSchema,
  resourceBackupExportRequestSchema,
  resourceBackupExportResultSchema,
  resourceBackupImportRequestSchema,
  resourceBackupImportResultSchema,
} from "./schemas/resources.js";

export {
  credentialDeleteRequestSchema,
  credentialDeleteResultSchema,
  credentialListRequestSchema,
  credentialListResultSchema,
  credentialSaveRequestSchema,
  credentialSaveResultSchema,
} from "./schemas/credentials.js";

export {
  remoteWorkspaceDeleteRequestSchema,
  remoteWorkspaceDeleteResultSchema,
  remoteWorkspaceListRequestSchema,
  remoteWorkspaceListResultSchema,
  remoteWorkspaceSaveRequestSchema,
  remoteWorkspaceSaveResultSchema,
} from "./schemas/workspaces.js";

export {
  scpReadRequestSchema,
  scpReadResultSchema,
  scpWriteRequestSchema,
  scpWriteResultSchema,
  sftpDeleteRequestSchema,
  sftpDeleteResultSchema,
  sftpEditorSaveRequestSchema,
  sftpEditorSaveResultSchema,
  sftpListRequestSchema,
  sftpListResultSchema,
  sftpMkdirRequestSchema,
  sftpMkdirResultSchema,
  sftpReadRequestSchema,
  sftpReadResultSchema,
  sftpRenameRequestSchema,
  sftpRenameResultSchema,
  sftpStatRequestSchema,
  sftpStatResultSchema,
  sftpTransferCancelRequestSchema,
  sftpTransferCancelResultSchema,
  sftpTransferDiscardResultSchema,
  sftpTransferListRequestSchema,
  sftpTransferListResultSchema,
  sftpWriteRequestSchema,
  sftpWriteResultSchema,
} from "./schemas/files.js";

export {
  changeDirectoryRequestSchema,
  closeSessionRequestSchema,
  closeSessionResultSchema,
  openSessionRequestSchema,
  openSessionResultSchema,
  readRequestSchema,
  readResultSchema,
  resizeRequestSchema,
  resizeResultSchema,
  terminalStreamRequestSchema,
  writeRequestSchema,
  writeResultSchema,
} from "./schemas/terminal.js";

export {
  agentSettingsGetRequestSchema,
  agentSettingsResultSchema,
  agentSettingsSaveRequestSchema,
  execPolicyGetRequestSchema,
  execPolicyGetResultSchema,
  execPolicySetRequestSchema,
  execPolicySetResultSchema,
  featureSettingsSchema,
  languageGetRequestSchema,
  languageResultSchema,
  languageSaveRequestSchema,
} from "./schemas/settings.js";

export {
  systemStatsRequestSchema,
  systemStatsResultSchema,
} from "./schemas/monitor.js";

export {
  batchCancelRequestSchema,
  batchCancelResultSchema,
  batchPlanRequestSchema,
  batchPlanResultSchema,
  batchRunRequestSchema,
  batchRunResultSchema,
  batchRunRowSchema,
  batchTaskListRequestSchema,
  batchTaskListResultSchema,
} from "./schemas/batch.js";

export {
  sessionLogDeleteRequestSchema,
  sessionLogDeleteResultSchema,
  sessionLogListRequestSchema,
  sessionLogListResultSchema,
  sessionLogReadRequestSchema,
  sessionLogReadResultSchema,
  sessionLogSearchRequestSchema,
  sessionLogSearchResultSchema,
} from "./schemas/logs.js";

export {
  tunnelListRequestSchema,
  tunnelListResultSchema,
  tunnelStartDynamicRequestSchema,
  tunnelStartDynamicResultSchema,
  tunnelStartLocalRequestSchema,
  tunnelStartLocalResultSchema,
  tunnelStartRemoteRequestSchema,
  tunnelStartRemoteResultSchema,
  tunnelStopRequestSchema,
  tunnelStopResultSchema,
} from "./schemas/tunnels.js";
