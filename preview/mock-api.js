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


let statsCalls = 0;

export function createMockApi(options = {}) {
  const handlers = {
    list: async () => ({ connections: CONNECTIONS, activeConnectionId: "c1" }),
    agentSettingsGet: async () => ({
      agentAutoConnect: true,
      features: { tunnelTools: true, logTools: true, statusTools: true, showTunnels: true, showSnippets: true, showLogs: true, showMonitor: true }
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

    // The status pane reads one normalized sample. Numbers are plausible and
    // slightly alive (a sine wobble per call) so a screenshot shows a trend
    // line after a few polling ticks instead of an empty box.
    systemStats: async () => {
      // "?unsupported" in the preview URL renders the honest empty state, so
      // that screen can be reviewed without a non-Linux host at hand.
      if (options.unsupported === true) {
        return {
          sampledAt: new Date(nowMs).toISOString(),
          sampleMs: 11,
          platform: "other",
          platformName: "Darwin",
          supported: false,
          reason: "no-procfs",
          capabilities: { processes: false, gpu: false, disks: false, io: false },
          gpu: [],
          disks: [],
          diskIo: null,
          network: [],
          processes: null,
          warnings: []
        };
      }
      statsCalls += 1;
      const wobble = Math.sin(statsCalls / 2.4) * 3.5;
      const k = 1024;
      return {
        sampledAt: new Date(nowMs + statsCalls * 2000).toISOString(),
        sampleMs: 38,
        platform: "linux",
        platformName: "Linux",
        supported: true,
        host: {
          hostname: "prod-web-01",
          os: "Ubuntu 24.04.1 LTS",
          kernel: "6.8.0-45-generic",
          arch: "x86_64",
          cores: 16,
          cpuModel: "Intel(R) Xeon(R) Gold 6248 CPU @ 2.50GHz",
          uptimeSeconds: 3648123
        },
        cpu: {
          usagePercent: Math.max(1, 12.4 + wobble),
          perCore: [8, 14, 22, 6, 31, 12, 9, 17, 5, 44, 11, 7, 19, 26, 3, 15],
          iowaitPercent: 0.4,
          stealPercent: 0,
          load: [0.08, 0.12, 0.09],
          cores: 16,
          model: "Intel(R) Xeon(R) Gold 6248 CPU @ 2.50GHz"
        },
        memory: {
          totalBytes: 16316332 * k,
          freeBytes: 1234567 * k,
          availableBytes: 7654321 * k,
          buffersBytes: 123456 * k,
          cachedBytes: 3580245 * k,
          swapTotalBytes: 2097148 * k,
          swapFreeBytes: 1048574 * k
        },
        gpu: [{
          index: 0,
          name: "NVIDIA GeForce RTX 4090",
          utilizationPercent: 78,
          memoryUsedBytes: 19661 * k * k,
          memoryTotalBytes: 24564 * k * k,
          temperatureC: 68,
          powerW: 310.4
        }],
        disks: [
          { mount: "/data", device: "/dev/nvme0n1p4", totalBytes: 1953000000 * k, usedBytes: 1800000000 * k, availableBytes: 153000000 * k, usePercent: 92 },
          { mount: "/", device: "/dev/nvme0n1p2", totalBytes: 81000000 * k, usedBytes: 34000000 * k, availableBytes: 47000000 * k, usePercent: 43 },
          { mount: "/var", device: "/dev/nvme0n1p3", totalBytes: 358000000 * k, usedBytes: 120000000 * k, availableBytes: 238000000 * k, usePercent: 34 }
        ],
        diskIo: { readBytesPerSec: 12 * k * k, writeBytesPerSec: 3.1 * k * k },
        network: [
          { name: "eth0", rxBytesPerSec: Math.round(1.2 * k * k + wobble * 8000), txBytesPerSec: 86 * k, rxTotalBytes: 987654321, txTotalBytes: 123456789 },
          { name: "docker0", rxBytesPerSec: 12400, txBytesPerSec: 9800, rxTotalBytes: 45678901, txTotalBytes: 12345678 }
        ],
        processes: {
          total: 823,
          running: 2,
          top: [
            { pid: 4213, name: "python3", cpuPercent: 84.2, memPercent: 12.1 },
            { pid: 902, name: "node", cpuPercent: 30.5, memPercent: 0.4 },
            { pid: 887, name: "nginx", cpuPercent: 3.0, memPercent: 1.2 },
            { pid: 1210, name: "postgres", cpuPercent: 1.4, memPercent: 6.8 },
            { pid: 640, name: "systemd-journal", cpuPercent: 0.6, memPercent: 0.3 }
          ]
        },
        capabilities: { processes: true, gpu: true, disks: true, io: true },
        warnings: []
      };
    },

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