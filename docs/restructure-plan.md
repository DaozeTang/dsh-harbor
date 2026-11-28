# Harbor 项目结构审查与重构方案

> 审查对象：`dsh-harbor` 0.6.0（`main` @ `5833419`，工作区含未提交改动）  
> 审查范围：仓库全部源码、测试、脚本、构建与打包配置  
> 结论一句话：**代码本身干净，冗余集中在目录组织与契约副本，不在重复实现。**

---

## 0. 摘要：五个结论

1. **一半源码平铺在两层目录根部。** 147 个源文件里 70 个（48%）直接放在 `src/client/`（34 个）与 `src/host/`（36 个）下，没有领域分组；同一功能的文件散落在 `service/`、`tools/`、根目录、`rpc/`、`client/features/` 五处。
2. **`features/` 名不副实。** 10 个 feature 目录中，`files/` 与 `settings/` 只有 CSS；真正的组件 `HarborFiles.jsx`（1482 行）和 `HarborResources.jsx`（1912 行）反而在 `src/client/` 根目录，`terminal-display/`（16 个文件）则整个在 `features/` 之外。
3. **客户端反向依赖宿主。** `client/command-snippets.js → host/safety.js`、`client/features/logs/logs-pane.jsx → host/terminal-text.js` 两处跨半边引用；`shared/` 里又放了只有宿主用的 `service-hub.js`。边界因此说不清。
4. **一份 RPC 契约有 4 份手写副本。** `schemas.js`（1085 行、130 个导出）、`descriptors.js`（66 个方法）、`typert.js`（66 个成员 + 142 条 TypeScript 声明）、`client/api.js`（72 个包装方法），并专门有 `test/rpc-contract.mjs` 兜漂移。
5. **测试平铺且耦合源码路径。** 114 个 spec 全在 `test/` 一层；14 个测试按路径读取 `.jsx/.js` 源码并用正则断言，目录一移动就红。

方案把工作拆成 6 个阶段（约 5–7 人日），其中 **P1 是纯移动、无行为变化**，可在一天内完成并全绿；拆文件与契约生成放在其后，逐步验证。

**不动的部分**：`package.json` 的 5 个公开入口路径、`lib/` 产物形态、`src/host/service/` 的 mixin 组合方式。这三项是对外契约或已验证的架构，改造收益低、风险高。

---

## 1. 审查方法与可信度

| 检查项 | 方法 | 结果 |
| --- | --- | --- |
| 文件与规模 | `find` + 逐文件行数 | 147 个源文件 / 34,264 行；114 个测试 spec |
| 模块依赖 | 自写 import 图脚本解析 583 条相对 import（src 501 + test 82） | **无环** |
| 代码副本 | 跨文件相同长行（≥45 字符）配对统计 | src 内 **0 组**（≥12 行） |
| 死代码 | 导出符号全仓引用计数 | 仅 3 个未使用导出 |
| 目录职责 | 逐文件读首部注释 + 导入者集合 | 70 个根级模块，职责跨 8 个领域 |
| 跨半边依赖 | 匹配 client→host、host→client | client→host 2 处，host→client 0 处 |
| 契约漂移 | 对比 schemas / descriptors / typert / api 方法集 | 66 方法 / 130 schema 导出 / 66 成员 + 142 声明 / 72 api 方法 |
| 测试耦合 | 扫描测试中的源码读取调用 | 14 个 spec 依赖源码文本 |
| 方案可行性 | 在 `/tmp` 影子副本上完整演练 P1 | 88 次移动、583 条 import 重写、构建通过、368 个用例全绿 |

这组结果说明：**没有需要合并的重复模块，也没有可以删的死代码**；要解决的是「文件放错层、职责靠文件名猜、同一事实写多遍」三类结构问题。因此方案以**移动与收拢**为主，拆分只针对超长文件，不重写逻辑。

---

## 2. 现状度量

| 区域 | 文件数 | 行数 | 根级平铺 |
| --- | ---: | ---: | ---: |
| `src/client/` 根 | 34 | 7,210 | 34 |
| `src/client/features/` | 14 | 3,255 | — |
| `src/client/terminal-display/` | 16 | 2,527 | 16 |
| `src/client/ui/` | 5 | 2,452 | — |
| `src/host/` 根 | 36 | 6,183 | 36 |
| `src/host/service/` | 22 | 7,248 | — |
| `src/host/tools/` | 6 | 1,636 | — |
| `src/host/monitor/` | 3 | 638 | — |
| `src/rpc/` | 4 | 1,463 | 4 |
| `src/i18n/` | 2 | 1,100 | 2 |
| `src/shared/` | 3 | 97 | 3 |
| `src/` 入口 | 2 | 602 | 2 |
| `test/` | 114 spec + 7 支撑 | 18,775 | 114 |

**超过 500 行的文件有 17 个**，前 8 名：

| 文件 | 行数 | 主要职责 |
| --- | ---: | --- |
| `client/HarborResources.jsx` | 1,912 | 资源设置页 + 资源编辑器 + 4 个对话框 + 共享凭据编辑器 + 服务器行 |
| `client/HarborFiles.jsx` | 1,482 | 文件列表 + 面包屑 + 搜索 + 编辑器 + 传输任务 + 冲突处理 + 4 个对话框 |
| `client/ui/styles/app.css` | 1,268 | token + 基础组件 + 工作台外壳 + 文件区 + 设置区 + 工具类 |
| `rpc/schemas.js` | 1,085 | 66 个方法的请求/结果 zod schema |
| `host/service/connections.js` | 951 | 连接、host-key、keepalive、重连、跳板 |
| `i18n/messages.en.js` | 889 | 全量英文词典 |
| `client/ui/kit.jsx` | 854 | 34 个 UI 原语与覆盖层组件 |
| `host/safety.js` | 697 | 命令分类、放行清单、精确规则、策略判定 |

现状目录（略去文件）：

```text
src/
├── index.js                 宿主入口（组合根）
├── terminal-backend.js      持久终端伴侣入口
├── host/                    ← 36 个文件平铺
│   ├── service/             16 个 mixin + 基础设施（22 文件）
│   ├── tools/               6 个 Agent 工具注册
│   ├── monitor/             探针与解析
│   └── *.js                 ssh/sftp/terminal/policy/resource 全部同级
├── client/                  ← 34 个文件平铺
│   ├── features/            10 个目录，其中 2 个只有 CSS
│   ├── terminal-display/    16 个文件（逻辑 + 4 个组件 + worker）
│   └── ui/                  设计系统
├── rpc/                     契约（schemas 单文件 1085 行）
├── i18n/                    共享词典
└── shared/                  3 个跨端模块（含 1 个 host-only）
```

---

## 3. 冗余清单

按「改动收益 ÷ 风险」排序。每条给出证据、为什么是结构问题、对应阶段。

### R1 客户端 34 个根级模块，与 features 双轨并存 —— 高

- 证据：`src/client/` 根 34 个文件，其中一批模块只服务单一功能（`file-editor`、`download-checkpoints`、`stream-download`、`sftp-favorites`、`log-highlight`、`terminal-zoom`、`command-snippets`、`exec-policy-ui`、`update-guidance` 等），却与 `api.js`、`store.js` 这类全局基础设施同级。
- 问题：新增文件没有明确落点；reviewer 只能靠文件名猜归属；两个最大的组件在根目录，较小的功能反而有目录。
- 处置：P1 归入 `core/`（api、format、locale）、`state/`（store、pane-selection、session-terminals）、`shell/`（工作台外壳与侧栏接线）、`features/<name>/`（功能与它的 CSS、helper 同目录）。改完根目录只剩 `index.jsx`。

### R2 宿主 36 个根级模块，按实现细节命名而非领域 —— 高

- 证据：`host/` 根同时有 `ssh2-client`、`ssh-auth`、`ssh-banner`、`ssh-agent`、`hostkey`、`net-errors`（SSH 握手）；`sftp-dir`、`sftp-write`、`sftp-pipeline`、`scp`、`transfer-tasks`（文件）；`terminal-backend`、`terminal-census`、`terminal-input`、`terminal-output`、`terminal-owner`、`session-log`（终端）；`safety`、`dsh-permission`、`policy-messages`、`redact`（策略）。
- 问题：一次功能改动横跨 `service/`（RPC 方法）、`tools/`（Agent 工具）、`host/*`（纯逻辑）、`rpc/schemas`（契约）、`client/features`（面板）五个位置；「这条连接为什么会自动重连」要在 6 个同级文件里翻。
- 处置：P1 归入 `ssh/`、`exec/`、`policy/`、`files/`、`terminal/`、`resources/`、`tunnels/`、`runtime/`；`service/`、`tools/`、`monitor/` 保持不动。

### R3 features/files 与 features/settings 只有 CSS —— 高（修复成本最低）

- 证据：`src/client/features/files/` 仅 `files.css`，`src/client/features/settings/` 仅 `settings.css`；对应组件 `HarborFiles.jsx`（1482 行）与 `HarborResources.jsx`（1912 行）在 `src/client/` 根。
- 问题：目录名承诺了「功能自包含」，实际 CSS 与组件分居两处；`settings` 这个名字还和宿主的设置系统混淆（该页是「服务器资源」设置）。
- 处置：P1 把组件、专属 helper、CSS 一起移入 `features/files/` 与 `features/resources/`（顺带把 `settings/` 改名为 `resources/`）。

### R4 客户端反向 import 宿主模块 —— 中高

- 证据：`src/client/command-snippets.js:3 → ../host/safety.js`（`shellQuote`）；`src/client/features/logs/logs-pane.jsx:16 → ../../../host/terminal-text.js`（`toReadableText`、`readableLine`）。
- 问题：`shared/` 的存在意义就是「两端都能跑」；现在两个纯函数留在 host，导致浏览器 bundle 里混入宿主目录的模块，单测也必须从 host 路径导入，边界失去可检查性。
- 处置：P1 把 `shellQuote` 提到 `shared/shell-quote.js`，`terminal-text.js` 整体移到 `shared/terminal-text.js`；在守卫测试里禁止 client→host。

### R5 shared 混入 host-only 运行时 —— 中

- 证据：`src/shared/service-hub.js` 只被 `src/index.js`、`src/terminal-backend.js`、`host/service/terminal-bridge.js`、`host/terminal-backend.js` 引用；另外两个 shared 模块（`private-key`、`exec-policy-label`）确实双端使用。
- 问题：`shared/` 的约定是「无 Node、无 DOM、两端通用」，一个持有服务实例的模块放在这里，会让后续贡献者误以为可以在浏览器 import。
- 处置：P1 移到 `host/runtime/service-hub.js`；`shared/` 只保留纯函数。

### R6 RPC 契约四处手写 —— 高（长期维护成本）

- 证据：同一个 66 方法契约在四处人工维护：`rpc/schemas.js`（130 个导出）、`rpc/descriptors.js`（66 个 `def`）、`rpc/typert.js`（66 个成员 + **142 条 TypeScript 声明**）、`client/api.js`（72 个包装方法）。`test/rpc-contract.mjs` 的首部注释直接记录了历史上三种漂移（schema 剥掉字段、结果缺字段、handler 改名）。
- 问题：加一个 RPC 要改 4–6 处并按顺序对齐；142 条声明是 zod schema 的第二次手写，最容易过期。
- 处置：P3 以 `descriptors.js` 为单一来源生成 `typert.js` 的成员；把 142 条声明抽到按领域的 `rpc/declarations/<domain>.js`，`typert.js` 只做装配。P1 先把 `schemas.js` 按领域拆分并保留 `schemas.js` 作为 barrel（import 路径不变，零改动消费方）。

### R7 17 个超过 500 行的文件，职责叠加 —— 中

- 证据：见第 2 节表格。`HarborResources.jsx` 里有 8 个顶层组件 + 3 个表单辅助函数 + 遗留 localStorage 迁移；`HarborFiles.jsx` 有 **30 个 `useState`**（列表、收藏、搜索、编辑器、差异/冲突、传输任务、上传、对话框、过滤）。
- 问题：改一个对话框要滚动 1900 行；状态之间没有边界，新增一个面板状态就要动同一个闭包。
- 处置：P2 按第 7 节的拆分表执行，先拆组件与纯函数，再抽 hook；每拆一个文件跑一次测试。

### R8 测试平铺 + 14 个源码文本断言 —— 中

- 证据：`test/` 下 114 个 `.mjs` 平铺；`scripts/run-tests.mjs` 只 `readdirSync(test)` 一层，所以现在也无法分组。14 个 spec 用 `readFileSync` 读 `src/...` 再用正则断言（`client-state-fixes`、`resource-card-layout`、`sidebar-integration`、`ssh2-interop` 等）；`p1/p2/p3-regressions`、`issues-50-51`、`harbor-0-2-0-regressions` 是按「评审批次」而非领域归集的兜底文件。
- 问题：P1 的纯移动会让这 14 个测试全部失败（路径失效）；按批次命名的文件随着时间只增不减，找不到「这个功能现在由谁守护」。
- 处置：P1 同步更新 14 处路径；P4 让 runner 递归、目录镜像 src、把批次回归用例拆回领域文件，只保留一个 `test/meta/structure.test.mjs` 做架构守卫。

### R9 命名碰撞 6 组 —— 低（但会持续误导）

| 重名文件 | 各自职责 | 处置 |
| --- | --- | --- |
| `client/format.js` / `client/features/monitor/format.js` | 通用字节与时间 / 监控指标格式 | 后者改名 `metrics-format.js` |
| `client/terminal-theme.js` / `client/terminal-display/theme.js` | 宿主 chrome 配色 / ANSI 调色板与极性 | 前者改名 `chrome-theme.js` |
| `host/session-log.js` / `host/service/session-logs.js` / `host/tools/session-log.js` | 存储 / RPC mixin / Agent 工具 | 目录分层后自然消歧，无需改名 |
| `host/terminal-backend.js` / `src/terminal-backend.js` | 后端实现 / 伴侣入口 | 入口保留，实现移到 `host/terminal/backend.js` |
| `host/service/settings.js` / `client/terminal-display/settings.js` | 操作者设置 / 终端外观设置 | 目录分层后消歧 |
| `host/service/batch.js` / `host/tools/batch.js` | 批量执行 mixin / 工具注册 | 目录分层后消歧 |

### R10 连接表单字段重复 —— 中

- 证据：`HarborResources.jsx` 的 `ResourceEditor`（149–453 行）与 `features/connect/connect-dialog.jsx` 各自实现 host / port / username / 认证方式 / 私钥 / 口令一组字段与校验，两处都调用 `privateKeyProblem`。
- 问题：改一个字段（如新增 `hostKeyMode` 提示或代理跳板校验）要改两遍，容易出现「临时连接能填、保存资源不能填」这类不对称。
- 处置：P2 抽 `features/connect/connection-fields.jsx`（纯受控字段组）+ 共用校验，两个表单复用。

### R11 仓库根与生成物 —— 低

- 证据：`lib/`、`release/`、`preview/out/` 是本地构建产物，均已在 `.gitignore`；`.DS_Store` 存在于根目录（已忽略）；`release` 的 ZIP 按设计包含 `src/`、`test/`、`preview/`（源码包）。
- 问题：不是仓库缺陷，但会让新读者把产物当源码；`preview/theme-fallback.css` 是生成文件却在源码树里（文件头已注明）。
- 处置：P5 清理工作区、在 `README` 开发节补一句「`lib/`、`release/`、`preview/out/` 为产物」；生成物保留，不迁目录。

### 已核查、明确不改的「疑似冗余」

| 现象 | 为什么不是问题 |
| --- | --- |
| `client/format.js` 被 `monitor/format.js` 再导出 | 单向再导出，避免监控面板深入 `../..`；拆分后保留 |
| `client/api.js` 与 `host/service/text.js` 各有一份 base64 编解码 | 浏览器用 `btoa/atob`，宿主用 `Buffer`；环境不同，强行共用反而引入分支 |
| `features/*/*.css` 与 `ui/styles/app.css` 看似重复 | 分层明确：`app.css` 是共享词汇与 token，feature CSS 只写几何，全部作用域在 `.hb` 下；抽查无选择器重复 |
| 16 个 service mixin | 服务状态跨领域共享（连接、会话、策略互相调用），拆成聚合类会引入循环继承；组合根 44 行，可读性可接受 |
| `README.md` / `README.en.md`、`locale/*.json` 与 `i18n/messages.en.js` | 前者面向不同读者，后者是插件元数据与运行期词典，消费方不同 |
| `lib/client.js` 是 CJS 包装、`lib/index.js` 是 ESM | 宿主 web shell 的模块加载契约，不是重复产物 |

---

## 4. 目标结构

组织原则（写进 `docs/` 与守卫测试）：

1. **根只放入口。** `src/`、`src/client/`、`src/host/` 根部不再出现功能模块。
2. **一层一个领域。** 领域内按「传输 / 执行 / 策略 / 文件 / 终端 / 资源 / 转发」划分，名字即职责。
3. **功能自包含。** 一个 feature 的组件、helper、CSS 同目录；只有被两个以上 feature 使用才上提。
4. **依赖单向。** `client → shared ← host`；`client` 不得 import `host`，`host` 不得 import `client`。
5. **纯逻辑与 UI 分离。** 浏览器侧纯函数（matcher、scheme、drag-order）不 import React；组件不直接碰存储。

落点速查：

| 新增的东西 | 放在哪里 |
| --- | --- |
| 一个 RPC 的请求/结果 | `rpc/schemas/<domain>.js` + `rpc/descriptors.js` |
| 有状态的宿主能力 | `host/service/<concern>.js`（mixin） |
| 宿主纯逻辑 | `host/` 下按领域：`ssh`、`exec`、`policy`、`files`、`terminal`、`resources`、`tunnels` |
| Agent 工具 | `host/tools/<domain>.js` |
| 双端纯函数 | `shared/` |
| 仅浏览器的纯函数 | `client/core/` |
| 新面板 / 视图 | `client/features/<name>/`（组件 + helper + CSS） |
| 对应测试 | `test/<与 src 相同的路径>.mjs` |

```text
src/
├── index.js                       宿主入口（不动）
├── terminal-backend.js            持久终端伴侣入口（不动）
├── host/
│   ├── service/                   16 个 mixin + 基础设施（不动，22 文件）
│   ├── tools/                     6 个 Agent 工具注册（不动）
│   ├── monitor/                   探针、解析、采样（不动，3 文件）
│   ├── ssh/                       client / auth / banner / agent / hostkey / net-errors
│   ├── exec/                      cwd / network-cli
│   ├── policy/                    safety / dsh-permission / messages / redact
│   ├── files/                     sftp-dir / sftp-write / sftp-pipeline / sftp-editor-save /
│   │                              scp / transfer-tasks / upload-scheduling /
│   │                              local-path-guard / trash
│   ├── terminal/                  backend / census / input / output / owner / session-log
│   ├── resources/                 backup-crypto / backup-store / openssh-import /
│   │                              remote-workspace / profile-connection / agent-connect
│   ├── tunnels/                   socks5
│   └── runtime/                   service-hub（宿主单例枢纽）
├── rpc/
│   ├── envelope.js                统一 { ok, value | error } 信封
│   ├── schemas.js                 barrel（保持 import 路径不变）
│   ├── schemas/                   13 个领域 schema 文件
│   ├── declarations/              142 条类型声明按领域存放（P3）
│   ├── descriptors.js             66 个方法描述（单一来源）
│   ├── typert.js                  装配产物（P3 生成成员）
│   └── remote.js                  浏览器侧 Remote 标记
├── i18n/                          词典与语言核心（不动）
├── shared/                        private-key / exec-policy-label / terminal-text / shell-quote
└── client/
    ├── index.jsx                  浏览器入口（不动）
    ├── core/                      api / format / locale
    ├── state/                     store / pane-selection / session-terminals
    ├── shell/                     HarborPanel / HarborSidebarBody / HarborHeaderAction /
    │                              AgentRevealWatcher / sidebar-lifecycle / settings-nav-icon /
    │                              agent-connection-poll / connection-status
    ├── ui/                        kit / icons / dialog-stack / styles/
    └── features/
        ├── batch/                 batch-dialog
        ├── connect/               connect-dialog / connection-fields / pemkey
        ├── files/                 HarborFiles / file-editor / file-transfers /
        │                          download-checkpoints / stream-download /
        │                          remote-file-search / sftp-favorites / files.css
        ├── logs/                  logs-pane / log-highlight
        ├── monitor/               monitor-pane / monitor-charts / errors /
        │                          metrics-format / monitor.css
        ├── policy/                policy-menu / exec-policy-ui
        ├── resources/             HarborResources / ResourceWorkspaces /
        │                          ResourceEditor / SharedCredentialEditor / ServerRow /
        │                          HostKeyDialog / dialogs/ / update-guidance / settings.css
        ├── snippets/              snippets-view / command-snippets
        ├── terminal/              xterm-view / terminal-pool / terminal-search /
        │                          terminal-zoom / terminal-styles / chrome-theme
        ├── terminal-display/      逻辑（addon/matcher/scheme/…）+ ui/（4 个组件）
        └── tunnels/               tunnels-pane
```

目标结构下：客户端根级模块 **34 → 1**，宿主根级模块 **36 → 0**；每个 feature 自包含组件与 helper（有专属样式的同目录）；`terminal-display` 归位并区分逻辑与组件。

---

## 5. 迁移映射

以下映射覆盖全部 147 个源文件：**88 个移动/重命名 + 1 个拆分**，其余 **58 个保持原位**（其中 15 个在表内显式标注，43 个未列入表格）。全部校验过源文件存在、目标不重复。

### 5.1 契约与共享层

| 现状 | 目标 | 动作 |
| --- | --- | --- |
| `rpc/schemas.js` | `rpc/schemas/{common,auth,connections,resources,credentials,workspaces,files,terminal,settings,monitor,batch,logs,tunnels}.js + src/rpc/schemas.js barrel` | 拆分 |
| `shared/service-hub.js` | `host/runtime/service-hub.js` | 移动 |
| `host/envelope.js` | `rpc/envelope.js` | 移动 |
| `host/terminal-text.js` | `shared/terminal-text.js` | 移动 |

`src/index.js`、`src/terminal-backend.js`、`src/rpc/descriptors.js`、`src/rpc/remote.js`、`src/rpc/typert.js`、`src/i18n/*`、`src/shared/private-key.js`、`src/shared/exec-policy-label.js` **保持原位**（前五个是对外入口或装配点）。

`envelope.js` 归入 `rpc/` 而不是 `shared/`：它是 `{ ok, value | error }` 线协议的一部分，只有宿主使用，放进 shared 会再次模糊边界。

### 5.2 宿主

| 现状 | 目标 | 动作 |
| --- | --- | --- |
| `host/agent-connect.js` | `host/resources/agent-connect.js` | 移动 |
| `host/dsh-permission.js` | `host/policy/dsh-permission.js` | 移动 |
| `host/exec-cwd.js` | `host/exec/cwd.js` | 移动+重命名 |
| `host/hostkey.js` | `host/ssh/hostkey.js` | 移动 |
| `host/local-path-guard.js` | `host/files/local-path-guard.js` | 移动 |
| `host/net-errors.js` | `host/ssh/net-errors.js` | 移动 |
| `host/network-cli.js` | `host/exec/network-cli.js` | 移动 |
| `host/openssh-import.js` | `host/resources/openssh-import.js` | 移动 |
| `host/policy-messages.js` | `host/policy/messages.js` | 移动+重命名 |
| `host/profile-connection.js` | `host/resources/profile-connection.js` | 移动 |
| `host/redact.js` | `host/policy/redact.js` | 移动 |
| `host/remote-workspace.js` | `host/resources/remote-workspace.js` | 移动 |
| `host/resource-backup-crypto.js` | `host/resources/backup-crypto.js` | 移动+重命名 |
| `host/resource-backup-store.js` | `host/resources/backup-store.js` | 移动+重命名 |
| `host/safety.js` | `host/policy/safety.js` | 移动 |
| `host/scp.js` | `host/files/scp.js` | 移动 |
| `host/session-log.js` | `host/terminal/session-log.js` | 移动 |
| `host/sftp-dir.js` | `host/files/sftp-dir.js` | 移动 |
| `host/sftp-editor-save.js` | `host/files/sftp-editor-save.js` | 移动 |
| `host/sftp-pipeline.js` | `host/files/sftp-pipeline.js` | 移动 |
| `host/sftp-write.js` | `host/files/sftp-write.js` | 移动 |
| `host/socks5.js` | `host/tunnels/socks5.js` | 移动 |
| `host/ssh-agent.js` | `host/ssh/agent.js` | 移动+重命名 |
| `host/ssh-auth.js` | `host/ssh/auth.js` | 移动+重命名 |
| `host/ssh-banner.js` | `host/ssh/banner.js` | 移动+重命名 |
| `host/ssh-upload-scheduling.js` | `host/files/upload-scheduling.js` | 移动+重命名 |
| `host/ssh2-client.js` | `host/ssh/client.js` | 移动+重命名 |
| `host/terminal-backend.js` | `host/terminal/backend.js` | 移动+重命名 |
| `host/terminal-census.js` | `host/terminal/census.js` | 移动+重命名 |
| `host/terminal-input.js` | `host/terminal/input.js` | 移动+重命名 |
| `host/terminal-output.js` | `host/terminal/output.js` | 移动+重命名 |
| `host/terminal-owner.js` | `host/terminal/owner.js` | 移动+重命名 |
| `host/transfer-tasks.js` | `host/files/transfer-tasks.js` | 移动 |
| `host/trash.js` | `host/files/trash.js` | 移动 |

`src/host/service/*`（22）、`src/host/tools/*`（6）、`src/host/monitor/*`（3）**保持原位**。

### 5.3 浏览器根级

| 现状 | 目标 | 动作 |
| --- | --- | --- |
| `client/AgentRevealWatcher.jsx` | `client/shell/AgentRevealWatcher.jsx` | 移动 |
| `client/HarborFiles.jsx` | `client/features/files/HarborFiles.jsx` | 移动 |
| `client/HarborHeaderAction.jsx` | `client/shell/HarborHeaderAction.jsx` | 移动 |
| `client/HarborPanel.jsx` | `client/shell/HarborPanel.jsx` | 移动 |
| `client/HarborResources.jsx` | `client/features/resources/HarborResources.jsx` | 移动 |
| `client/HarborSidebarBody.jsx` | `client/shell/HarborSidebarBody.jsx` | 移动 |
| `client/ResourceWorkspaces.jsx` | `client/features/resources/ResourceWorkspaces.jsx` | 移动 |
| `client/agent-connection-poll.js` | `client/shell/agent-connection-poll.js` | 移动 |
| `client/api.js` | `client/core/api.js` | 移动 |
| `client/command-snippets.js` | `client/features/snippets/command-snippets.js` | 移动 |
| `client/connection-status.js` | `client/shell/connection-status.js` | 移动 |
| `client/download-checkpoints.js` | `client/features/files/download-checkpoints.js` | 移动 |
| `client/exec-policy-ui.js` | `client/features/policy/exec-policy-ui.js` | 移动 |
| `client/file-editor.js` | `client/features/files/file-editor.js` | 移动 |
| `client/file-transfers.js` | `client/features/files/file-transfers.js` | 移动 |
| `client/format.js` | `client/core/format.js` | 移动 |
| `client/locale.js` | `client/core/locale.js` | 移动 |
| `client/log-highlight.js` | `client/features/logs/log-highlight.js` | 移动 |
| `client/pane-selection.js` | `client/state/pane-selection.js` | 移动 |
| `client/pemkey.js` | `client/features/connect/pemkey.js` | 移动 |
| `client/remote-file-search.js` | `client/features/files/remote-file-search.js` | 移动 |
| `client/session-terminals.js` | `client/state/session-terminals.js` | 移动 |
| `client/settings-nav-icon.js` | `client/shell/settings-nav-icon.js` | 移动 |
| `client/sftp-favorites.js` | `client/features/files/sftp-favorites.js` | 移动 |
| `client/sidebar-lifecycle.js` | `client/shell/sidebar-lifecycle.js` | 移动 |
| `client/store.js` | `client/state/store.js` | 移动 |
| `client/stream-download.js` | `client/features/files/stream-download.js` | 移动 |
| `client/terminal-pool.js` | `client/features/terminal/terminal-pool.js` | 移动 |
| `client/terminal-search.js` | `client/features/terminal/terminal-search.js` | 移动 |
| `client/terminal-styles.js` | `client/features/terminal/terminal-styles.js` | 移动 |
| `client/terminal-theme.js` | `client/features/terminal/chrome-theme.js` | 移动+重命名 |
| `client/terminal-zoom.js` | `client/features/terminal/terminal-zoom.js` | 移动 |
| `client/update-guidance.js` | `client/features/resources/update-guidance.js` | 移动 |

`src/client/index.jsx` **保持原位**（入口）。

### 5.4 浏览器既有子目录

| 现状 | 目标 | 动作 |
| --- | --- | --- |
| `client/features/monitor/format.js` | `client/features/monitor/metrics-format.js` | 移动+重命名 |
| `client/features/settings/settings.css` | `client/features/resources/settings.css` | 移动 |
| `client/terminal-display/EditablePreview.jsx` | `client/features/terminal-display/ui/EditablePreview.jsx` | 移动 |
| `client/terminal-display/PatternTags.jsx` | `client/features/terminal-display/ui/PatternTags.jsx` | 移动 |
| `client/terminal-display/TerminalAppearanceButton.jsx` | `client/features/terminal-display/ui/TerminalAppearanceButton.jsx` | 移动 |
| `client/terminal-display/TerminalDisplaySettings.jsx` | `client/features/terminal-display/ui/TerminalDisplaySettings.jsx` | 移动 |
| `client/terminal-display/addon.js` | `client/features/terminal-display/addon.js` | 移动 |
| `client/terminal-display/custom-rules.js` | `client/features/terminal-display/custom-rules.js` | 移动 |
| `client/terminal-display/drag-order.js` | `client/features/terminal-display/drag-order.js` | 移动 |
| `client/terminal-display/highlight-worker.js` | `client/features/terminal-display/highlight-worker.js` | 移动 |
| `client/terminal-display/matcher.js` | `client/features/terminal-display/matcher.js` | 移动 |
| `client/terminal-display/preview-text.js` | `client/features/terminal-display/preview-text.js` | 移动 |
| `client/terminal-display/regex-runner.js` | `client/features/terminal-display/regex-runner.js` | 移动 |
| `client/terminal-display/rules.js` | `client/features/terminal-display/rules.js` | 移动 |
| `client/terminal-display/scheme.js` | `client/features/terminal-display/scheme.js` | 移动 |
| `client/terminal-display/settings.js` | `client/features/terminal-display/settings.js` | 移动 |
| `client/terminal-display/theme.js` | `client/features/terminal-display/theme.js` | 移动 |
| `client/terminal-display/use-regex-matches.js` | `client/features/terminal-display/use-regex-matches.js` | 移动 |

`src/client/ui/*`（5 个）、`src/client/features/{batch,connect,logs,policy,snippets,terminal,tunnels}` 下既有文件 **保持原位**，仅移动其同目录 helper（见上表）。

### 5.5 P2/P3 新增文件（由拆分产生，非移动）

| 目标文件 | 来源 |
| --- | --- |
| `client/features/resources/{ResourceEditor,SharedCredentialEditor,ServerRow,HostKeyDialog}.jsx`、`dialogs/{ImportSourceDialog,OpenSshImportDialog,ResourceBackupDialog}.jsx`、`form.js` | `HarborResources.jsx` 按现有顶层函数边界拆出 |
| `client/features/files/{path-utils,entries}.js` + `hooks/{useFileList,useFileSearch,useEditor,useTransfers}.js` | `HarborFiles.jsx` 的纯函数与状态组 |
| `client/features/connect/connection-fields.jsx` | `ResourceEditor` 与 `ConnectDialog` 的重复字段组 |
| `client/ui/{primitives,surfaces,overlays,index}.jsx` | `kit.jsx` 的 34 个导出按类型拆分，`kit.jsx` 保留为 barrel |
| `rpc/schemas/<domain>.js`（13 个） + `rpc/schemas.js` barrel | `schemas.js` 按现有领域注释切分 |
| `rpc/declarations/<domain>.js` | `typert.js` 的 142 条声明 |
| `shared/shell-quote.js` | `host/safety.js` 的 `shellQuote` |

---

## 6. 分阶段执行计划

总工作量约 **5–7 人日**；P0/P1 是机械操作，可在一个 PR 完成；P2 之后每个 PR 只做一类事。

| 阶段 | 内容 | 风险 | 预估 | 合并粒度 |
| --- | --- | --- | --- | --- |
| P0 | 基线、守卫测试、迁移脚本 | 低 | 0.5 天 | 1 PR |
| P1 | 纯移动（88 个文件 + import 重写） | 低（机械） | 1 天 | 1–2 PR |
| P2 | 大文件拆分 + 表单去重 | 中 | 1.5–2 天 | 每文件 1 PR |
| P3 | 契约生成与声明归位 | 中 | 1 天 | 1 PR |
| P4 | 测试目录重组与断言改造 | 中 | 1 天 | 1–2 PR |
| P5 | 文档、根目录收尾 | 低 | 0.5 天 | 1 PR |

### P0 准备（0.5 天）

1. 记录基线：`npm run lint`、`npm run build`、`npm test`、`npm run i18n:extract` 全绿，并保存测试数量与耗时。
2. 把第 5 节映射固化为一次性脚本的输入（`scripts/oneoff/restructure-map.mjs`，用后删除），避免手工 `git mv` 88 次。
3. 新增 `test/meta/structure.test.mjs`（runner 递归后生效），先以「当前状态」为基线，P1 后收紧断言：
   - `src/client/`、`src/host/` 根目录只允许白名单文件（入口）；
   - 扫描 import，禁止 client→host 与 host→client；
   - `shared/` 不得 import `node:*`（`terminal-text` 移动后需确认不依赖 Buffer）。
4. 更新 `scripts/run-tests.mjs` 支持递归（或用自写 walk），为 P4 铺路；这一步可提前，不改变现有行为。

### P1 纯移动（1 天，无行为变化）

1. 按映射执行 `git mv`：宿主 8 个目录、客户端 `core/state/shell/features`、3 处跨层移动（`service-hub`、`envelope`、`terminal-text`）并新建 `shared/shell-quote.js`；删除清空后的 `client/features/settings/`。
2. 用 codemod 重写相对 import：
   - 解析每条 specifier 的旧目标路径，查映射表得到新目标，再从**新文件位置**计算相对路径；
   - 移动会导致深度变化的文件，其自身 import 也要重算；
   - CSS import（`./files.css`、`../ui/styles/app.css`）同样处理。
   预期触碰 **233 条指向平铺模块的边（src 151 + test 82）+ 被移动文件自身的出边**（全仓共 583 条相对边）。
3. 更新硬编码路径与测试引用：
   - `scripts/build-client.mjs:22` 的 `highlight-worker.js` 入口；
   - `README.md:110–113` 的开发目录说明；
   - 14 个测试中的源码读取路径（见 R8）。其中两个要改逻辑而不只是改路径：
     - `test/confirmations.mjs` 用「客户端相对目录 + 裸文件名」拼路径：`terminal-display/TerminalDisplaySettings.jsx` 需改为 `features/terminal-display/ui/...`；
     - `test/client-apply-reentrancy.mjs` 从 import 说明符推导 stub 导出名：改用 `basename`，否则 `HarborResources.jsx` 移入子目录后会生成非法标识符。
4. 验证：`npm run build`（esbuild 会暴露漏改的 import）、`npm test`、`npm run lint`、`npm run preview:ui` 后人工看 4 个预览页。
5. 该阶段**只移动、不改内容**：`git mv` + import 行修改保持在同一提交，`git blame` 才能跟随；重命名与内容修改不要混在一起。

**P1 已完成演练（影子副本，未改动本仓库）：**

- 规模：按第 5 节映射执行 **88 次移动**、重写 **583 条 import**、修正 **35 处路径字符串**。
- 结果：`build:host` 与 `build:client` 均成功，`npm test` **368/368 通过**。
- 测试影响：14 个源码读取测试中，12 个只需替换路径；`confirmations` 与 `client-apply-reentrancy` 需要一笔逻辑修改（见上条）。
- codemod 规则（演练确认）：import 说明符按「新文件位置」重算相对路径；而 `src/...` 字符串必须保留原有前缀（`src/`、`../src/`）只替换尾部——整体重算会把 `path.join(ROOT, "src/...")` 与 `new URL("../src/...")` 两类写法一起改坏。

**回滚**：单个 PR、纯机械改动，`git revert` 即可；不涉及数据或配置。

### P2 大文件拆分与表单去重（1.5–2 天）

顺序（每个文件一个提交，先拆纯函数再拆组件）：

1. `HarborResources.jsx` → 7 个组件 + 两张卡片组件 + `form.js` + 2 个页面级 hook（第 7 节给出函数边界与行号）。
2. `HarborFiles.jsx` → `path-utils.js`、`entries.js`、5 个 hook、11 个展示组件；30 个 `useState` 收敛到 5 组。
3. `kit.jsx` → `primitives` / `surfaces` / `overlays` + barrel；`kit.jsx` 改为 re-export，避免一次性改 20 个消费方。
4. `schemas.js` → 13 个领域文件 + barrel。
5. `safety.js` → `categories.js`（分类与标签）/ `canonical.js`（命令规范化词法）/ `rules.js`（解析与清单归一化）/ `decision.js`（判定与文案）；保留 `safety.js` barrel。
6. 抽 `connection-fields.jsx`，两处表单复用（实际评估后跳过，见第 11 节）。

验收：每步 `npm test` 绿；`HarborResources` 与 `HarborFiles` 单文件降到 400 行以内；预览页交互抽查（文件列表、编辑器、上传任务、资源编辑、导入/备份对话框）。

### P3 契约收敛（1 天）

1. `scripts/gen-typert.mjs`：从 `DESCRIPTORS` 生成 `typert.model.services[0].members`（`name` + `signature` 可由方法名与类型名拼出），`typert.js` 保留为薄装配层。
2. 142 条 `declaration` 移到 `rpc/declarations/<domain>.js`，按领域与 schema 同侧存放；`typert.js` 只汇总。
3. `test/rpc-contract.mjs` 继续作为漂移守卫，并新增一条：成员必须与 `DESCRIPTORS` 一一对应（生成物被手改即失败）。
4. 可选（不建议本期做）：从 zod 反向生成 TS 声明。现有 zod v4 内部结构不足以稳定生成，成本高于收益。

### P4 测试重组（1 天）

1. 目录镜像：`test/client/{core,state,shell,features}/`、`test/host/{ssh,exec,policy,files,terminal,resources,tunnels,service}/`、`test/rpc/`、`test/integration/`、`test/meta/`（manifest、release、preview）。
2. 批次回归文件（`p1/p2/p3-regressions`、`issues-50-51`、`harbor-0-2-0-regressions`）按用例归属拆回领域文件；跨领域且暂无法归类的保留，但文件名改为 `regressions/<主题>.mjs`。
3. 14 个源码文本断言：
   - 3 个纯结构断言（文件存在、导出存在）并入 `test/meta/structure.test.mjs`；
   - 行为类改为渲染/DOM 或纯函数测试（项目已有 `jsdom`）；
   - 必须保留的源码断言集中到一个文件，并使用映射表解析路径，避免下次移动再红一片。
4. CI 不变（`npm test` 已覆盖全部 spec），但测试数应保持不变：迁移前后对比 `--test` 报告的总用例数。

### P5 文档与收尾（0.5 天）

1. `README` 开发节改为「目录职责 + 落点规则」，不再罗列文件；与 `docs/restructure-plan.md` 互链。
2. `docs/ui-guidelines.md` 补一节「组件放哪里」；`docs/product-guide.md` 不动。
3. 清理工作区：`npm run clean`、删除 `.DS_Store`、确认 `git status` 只剩预期改动。
4. 在 `INSTALL.md` 的开发命令处补一句产物目录说明。

---

## 7. 大文件拆分细则

| 文件 | 行数 | 拆分 | 目标 |
| --- | ---: | --- | --- |
| `HarborResources.jsx` | 1,912 | 按现有顶层函数边界 | `ResourceEditor`（149–453）、`ImportSourceDialog`（454–480）、`OpenSshImportDialog`（481–614）、`ResourceBackupDialog`（615–722）、`SharedCredentialEditor`（723–851）、`HostKeyDialog`（852–886）、`ServerRow`（887–970）、`HarborResources`（971–1912）、`form.js`（`emptyForm` 59–83、`profileToForm` 84–113、`readLegacyProfiles` 114–148） |
| `HarborFiles.jsx` | 1,482 | 纯函数 → hook → 展示 | `path-utils.js`（48–67）、`entries.js`（68–112）、`hooks/useFileList`、`useFileSearch`、`useEditor`、`useTransfers`、`useDownloads`（从 113 行起的 30 个 state 分组）、`FileToolbar` / `FileList` / `FileSearchPanel` / `FileEditorPane` / `TransferTasks` / `ScpPane` / 3 个对话框 |
| `kit.jsx` | 854 | 按组件类型 | `primitives`（Button/Input/Field/Switch/Checkbox/Segmented/Tabs）、`surfaces`（Card/Section/Row/Badge/Dot/Pill/Empty/Spinner/Error/Notice/Progress）、`overlays`（Dialog/Confirm/Menu/Toast）、`useCopy`；`kit.jsx` 保留 barrel |
| `schemas.js` | 1,085 | 按现有领域注释 | `common`（信封、错误、owner）、`auth`、`connections`、`resources`、`credentials`、`workspaces`、`files`、`terminal`、`settings`、`monitor`、`batch`、`logs`、`tunnels`；`schemas.js` barrel |
| `safety.js` | 697 | 按职责 | `categories.js`、`canonical.js`、`rules.js`、`decision.js`；`safety.js` barrel（词法层单拆，四个文件都在 140–410 行） |
| `host/service/connections.js` | 951 | 可选 P2b | 按阶段拆 connect / hostkey / keepalive-reconnect / jump；mixin 组合顺序需保持，风险高于其他拆分 |
| `host/service/exec.js` | 596 | 可选 P2b | exec 通道 / 网络 CLI 回退 / 终端输入闸门 |
| `host/service/transfers.js` | 579 | 可选 P2b | 目录批传 / 可恢复上传任务 |
| `host/service/resources.js` | 511 | 可选 P2b | 资源 CRUD / 备份 / OpenSSH 导入（后半可委托 `host/resources/*`） |

拆分原则：**先抽纯函数，再抽 hook，最后拆 JSX**；每个新文件不超过 400 行；barrel 文件只做 re-export，保证消费方 import 路径不变。

---

## 8. 风险与回滚

| 风险 | 触发点 | 控制 |
| --- | --- | --- |
| import 漏改 | P1 88 个文件移动 | codemod 基于解析后的旧图生成新路径；`npm run build` 对未解析 import 立即失败；再加一条全仓 import 解析守卫 |
| 14 个源码文本测试失败 | P1 | P0 先列出清单，随移动提交同步改路径；其中 `confirmations` 与 `client-apply-reentrancy` 需改测试逻辑（见 P1 演练）；不留在后续 PR |
| `shared/terminal-text.js` 依赖 Node | 移动后浏览器 bundle | 该文件只做字符串处理；检查无 `Buffer`/`node:*`；`test/meta/structure.test.mjs` 禁止 `shared/` import `node:*` |
| CSS 相对路径断裂 | 组件移动 | 同 codemod 处理 `.css` import；`npm run preview:ui` 后目视 4 个页面 |
| git blame 丢失 | 移动与改内容混提交 | 移动提交只允许 import 行变化；拆分另起提交 |
| 公开入口变化 | 误移 `src/index.js`、`terminal-backend.js`、`rpc/typert.js`、`rpc/remote.js`、`client/index.jsx` | 白名单守卫；`package.json` exports 与 `cordis.patch.yml` 零改动 |
| Windows 路径分隔符 | 开发者环境 | codemod 统一用 `path.posix` 生成 import，落盘用 `path.join` |
| i18n 提取差异 | 移动文件 | `npm run i18n:extract` 后 `git diff` 必须为空（脚本扫描源码） |
| 预览页静态断言 | P2 拆组件 | 预览构建 + 截图对比工作台/设置/画廊三页 |

回滚策略：每个阶段独立 PR；P1 纯机械可整体 revert；P2 每文件一提交，失败只回滚该文件；P3 生成物可退回手写版本；P4 测试移动可单独 revert。

---

## 9. 验收标准

结构：

- [ ] `src/client/` 根只剩 `index.jsx`；`src/host/` 根没有 `.js` 文件。
- [ ] 每个 `src/client/features/<name>/` 目录自包含其组件与专属 helper；有专属样式的放进同目录；不存在只有 CSS 的 feature 目录。
- [ ] 扫描 import：`src/client/` 中没有指向 `../host` 的引用，`src/host/` 中没有指向 `../client` 的引用。
- [ ] `src/shared/` 不含 `node:*` import，也不含持有服务实例的模块。
- [ ] 没有超过 600 行的源码文件，豁免清单仅 `i18n/messages.en.js`、`ui/styles/app.css`（并注明理由）。
- [ ] 测试目录镜像 `src/` 的顶层分组；只有 `test/meta/structure.test.mjs` 允许读源码文本。

行为：

- [ ] `npm run lint`、`npm run i18n:extract`、`npm run build`、`npm test` 全绿；测试总用例数不低于迁移前。
- [ ] `npm run preview:ui` 后 `preview/out/{workspace,settings,gallery}-{light,dark}.html` 正常渲染，终端、文件、资源编辑、导入/备份对话框可交互。
- [ ] 打包：`npm run pack:release` 成功，`release/*.zip` 含 `src/`、`test/`、`docs/`，`release/*.tgz` 只含 `package.json files` 声明的产物。
- [ ] 以链接方式安装后 `npm run build` + 刷新页面，宿主半重启后 `terminal_open({type:'harbor-ssh'})` 仍可用（验证 `cordis.patch.yml` 伴侣入口未受影响）。

契约：

- [ ] `test/rpc-contract.mjs` 绿；typert 成员与 `DESCRIPTORS` 数量一致且由脚本生成。
- [ ] 新增一个 RPC 的改动点 ≤ 4 个文件（schema 领域文件、descriptor、service mixin、client api）。

---

## 10. 明确不做的事

1. **不重写 service mixin 架构。** 16 个 mixin 共享连接/会话状态，改成按领域聚合会在类继承层形成环；当前组合根清晰，保持。
2. **不拆 `i18n/messages.en.js` 与 `ui/styles/app.css`。** 词典按键全局唯一、样式依赖级联顺序；拆分只增加维护点，不降低复杂度。
3. **不合并 `README.md` / `README.en.md`，不合并 `locale/*.json` 与 `i18n`。** 读者与消费方不同。
4. **不改 `lib/` 产物结构与打包清单。** 宿主加载契约已稳定，结构调整不应触碰发布形态。
5. **不引入 TypeScript、路径别名或 monorepo。** 会牵动 esbuild 配置、DSH 插件加载与测试运行方式，收益与风险不成比例。
6. **不为「看起来重复」的 base64、CSS、`format.js` 强行合并**（见第 3 节「已核查」表）。

---

## 附录 A 新增一个 RPC：现在 vs 之后

| 步骤 | 现在 | 重构后 |
| --- | --- | --- |
| 1 | `rpc/schemas.js` 加请求/结果 schema | `rpc/schemas/<domain>.js` |
| 2 | `rpc/descriptors.js` 加 `def()` | 同左 |
| 3 | `rpc/typert.js` 加成员 + 1–2 条声明 | 生成，无需手改 |
| 4 | `host/service/<concern>.js` 实现方法 | 同左 |
| 5 | `client/api.js` 加包装方法 | 同左 |
| 6 | （Agent 可见时）`host/tools/<domain>.js` 注册 | 同左 |
| 7 | `test/rpc-contract` 期望 | 自动覆盖成员一致性 |
| 文件数 | 5–7 | 3–4 |

## 附录 B 迁移脚本骨架

```js
// scripts/oneoff/restructure.mjs（一次性，合并前删除）
// 1) 读映射表 [{ from, to }]
// 2) 对每个 from: git mv from to
// 3) 重建 import 图：
//    - 用旧路径解析每条相对 specifier，得到旧目标
//    - 查映射得到新目标（未映射则保留）
//    - 以新文件所在目录为基准，path.posix.relative(dirname(to), target)
// 4) 只改 specifier 字符串，不改其余内容
// 5) 校验：全仓每条相对 import 都能解析到真实文件
```

执行顺序建议：`git mv` 与 import 重写放在同一提交；随后跑 `npm run build && npm test`；确认 `git diff --stat` 中只有 rename 与 import 行，再进入 P2。

---

## 11. 执行记录（2026-11-28）

P0 → P5 已按顺序落地，每个阶段一个提交；每次提交前 `npm run lint`、`npm run build`、`npm test`、`npm run i18n:extract` 均为绿。

| 提交 | 阶段 | 内容 |
| --- | --- | --- |
| `64bda61` | P0 | `test/meta/structure.test.mjs` 结构守卫、`scripts/run-tests.mjs` 递归发现、迁移映射脚本 |
| `c6f4cc5` | P1 | 88 个文件移动、583 条 import 与 123 处路径字符串重写；新增 `src/shared/shell-quote.js` |
| `d933f22` | P2 | `safety` 拆分为 categories / canonical / rules / decision |
| `f07e8e2` | P3 | typert 成员由 descriptors 生成；142 条声明拆到 `src/rpc/declarations/` |
| `2a33feb` | P2 | `kit` 拆成 primitives / surfaces / overlays，barrel 保留 34 个导出 |
| `a382167` | P2 | `schemas` 拆成 13 个领域模块 + barrel（132 个导出逐一比对一致） |
| `28a017b` | P2 | `HarborResources` 1,912 → 312 行 + 17 个模块 |
| `f0b8dfc` | P2 | `HarborFiles` 1,482 → 384 行 + 5 个 hook + 11 个展示组件 |
| `6281cb7` | P4 | 114 个 spec 迁入镜像目录，路径与 `import.meta.url` 引用同步重算 |
| `f75aa0b` `1fcd4e0` | P5 | README / INSTALL / ui-guidelines 的目录职责与落点规则 |

### 结果

| 指标 | 重构前 | 重构后 |
| --- | ---: | ---: |
| `src/host/` 根级 `.js` | 36 | 0 |
| `src/client/` 根级文件 | 34 | 1（`index.jsx`） |
| 超过 500 行的源文件 | 17 | 8 |
| `test/` 根级 spec | 114 | 0（20 个子目录） |
| 结构守卫断言 | 0 | 8 |
| 测试用例 | 368 | 376（原 368 + 8 条结构断言） |

护栏：`test/meta/structure.test.mjs` 现在会拒绝根目录新增文件、client↔host 互相 import、只有 CSS 的 feature 目录、`shared/` 引用 `node:*`、无法解析的相对 import，以及把 spec 放回 `test/` 根目录。

### 与方案的差异

1. **`safety` 拆成 4 个文件**（多一个 `canonical.js`）。命令规范化是一段独立词法逻辑，合在 `rules.js` 里会让该文件超过 400 行；拆开后四个文件是 60 / 140 / 410 / 101 行。
2. **R10 连接表单未合并**。两处表单控件不同（`Select` vs `SegmentedControl`）、字段标签与校验规则也不同，共享组件需要为几乎每个字段加 variant，反而比重复更难读。真正共用的部分（私钥体检、凭据写入）此前已在 `features/connect/pemkey.js` 与 `features/resources/form.js` 中共享。
3. **P3 用「生成物 + 派生函数 + 漂移测试」而非纯脚本覆盖**。`scripts/gen-typert.mjs` 写 `src/rpc/typert.generated.js`，`test/rpc-contract.mjs` 把生成物与 `deriveMembers(DESCRIPTORS, prototype)` 逐项比较：手改生成物或改了方法同步性却忘记重新生成都会失败。
4. **回归批次 spec 仍成组保留**（`test/integration/regressions/`）。按用例归属拆回领域文件需要逐条判断覆盖范围，风险和收益不成比例，留作独立任务。
5. 新增 `test/shared/`，镜像唯一一个 `src/shared/` spec。

### 留下的后续（不在本次范围）

- `host/service/connections.js`（951）、`exec.js`（596）、`transfers.js`（579）仍按 P2b 处理：拆分要先固定 mixin 组合顺序，风险高于本轮。
- `HarborPanel.jsx`（657）与 `TerminalDisplaySettings.jsx`（610）未在方案的第 7 节清单内，本轮未动。
- 回归批次 spec 的按领域拆分。
- 源码文本断言仍分散在各 spec（拆分时已逐条改读到新的归属文件），尚未集中到单一文件 + 路径映射表。
