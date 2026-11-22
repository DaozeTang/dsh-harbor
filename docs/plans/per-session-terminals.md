# 终端与会话绑定：每个 DSH 会话独占一个 SSH 终端

> 状态：**已实施（0.3.0）** · 作者：Harbor 维护者
>
> 实施记录与草案的差异：
> 1. tty 学习改为「打开后后台 census + 未被占用最新者」（草案的 `before` 快照会多一次探测在关键路径上），并用 `conn.ttyCensus` 记住上次结果做差集；`resolveTerminalTty` 是服务构造器里的显式开关（默认开），测试桩不会探测假 transport。
> 2. 作用域最终只实现 `conversation`（D 决策为「对话级」）；`terminalScope` 字段保留为将来 `agent` 级预留，代码已按参数化实现。
> 3. 领取队列增加 30 秒 TTL；`mine` 由宿主按调用方会话算出，客户端只在缺失时用 `ownerSessionId` 兜底。
> 4. 额外收获：agent 自行打开的终端（`ssh_write` 懒开）也会带上 `agentRevealOwnerSessionId`，让面板把它揭示到正确的对话里。
> 5. 每次 `resolveOwnerSession` 都从会话自身派生（索引缺失时），避免任何「静默没有终端」的分支。
> 6. 范围外补充：面板关闭服务器标签改为「只结束本对话的终端」，只有没有其他对话在这条连接上还有终端时才断开 transport（否则关标签会掐掉别的对话的终端）；规则提取为 `closeTabAction()` 并有测试。

## 1. 现状与问题

### 1.1 当前模型

今天 Harbor 的模型是「**一条 SSH 连接 = 一个终端池**」：

| 层 | 现状 | 位置 |
| --- | --- | --- |
| 连接 | 一条 ssh2 transport，`conn.sessions: Set<sessionId>` 可含多个 PTY | `src/host/service/connections.js` |
| 终端 | 每个 PTY 一条 channel，记录里只有 `openedBy: "panel" \| "agent"`，**没有会话归属** | `src/index.js:121-151` |
| 面板 | 按 `connection.sessions[0]` 取「第一个终端」显示 | `src/client/HarborPanel.jsx:378` |
| Agent 目标 | `activeConnectionId` 是**进程级单值** | `src/host/service/harbor-service.js:46` |
| 写入 | `writeToConnection()` **广播到该连接的所有终端** | `src/host/service/exec.js:418-428` |
| 读取 | `readConnectionOutput()` 读「第一个存活终端」 | `src/host/service/exec.js:471` |
| exec 回显 | 命令与输出**镜像到该连接的所有终端** | `src/host/service/exec.js:344-352` |
| 网络 CLI | `conn.cliBusy` 是**连接级**串行锁；命令打进「第一个终端」 | `src/host/service/exec.js:172-183, 209` |
| exec cwd | 用 `/proc` 找「该 transport 上**唯一**的前台交互 shell」来继承目录 | `src/host/exec-cwd.js:59-81` |

因此两个 DSH 会话（对话 A、对话 B）在同一台服务器上并行工作时：

1. 面板 A 与面板 B 都显示 `sessions[0]`——同一个终端，互相刷屏；
2. A 的 Agent `ssh_write` 把按键同时打进 A、B 两个终端（`writeToConnection` 广播）；
3. A 的 Agent `ssh_read` 读到 B 终端里的内容（含 B 里人敲的密码提示、B 的命令输出）；
4. A 的 `ssh_exec` 回显出现在 B 的终端里；
5. 谁先点服务器条，全局 `activeConnectionId` 就归谁，另一个会话的 Agent 会「打错机器」；
6. 因为一条连接上出现多个 shell，`exec cwd` 解析直接退化（`multiple interactive shells match this connection`），`ssh_exec` 从登录目录跑。

### 1.2 已有但不够用的机制

- 连接对话框的「复用已打开的连接」默认关闭：面板里两次连接同一台服务器会得到**两条独立连接**，因此各有一个终端。这只能解决人工操作，Agent 侧 `ssh_connect_profile` 恒定 `reuseExisting: true`（`src/host/service/agent.js:121`），必然共用。
- `changeDirectory` / `enableShellIntegration` 用 `conn.sessions.size === 1` 做前置校验（`src/host/service/sessions.js:49`、`src/index.js:221`），说明「多终端」在现有实现里本来就被当成不支持的状态。

## 2. 目标与非目标

### 目标

1. **每个 DSH 会话（对话）在每台服务器上拥有自己的 PTY**：面板只看自己的终端，Agent 只读写自己的终端。
2. **人机共用不变**：同一个会话里，操作者在面板敲的键和 Agent 的 `ssh_write` 仍然落在**同一个**终端上（这是产品承诺，只是把「每服务器一个」改成「每会话每服务器一个」）。
3. **Agent 目标连接按会话绑定**：`ssh_exec` 等省略 `connection_id` 时，按**调用方会话**解析，不再靠全局单值。
4. **exec 的 cwd 继承继续可用**：多终端成为常态后，`ssh_exec` 仍应落在**本会话终端**的当前目录。
5. 旧客户端、旧面板、设置页等**无会话上下文**的调用保持可用（匿名终端 + 收养规则）。

### 非目标

- 不改变「一条 SSH 连接承载多个 channel」的传输模型（不做「每会话一条 transport」）。
- 不改 SFTP / 转发 / 批量任务的资源共享模型（这些本来就与 PTY 无关）。
- 不做终端「接管」式的跨会话写操作（跨会话只读，见 §7 可选）。
- 不把会话日志（session log）切分为按会话存储（保持按 PTY 记录）。

## 3. 核心模型

### 3.1 归属标识

```js
// ownerSessionId: DSH SessionId 字符串；null 表示匿名（旧客户端 / 设置页 / 升级前遗留）
session.ownerSessionId = "…" | null;
session.ownerKind = "panel" | "agent";   // 谁开的
session.tty = "/dev/pts/3" | null;        // 由 census 探针学习（§6）
session.cliBusy = false;                  // 从 conn 迁移到 session
```

**终端主键 = `(connectionId, ownerSessionId)`，同一主键最多一个存活 PTY。**

### 3.2 归属来源

| 调用方 | ownerSessionId 来源 |
| --- | --- |
| 右侧面板 | Slot 座席标准 prop `sessionId`。`sidebar.right.pane.tab` 在宿主里声明为 `scope: 'session'`，`inject` 的标准形状就是 `(sessionId, actions) => face`（官方 `sidebar-files` 的 `filesFace` 即此形状；`PropsRuntime<'sidebar.right.pane.tab'>` 直接带 `sessionId`）。`src/client/index.jsx:199` 的 `inject` 改为收 `sessionId` |
| Agent 工具 | `exec.agent.id`（`Agent.id: SessionId`）；PTC 子调度同样携带 `agent`（`dsh-tools` lib:1217） |
| 设置页 / 旧客户端 | 无 → `null`（匿名） |

### 3.3 作用域策略 `terminalScope`

子 Agent（subagent）的会话是独立 SessionId，默认策略下**归到根对话**：

```
conversation（默认）: owner = 沿 session.header.parentSession 上溯到 delegationDepth 0 的根会话
agent（可选）        : owner = exec.agent.id 本身（每个 subagent 一个独立、面板不可见的终端）
```

- `conversation`：符合「用户与 Agent 共用一个终端」的产品语义，subagent 的 `ssh_write` 会落进当前对话的终端，操作者看得见；代价是**同一对话内并行 subagent 仍可能互相干扰**（仅限交互式写入）。
- `agent`：最大隔离；代价是 subagent 各开 PTY（受 sshd `MaxSessions` 限制）且面板看不到。

上溯实现：`ctx.get("agents").get(sessionId)` → `agent.session.header.parentSession`（`dsh-agent/lib/types/index.d.ts:341` 提供 `get(id)`；子会话 header 记录 `parentSession`，见 `dsh-subagent` 的 `childSessionMeta`）。解析失败时降级为 `agent` 语义（不共享，宁多勿串）。

### 3.4 新增状态

```js
// HarborService
activeConnectionByOwner = new Map();  // ownerSessionId -> connectionId
activeConnectionId = null;            // 兼容保留：无会话上下文的最后一个选择
terminalScope = "conversation";       // 设置项（settings 域，可后置）

// connection record
conn.ownerIndex = new Map();          // ownerKey(string|"") -> Set<sessionId>（旧→新）
conn.openQueue = Promise.resolve();   // 串行化 PTY 建立 + tty census

// session record（见 3.1）
```

### 3.5 解析阶梯

```js
resolveOwnerSession(conn, ownerSessionId)      // 该主键下最新存活 PTY
  → ownerSessionId != null ? conn.ownerIndex.get(ownerSessionId) 中最新的存活者
  → ownerSessionId == null ? conn.ownerIndex.get("") 中最新的存活者
  → null

ensureOwnerSession(conn, ownerSessionId, { adopt = true })
  → resolveOwnerSession 命中即返回（reused: true）
  → adopt 且该连接恰有 1 个存活的匿名 PTY → 认领（改 ownerSessionId 并迁移索引，reused: true）
  → 否则在 openQueue 里新建 PTY

resolveConnection(connectionId, ownerSessionId)   // agent.js
  1. 显式 connectionId → 用它
  2. activeConnectionByOwner.get(owner) → 用它（连接仍存活）
  3. 该会话在此连接上有存活终端、且唯一 → 用它（"我的终端在哪就在哪"）
  4. 全局 activeConnectionId（兼容旧客户端）
  5. 只有一条连接 → 用它
  6. 否则 connection-selection-required
```

## 4. 行为对照

| 场景 | 改前 | 改后 |
| --- | --- | --- |
| 对话 A、B 打开同一服务器 | 共用 1 个 PTY | 各自 1 个 PTY，互不影响 |
| 面板显示哪个终端 | `sessions[0]` | 本会话的终端；没有则显示「打开终端」空态 |
| `ssh_write` | 广播到该连接所有终端 | 只写本会话终端（无则按需开一个） |
| `ssh_read` | 读第一个存活终端 | 只读本会话终端（无则 `hasSession:false`） |
| `ssh_exec` 回显 | 镜像到所有终端 | 只镜像到本会话终端（无终端则不镜像，同今天） |
| `ssh_exec` 省略 connection_id | 全局 activeConnectionId | 本会话绑定的连接 → 否则兜底阶梯 |
| `ssh_exec` 的 cwd | 唯一交互 shell 的 cwd | **本会话终端**的 cwd（tty 定位） |
| 网络 CLI 串行锁 | 连接级 | 会话级 |
| 面板点服务器条 | 全局改 Agent 目标 | 只改**本会话**的 Agent 目标 |
| 设置页连接 + cd | 打开终端（匿名） | 打开匿名终端，由首个领取的会话**收养** |
| 会话结束 | 终端留到连接断开 | `session/disposed` 关闭该会话终端 |

## 5. 改动清单（按文件）

### 5.1 Host — 新增模块

**`src/host/terminal-owner.js`**（纯函数，好测）
- `normalizeOwner(value)`：字符串校验（非空、≤128、无控制字符），否则 `null`。
- `ownerResolution(session, scope)`：`session.header.delegationDepth/origin` 判断是否需要上溯。
- `pickOwnerSession(conn, ownerKey, sessions)` / `countAnonymous(conn, sessions)`。
- `adoptableSession(conn, sessions)`：唯一匿名存活者。
- `rootOwnerSessionId(agent, getAgent)`：沿 `parentSession` 上溯（带环保护、最大 8 层）。

**`src/host/terminal-census.js`**（§6）
- `buildCensusScript({ procRoot })` / `parseCensus(stdout)` / `pickNewTty(before, after)`。

### 5.2 Host — 会话/连接

**`src/index.js`**
- `openSession(request)`（98-213）
  - 读 `request.sessionId` → `ownerSessionId`（`terminalScope` 归一）；
  - 命中已有/可收养 → 直接返回 `{ sessionId, reused: true, ownerSessionId }`，**不新建 channel**；
  - 整个「查重 + 建 channel + tty census」放进 `conn.openQueue` 串行段；
  - 记录里新增 `ownerSessionId / ownerKind / tty / cliBusy / capture…（不变）`；
  - 索引维护：`conn.ownerIndex`；
  - 185 行 `this.activeConnectionId = …` → `this.bindActiveConnection(connectionId, ownerSessionId)`；
  - channel 建立后异步 `resolveSessionTty(conn, session)`（不阻塞返回，失败静默 + 日志）。
- `enableShellIntegration`（215-247）与 `sessions.js` 的 `changeDirectory` 守卫：`conn.sessions.size === 1` → `singleInteractiveShell(conn) || session.tty !== null`。
- `appendSessionOutput` / `recordExit`：退出时同时维护 `conn.ownerIndex`。
- `ctx.on("session/disposed", …)`：关闭该 owner 的全部终端（`session/disposed` 在 `dsh-session` 有事件声明）。
- 构造器卸载清理：`activeConnectionByOwner.clear()`。

**`src/host/service/harbor-service.js`**
- 新增 `activeConnectionByOwner`、`terminalScope`；`activeConnectionId` 保留为兼容字段（注释说明）。
- 新增方法 `bindActiveConnection(connectionId, owner)` / `activeConnectionFor(owner)` / `closeTerminalsForOwner(owner)`。

**`src/host/service/connections.js`**
- `connectInternal`：`record.ownerIndex = new Map(); record.openQueue = Promise.resolve();`；`activate` 保持（只影响兼容字段，另外若请求带 `sessionId` 则 `bindActiveConnection`）。
- `handleTransportLoss`（611-620）/`disconnect`（708-719）：删会话时同步清 `ownerIndex`。
- `openSession` 相关队列在断开时置空。

**`src/host/service/sessions.js`**
- `write`：不变（以 sessionId 为目标），仅 `noteTerminalInput` 保持连接级节流。
- `changeDirectory`（39-69）：守卫改为 tty 已知即可；探针命令带上 `{ tty: session.tty }`。
- `listTerminalContexts(request)`（130-141）：每项增加 `ownerSessionId`（nullable）与 `mine`（`request.sessionId` 比较）。
- `closeSession`（224-236）、`pruneExitedSessions`（257-266）：同步 `ownerIndex`。

**`src/host/service/agent.js`**（核心改动）
- `list(request)`：`request.sessionId` 决定
  - `activeConnectionId` = 该会话绑定（兜底全局）；
  - 每条连接新增 `terminals: [{ sessionId, ownerSessionId, openedBy, alive, mine }]`（`sessions: string[]` 保留，标记 deprecated）；
  - `agentSession` 判据改为「该会话有 agent 开的终端」。
- `selectConnection({ connectionId, sessionId })`：有会话写 `activeConnectionByOwner`，无会话写兼容字段。
- `agentConnectProfile({ resource, sessionId })`：
  - 137 行 `connection.sessions.size === 0` → `ensureOwnerSession(conn, ownerSessionId, { adopt: false })`（不回滚别人的终端）；
  - rollback 恢复本会话绑定；`terminalOpened` 表示「本次为该会话新开」；
  - `connection.agentRevealOwnerSessionId = ownerSessionId`。
- `resolveConnection(connectionId, ownerSessionId)`：§3.5 阶梯。
- `executeCommand / readCurrentConnection / writeCurrentConnection / ensureSessionForWrite / disconnectCurrentConnection`：全部接收并转发 `sessionId`；`ensureSessionForWrite` 用 `ensureOwnerSession`。

**`src/host/service/exec.js`**
- `execOnConnection(connectionId, command, timeoutMs, retried, approvalToken, ownerSessionId)`：
  - `const owner = this.resolveOwnerSession(conn, ownerSessionId)`（只读，用于 cwd/镜像/CLI 路由）；
  - `runPreparedExec(..., { ownerSessionId })`：`buildCwdAwareCommand(prepared, { tty: owner?.tty })`；镜像循环（344-352）只写 `owner` 一个会话。
- `cliExecOnConnection(conn, command, timeoutMs, ownerSessionId)`：选 owner 终端；没有则报「本会话还没有终端」（新文案）；`conn.cliBusy` → `session.cliBusy`。
- `writeToConnection(connectionId, input, ownerSessionId)` → 改为 `writeToOwnerSession(connectionId, input, ownerSessionId)`：只写 owner（广播循环删除）；保留旧签名兼容（owner 为 `undefined` 时退化为「写所有」（仅旧客户端），并标记 deprecated）。
- `readConnectionOutput(connectionId, mode, ownerSessionId)`：471 行改为 owner（无 owner 时维持旧「第一个」行为，供旧客户端）。
- 新增 `resolveOwnerSession(conn, owner)` 复用 `terminal-owner.js`。

**`src/host/service/settings.js`**
- `execPolicyGet({ connectionId, sessionId })`：164 行兜底改 `activeConnectionFor(sessionId)`。
- `execPolicySet`：可选把覆盖键改为 `(connectionId, owner)`（§9 待定）。

**`src/host/service/remote-workspaces.js`**
- `resolveRemoteToolPath(request, exec)`：把 `exec?.agent?.id` 作为 owner 传下去。
- `revealRemoteWorkspaceConnection(connection, state)`：`liveSession` 判据（192-195）→ `ensureOwnerSession(conn, owner, { adopt: true })`；`selectConnection` 带 owner。

**`src/host/service/constants.js`**
- `MAX_SESSIONS_PER_OWNER = 1`、`MAX_SESSIONS_PER_CONNECTION = 8`、`SESSION_TTY_PROBE_MS = 4000`。

### 5.3 Host — 工具层

**`src/host/tools/ssh-session.js`**
- 每个 `execute(args, exec)` 取 `const sessionId = exec?.agent?.id`，透传：
  - `ssh_exec` → `executeCommand({…, sessionId})`；
  - `ssh_read` / `ssh_write` / `ssh_disconnect` → 对应方法；
  - `ssh_connect_profile` / `ssh_connect` → `sessionId`（新终端即本会话所有）；
  - `ssh_terminal_sessions` → `listTerminalContexts({ sessionId })`；
  - `ssh_terminal_context` → 省略 `session_id` 时默认**本会话终端**（仍走审批）。
- `tools/pre-execute` 网关（57 行）`resolveConnection(connection_id)` → `resolveConnection(connection_id, execution.agent?.id)`。
- 精选文案更新（模型依赖描述）：`ssh_exec`/`ssh_read`/`ssh_write` 明确「每个对话各有自己的终端；不带 session_id 时只看/写本对话的终端；要看别的会话的终端请传 session_id」。

**`src/host/tools/sftp.js`**：`resolveRemoteToolPath(request, exec)` 已经带 exec，无需改签名（靠 5.2 的 owner 透传）。**`batch.js` / `tunnel.js`**：不涉及 PTY，不改。

### 5.4 RPC 契约

**`src/rpc/schemas.js`**
- 统一新增 `ownerSessionIdSchema = z.string().min(1).max(128).optional()`；
- 加参：`listRequestSchema`、`selectConnectionRequestSchema`、`openSessionRequestSchema`（+ `adopt: z.boolean().optional()`）、`profileConnectRequestSchema`、`connectRequestSchema`、`execPolicyGetRequestSchema`、`execPolicySetRequestSchema`、`terminalContextListRequestSchema`；
- 加字段：`connectionInfoSchema.terminals`、`openSessionResultSchema.{reused, ownerSessionId}`、`terminalContextSessionSchema.{ownerSessionId, mine}`、`connectionInfoSchema.{agentSession, agentRevealId, agentRevealOwnerSessionId}`；
- `listResultSchema.activeConnectionId` 语义改为「按请求会话解析后的值」，向后兼容。

**`src/rpc/typert.js`**：手写声明同步（`test/typert-sync.mjs` 会校验）。
**`src/rpc/descriptors.js`**：方法名不变，无需新增条目。

### 5.5 客户端

**`src/client/index.jsx`**（199 行）
```js
inject: (sessionId) => ({ api, credentials: ctx.remote?.credentials, sessionId })
```
（旧宿主不传时为 `undefined`，面板降级为兼容路径。）

**`src/client/HarborSidebarBody.jsx`**：透传 `sessionId` 给 `HarborPanel`。
**`src/client/HarborPanel.jsx`**
- `refreshConnections` / 轮询：`api.list(sessionId)`；
- `bindAgent`：`api.selectConnection(connectionId, sessionId)`；
- `openSession`：`api.openSession(connectionId, 100, 30, { sessionId, adopt: true })`；
- 终端解析 `terminalFor(connection)`：`connection.terminals?.find(t => t.mine && t.alive)`；
- 空态文案分三种：「本会话还没有终端」（读其余终端数量给提示）/「其它会话正在使用该服务器（N 个终端）」/「连接已断开」；
- `cdFromFiles`（244）、`alive` 判断（271）、`sessions[0]`（378）改用解析结果；
- 服务器条 `Agent` 徽标 = 本会话目标（数据来自 `list(sessionId)`）。

**`src/client/api.js`**：`list(sessionId)`、`openSession(connectionId, cols, rows, { sessionId, adopt, openedBy })`、`selectConnection(connectionId, sessionId)`、`execPolicyGet/Set(connectionId, sessionId)`（全部向后兼容，旧参数位置不变）。

**`src/client/pane-selection.js`**：`requestPaneOpen(connectionId, { ownerSessionId, adopt })`；`claimPendingOpens(sessionId)` 只领取本会话或匿名条目；超过 30s 的条目丢弃（`pendingOpens` 从数组改为带时间戳的条目）。

**`src/client/store.js`**：`harborUiAnnounceAgentConnections(connections)` 读取 `agentRevealOwnerSessionId`，投递带 owner 的领取请求。

**`src/client/agent-connection-poll.js`**：无需改逻辑（匿名 list 也返回 reveal 字段）。

**`src/client/features/snippets/snippets-view.jsx:38`** 与 **`src/client/features/connect/connect-dialog.jsx:82`**：改用面板传入的 `sessionId` / 解析出的终端。

**`src/client/HarborResources.jsx:1249`**（设置页）：保持无 sessionId 的 `openSession`（匿名），随后 `requestPaneOpen(connectionId, { ownerSessionId: null, adopt: true })`，由首个领取的面板收养。

**`src/client/features/logs/logs-pane.jsx`**：可选显示终端归属（需 host 侧 `sessionLogList` 增加字段；列 P3）。

### 5.6 文档与版本

- `docs/product-guide.md:66` 的配方改写：「同一台机器开两个会话 → 各自一个终端；要刻意共享，用连接对话框的『复用已打开的连接』（此时两端共用同一 PTY，属显式选择）」。
- `README.md:28` / `README.en.md` 的「Agent 与终端共用一条连接」措辞改为「每个会话各自一个终端，Agent 与你在同一会话里共用它」。
- `CHANGELOG.md` 0.3.0 条目（破坏性语义变化 + 升级行为说明）。

## 6. exec cwd 继承：按 tty 定位本会话终端

现状 `exec-cwd.js` 要求「该 transport 上**唯一**的前台 shell」，多终端即退化。改法：

1. **census 探针**（新增，POSIX 登录 shell 才跑，4s 超时）
   - 脚本遍历 `/proc/[0-9]*`，按 `SSH_CONNECTION` 命中本 transport（与现逻辑一致）+ `fd/0` 为 pty + `comm` 属于 shell 家族；
   - 输出每行：`pid tty starttime pgrp tpgid argv…`（`/proc/<pid>/stat` 第 22 字段 starttime 天然近似单调）；
   - `parseCensus` 解析为 `[{pid, tty, startTime, …}]`。
2. **学习 tty**：`openSession` 在 `conn.openQueue` 内先 census 快照 → 建 channel → 再 census；差集恰为 1 个 tty 则记 `session.tty`；否则取「未被其他 session 占用且 starttime 最大」的候选；仍不唯一则留 `null`。
3. **定位**：`buildCwdAwareCommand(command, { procRoot, tty })` 在 `__dsh_find_shell` 里追加 `[ -n "$__dsh_tty_filter" ] && [ "$__dsh_tty" != "$__dsh_tty_filter" ] && continue`（按字面量注入 `/dev/pts/N`），其余空闲/前台判定不变。
4. **降级阶梯**：tty 已知 → 精确定位；tty 未知但该连接只有 1 个 shell → 现行为；否则 `status 3`（今天已有的 MULTI_DEGRADED 路径），提示里补一句「本会话终端尚未识别」。
5. 配置开关 `resolveTerminalTty`（默认 true）；无 `/proc` 的 BusyBox/非 Linux 主机自动失效，不影响主流程。

## 7. 面板可见性（可选增补，建议 P2）

默认只看本会话终端；若该连接存在其它会话的终端，空态/条上给出「另有 N 个终端」并提供一个**只读**查看器（复用 `readTerminalContext` + 审批链路，不能写入）。跨会话写入一律不提供——这正是要消除的干扰。

## 8. 生命周期与配额

- **会话结束**：`ctx.on("session/disposed", …)` → 关闭该 owner 的终端（记录退出原因 `session-closed`）。`session/disposed` 由 `dsh-session` 发出；监听用 `typeof ctx.on === "function"` 守卫（与现有 `tools/pre-execute` 同一写法），宿主没有该事件时退化为下面的惰性回收。
- **惰性回收（兜底）**：每次 `resolveOwnerSession` 时用 `ctx.get("sessions")?.get?.(ownerId)` 校验 owner 是否仍存活（`ctx.sessions.get` 由 `dsh-session` 提供），已消失则关闭其终端；这样即使事件缺失，终端也不会无限累积。
- **终端主动关闭**：不变（`closeSession`）。
- **传输断开/重连**：全部 owner 终端一起销毁（今天语义），重连后按需重建。
- **配额**：每 owner 每连接 1 个（`MAX_SESSIONS_PER_OWNER`）；每连接 ≤8 个（`MAX_SESSIONS_PER_CONNECTION`），超出返回 `terminal-limit` 并提示「服务器对单连接的并发 channel 有限制（sshd MaxSessions），可调高该值或另开一条连接」。全局 `MAX_SESSIONS=64` 不变。
- **不隐式开终端**：`ssh_exec` 不建 PTY（与今天一致），只有面板、`ssh_write`、`ssh_connect_profile`、远程工作区揭示会建。

## 9. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| sshd `MaxSessions`（默认 10）上限 | 多会话 + SFTP + exec 打满时新 channel 被拒绝 | 每连接配额 + 明确错误码与文案；文档说明；后续可加「超额时新开独立连接」 |
| PTY 数量增长 | 远端资源占用 | `session/disposed` 回收 + 不隐式开 + 每连接配额 |
| tty census 增加一次探测往返 | 开终端慢 50–200ms | 只对 POSIX 登录 shell 做、异步不阻塞返回、可关闭 |
| 旧客户端不传 sessionId | 回到「共用」语义 | 匿名终端 + 唯一匿名收养；所有新字段可选 |
| 子 agent 归属上溯失败 | 各自开终端（更多 PTY） | 失败降级为 `agent` 语义并日志；可配置 |
| 执行策略覆盖是连接级 | 对话 A 放宽后对话 B 的 Agent 也受益 | 见待定项 D（建议改为 `(connection, owner)`） |
| 回显不再出现在别的会话终端 | 操作者可能觉得「Agent 输出不见了」 | 同会话仍然可见；空态提示 + 服务器条计数 |

## 10. 测试计划

**新增**
1. `test/terminal-owner.mjs`：owner 归一化、作用域上溯（含环）、收养唯一性、每 owner 去重。
2. `test/per-session-terminals.mjs`（服务级，stub 连接）：
   - 两会话同连接各开一个 PTY（`openSession` 两次 → 两个 sessionId）；
   - 同会话重复 `openSession` → `reused:true` 同一个；
   - `writeToConnection` 只落到 owner；`readConnectionOutput` 只读 owner（含 `lastReadRaw` 游标独立）；
   - `execOnConnection` 只镜像到 owner；
   - `resolveConnection` 按会话解析（互不串台）；`selectConnection` 按会话生效；
   - `ensureSessionForWrite` 按会话开终端；
   - `agentConnectProfile` 两会话 → 两个终端，`terminalOpened` 均为 true；
   - 断链/断开 → 全部回收；`session/disposed` → 只回收该会话。
3. `test/terminal-census.mjs`：脚本生成 + 解析 + 差集选择（用 `test/exec-cwd.mjs` 的 fake `/proc` 手法，Linux 专属，win32 跳过）。
4. `test/panel-session-terminal.mjs`（jsdom，参照 `test/sftp-files-ui.mjs`）：面板按 `sessionId` 选终端、空态三态文案、`selectConnection` 带 sessionId。
5. `test/pane-reveal-owner.mjs`：领取队列只匹配本会话/匿名，超时丢弃。

**更新**
- `test/exec-cwd.mjs` / `test/exec-cwd-rules.mjs`：MULTI_DEGRADED 用例保留为「无 tty 过滤」分支，新增「tty 过滤精确定位」。
- `test/active-connection.mjs`：断言改为会话级映射 + 兼容字段。
- `test/ssh-write.mjs`：从「双终端广播」改为「只写 owner」。
- `test/agent-connect.mjs`、`test/remote-workspace-service.mjs`、`test/ask-gate.mjs`、`test/exec-policy.mjs`、`test/network-cli.mjs`（`cliBusy` 迁到 session）、`test/client.mjs`（api 包装参数）、`test/typert-sync.mjs`（契约）。

**验收**（人工，配 `test/support/test-sshd.mjs` 或真机）：
- 两个对话并行 `ssh_write` 到同一服务器，各自终端只出现自己的输入；
- 各自 `ssh_exec` 的 cwd 分别跟随各自终端 `cd` 的目录；
- 面板 A 关闭终端不影响 B；对话 A 结束后其终端自动关闭；
- 旧版面板（不带 sessionId）仍可打开并操作终端。

## 11. 分阶段实施

| 阶段 | 内容 | 可独立验收 |
| --- | --- | --- |
| P0 | `terminal-owner.js` + 数据模型 + `openSession/ensureOwnerSession` + 索引与回收 | 两会话两个 PTY，`ssh_terminal_sessions` 可见归属 |
| P1 | exec 读/写/镜像/CLI 按 owner + `resolveConnection` 会话化 + 工具透传 | 两会话互不串台 |
| P2 | RPC/typert 契约 + 客户端面板按会话选终端 + 领取队列 | 面板只显示本会话终端 |
| P3 | tty census + `buildCwdAwareCommand({tty})` + 守卫放宽 | 两会话各自 cwd |
| P4 | `session/disposed` 回收、配额与错误文案、文档/CHANGELOG、可选：跨会话只读查看、策略覆盖按 owner | 发布 0.3.0 |

工作量估计：P0+P1 ≈ 1.5 天，P2 ≈ 1 天，P3 ≈ 1 天，P4 ≈ 0.5 天（含测试）。

## 12. 待决策

A. **作用域粒度**：默认「对话」（subagent 归根会话、看得见但同对话内并行 subagent 仍可能抢终端）还是默认「agent」（最大隔离、面板看不见 subagent 终端、PTY 更多）？
B. **tty census**：接受开终端多一次 exec 探测（50–200ms）换来多终端下 cwd 继承，还是先不做、多终端时退化为登录目录？
C. **跨会话可见性**：面板要不要提供「其他会话终端」的只读查看入口（P2 可选）？
D. **执行策略覆盖**：保持连接级（简单，但跨会话放宽会外溢），还是改为「连接 + 会话」？
E. **发布方式**：见下方三选一。

### 附：E 的三个具体形态

| | E1 直接切换 | E2 默认开 + 可见开关 | E3 默认开 + 隐藏逃生阀 |
| --- | --- | --- | --- |
| 升级后体验 | 立刻是新语义 | 立刻是新语义，用户可关 | 立刻是新语义 |
| 出问题时 | 只能回装 0.2.x | 面板里一开关回到今天的共用行为 | 手改 `~/.dsh/harbor_settings.json` 的 `terminalPerSession: false` |
| 代码路径 | **一条**（旧广播/取首条逻辑删除） | **两条**（旧行为保留并长期测试） | 两条（旧行为只走隐藏分支） |
| 决策点分支 | 无 | `openSession` 归属 + `write` + `read` + `镜像` + `resolveConnection` 共 5 处 | 同 E2 |
| 额外工作量 | 0 | +0.5～0.8 天（设置行、i18n zh/en、schema、旧模式测试、文档） | +0.2～0.3 天（无 UI、一个回归测试） |
| 长期成本 | 低：只有一种语义要解释、要测 | 高：此后每个相关改动都要回答「共用模式怎么办」，且关闭开关时已存在的多终端语义含混（谁显示、谁写入） | 中：隐藏配置容易腐烂，但至少不进 UI |
| 适合 | 认为「每个会话一个终端」是唯一正确语义 | 有大量用户依赖共用终端，或 sshd `MaxSessions` 常常不够用 | 想要便宜的回退保险 |

推荐 **E1**，理由：

1. 这不是「多一个选项」，而是**修正归属语义**。共用终端下 `ssh_read` 能读到别的对话里的内容、`ssh_write` 会打进别人的终端，两个开关位置无法让同一套代码既安全又兼容。
2. E2 的「关闭开关」在运行期是有歧义的：一条连接上已经存在多个终端时，关掉开关意味着面板只显示 `sessions[0]`、写入广播回所有终端——正是要消除的行为，却要被长期保留和测试。
3. 真正的回退需求（sshd `MaxSessions` 不够）已有现成解法：连接对话框不勾「复用已打开的连接」，一台机器两条连接、两个终端，今天就能用；文档里写清即可。
4. 与 0.2.0 的做法一致：宁可删掉一条路径，也不留长期双轨（参见 CHANGELOG 0.2.0「移除数据库控制台」）。
