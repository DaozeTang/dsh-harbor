/**
 * A fake host for the offline preview.
 *
 * The preview renders the real workbench against this object, so what a design
 * review looks at is the shipping components with plausible data — not a
 * separate mock-up that can drift. Unknown RPCs resolve to a benign default so
 * a newly added method does not blank the page while its screen is still being
 * built.
 */
const now = new Date("2026-03-02T10:24:03+08:00").toISOString();

const PROFILES = [
  { profileId: "p1", name: "prod-web-01", host: "10.0.0.12", port: 22, username: "root", groupId: "g1", groupName: "生产", authKind: "key", hostKeyMode: "accept-new", connected: true, credentialConfigured: true, defaultProjectPath: "/srv/app" },
  { profileId: "p2", name: "staging-db", host: "10.0.0.31", port: 22, username: "ubuntu", groupId: "g2", groupName: "测试", authKind: "password", hostKeyMode: "accept-new", connected: false, credentialConfigured: true },
  { profileId: "p3", name: "edge-cdn", host: "cdn.internal", port: 2222, username: "ops", groupId: "g1", groupName: "生产", authKind: "key", hostKeyMode: "verify", connected: false, credentialConfigured: true }
];

const CONNECTIONS = [
  {
    connectionId: "c1", name: "prod-web-01", host: "10.0.0.12", port: 22, username: "root",
    connected: true, sessions: ["s1"], agentSession: true
  },
  {
    connectionId: "c2", name: "staging-db", host: "10.0.0.31", port: 22, username: "ubuntu",
    connected: true, sessions: ["s2"]
  }
];

// Entries follow the wire contract (SftpEntry in src/rpc/typert.js):
// name, isDirectory, size, mtime in ms, mode as the numeric st_mode. A mock
// with its own shape makes the preview show behaviour the host never has.
const nowMs = new Date(now).valueOf();

const FILES = [
  { name: "www", isDirectory: true, size: 4096, mtime: nowMs, mode: 0o040755 },
  { name: "log", isDirectory: true, size: 4096, mtime: nowMs, mode: 0o040755 },
  { name: "lib", isDirectory: true, size: 4096, mtime: nowMs, mode: 0o040755 },
  { name: "nginx", isDirectory: true, size: 4096, mtime: nowMs, mode: 0o040755 },
  { name: "access.log", isDirectory: false, size: 18_442_301, mtime: nowMs, mode: 0o100644 },
  { name: "error.log", isDirectory: false, size: 902_144, mtime: nowMs, mode: 0o100640 },
  { name: "deploy.sh", isDirectory: false, size: 2_118, mtime: nowMs, mode: 0o100755 },
  { name: "app.env", isDirectory: false, size: 812, mtime: nowMs, mode: 0o100600 }
];

const TERMINAL_BANNER = [
  "Welcome to Ubuntu 24.04.1 LTS (GNU/Linux 6.8.0-45-generic x86_64)",
  "",
  "Last login: Mon Mar  2 09:58:11 2026 from 10.0.0.1",
  "root@prod-web-01:~# uptime",
  " 10:24:03 up 42 days,  3:11,  1 user,  load average: 0.08, 0.12, 0.09",
  "root@prod-web-01:~# df -h / /var",
  "Filesystem      Size  Used Avail Use% Mounted on",
  "/dev/nvme0n1p2   78G   32G   43G  43% /",
  "/dev/nvme0n1p3  342G  118G  207G  37% /var",
  "root@prod-web-01:~# systemctl is-active nginx",
  "active",
  "root@prod-web-01:~# journalctl -u nginx --since '10 min ago' --no-pager | tail -4",
  "Mar 02 10:18:41 prod-web-01 nginx[812]: 10.0.0.7 - - [02/Mar/2026:10:18:41 +0800] \"GET /healthz HTTP/1.1\" 200 2",
  "Mar 02 10:19:02 prod-web-01 nginx[812]: 10.0.0.9 - - [02/Mar/2026:10:19:02 +0800] \"POST /api/orders HTTP/1.1\" 201 1382",
  "Mar 02 10:21:15 prod-web-01 nginx[812]: 10.0.0.7 - - [02/Mar/2026:10:21:15 +0800] \"GET /healthz HTTP/1.1\" 200 2",
  "Mar 02 10:23:58 prod-web-01 nginx[812]: 10.0.0.7 - - [02/Mar/2026:10:23:58 +0800] \"GET /healthz HTTP/1.1\" 200 2",
  ""
];

function streamOnce(text, offset) {
  const chunk = text.slice(offset);
  return { data: chunk, exit: null, startOffset: offset, offset: offset + chunk.length };
}

let streamCursor = 0;
let bannerSent = false;
// Recorded-session fixture. Shapes follow SessionLogInfo /
// SessionLogReadResult in src/rpc/schemas.js, so the logs pane exercises its
// real paging and highlight paths instead of a parallel mock contract.
const SESSION_LOG_TEXT = [
  ...TERMINAL_BANNER,
  "Mar 02 10:24:18 prod-web-01 systemd[1]: WARNING: unit harbor-agent.service entered failed state",
  "Mar 02 10:24:20 prod-web-01 sshd[123]: error: kex_exchange_identification: Connection closed by remote host",
  "Mar 02 10:24:21 prod-web-01 kernel: [ 9021.441] EXT4-fs (nvme0n1p2): re-mounted. Opts: errors=remount-ro",
  ""
].join("\r\n");

const SESSION_LOGS = [
  {
    sessionId: "76137702", connectionId: "c1", name: "prod-web-01", host: "10.0.0.12", port: 22,
    openedBy: "panel", startedAt: now, endedAt: null, exitCode: null,
    bytes: SESSION_LOG_TEXT.length, truncated: false
  },
  {
    sessionId: "83431f89", connectionId: "c2", name: "staging-db", host: "10.0.0.31", port: 22,
    openedBy: "agent", startedAt: now, endedAt: now, exitCode: 0,
    bytes: SESSION_LOG_TEXT.length, truncated: false
  }
];


export function createMockApi() {
  const handlers = {
    list: async () => ({ connections: CONNECTIONS, activeConnectionId: "c1" }),
    agentSettingsGet: async () => ({
      agentAutoConnect: true,
      features: { tunnelTools: true, logTools: true, showTunnels: true, showSnippets: true, showLogs: true }
    }),
    agentSettingsSave: async () => ({ agentAutoConnect: true, features: {} }),
    profileList: async () => ({ profiles: PROFILES }),
    groupList: async () => ({ groups: [{ groupId: "g1", name: "生产" }, { groupId: "g2", name: "测试" }] }),
    credentialList: async () => ({
      credentials: [
        { credentialId: "cred1", name: "prod 运维私钥", authKind: "key", credentialConfigured: true, passphraseConfigured: true, secondaryConfigured: false },
        { credentialId: "cred2", name: "共享 root 密码", authKind: "password", credentialConfigured: true, passphraseConfigured: false, secondaryConfigured: false }
      ]
    }),
    batchTaskList: async () => ({ tasks: [] }),
    execPolicyGet: async () => ({ effective: "standard", source: "global", allow: ["systemctl status", "docker ps"], global: { policy: "standard", allow: [] }, profileOverride: null }),
    execPolicySet: async () => ({ effective: "standard", source: "session", allow: [], global: { policy: "standard", allow: [] }, profileOverride: null }),
    languageGet: async () => ({ language: "zh", autoApplySystemLanguage: true }),
    languageSave: async () => ({ language: "zh", autoApplySystemLanguage: true }),

    openSession: async () => ({ sessionId: "s1" }),
    write: async () => ({}),
    resize: async () => ({}),
    selectConnection: async () => ({ activeConnectionId: "c1" }),
    disconnect: async () => ({ disconnected: 1 }),
    streamTerminal: async function* (_sessionId, _signal, _offset = 0) {
      // The banner ends with a newline; the prompt is appended once here so the
      // mock transcript matches what a real shell leaves on screen.
      const banner = TERMINAL_BANNER.join("\r\n") + "root@prod-web-01:~# ";
      // Emitted once per page: a remounting pane re-subscribes from its pooled
      // offset, and replaying the welcome block would duplicate the transcript.
      if (!bannerSent) {
        bannerSent = true;
        streamCursor = banner.length;
        yield { data: banner, exit: null, startOffset: 0, offset: banner.length };
      }
      // Keep the stream open like a quiet terminal: the pane shows the prompt
      // and the heartbeat keeps the connection marked alive.
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        yield { data: "", exit: null, startOffset: streamCursor, offset: streamCursor };
      }
    },
    read: async (_sessionId, _ms, offset = 0) => streamOnce(TERMINAL_BANNER.join("\r\n") + "root@prod-web-01:~# ", offset),

    sftpList: async (connectionId, path) => ({ path: path ?? "/var", entries: FILES }),
    sftpStat: async (connectionId, path) => ({ path, isDirectory: false, size: 2118, mtime: nowMs, mode: 0o100644 }),
    sftpReadFile: async () => {
      const text = "server {\n  listen 443 ssl;\n}\n";
      return { data: new TextEncoder().encode(text), bytes: text.length, truncated: false };
    },
    sftpEditorSave: async (connectionId, path) => ({
      path,
      backup: path + ".dsh-backup-4f1c2b8a-9d3e-4a6b-8c2d-1e5f7a9b0c3d"
    }),
    sftpWriteFile: async () => ({ written: true }),
    sftpUploadFile: async (connectionId, path, file, onProgress) => {
      onProgress?.(file.size, file.size);
      return { path, bytes: file.size };
    },
    sftpMkdir: async () => ({}),
    sftpDelete: async () => ({}),
    sftpRename: async () => ({}),
    sftpTransferList: async () => ({ transfers: [] }),
    scpReadFile: async () => ({ data: new Uint8Array(), truncated: false }),
    scpWriteFile: async () => ({}),


    tunnelList: async () => ({
      tunnels: [
        { tunnelId: "t1", kind: "local", bindAddr: "127.0.0.1", bindPort: 13306, remoteHost: "10.0.0.31", remotePort: 3306, active: true, connections: 0 },
        { tunnelId: "t2", kind: "dynamic", bindAddr: "127.0.0.1", bindPort: 11080, remoteHost: "", remotePort: 0, active: true, connections: 2 }
      ]
    }),
    tunnelStartLocal: async () => ({}),
    tunnelStartRemote: async () => ({}),
    tunnelStartDynamic: async () => ({}),
    tunnelStop: async () => ({ stopped: true }),

    sessionLogList: async () => ({ enabled: true, logs: SESSION_LOGS }),
    sessionLogRead: async (sessionId, offset = 0, maxBytes = 48 * 1024) => {
      const data = SESSION_LOG_TEXT.slice(offset, offset + maxBytes);
      const nextOffset = offset + data.length;
      return { sessionId, data, startOffset: offset, nextOffset, eof: nextOffset >= SESSION_LOG_TEXT.length, size: SESSION_LOG_TEXT.length };
    },
    sessionLogSearch: async (sessionId, query) => {
      const hits = [];
      let index = 0;
      for (const line of SESSION_LOG_TEXT.split("\r\n")) {
        if (line.toLowerCase().includes(query.toLowerCase())) hits.push({ offset: index, line });
        index += line.length + 2;
      }
      return { sessionId, hits, scannedBytes: SESSION_LOG_TEXT.length, stoppedEarly: false };
    },
    sessionLogDelete: async () => ({ deleted: 1, remaining: SESSION_LOGS.length - 1 }),

    listKnownHosts: async () => ({ hosts: [{ host: "10.0.0.12", port: 22, algorithm: "ssh-ed25519", fingerprint: "SHA256:9f2c7be1c0d9f1a2b8e4d6c3a1f0e9d8c7b6a5", firstSeenAt: now, lastSeenAt: now }] }),
    forgetHostKey: async () => ({ forgotten: true }),
    remoteWorkspaceList: async () => ({ bindings: [], workspaces: [{ path: "/Users/operator/DSH/session-8f2c1a", title: "session-8f2c1a" }] }),
    resourceBackupExport: async () => ({ archive: "" }),
    openSshImport: async () => ({ preview: { fingerprint: "open-ssh", entries: [] } })
  };

  return new Proxy(handlers, {
    get(target, property) {
      if (property in target) return target[property];
      if (typeof property !== "string") return undefined;
      // Benign default: a screen under construction should render, not throw.
      return async () => ({});
    }
  });
}