# Remote Machine：页面改名与「状态」标签

> 状态：**已实施（0.4.0）** · 基线：`main` @ `3b386f5`
>
> 实施记录与草案的差异（评审结论见 §11）：
> 1. 中文标签定为「远程主机」，英文 Remote Machine；插件名 Harbor / 远程运维 不变。
> 2. 卡片顺序按评审意见改为 CPU / GPU / 内存 / 磁盘 / 网络 / 进程 / 连接（GPU 紧跟 CPU）。
> 3. 探测脚本不走 stdin：改为 `sh -c '<script>'`，脚本内无单引号、无模板插值（`test/monitor-parse.mjs` 守住），`collectExecOutput` 零改动。
> 4. `df` / `diskstats` / `meta` 全部走慢节拍并跨拍携带；快拍只用 `/proc` + `ps` + 受 `command -v` 保护的 `nvidia-smi`。
> 5. `ssh_status` 工具同期加入（草案把它列为 Phase 2），与面板共用同一份采样与同一个 1 秒缓存。
> 6. 首拍不显示 0：`usagePercent` 为 null，面板显示「采样间隔尚未完成」。
> 7. 新增 `showMonitor` 与 `statusTools` 两个功能开关（默认开）。
> 8. 顺带扩展了 `ProgressBar` 的 `tone`（warn/err），并调整六标签在窄栏的退化规则（先压内边距、再到图标）。
>
> 一句话：把右侧栏那页从「远程终端」改成 **Remote Machine**，并在页内加一个只读的**状态**标签，用一条固定的远端探测脚本，把 CPU / 内存 / 磁盘 / 网络 / GPU / 进程变成面板上的实时仪表。

---

## 0. 摘要

| 部分 | 内容 | 影响面 |
| --- | --- | --- |
| A. 改名 | 侧栏标签、引导项、会话头按钮、设置页小节、README / INSTALL / 产品指南 | 纯文案 + 字典键，不动任何标识符（tab kind / id / settings section id 全部保持） |
| B. 新标签「状态」 | `VIEWS` 增加一项 + 新面板组件 + 新 host 采样通道 + 新 RPC（`systemStats`） | host 侧新增 4 个模块、RPC 契约 1 条、面板 1 套卡片、约 50 条文案 |
| C. 工程配套 | 单测（解析 / 采样 / 结构）、i18n 提取、theme token 校验、离线预览 mock、CHANGELOG、产品指南 | 见 §8 |

建议切成 4 个 PR（另有一个可选的 PR0 预览，§9）：**PR1 改名 → PR2 host 采样 → PR3 面板 → PR4 文案文档回归**。改名可以独立先落，不阻塞状态面板。

---

## 1. 现状

| 层 | 位置 | 现状 |
| --- | --- | --- |
| 标签名 | `src/client/index.jsx:77-92` | `ctx.locale.register` 提供 `sidebarTabTitle`「远程终端 / Remote terminal」；`guideTitle` 同 |
| 会话头按钮 | `src/client/HarborHeaderAction.jsx:38-39` | 兜底文案「远程终端」「打开或聚焦远程终端标签」 |
| 视图集合 | `src/client/HarborPanel.jsx:75-81` | `VIEWS` = 终端 / 文件 / 转发 / 快捷命令 / 日志；所有面板 keep-alive（`display:none`），切换不卸载 |
| 功能开关 | `src/host/service/settings.js:34-39`、`src/rpc/schemas.js:193-199`、`src/client/HarborResources.jsx:1753-1772` | `showTunnels` / `showSnippets` / `showLogs` 三层（schema / host 归一化 / 设置页开关） |
| RPC 契约 | `src/rpc/descriptors.js`、`schemas.js`、`typert.js:28-99` | 手工维护三处，`test/typert-sync.mjs` 做漂移守卫 |
| 执行通道 | `src/host/service/exec.js:27-70` | `collectExecOutput`：独立 exec channel、**不镜像终端、不走策略**；`execOnConnection` 才带策略与终端回显 |
| 客户端 api | `src/client/api.js` | 每个 RPC 一个薄封装，统一解 `{ok,value|error}` 信封 |
| 预览 | `preview/mock-api.js`、`preview/workspace.jsx`、`preview/gallery.jsx` | 离线渲染真实组件；未知 RPC 有良性兜底，新面板可先接 mock |
| i18n | `src/i18n/core.js` + `src/i18n/messages/*.js` + `scripts/i18n-extract.mjs` | 中文为源语言；缺条目 / 孤儿条目都会让 `test/i18n.mjs` 失败 |

**问题**：页面叫「远程终端」，但它的职责早就不只是终端（文件、转发、日志、快捷命令都在里面），再加状态监测会更名不副实。而「这台机器现在怎么样」目前只有两条路：让模型跑 `ssh_exec`（走执行策略、回显进终端、没有历史、口径取决于模型随手写的命令），或者自己切到终端敲 `top`/`df`。面板没有任何一屏能一眼看到 CPU / GPU / 磁盘 / 网络。

---

## 2. 目标与非目标

**目标**

1. 页面更名为 **Remote Machine**，且四处称呼一致（侧栏标签 / 引导 / 会话头按钮 tooltip / 设置页小节）。
2. 页内新增只读**状态**标签：CPU、内存、磁盘（含 IO）、网络、GPU、进程 + 本连接的坐标信息，2 秒级刷新。
3. 数据只有一份归一化口径：面板与（可选的）Agent 工具共用同一个采样器，模型以后回答「磁盘还剩多少」不再各写各的命令。
4. 不新增权限面：固定脚本、只读、不需要 sudo、不进终端回显、不触发 AI 执行策略。
5. 不能采集时要**如实说明并给出下一步**，而不是空白或 0。

**非目标（v1）**

- 不做长期历史、阈值告警、通知推送（sparkline 只在面板内存活约 2 分钟）。
- 不做进程管理（kill / renice）、服务状态、容器编排视图。
- 不做 Windows 远端；macOS / BSD 远端 v1 只做「如实说不支持」（见 Q5）。
- 不改连接/终端归属模型，不动 SFTP、转发、批量任务。
- 不改设置页结构（状态标签的开关只是「功能开关」卡片里多一行）。

---

## 3. 第一部分：改名（Remote Machine）

### 3.1 改动清单

| 文件 | 位置 | 改动 |
| --- | --- | --- |
| `src/client/index.jsx` | 77-92 | `sidebarTabTitle` / `guideTitle` / `openSidebarTab` / `guideDescription` 四条的 zh + en |
| `src/client/HarborHeaderAction.jsx` | 38-39 | 兜底 `t(...)` 字面量 |
| `src/i18n/messages/en-workspace.js` | 165-166 | 字典**键和值**一起改（键是中文源串） |
| `src/client/HarborResources.jsx` | 1753 | 设置小节标题「右侧终端面板标签」→「Remote Machine 的标签」 |
| `src/i18n/messages/en-settings.js` | 31 | 同上那条的字典键与值 |
| `README.md` / `README.en.md` | 22 | 快速上手里的「远程终端」 |
| `INSTALL.md` | 28 | 同上 |
| `docs/product-guide.md` | 7 | 快速上手第 1 步 |
| `docs/assets/*.png` | — | 改名后重截工作台截图（顺带把新标签截进去） |
| `CHANGELOG.md` | 顶部 | 0.4.0 条目里写明改名与迁移说明 |

### 3.2 只改显示名，不改标识

`HARBOR_TAB_KIND = "harbor"`、`HARBOR_TAB_ID = "dsh-harbor"`、`id: "harbor-resources"` 是持久化 / 契约标识（侧栏布局记录、设置导航、插件导航），改它们会让用户的布局断链。**只有 title / label / guide 文案是字符串**，这是安全的改动面。

### 3.3 别留孤儿字典键

字典以中文源串为键。改名必须**字面量与键名一起改**，否则 `scripts/i18n-extract.mjs` 会同时报 missing（新串没条目）与 orphan（旧条目没人用），`test/i18n.mjs` 直接失败。顺序：改字面量 → 跑 extractor → 按输出增删字典条目 → 再跑测试。

注意：`messages.en.js:93-94` 的「远端终端已退出 / 被信号终止」说的是 PTY 进程，**不是页面名，不要改**。

### 3.4 命名候选（Q1）

| 中文 | English | 点评 |
| --- | --- | --- |
| 远端机器 | Remote Machine | 与 README 首页那句「远端机器是产品的一等对象」用同一套词 |
| **远程主机**（选定） | Remote Machine | 与设置页已有小节「远程主机」同词，界面里也读得顺 |
| Remote Machine | Remote Machine | 中文界面保留英文，像 DSH 自己的 Terminals / Plugins；最省歧义，但与全站中文文案不齐 |

插件名（`locale/zh.json` 的 `meta.title`「远程运维」/ `en.json`「Harbor」）**不动**：Harbor 是产品名，Remote Machine 是页面名。

---

## 4. 第二部分：「状态」标签

### 4.1 位置与默认落点（Q2）

`VIEWS` 变为：**终端 / 状态 / 文件 / 转发 / 快捷命令 / 日志**。

- 图标用宿主 sprite 里现成的 `gauge-outline`。
- `needsConnection: true`（与文件、转发一致）：没有选中服务器时置灰，鼠标悬停说明原因；＋ 连接按钮就在同一行。
- 默认落点**仍是终端**：空态引导（「连接一台服务器即可开始」）与用户肌肉记忆都在那里；状态页是第二眼信息。

### 4.2 信息架构（窄侧栏优先，单列）

```
┌─ prod-web-01 ─────────────────────────────┐
│ Ubuntu 24.04.1 · 6.8.0-45 · x86_64 · 42 天 │
├─ CPU ──────────────────────── 12.4% ──────┤
│ ▁▂▁▃▂▂▁▁▂▃▂▁  (60 点 sparkline)           │
│ 负载 0.08 / 0.12 / 0.09 · 16 核            │
│ ▮▮▮▯▯▯▯▮ ▯▯▯▯▯▯▯▯  (每核迷你条)          │
├─ 内存 ────────────────────────────────────┤
│ 8.1 / 15.6 GB  ▓▓▓▓▓░░░░░                  │
│ swap 0 / 2 GB · buff/cache 2.4 GB          │
├─ 磁盘 ────────────────────────────────────┤
│ /       43%  32/78 G    ▓▓▓▓░░░            │
│ /var    37% 118/342 G   ▓▓▓░░░░            │
│ /data   91% 1.8/2.0 T   ▓▓▓▓▓▓▓  ⚠         │
│ 读 12 MB/s · 写 3.1 MB/s                   │
├─ 网络 ────────────────────────────────────┤
│ eth0  ↓ 1.2 MB/s  ↑ 86 KB/s                │
│       ▁▂▁▃▂▂▁▁▂▃▂▁                        │
│ lo    折叠                                 │
├─ GPU ─────────────────────────────────────┤
│ 0  RTX 4090  78%  19.2/24 GB  68°C  310 W  │
├─ 进程 ────────────────────────────────────┤
│ 4213 python3   84%  12%                    │
│ 887  nginx      3%   1%                    │
├───────────────────────────────────────────┤
│ 采样 2s 前 · 38 ms   [暂停] [刷新] [复制]  │
└───────────────────────────────────────────┘
```

| 卡片 | 主指标 | 明细 | 数据来源 | 缺数据时 |
| --- | --- | --- | --- | --- |
| 身份条（非卡片） | 主机名 | 发行版 / 内核 / 架构 / 在线时长 | `uname`、`/etc/os-release`、`/proc/uptime` | 只显示连接坐标 |
| **CPU** | 总利用率 + 头部迷你 trend | 负载 1/5/15、核心数、型号、iowait/steal、每核柱条 | `/proc/stat`、`/proc/loadavg`、`/proc/cpuinfo` | 整卡换成「已暂停/不支持」说明 |
| **GPU** | 每卡一行 | 利用率、显存条、温度、功耗 | `nvidia-smi --query-gpu=...` | 整卡隐藏（无 GPU） |
| **内存** | used / total 条 | swap、buff/cache、available | `/proc/meminfo` | 隐藏卡 |
| **磁盘** | 每个挂载点一行（最满的在前，最多 8 行） | 可用字节、百分比、读写速率 | `df -P -k`、`/proc/diskstats` | 显示「没有可读取的挂载点」 |
| **网络** | 每个接口一行 ↓↑ | 累计流量、sparkline | `/proc/net/dev` | 显示「没有网络接口数据」 |
| **进程** | Top 5–8 | PID、名称、CPU%、内存%、线程数 | `ps -e -o pid=,pcpu=,pmem=,comm=`（能力探测） | 说明这台设备的 ps 读不到 |
| **连接** | 连接名 | 地址、本对话终端数、采样往返耗时 | host 侧连接记录 | — |

阈值：>85% 用 `warn`、>95% 用 `err`（`Badge` / `ProgressBar` 的既有 tone），其余中性色。数值一律 `.hb-mono`，正文不用等宽。

### 4.3 状态与交互

- **首次加载**：骨架，不渲染 0（0 是错误信息，不是「还不知道」）。
- **预热**：第一拍只有计数器没有差值 → 显示「采样中…」，2 秒后出数。
- **暂停**：按钮 + `Badge`「已暂停」，保持最后一帧数据与时间戳（用户知道这是旧数据）。
- **采样间隔**：2s / 5s / 10s 三档，默认 2s，存 localStorage（与终端外观同一套「按浏览器保存」的习惯）。
- **可见才算**：`view !== "monitor"` 或 `document.hidden` 时停表（面板 keep-alive 意味着不这么做会一直烧 SSH 通道）。
- **错误**：`ErrorNote` + 内置重试；退避期间显示「8 秒后重试」。
- **不支持**：用 `Notice` 而不是 `ErrorNote`（这不是故障），并说明原因与替代做法（例如「切到终端查看」）。
- **复制快照**：纯文本摘要写剪贴板（`useCopy`），方便直接粘进对话。
- **可选**：挂载点行「在文件中打开」→ 切到文件标签并定位到该目录（需要 HarborPanel 传一个 `onOpenPath`）。

### 4.4 复制快照格式

```
prod-web-01 · Ubuntu 24.04.1 LTS · 6.8.0-45-generic · x86_64
CPU 12.4%（16 核）load 0.08 / 0.12 / 0.09
内存 8.1 / 15.6 GB（52%）· swap 0 / 2 GB
磁盘 / 43%（32/78 G）· /var 37% · /data 91%
网络 eth0 ↓1.2 MB/s ↑86 KB/s
GPU0 RTX 4090 78% · 19.2/24 GB · 68°C · 310 W
采样 2026-11-23 10:24:03 +08:00（38 ms）
```

### 4.5 视觉约束（照 `docs/ui-guidelines.md`）

- 颜色 / 圆角 / 字号只走 `--hb-*` 与 `--dsw-alias-*`；`test/theme-snapshot.mjs` 会把「引用了宿主没声明的 token」判为失败。
- 每张卡一个 `Card`；行距 28–32px；数值 12px `.hb-mono`。
- sparkline 用内联 SVG（`stroke: var(--hb-accent)`），`role="img"` + `aria-label` 带当前值；柱条过渡 ≤200ms，全局 `prefers-reduced-motion` 已生效。
- 空态 / 错误 / 暂停 / 不支持 四种状态都要有「下一步做什么」的一句话。

---

## 5. 数据层

### 5.1 为什么必须新开一条 host 通道

面板侧今天能「执行命令」的入口都不合适：

| 入口 | 不能用的原因 |
| --- | --- |
| `execOnConnection()` | 走 AI 执行策略，并把命令与输出**镜像进操作者终端**；2 秒一条会把终端刷爆，也会把「面板传感器」和「Agent 操作」两种语义混在一起 |
| `ssh_exec` 工具 | 同上，且是 Agent 面的工具，面板不该借道 |
| 终端 `write` | 会打断用户在终端里的输入，且要求本会话有 PTY |

→ 新增 **`systemStats`**：host 侧独占的只读采样通道，复用 `collectExecOutput()`（不镜像、不策略），脚本是代码里的常量，浏览器只能传 connectionId。

### 5.2 RPC 契约（草案）

```ts
// request
interface SystemStatsRequest {
  readonly connectionId: string;
  /** true：忽略缓存，强制刷新慢项（df / GPU / 能力探测）。默认 false */
  readonly refresh?: boolean;
}

// result
interface SystemStatsResult {
  readonly sampledAt: string;        // ISO
  readonly sampleMs: number;         // 探测往返耗时
  readonly platform: "linux" | "other";
  readonly supported: boolean;       // false → 面板显示 Notice，不显示卡片
  readonly warmingUp?: boolean;      // 首拍：没有可用速率
  readonly host?: { hostname?: string; os?: string; kernel?: string; arch?: string; uptimeSeconds?: number; cpuModel?: string; cores?: number };
  readonly cpu?: { usagePercent: number; perCore: number[]; load: [number, number, number] | null; iowaitPercent?: number; stealPercent?: number };
  readonly memory?: { totalBytes: number; availableBytes: number; buffersBytes?: number; cachedBytes?: number; swapTotalBytes: number; swapFreeBytes: number };
  readonly disks?: Array<{ mount: string; device: string; fsType?: string; totalBytes: number; usedBytes: number; availableBytes: number; usePercent: number }>;
  readonly diskIo?: { readBytesPerSec: number; writeBytesPerSec: number } | null;
  readonly network?: Array<{ name: string; rxBytesPerSec: number; txBytesPerSec: number; rxTotalBytes: number; txTotalBytes: number }>;
  readonly processes?: { total: number | null; top: Array<{ pid: number; name: string; cpuPercent: number; memPercent: number }> };
  readonly gpu?: Array<{ index: number; vendor: "nvidia" | "amd"; name: string; utilizationPercent: number | null; memoryUsedBytes: number | null; memoryTotalBytes: number | null; temperatureC: number | null; powerW: number | null }>;
  readonly warnings?: string[];
}
```

约定：**缺数据用「字段缺失 / null」，绝不用 0 冒充**；`supported: false` 是正常返回（ok:true），只有传输层失败才是 `{ok:false,error}`（`no-connection` / `probe-timeout` / `probe-failed`）。

落地三处要同步：`src/rpc/schemas.js`（zod）、`src/rpc/descriptors.js`（`def("systemStats", …)`）、`src/rpc/typert.js`（members + types 两段手写清单），否则 `test/typert-sync.mjs` 失败。

### 5.3 探测脚本

- **一条自包含命令**：`sh -c '<script>'`。脚本里**不出现单引号**（只用双引号），于是一层单引号包裹就够，不需要任何转义；再加一条源码测试断言「脚本不含 `'`、不含模板插值」，从结构上排除拼装错误。
- 为什么不走 stdin：`collectExecOutput(client, command, timeout)` 现有签名就能用，零改动；而仓库自带的测试 sshd（`test/support/test-sshd.mjs:185-193`）对 exec 只做 `sh -c <command>`、不转发客户端 stdin，走 stdin 反而要先改测试服务器。
- 脚本以多行模板字符串常量放在 `src/host/monitor/probe-script.js`（宿主构建没有 `.sh` 的 text loader，常量字符串最省事，也仍然可审阅、可做源码断言）。
- 分段标记：`#meta` `#cpu` `#mem` `#load` `#net` `#df` `#diskstats` `#gpu` `#procs`；解析器只认这些段，未知段忽略（向前兼容）。
- 每段失败不致命：`2>/dev/null`、不 `set -e`、缺段就缺字段。
- 慢项与能力探测（`df`、`ps -o pcpu` 是否支持、`command -v nvidia-smi`）走 inventory 缓存，TTL 10–60s；`refresh: true` 时强制重跑。
- 新模块：
  - `src/host/monitor/probe-script.js`：脚本常量（单一来源）
  - `src/host/monitor/parse.js`：**纯函数**解析（每个 `/proc` 格式一个函数）
  - `src/host/monitor/sample.js`：差分、速率、首拍预热、计数器回退保护
  - `src/host/service/monitor.js`：mixin（`systemStats`、单飞、缓存、退避、sampler 生命周期），在 `src/host/service/index.js` 的 `MIXINS` 里加一行

### 5.4 采样状态机（host 侧每连接一份）

| 规则 | 做法 |
| --- | --- |
| 差分 | 保存上一次的 cpu jiffies / net 字节 / disk sectors + 时间戳，算速率 |
| 首拍 | `warmingUp: true`，只回计数器，不出百分比 |
| 计数器回退（机器重启） | 视为新基线，**不出负值或尖峰**，下一拍恢复 |
| 单飞 | 同连接同时只允许一个探测；并发调用共享同一个 Promise |
| 去重缓存 | 结果 1 秒内复用（两个分栏看同一台机器只发一次探测） |
| 失败退避 | 2s → 4s → 8s → 上限 30s，成功后复位；面板显示下次重试时间 |
| 超时 | 4s，超时后关闭 channel（沿用 `collectExecOutput` 的「本地先行 settle」策略，不依赖对端 CHANNEL_CLOSE） |
| 清理 | 断开 / 删除连接时 `samplers.delete(connectionId)` |

### 5.5 频率与成本

| 动作 | 频率 | 远端代价 |
| --- | --- | --- |
| 快拍（`/proc/*` + loadavg + netdev） | 2s（面板可见且在该标签） | 1 个 exec channel，约 2–4 KB 输出，一次 `sh` 启动 |
| 慢项（df / diskstats / ps 能力 / GPU） | 每 10s 或首拍 | 一次 `df`（本地盘 <10ms；陈旧 NFS 可能慢，所以不进 2s 节拍） |
| 面板切走 / 侧栏收起 / 窗口隐藏 | 0 | 无 |
| 暂停 | 0 | 无 |

比常驻一个 `ssh top` 便宜，且**不写任何远端文件**。采样间隔做成面板上的三档，默认 2s。

### 5.6 设备差异与降级矩阵

| 环境 | 行为 | 面板文案 |
| --- | --- | --- |
| Linux（主流发行版、容器、WSL） | 全量 | — |
| Alpine / OpenWrt（busybox `ps` 无 `pcpu`） | 进程卡降级，其余正常 | 「这台设备的 ps 不支持 CPU 占比」 |
| 无 `/proc`（macOS / BSD） | `supported: false`，只给 `uname` 能给的 | 「这台设备不是 Linux 主机，状态采集暂不支持」 |
| 网络 CLI（VRP / Comware，无 exec 通道） | 直接 `supported: false` | 复用现有「该设备不支持 exec 通道」的说法 |
| sshd `MaxSessions` 已满 | channel open 失败 → 退避 + 明确提示 | 「这台服务器的 sshd 不允许额外会话（MaxSessions），状态采样已暂停」 |
| 高延迟链路（>500ms RTT） | 采样耗时上升，节拍自然变慢（单飞） | 页脚显示真实往返耗时 |

---

## 6. 安全

1. **固定脚本、零插值**：`systemStats` 只接受 `connectionId` + `refresh`。加一条源码级测试断言探测脚本里没有模板插值，从结构上排除注入。
2. **只读**：不写文件、不改状态、不需要 sudo / root；等价于 `cat /proc/*`、`df`、`ps`、`nvidia-smi` 查询。
3. **为什么可以不走 AI 执行策略**：策略管的是「Agent / 操作者让远端执行的命令」。面板采样是插件自己的传感器，命令是代码常量、不可由调用方影响、不产生不可逆后果、不进终端回显。这段理由要写进代码注释与 CHANGELOG，否则后来者会以为是绕过。所有真正执行命令的路径（`execOnConnection` / `write` / 工具）策略不变。
4. **输出上限**：沿用 `maxCommandOutputBytes`（64 KB），超限标记 truncated；stderr 只留尾部供诊断，不进 UI 正文。
5. **不跨对话泄漏**：采样只按 connectionId 取，不携带任何对话内容；也不暴露其他对话的终端/命令。
6. **v1 不给 Agent**（见 Q7）；若做 `ssh_status`，同样只读、按调用方会话解析连接。

---

## 7. i18n 与文案

- 新增约 **45–60 条**中文源串：卡片标题与单位、阈值说明、四种状态、错误与退避、复制快照模板、设置开关一行。按领域放进 `src/i18n/messages/en-operations.js`（状态面板与转发/日志同域）。
- 改名要**删旧键**（§3.3）。
- CI：`node scripts/i18n-extract.mjs`（missing / unwrapped / orphan / dynamic 四类漂移，前两类非零退出）。
- 文案基调照产品指南：短句、具体、说清下一步；不出现「性能异常」这类结论式措辞——面板只报告读数，不替用户下判断。

---

## 8. 测试计划

| 文件 | 覆盖 |
| --- | --- |
| `test/monitor-parse.mjs`（新） | 每种 `/proc` 格式的 fixture；首拍、计数器回退、字段缺失、`df` 伪文件系统过滤与 8 行上限、GPU `[N/A]`、busybox 无 `pcpu`、非 Linux 输出、CRLF、超长行 |
| `test/monitor-service.mjs`（新） | 用 `test/batch.mjs:168` 那种假 `client.exec` → 单飞、1s 缓存、退避、超时、`supported:false`、信封形状、sampler 清理；源码断言「脚本无插值」 |
| `test/monitor-pane.mjs`（新） | 结构断言（沿用仓库的源码级风格）：仅在可见且该标签时轮询、切走即停、无 `window.confirm`、四态齐备、只用 token、feature flag 生效 |
| `test/typert-sync.mjs`（既有） | 新 descriptor ↔ member ↔ type 自动对齐 |
| `test/i18n.mjs`（既有） | 新文案都有英文条目、改名后无孤儿 |
| `test/theme-snapshot.mjs`（既有） | 新 CSS 不引用未声明的宿主 token |
| `test/manifest.mjs`（既有） | 打包文件集不变（源码不进包） |

命令：`npm test` · `npm run build` · `npx eslint .` · `node scripts/i18n-extract.mjs` · `npm run preview:ui`。

**手工矩阵**：带 GPU 的 Linux / 无 GPU 的 Linux / Alpine / macOS 远端 / VRP 交换机 / `MaxSessions=1` / 探头期间掉线 / CPU 100% / 200+ 挂载点 / 1s 延迟链路 / 同一台机器开两个分栏 / 侧栏收起再展开。

**端到端**：`test/support/test-sshd.mjs` 起在本机（开发机多为 macOS），`/proc` 不存在，因此 E2E 断言的是**降级路径**（`supported:false` + 可读文案）；Linux 口径由 `test/monitor-parse.mjs` 的 fixture 覆盖，真机矩阵在手工清单里。

---

## 9. 实施顺序与工作量

| PR | 内容 | 估时 | 验收 |
| --- | --- | --- | --- |
| **PR0（可选）** | 用 `preview/mock-api.js` 的假数据把面板画出来，截屏评审视觉 | 0.5 天 | 你点头再往下做，省得接完真数据再改版式 |
| **PR1** | 改名（四处文案 + 字典 + 文档 + CHANGELOG 占位） | 0.5 天 | 标签 / 引导 / 按钮 / 设置小节一致；i18n 无孤儿 |
| **PR2** | host：`probe-script` / `parse` / `sample` / `monitor` mixin + schema + descriptor + typert + 单测 | 1.5–2 天 | 假 client 下契约稳定；真机采样 <100ms |
| **PR3** | client：`monitor-pane` + 卡片 + sparkline + CSS + 预览 mock + 结构测试 | 1.5–2 天 | 四态齐备；切走停表；窄栏不换行溢出 |
| **PR4** | 文案润色、产品指南 / README / 截图、CHANGELOG 0.4.0、全量回归 | 0.5–1 天 | `npm test` + `npx eslint` + 预览截图 |

合计约 **4–5 个工作日**（含测试）。改名可以今天就单独落地。

---

## 10. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| `sshd MaxSessions` 小 / 通道被拒 | 采样直接失败 | 单飞 + 退避 + 明确文案；不形成重试风暴 |
| `df` 卡在陈旧 NFS | 2s 节拍被拖垮 | `df` 不进快拍；channel 超时 4s；超时即关 |
| 低端设备 CPU 开销 | 采样本身成为负担 | 默认 2s、可调到 10s、可暂停、功能开关可整体关闭 |
| `ps` 的 CPU% 是**生命周期平均**而非瞬时 | 数字会被误读 | UI 标注口径（或 v1 只显示内存%，把进程卡做成「按内存排序」） |
| GPU 厂商覆盖 | 非 NVIDIA 用户看不到 | v1 只做 NVIDIA；AMD（rocm-smi）留 Q4 |
| i18n 字典改动 | CI 红 | 改完立刻跑 extractor，按输出批量补 |
| 面板在别处轮询 | 白白消耗 SSH | `active` prop + `document.hidden` 双闸 |
| 行号漂移 | 文档过期 | 文档以「文件 + 符号名」为准，行号仅作参考 |

---

## 11. 评审结论（已确认）

| # | 问题 | 结论 |
| --- | --- | --- |
| Q1 | 中文标签 | **远程主机**；插件名 Harbor / 远程运维 不动 |
| Q2 | 标签名与位置 | 叫**状态**，放在终端之后；默认落点仍是终端 |
| Q3 | 卡片范围 | 七块即可，但顺序改为 CPU → **GPU** → 内存 → 磁盘 → 网络 → 进程 → 连接 |
| Q4 | GPU | 只做 **NVIDIA**（`rocm-smi` 留后） |
| Q5 | 非 Linux | v1 只做「如实说不支持」 |
| Q6 | 频率与开关 | 默认 2s、可切 2/5/10s、隐藏即停、`showMonitor` 默认开 |
| Q7 | Agent 工具 | **同期**加入只读 `ssh_status`（并配 `statusTools` 开关） |
