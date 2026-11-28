# 变更记录

版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。0.2.0 为首个公开版本，0.1.0 是其内部基线。

## 0.6.0 — 2026-11-28

**审批、生命周期与客户端状态的收口；Wire 契约与变更记录的坏结构一并复位。**

### 审批与连接

- **删除命令的两种转义拼写不再绕过审批**：双引号里用「反斜杠 + 换行」拆开程序名，或写成 ANSI-C 的 \u / \U（bash 4.2+），规范化文本与原文里都不含 rm，`$'\u0072\u006d' -rf x` 因此既不弹审批也不走回收站。`assessShellCommand` 现在按 shell 语义去掉续行并解码这些转义，`test/safety.mjs` 增加对应回归。
- **掉线的连接不再被静默换成另一台服务器**：`activeConnectionFor` 过去会因为 transport 暂时 dead 就丢掉会话绑定，`handleTransportLoss` 还会主动 `forgetActiveConnection`，于是同一对话在另一台机器上也有终端时，`ssh_exec` 会被解析到那台机器，并把它重新绑定下来。现在绑定随记录一起存活（自愈重连复用同一条记录），工具侧由 `ensureAlive` 判定并在放弃时报 `connection-lost`；`test/per-session-terminals.mjs` 固定了这条行为。
- **「保存并连接」不再丢共享凭据**：连接对话框的 `profileSave` 漏传 `credentialId`，而选中共享凭据后密码/私钥输入框是隐藏的，结果要么被「请输入密码」拦下（提示与操作不符），要么存下一台既无共享凭据也无内联凭据的服务器，首次连接即报 `credential-missing`。现在凭据随资源保存，内联凭据写入被跳过。

### 审查修复（P2：窄窗口缺陷）

- **跳板链失败不再漏 socket**：hop 客户端只在整条链成功后才进入 `record.hops`，而 `forwardOut` 在已关闭的客户端上会同步抛错（不回调），两种形状都让一条 SSH transport（含 keepalive 定时器）活到进程退出。`connectChain` 现在只有一个收口：hop 握手失败、`forwardOut` 同步抛、主机密钥写入失败，都会关闭对应的 hop；主机密钥写入改为非致命（与目标连接同一策略）。
- **横幅修复失败不再漏 socket**：`withRepairedBanner` 读超时或对端关闭时，套接字被留在暂停状态且无人持有，下一次尝试会另开一条。现在失败即销毁。
- **`disconnect` 立即生效**：它过去只删除记录，正在握手的那次尝试与所有停在 `ensureAlive` 的调用者仍各自等到超时（握手最长 20 秒、等待最长 30 秒）。现在会中止 in-flight 资源并唤醒等待者，面板说「已断开」时它真的已经断开。
- **连接数上限**：同时打开的 SSH 连接限制为 32 条，断开一台即释放名额；超出时以 `connection-limit` 说明原因，而不是继续分配套接字、keepalive 定时器与跳板链。
- **同一连接只开一条 SFTP 通道**：并发调用各自看到 `sftp === null`，各自打开子系统通道，只有最后一条被缓存，其余无人持有也无法关闭，持续占用 sshd 的 MaxSessions。现在单飞共享通道与失败；若通道打开期间传输掉线则不再缓存该 wrapper（否则后续调用会等一个永远不会来的回复）。
- **删除不再跟随符号链接**：`sftp_delete` 改用 lstat 判断条目自身类型——指向目录的符号链接按链接删除，断链也能删除，不再对链接发 rmdir。
- **重命名不再把属性当身份**：`size`/`mtime`/`mode` 相同的两个不同文件曾被判定为「同一个条目」，随后 `rename` 静默覆盖目标。现在用 `realpath` 等价判断同一路径，大小写差异再读父目录 listing 判断是否同一个条目：大小写不敏感导出上的仅改大小写重命名仍可用，大小写敏感导出上两个真实条目会被拒绝。
- **终端关闭与通道打开的竞态**：面板在 shell 出现前关掉标签时，记录已删除而通道随后到达，过去会被一个没人能再引用的记录收下——关不掉，且占一个 sshd 通道槽位。现在检测记录是否仍在，否则关闭通道并返回 `session-closed`。
- **已结束的 `terminal_send` 不再被取消**：`cancel()` 过去只看「是否已取消」，迟到的 abort（或 registry 的收尾）会往终端写入 `^C`，打断用户此刻正在做的事。现在 send 结束即置 settled，`cancel()` 返回 false。
- **提交中的上传不再谎报取消**：提交是一次 rename，开始后无法撤销。现在 `task.committing` 期间 `cancel()` 返回 false，不再出现「显示已取消、文件其实已落盘」的状态。
- **会话日志分页不再切断字符**：页边界落在多字节字符内会解码成替换符并跳过原字节，面板显示乱码且原文无法再取回。现在页边界与 append 的字节上限都按码点收口，分页可无损还原。
- **known_hosts 按算法记录**：一台服务器同时提供 ed25519/rsa/ecdsa 是常态，协商到哪一种会随固件与客户端能力变化；单条记录把这种正常变化报成「主机密钥已变更」，而误报会训练人忽略真警报。同一 host:port 现在记录多个算法（顶层保留最新一对以兼容面板与旧归档），合并写入按主机串行化以免并发丢键，boot schema 与备份 schema 同步扩展，「忘记主机指纹」删除该主机的全部算法。
- **设置读取失败不再无声无息**：配置记录无法解析时仍以安全默认值启动（自动连接关闭、标准策略），但会写入一行日志——过去它看起来和「我的设置被重置了」一模一样，且没有任何痕迹可查。

### 安全与生命周期修复

- **`terminal_send` 的审批不再承诺回收站**：只有 `ssh_exec` 会在执行前把字面删除改写成 `mv` 进 `~/.dsh-trash/`；`terminal_send` 直接向 PTY 写入，没有改写点。审批卡片现在对终端路径明确提示「原样执行、不进回收站」，并建议改用 `ssh_exec`，不再复用 `ssh_exec` 的可逆承诺。
- **取消 `terminal_open` 不再关闭复用的面板终端**：启动等待失败时只清理本次调用新建的 PTY；`reused` 的 PTY 是用户正在使用的 shell，取消、超时或启动失败都不再把它关掉。
- **第一次按键即取得终端所有权**：`notePanelInput` 现在无条件把 PTY 标记为 `userOwned`，不再依赖 `terminal_open` 建立的 registry binding；`ssh_connect`、`ssh_exec` 与面板打开的原始终端也不会在用户输入后被 Agent 接管。匿名 PTY 被用户输入后同样不会被 adoption 拿走。
- **补齐构建与测试输入**：`.github/workflows/ci.yml`、`src/host/sftp-write.js`、`src/client/format.js`、`src/client/file-transfers.js`、`src/shared/exec-policy-label.js` 与五个测试/支持文件此前只存在于工作树，干净检出无法构建或跑测试；现已全部纳入仓库，并新增 `test/terminal-open-lifecycle.mjs`。

### 终端、传输与性能修复

- **面板终端与 registry id 不再混用**：`ssh_connect` / `ssh_connect_profile` 打开的是 Harbor 面板 PTY，其 id 不是 `terminal_send` / `terminal_read` 能解析的 registry session id。工具结果不再返回 `terminalSessionId`，`ssh_list` 不再把面板 id 当作可操作 id；系统提示、工具描述、README 与产品指南统一改为「先调 `terminal_open`（type 为 `harbor-ssh`），它复用同一条 PTY 并返回 registry id」。新增回归证明 `terminal_open` 确实复用面板 PTY。
- **`sftp_read` 的 `max_bytes` 在服务层封顶**：RPC schema 有 16 MiB 上限，但 agent 工具直接调 service，绕过 zod；现在服务层把它夹到 `MAX_FILE_READ_BYTES`（4 MiB），0 仍表示只读 0 字节，负数和 `NaN` 不再放大读取。
- **移除未受本地路径保护的目录传输 RPC**：`sftpUploadDir` / `sftpDownloadDir` 仍由 agent 工具调用（工具层有 `requireLocalAgentPath` 审批），但不再作为 direct RPC 暴露；此前任何已认证客户端都能绕过本地路径守卫直接读写宿主文件。对应 Typert 方法与类型一并删除。
- **目录下载不再跟随远端符号链接**：`walkRemoteDir` 用 `attrs.mode` 标记 symlink，`sftpDownloadDir` 把它列入 `failed` 并明确报「symbolic links are not followed」，与上传方向一致；嵌套的 `vendor -> /etc` 不会再被带出绑定根。
- **远端写入真正可取消**：旧实现用 `Promise.race` 套一个不可取消的写，30 秒后报告失败时 rename 仍可能完成。现在 `writeRemoteFileAtomic` / `saveEditorFile` 接受 `AbortSignal` 与写预算，超时或取消会 `destroy` 流、删除临时文件；提交阶段（chmod/rename）不再被传输预算误伤。`sftp_write` 也把工具 signal 传进服务。
- **陈旧传输锁可回收**：journal lock 改为 `{pid, token, at}`，持锁进程已退出、同进程但 token 已失效、或锁内容损坏时，会先 rename 再删除（两个回收者不会互删新锁）；活锁仍保持 3 秒等待。
- **终端 journal 追加从 O(n²) 降为摊还 O(chunk)**：不再每个 chunk 都把整段 2 MB 文本 `Buffer.from(...)` 重编码；改为从头部按 UTF-8 边界扫描并丢弃超额字节，保留上限仍精确到字节。
- **`atPrompt` 只渲染尾部 4 KB**：原来每 50 ms 对整段 journal 做 `renderTerminalSession`（2 MB 约 39 ms/次）；现在只对最后 4 KB 做 `toReadableText`。`terminal_send` 同时接受 `request.signal`，取消会立即结束等待（沿用既有 `waitReason` 取值，不新增契约值）。

### 客户端与并发修复

- **关闭服务器标签前重新读取宿主列表**：面板用最多 5 秒前的缓存判断「是否还有别的对话在用这台服务器」，窗口内另一个对话新建的终端会被一次 `disconnect` 连带杀掉。现在关闭动作先 `api.list(sessionId)` 取新鲜数据，再决定「只关本对话终端」还是「断开 transport」；读取失败才退回缓存。
- **设置页不再污染面板的连接列表**：设置页连接成功后调用的 `api.list()` 不带 session，却写进共享 store；与会话面板同时挂载时，`mine` / `activeConnectionId` 会被匿名列表覆盖，面板短暂把本会话终端看成别人的。设置页现在只排队 reveal，列表交给面板自己的轮询。
- **Esc 只关闭最上层对话框**：每个 Dialog 都在 document 上监听捕获阶段 keydown，`stopPropagation()` 阻止不了同节点上的兄弟监听器，确认框和它后面的设置框会一起关闭。新增 dialog 栈，只有栈顶处理 Esc/Tab，焦点归还也只由原本持有焦点的对话框执行。
- **隐藏面板不再轮询**：文件传输列表（1.5 秒）、转发列表（4 秒）在 `display:none` 时仍持续请求，切换视图后也不停；批任务轮询（1 秒）还允许请求叠加。现在文件/转发按 `active` 视图启停，隐藏标签页不请求；批任务加 in-flight 守卫。
- **收藏、项目目录与策略读取的时序**：收藏 key 改为从面板已有的 connection 同步计算，不再等 `api.list()`，避免「点了收藏但 key 还是 null」被静默丢弃；设置页给的项目目录只在首次进入该服务器时消费一次，之后不再覆盖用户自己的 cwd；执行策略读取失败不再伪造 `standard`，而是明确报错并禁用档位选择。
- **并发 `terminal_open` 串行化**：两次并发 spawn 都可能通过 `liveAgentTerminal()` 检查，然后把两条 registry 记录绑到同一条 PTY，任一条 `terminal_close` 都会结束另一条。现在按 owner 串行执行「打开 + 发布 binding」，第二次调用会看到第一个 binding 并拒绝，而不是复用同一条 PTY。

### 文档、打包与冗余清理

- **源码 zip 补齐开发输入**：`npm run pack:release` 的源码归档加入 `eslint.config.js`、`.editorconfig` 与 `preview/`（排除可再生的 `preview/out`）；此前解压后 `npm run lint` / `npm run preview:ui` 按 INSTALL 执行会失败。
- **INSTALL 增加「升级」章节**：本地链接、`.tgz` 与 registry 三种安装方式分别写清覆盖安装与重启步骤，并说明升级不会删除 DSH 本地存储中的资源/指纹/凭据。
- **文档去重与回到实现**：UI 指南不再重复 INSTALL 的预览/快照命令；README 中英的开发树改为入口说明，不再手抄会漂移的目录；`connection_id` 的作用范围排除 `ssh_batch` 与 `ssh_session_log_*`；`app.css` 的字号与 2px 圆角收进 token，UI 规范「无字面量」重新成立。
- **死代码与上限**：移除无生产调用者的 `newestUnclaimedTty` / `isOwnedBy`、永远不可能命中的 locale 探测分支、`index.js` 里遮蔽外层变量的 `conn`；批量任务增加 50 条待处理上限。`profileSave` 省略 `groupId` 时保留原分组，`profileConnect` 传递 `sessionId`，删除不存在的会话日志返回 0，Typert 手写类型补齐请求字段。
- **同一实现的多份副本收敛**：`ext_openssh_rename → rename` 的回退从四处（目录上传、断点续传提交、流式上传、编辑器写入）收敛到 `sftp-write.js` 的 `replaceRemoteFile`；本地路径包含性判断只保留 `local-path-guard.js` 一份，`sftp-dir.js` 改为抛出式包装；「是否已停在提示符」的渲染侧规则移入 `service/text.js`，与原始侧规则相邻；「这条终端属于本对话」的判定只保留 `isMineTerminal` 一份（它同时修正了无会话 id 时把匿名终端算成自己的问题）。
- **删除生产路径已不再使用的编译器和测试替身**：`compileCustomRules` 没有任何生产调用者（真正的路径是 `scheme.js` 把旧 `customRules` 映射成条目再编译），已删除，对应测试改为驱动出货路径 `getScheme` + `compileScheme`。
- **`appendCapped` 不再切断多字节字符**：`ssh_exec` 输出在 64 KB 截断处的最后一个字符曾按字节切开、显示为 `�`；现在与 `tailUtf8` 用同一套码点回退。
- **i18n 字典不再有永远命不中的词条**：字典按「字面段」建键，`活动连接 ${a}` 与 `活动连接 ${b}` 编译出同一个正则，每组只有第一条可达。删除 8 条撞键死词条与 1 条孤儿词条，`i18n-extract` 现在把撞键当成错误（此前 `dictNormalized` 会静默保留最后一条）。
- **文档回到一处**：README 中英重新对齐（英文补回 7 个功能子节与 5 处缺失事实）；`terminal_open` 的完整步骤与 `terminal_send` 不可逆的完整解释各自只留一处正文，另一处改为一句摘要 + 链接；产品指南把「盾形按钮」改成实现里的「带档位文字的策略按钮」；配色快照头部的版本说明并入 `sync-theme-snapshot.mjs` 的模板（此前是手写，重生成会被静默擦掉）。
- **项目结构**：删除空的 `test/helpers/`；`build-preview` 去掉逐字重复的 `html.cap [data-preview-chrome]` 规则；`npm test` 改为 `node scripts/run-tests.mjs`（原先的 `$(node scripts/list-tests.mjs)` 在 cmd.exe 下无法展开，而项目其它脚本都认真处理了 win32）；新增 `test/preview-mock.mjs`，把离线预览 stub 的方法名钉在 `src/client/api.js` 的真实方法表上——它一上线就抓到两个漂移的 stub。

### 面板与终端状态（P3）

- **终端池不再泄漏 xterm**：死会话（收到 `exit` 或 `no-session`）卸载时调用 `drop()`；租约改为按会话匹配，同一 mount 里不该释放的终端不再被误 dispose；仍被别人画着的条目只标 `dead`，由持有者收尾。
- **编辑器关闭前确认**：Esc、遮罩与「关闭」都走同一个 `closeEditor`，内容改过就弹「放弃未保存的修改？」，未改直接关。
- **远程搜索失败不再卡死**：异常与取消都清掉 `running` 并给出原因（失败时带原文），此前按钮会一直禁用。
- **面板异常可恢复**：`PaneBoundary` 在切换页签或服务器时清除错误，并新增「重试」；快捷命令页签每次显示都会聚焦搜索框。
- **图标与键盘**：`paper-plane-outline` 不在 sprite 里（按钮什么都不画），改用 `terminal`，并增加一条扫描全部静态图标名的守卫；视图与服务器条都实现了真正的 tablist 键盘模型（方向键 / Home / End、单一 Tab 停靠点），服务器条的关闭按钮从 `role=tab` 里拆成兄弟节点。
- **设置页连接状态即时生效**：连接成功后立刻标记该行，5 秒轮询窗口内不会再点出第二条 SSH 连接。
- **注册表按需释放**：公告去重改为按连接的 `Map`（常量空间）；文件传输注册表在最后一个订阅者卸载且没有任务/冲突时删除。
- **批量轮询分档**：有人在等时 1 秒，纯发现新任务 4 秒，隐藏页不轮询；已消失的计划从去重集合里清掉。

### 主机侧边界（P3）

- **回收站保留期清理不再丢数据**：删失败的副本仍留在清单里（改写时按名字保留），`purged` 只统计真正删掉的条目。
- **上传提交阶段断开如实报未知**：返回 `sftp-upload-commit-unknown` 且不再自动重试（partial 可能已被 rename 搬走）。
- **临时文件名有界**：`.~<tag><10 hex>.tmp`，基名按 UTF-8 字节截到 255 以内；`sftpTransferDiscard` 改为按形状校验临时名，仍认旧版 `.dsh-upload-<uuid>.tmp`。
- **`tunnel_list` 的 dynamic 不再渲染成 `-> undefined:undefined`**；**CLI 回显**在设备先回空行时也能剥掉；**`parsePs`** 不再返回永远到不了线上的 `count`。
- **批量计划 30 分钟过期**：无人应答的计划不再永久占住 `batch-limit`；**`terminal_open` 文案**改为如实说明「同一会话已有终端时会被拒绝」。
- **`ssh_exec` 的 cwd 提示更快**：先从 tty census 取该终端的 shell pid 作为首选提示，命中即停止全量扫描；同一 tty 上有多个 shell 时也能选中正确的那条。

### 协议契约与发布

- **`openSession.forceNew` 上得了线**：宿主早就按 `request.forceNew` 决定是否复用终端（人接管后必须新开），而 schema、Typert 声明与客户端 facade 都没声明它，面板永远发不出这个开关。现已补齐，并断言解析后字段仍在。
- **`sftpStat` 的结果终于能通过校验**：schema 复用了列表条目（要求 `name`），宿主返回 `{path, isDirectory, size, mtime, mode}`，严格解码必然失败，调用方拿到的永远是 null。现在 stat 有独立载荷与 `SftpStat` 类型。
- **编辑器保存不再接受永远为空的取消信号**：`sftpEditorSave` 是一元 RPC，线上没有 AbortSignal，唯一调用方（面板）也从不传；`sftpWriteFile` 保留 `request.signal`，因为 `sftp_write` 工具确实会把这次调用的中止信号传进来（契约守卫把它登记为「仅内部字段」并写明原因）。
- **目录下载写后复核**：每个文件提交后比对本地大小，短包（服务端中途断流但 rename 已成功）记为失败并删掉半截文件；变大的文件（日志）不误报。
- **契约守卫**：新增 `test/rpc-contract.mjs`，对 66 个 descriptor 逐项检查「有实现、请求/结果键都出现在发布类型里、宿主只读线上字段、facade 只发 schema 字段」，并把 `forceNew` 往返与 `sftpStat` 载荷钉成断言。
- **CHANGELOG 结构复位**：此前 0.5.1 之后的整段历史被重复粘贴在文件开头，丢掉了标题与版本说明；现在恢复单一标题、单一历史与本节。
- **版本**：0.5.3 只在本地改过版本号、从未安装或发布，因此这一轮直接发 0.6.0，把两轮变更一起交付。

## 0.5.3 — 2026-11-28

**高风险边界、生命周期、文档与 CI 的收敛。**

### 边界修复

- **`terminal_send` 不再永久挂起**：前台命令持续输出时（`journalctl -f`、`yes`、高频构建），等待循环在偏移变化时 `continue`，跳过了循环末尾唯一的 deadline 判断，30 秒上限形同虚设。现在每一轮都检查期限，超时返回 `waitReason: "timeout"` 而不是永不返回；`SEND_TIMEOUT_MS` 导出，`SshTerminalSession` 增加仅供测试使用的 `sendTimeoutMs` 注入点。
- **脱敏覆盖 `.env` 与 CLI 密码**：`\b` 在 `_` 与 `P` 之间不是边界，`MYSQL_ROOT_PASSWORD=…`、`DB_PASSWORD=…`、`AWS_SECRET_ACCESS_KEY=…` 原来会原样进入模型上下文。现在按「标识符分段」识别凭据名（`SECRET` / `PASSWORD` / `TOKEN` / `PRIVATE_KEY` / `API_KEY` / `ACCESS_KEY` / `PASSPHRASE` / `CREDENTIALS`），并新增 `sshpass -p` / `--password` 规则。反向约束同样有测试：`getSecret()`、`TOKENIZERS_PARALLELISM`、`PUBLIC_KEY=` 不被误伤。
- **`tunnel_start` 的对外暴露走审批**：它此前是唯一没有审批门的写操作，且 `bind_addr` / `remote_host` 完全由模型控制——一次注入就能把监听暴露到局域网，或让服务器侧回连本机。现在监听地址非回环（或任何远程转发）时，调用会挂起在宿主的审批通道上，批准只对那一次生效；拒绝、取消、超时、无审批通道一律不建立监听。`allowAll`（DSH 完全访问）沿用既有约定不再额外询问，只读模式直接拒绝，面板里自己建的转发不受影响。
- **空 `bind_addr` 不再绕过转发审批**：审批门把空字符串当成「未指定」判为回环，服务层却用 `??` 把 `""` 原样交给 `listen()`——Node 对空地址绑定的是通配地址，于是 `tunnel_start{kind:"dynamic",bind_addr:""}` 能在没有审批的情况下开出一个对全网可达的 SOCKS5 代理（`local`/远程转发同理）。现在审批门与 `tunnelStartLocal`/`tunnelStartDynamic`/`tunnelStartRemote` 共用同一个归一化函数，空值与空白在 `listen()` 之前落到 `127.0.0.1`，并有真实 listener 的回归测试。

### 数据与生命周期修复（审查发现）

- **切换服务器标签不再中断传输**：文件面板此前把任务列表与 `AbortController` 放在组件里，而 `HarborPanel` 用 `key={connectionId}` 重挂载它——切一次服务器标签就中止正在进行的上传，远端只剩半截文件且没有续传路径。传输状态改存 `src/client/file-transfers.js` 的模块级注册表（按连接分桶），只有显式取消会中止；上传槽与同名冲突对话框一并迁移，重挂载后对话框重新出现。附带修掉任务列表 50 条上限的 off-by-one（原本会停在 51 条）。
- **部分保存不再把 `verify` 降级成 `accept-new`**：`profileSaveRequestSchema` 曾给 `hostKeyMode` / `agentForward` 加 `.default()`，`profileSave` 又无条件下写，任何不重复携带这两个字段的调用（脚本、旧面板、直接调 API）都会把钉死的 `verify` 改回 TOFU。请求 schema 改为 optional，服务端省略即保留原值；`resource-backup-store` 的跳板机等价比较同步补上归一化，避免缺字段的旧备份被重复导入。
- **远端文本写入原子化**：`sftpWriteFile` 与编辑器保存原来直接截断目标再写，链路中断或磁盘满就留下半截文件，下一次保存还会因「文件已变」的比对失败而永远存不回去。现在写同目录临时文件再 rename（优先 OpenSSH 的 `posix-rename` 扩展），失败只留临时文件；保留原文件权限位，目标是符号链接时替换解析后的真实路径。
- **SCP 超时改为空闲超时**：`ScpReader` 的定时器原本是总时限且不随数据到达重置，任何超过 30 秒的传输必然失败——而 SCP 正是不支持 SFTP 的服务器唯一的文件通道。现在数据到达与通道 `drain` 都会重置，只有真正静默 30 秒才失败。
- **永久性失败不再无限重连**：`connectClient` 把除主机指纹外的所有失败都折成 `connect-failed`，自愈循环因此对认证被拒、账号锁定这类永久失败也每 30 秒重拨一次，且从不结算等待者——每次落到这条连接上的工具调用都白等 30 秒。现在连接路径带回 `retriable`，永久失败立即停止并唤醒等待者，重试次数另有 8 次上限；`ensureAlive` 对已停止的记录立刻返回 false。
- **握手刚成功就断的传输不再漏看**：丢失处理器原本在 `connectClient` 返回之后才挂上，这中间（含首次主机密钥落盘的那次 await）的 `close`/`error` 无人接收，记录一直是「已连接」，所有通道操作失败且不会触发重连。处理器现在在 `ready` 之后、第一次 await 之前挂上；主机密钥落盘改为尽力而为，写失败不再把一次成功登录变成失败。
- **`ssh_exec` 不再丢掉回收站结果**：结果逐字段重建时漏了 `trashed`，而回收站脚本恒退出 0——「目标不存在」「移动失败」都会对模型显示成 exit 0 且无输出。现在逐项透传，并由 `[trash]` 段渲染。
- **日志清理不再销毁在录会话**：`prune()` / `removeAll()` 基于 `list()`，而后者会合并进行中的条目；删除会 destroy 写流并删文件，之后该会话静默不再记录（`prune` 在每次会话自然退出后都会跑）。两处改为跳过仍在录制的会话。

### 文档、CI 与收敛

- **CI 落地**：新增 `.github/workflows/ci.yml`（Ubuntu + Node 22），每次推送到 `main` 与每个 PR 执行 `npm ci` → `npm run lint` → `npm run i18n:extract` → `npm run build` → `npm test`。INSTALL 里「CI 跑的就是这些」此前没有对应文件，现在有了。
- **文档回到实现**：工具计数（Harbor 22 个 + 表格里另列宿主 6 个终端工具）、「功能开关」两组开关的实际生效方式（工具开关需重启，面板标签立即生效）、流式路由的前置条件（只需宿主 `webServer`，准入由宿主完成）、`release/*.zip` 是完整源码归档而非安装包、静态检查统一写 `npm run lint`、`install:dev` 的实际调用形式、`package-lock` 里落后的 typert peer 下限——全部按代码改。
- **测试脚手架收敛**：`test/review-regressions.mjs` 整体删除——其中与 `terminal-pool` / `terminal-stream` 重复的断言不再保留，`changeDirectory` 与 `cwd-unavailable` 的独有覆盖移到 `test/change-directory.mjs`；两份 sshd 启动代码合并为 `test/support/start-test-sshd.mjs`；四份 `fakeTable` 合并为 `test/support/fake-table.mjs`；`test/helpers/` 并入 `test/support/`；`manifest.mjs` 不再在 `npm test` 里隐式构建（缺 `lib/` 时直接报错，免得审计的是陈旧产物）。
- **导出与死代码**：`schemas.js` 里 30 个只在模块内使用的符号不再 `export`；宿主与客户端各一份的 `execPolicyLabel` 下沉到 `src/shared/`；`service-hub` 中无人读取的 `backendType` 删除；`.editorconfig` 的 `[*.py]` 与 `.gitignore` 里四条陈旧条目移除。
- **旧终端集成删除**：`src/host/shell-integration.js` 与 `test/shell-integration.mjs` 移除；交互式终端现在只通过官方持久终端分组内的 `harbor-ssh` 后端提供，不再维护第二套 shell 集成与对应 RPC。

### 冗余清理

- **文档每件事只有一个家**：安装与开发命令（原来在 README 中英、INSTALL 各一份）收敛到 INSTALL；预览参数与设计约定只在 `ui-guidelines`；DSH 版本与能力要求只在 README「兼容性」；审批期限与权限上限只在 README「安全模型」；状态采样口径只在产品指南。
- **INSTALL 的构建放行键过时**：写的是 `onlyBuiltDependencies`，当前 profile 用 `pnpm-workspace.yaml` 的 `allowBuilds`，照旧说明改等于没改；`clean`、`install:dev` 两个命令此前从未出现在文档里，现已补上（包括 `install:dev` 实际带的 `-w`）。
- **英文 README 补齐**：状态采样需要 POSIX shell + `/proc` 这条兼容性说明之前只写在中文版。
- **批量面板补文档**：产品指南新增「批量」一节——目标由操作者勾选、危险提醒始终出现（批量路径不看策略档位）、结果按目标分节展示。
- **UI 规范与实际例外对齐**：`ui-guidelines` 的「不允许字面量」「样式一律在 `.hb` 内」两条绝对规则，与 `app.css` 里已有注释的迁移桥、两个宿主节点冲突；例外现在写进规则本身。44 个图标名的手抄清单删除，`icons.js` 的键即唯一清单。
- **一份格式化实现**：字节/时间格式化原来三份（文件、日志、状态），同一个大小在不同面板会显示成 `1536.0 MB` 与 `1.5 GB`；统一到 `src/client/format.js`，状态的字节工具改为从那里取。
- **面板 tab 条**：工作台此前在 `kit.jsx` 的 `Tabs` 之外又手写了一份同样的标记；面板改用 `Tabs`，组件不再是只有预览页在用的死代码。
- **服务层重复**：`tunnels.js` 顶部 `import net` 之外另有两处 `await import("node:net")` 遮蔽；`handleTransportLoss` 把 `execPolicyOverrides` 复位了两次；`sftpUploadDir` 对同一根路径连续校验两次。已删除，并补注释说明「预校验 + 写入前复检」两阶段为什么不能合并。
- **终端输出只有一份**：每个 chunk 既要写 journal，又要重建一份 2 MB 的 `session.buffer`（两倍全量拷贝）。无游标的轮询读者改为在 journal 上记住自己的偏移，`session.buffer` 与 `drain()` 删除，网络 CLI 的提示符检测改读 journal 的 `tail()`。
- **不可达的隧道恢复**：`scheduleReconnect` 里遍历的 map 已在 `closeConnectionTunnels` 中被清空，那段「恢复远程转发」永远不会执行（`active` 字段也只写不读）。删掉，并写明隧道不跨重连。
- **形参与导出**：`execOnConnection` 从未读取的 `_retried` 形参删除（调用点同步）；`changeDirectory` 手写的单引号转义改用 `shellQuote`；`isPrefillable` 已无生产调用者，连同其断言删除。
- **typert 声明漂移**：`SshProfileInfo` 缺 `hostKeyMode`/`agentForward`/`credentialId`/`credentialName`/`proxyJump`/`defaultProjectPath`/`loginCommand`，`SshConnectResult` 缺 `legacyFallback`/`bannerRepair`/`warning`。已补齐；`test/typert-sync.mjs` 现在会用 schema 的键集合校验声明，新增字段漏写会直接失败。
- **打包**：tarball 不再发布 `scripts/*.mjs`（没有 `src/` 与 devDependencies，装到 profile 后跑不起来）；`RELEASE_ARCHIVE_ENTRIES` 去掉早已删除的 `assets`、`tools`，条目缺失时改为报错而不是静默跳过；`espree` 补进 devDependencies（`i18n:extract` 直接 import 它）；peerDependencies 下限从 `>=0.1.5-alpha.1` 对齐到实际测试的 `>=0.1.2-rc.1`，package-lock 里落后的 `engines.dsh` 也同步回 `>=0.2.3-alpha.2`。
- **测试**：新增 `test/tunnel-gate.mjs`、`test/file-transfers.mjs`、`test/change-directory.mjs`；扩展 `test/terminal-backend.mjs`、`test/safety.mjs`、`test/typert-sync.mjs`、`test/scp.mjs`、`test/session-log.mjs`、`test/sftp-editor-save.mjs`、`test/credentials.mjs`、`test/reconnect-recovery.mjs`（永久失败、重试上限、握手后立刻断链）与 `test/tunnel-gate.mjs`（空绑定地址的真实 listener）。全部 342 个测试、`npm run lint`、`npm run i18n:extract`、`npm run build` 与 `npm pack` 清单检查通过；同一组四项由 `.github/workflows/ci.yml` 在每次推送与 PR 上执行。

## 0.5.2 — 2026-11-27

**审批有期限，执行策略跟随 DSH 权限模式。**

- **审批不再无限等待**：DSH 的 approval seam 没有 TTL，Harbor 之前只把外层 signal 传进去。现在 `askOperatorApproval` 自己拥有 120 秒期限，并用 `Promise.race` 兜底；超时会中止审批 signal、让 DSH 撤下卡片、返回明确的 timeout deny，且不会记录一次性凭证；晚到的 `allowed-once` 也会被丢弃。覆盖 `ssh_exec`、`terminal_send`、`sftp_delete`。
- **终端拆行不再绕过**：`terminal_send` 之前只检查当前这段 `text`，Agent 可以分两次输入 `r` 和 `m -rf ...` 再回车绕过黑名单。现在 gate 会在会话的输入行镜像上模拟本次发送，按回车提交的完整命令行判定，审批文案也展示完整行；未提交的片段不提前拦截，到真正提交时再检查。
- **跟随 DSH 会话权限**：新增 `src/host/dsh-permission.js`，从 `permissionPresets` / `sandboxPolicy` / `approval` 读取本对话的模式，作为 Harbor 策略的上限：auto 让渡给 Auto review，danger-full-access 默认 allowAll，workspace-write 固定 standard，read-only 直接拒绝；没有权限预设时保持原行为。显式 Harbor 会话切换只能收紧，不能放宽。
- **面板与设置**：策略胶囊显示「（DSH）」与当前模式，菜单禁用超过上限的档位；设置页说明 DSH 模式是上限；完全访问 + `never` 下收紧会提示无法再请求审批。
- **测试**：新增 `test/dsh-permission.mjs`，扩展 `test/ask-gate.mjs` 覆盖 120 秒期限、晚到授权、只读/完全访问、SFTP 删除；`i18n`、`lint`、`build` 通过。

## 0.5.1 — 2026-11-27

**Agent 操作与右侧栏看板对齐：连接、终端与命令不再绕过面板。**

- **根因**：0.5.0 把交互式终端交给官方工具后，只有 `terminal_open` 和 `ssh_connect_profile` 会创建终端 / 写入 `agentRevealId`；`ssh_connect`、`ssh_exec`、SFTP、转发与状态工具都不产生终端或 reveal。面板只把 pane view 里的连接画出来，因此这些操作在侧栏不可见；`ssh_exec` 的镜像又只在“本会话已有终端”时执行，于是命令只回到对话。
- **统一可见性契约**：新增 `HarborService.touchAgentTarget`（绑定会话的 active connection、记录 per-conversation 活动、按会话 mint reveal、按需补开终端）。`ssh_connect` 连接后自动为当前对话开终端并在结果里返回 `terminalOpened` / `terminalSessionId`；`ssh_exec` 先确保终端再执行，命令与输出继续镜像；SFTP、转发与 `ssh_status` 也会揭示目标服务器但不强制开终端。
- **状态语义**：服务器条圆点改为 transport 连通性；新增终端小图标（本对话是否有终端）与 Agent 活动脉冲（`agentActive` / `agentLastActivityAt` / `agentActivityKind`）。连接活着但本对话没有终端时，圆点不再显示成 idle。
- **跨会话 reveal**：全局无 sessionId 的轮询与 `openTab(kind)` 改为 `conversation.session.header.actions` 内的会话级 watcher + `openTabIn(sessionId, kind)`；A 会话的 reveal 不再弹到 B 会话，切换回 A 时仍会重新检查。公告去重改为按会话，watcher 卸载时重置。
- **测试**：新增 `test/agent-visibility.mjs`（connect/exec/sftp/status 的可见性与终端补开）、`test/connection-status.mjs`（三个状态维度独立）；更新 `pane-selection` 的会话归属断言与 `sidebar-integration` 的结构契约。全部 326 个测试通过。

## 0.5.0 — 2026-11-24

**交互式终端改用 DSH 官方持久终端工具，插件名统一为 Harbor。**

- **复用官方终端**：新增 `lib/terminal-backend.js`，向 `ctx.terminals` 注册 `harbor-ssh` 后端。Agent 现在用官方 `terminal_open` / `terminal_send` / `terminal_read` / `terminal_signal` / `terminal_close` / `terminal_list` 操作 SSH 终端；Harbor 只负责 SSH 机制（连接、PTY、就绪判定、行分页、信号、清理）。
- **组合层**：官方终端插件把 `terminals` 隔离在 `optional-persistent-terminals` 组里，同级插件看不到该服务。`cordis.patch.yml` 用 loader 的「按 group id 插入」把后端子行放进该组；该组不存在时只跳过这一行，Harbor 其余功能照常。
- **删除重复工具（27 → 22）**：移除 `ssh_read`、`ssh_write`、`ssh_terminal_sessions`、`ssh_terminal_context`、`ssh_shell_integration`。保留官方无对应的 `ssh_exec`、连接生命周期、SFTP、转发、批量、日志与状态工具。
- **安全门保留并扩展**：`terminal_send` 若目标是 Harbor 的 SSH 会话，仍先经过服务器执行策略与操作者审批，危险命令不会因为换用官方工具而绕过。
- **接管语义**：你在面板里第一次敲键后该终端归你，Agent 的 `terminal_send` / `terminal_signal` 会被拒绝、只能 `terminal_read`；之后的 `terminal_open` 会另开一条 shell，不会抢回你正在用的那条。Agent 自己 `terminal_close` 时才关闭远端 shell。
- **命名统一**：插件列表、侧栏标签、设置页、会话头提示与文档一律使用英文名 **Harbor**，不再使用「远程运维」「远程主机」等独立中文名；`engines.dsh` 提升到 `>=0.2.3-alpha.2`。
- **测试**：新增 `test/terminal-backend.mjs`（spawn、行分页、send 等待原因、接管、关闭、信号）；移除已无宿主面的 `ssh-write` 与 `manual-terminal-context` 测试。

## 0.4.3 — 2026-11-23

**状态页的每核柱条不再画到 CPU 卡片外面。**

- **根因**：每核一根柱子，样式里写死 `gap: 3px` 与 `min-width: 2px`。128 核的主机光间隙就要 127 × 3 ≈ 381px，再加每根柱子 2px 的下限，这一行的最小宽度约 637px，而侧栏里 CPU 卡片的可用宽度只有 324px 左右——flex 把这一行卡在最小内容宽度上，柱条（连同卡片的 `scrollWidth`）就一路画到右边框之外。4 / 16 核的主机看不出问题，只有在核数多的机器上才暴露。
- **修复**：`.hb-cores` 的间隙改为 `min(3px, calc(33% / var(--hb-core-count, 8)))`——仍以 3px 为上限，但随核数收缩，最多只占一行的三分之一；`.hb-core` 的 `min-width` 从 2px 改为 0，柱子可以继续变窄。核数由 `CoreBars` 通过内联变量 `--hb-core-count` 传进样式表。4 / 16 核的排布与修改前逐像素一致。
- **回归测试**：`test/monitor-pane.mjs` 新增「每核柱条留在卡片内」一节，钉住间隙的上限与收缩、柱子不再有像素下限，以及核数确实传到了样式表。另在 280–520px 宽度、1–256 核下逐元素扫描确认没有任何元素越出卡片，状态页也不再出现横向滚动。

## 0.4.2 — 2026-11-23

**插件热更新之后再连接，不再报 “Client is not a constructor”。**

- **根因**：ssh2 是 CommonJS 包，宿主入口在模块加载时用 `import ssh2 from "ssh2"` 一次性取出 `Client`。DSH 的插件热更新会驱逐插件模块再重新导入（0.4.1 里“热更新只替换了宿主类、没重新导入 typert.js”说的就是这套机制），而 ssh2 作为依赖留在 `require` 缓存里跨过这次替换。重新加载时如果读到的 ssh2 导出还没写完（缺少 `Client` 的半成品），这个一次性绑定就永久是 `undefined`，之后每次建连都在 `newClient()` 抛 `TypeError: Client is not a constructor`——面板和 `ssh_*` 工具一起失效，只有重启 DSH 才能恢复。
- **修复**：新增 `src/host/ssh2-client.js`；`newClient()` 改为**每次建连时**用 `createRequire(import.meta.url)("ssh2")` 读取 `Client`。`require` 返回的永远是加载完成的 `module.exports`，上一次拿到半成品也会在下一次自愈；同时兼容 `{ Client }` 与 `{ default: { Client } }` 两种导出形状。
- **报错**：ssh2 真的缺失或没有 `Client` 时，给出 `harbor: the installed ssh2 package carries no Client constructor; reinstall dsh-harbor …`，不再让 V8 的笼统 TypeError 冒充连接错误。
- **回归测试**：新增 `test/ssh2-interop.mjs`：普通 CJS 导出、interop 命名空间、半成品导出“下一次自愈”、缺包文案，以及用子进程复刻现场那条 `Client is not a constructor` 并证明新路径可用；`test/reconnect-recovery.mjs` 的互操作断言改为“建连时才解析”。
- **升级提示**：已经加载进 DSH 进程的旧代码不会自己变化；更新插件后若仍看到旧报错，请重启 DSH。

## 0.4.1 — 2026-11-23

**在线编辑不再在远端留备份；插件热更新后状态页不再 404。**

- **文件编辑**：保存仍然先读远端、比对编辑器打开时的内容，再读一次确认检查期间没有被改；不再生成 `.dsh-backup-*` 备份文件，也移除了「恢复上一个版本 / 恢复备份」入口、对应文案与 RPC 结果里的 `backup` 字段。一次在线编辑不会在远端目录里多出文件。
- **状态监测 404（根因）**：DSH 的 typert loader 按包名缓存宿主清单；插件热更新只替换了宿主类，没有重新导入 `typert.js`。浏览器端新的 `systemStats` 在旧清单里不存在，`POST /api/harbor/systemStats` 于是返回 404——这不是 Tailscale 或 SSH 网络的问题。现在给 `systemStats` 补上 Typert 的 source-mode `Remote` 标记，Gateway 在严格清单缺失时通过源码回退仍能声明并分发该方法；全新启动继续使用严格清单，校验不受影响。
- **状态页呈现**：客户端识别 404 / 未挂载这类「宿主端没有这个接口」的错误，明确提示重启 DSH 后重试，并把轮询降到 30 秒一次；同时加单飞锁，慢链路下不会每 2 秒叠一个请求。
- **采样健壮性**：采样超时改为从 `monitorProbeTimeoutMs` 读取（默认仍 4 秒）；探测期间 SSH 客户端被重连替换时，立即返回可重试的连接错误，而不是进入 2/4/8/30 秒失败退避。
- **回归测试**：`sftp-editor-save` / `local-sshd-sftp` / `sftp-files-ui` 断言不产生备份；`monitor-service` 断言 source-mode 标记与重连语义；`monitor-pane` 断言 404 识别与慢退避；README、产品指南同步。

## 0.4.0 — 2026-11-23

**Remote Machine 与状态监测。** 右侧栏那页从「远程终端」改名为「远程主机 / Remote Machine」——它早就不只是终端（文件、转发、日志、快捷命令都在里面）。同时新增只读的「状态」标签与 \`ssh_status\` 工具，把「这台机器现在怎么样」从「让模型随手拼一条 top/df」变成一条固定口径的采样。

- **改名**：侧栏标签、引导项、会话头按钮 tooltip 与设置页小节统一为「远程主机」；tab kind / id / settings section id 不变，已有侧栏布局与导航不受影响。
- **状态标签**：CPU（总量 / 负载 / 每核）、GPU（NVIDIA）、内存与 swap、磁盘用量与读写、网络吞吐、进程 Top，外加本连接的服务器、地址、采样耗时。默认 2 秒采样，可切 2 / 5 / 10 秒或暂停；切走标签、收起侧栏、窗口隐藏即停表。
- **采样通道**（新模块 \`src/host/monitor/\`、\`src/host/service/monitor.js\`；新面板 \`src/client/features/monitor/\`）：只读 RPC \`systemStats\` 与只读工具 \`ssh_status\` 共用一套归一化数据；\`#df\` / \`#diskstats\` / \`#meta\` 走 10 秒 / 5 分钟慢节拍并跨拍携带；单飞、1 秒去重、2/4/8/30 秒失败退避。
- **只读、不越权**：探测脚本是代码常量，浏览器只能传 connectionId；不写远端文件、不需要 sudo、不进终端回显、不触发 AI 执行策略（理由写在 \`src/host/service/monitor.js\` 顶部）。
- **如实降级**：非 Linux 远端、无 exec 通道的网络设备、sshd \`MaxSessions\` 用满、busybox \`ps\` 无 \`pcpu\`、首拍间隔未完成，都有对应文案，绝不用 0 冒充读数；失败后退避并在面板上写明下次重试。
- **设置**：功能开关新增「状态」标签与「系统状态工具」两行（默认开启，工具开关需重启 DSH）。
- **界面**：trend line（带淡填充）与每核柱条、\`ProgressBar\` 新增 warn/err 色调；六个标签在窄栏先压缩内边距、再退化为图标；浅色与深色均已核对。
- **回归测试**：新增 \`test/monitor-parse.mjs\`（脚本不变量 / 各种 \`/proc\` 方言 / 速率与回退）、\`test/monitor-service.mjs\`（节拍、缓存、单飞、退避、降级、工具文案）、\`test/monitor-pane.mjs\`（可见才轮询、四态、token-only 样式、格式化）；README / INSTALL / 产品指南与截图同步。

## 0.3.0 — 2026-11-22

**终端与会话绑定。** 在此之前，「一条 SSH 连接 = 一个终端」是全局共享的：两个对话在同一台服务器上并行工作时，面板都显示同一个终端，Agent 的 `ssh_write` 会广播进两边的终端，`ssh_read` 读到的是别人的屏幕，`ssh_exec` 的回显也出现在别人的窗口里；两条对话还会争夺同一个「当前连接」。0.3.0 把归属修正为「每个对话在每台服务器上各有一个终端」。

- **归属模型**（新模块 `src/host/terminal-owner.js`）：每个 PTY 记录所属对话；子 Agent 默认归根对话（`terminalScope: "conversation"`），被委派的 Agent 仍在你眼前的终端里工作。索引缺失的记录按会话自身归属派生，不会被误判成「没有终端」。
- **面板**：服务器条的圆点与「Agent」徽标只报告**本对话**；面板只渲染本对话的终端，空态会说明「这台服务器上还有 N 个终端正被其他会话使用」。领取队列按对话投递、30 秒过期，避免把标签塞进别的对话或事后劫持。
- **Agent 工具**：`ssh_exec`/`ssh_read`/`ssh_write`/`ssh_disconnect` 按调用方对话解析目标连接；读取游标、exec 回显、网络 CLI 串行锁、`ssh_terminal_context` 的默认目标都收到本对话。`ssh_read` 在没有本对话终端时如实返回 `hasSession: false`，不再回落到别人的 shell。
- **exec 的 cwd 继承在多终端下重新精确**：新增 `src/host/terminal-census.js`，终端打开后在后台 census 本 transport 上的交互 shell，记住本 PTY 的 tty；`buildCwdAwareCommand` 支持按 tty 精确定位。此前一条连接上只要有两个 shell，`ssh_exec` 就退化为登录目录。
- **执行策略按对话**：操作者放宽的档位不再外溢到同一服务器上的其他对话；`execPolicyGet/Set` 接受 `sessionId`。
- **生命周期**：对话结束（`session/disposed`）时关闭它名下的终端；断链/断开仍整体回收。每连接终端数上限 8，超出时错误文案直接点名 sshd `MaxSessions`。
- **迁移**：升级后旧面板/设置页打开的是「匿名终端」，第一个认领它的对话收养它（一次性、不可再被夺走），人机共用的旧习惯因此继续成立；刷新页面后即享有完整隔离。
- **契约**：`list`/`openSession`/`selectConnection`/`connect`/`profileConnect`/`execPolicy*`/`listTerminalContexts` 全部接受可选的 `sessionId`；`list` 新增 `terminals[]`（含 `ownerSessionId` 与 `mine`）。新字段全部可选，旧调用方保持可用。
- **回归测试**：新增 `test/terminal-owner.mjs`、`test/terminal-census.mjs`、`test/per-session-terminals.mjs`、`test/session-terminals.mjs`；并更新 `active-connection`、`ssh-write`、`agent-connect`、`exec-policy`、`network-cli`、`pane-selection`、`manual-terminal-context`、`exec-cwd`/`exec-cwd-rules`、`shell-integration` 等受影响的断言。

## 0.2.2 — 2026-11-21

- **超长会话日志的预览区可以滚动**：预览区取的是面板剩下的高度，却没有把自己变成滚动容器，正文从底部边框溢出后被外壳裁掉，「继续加载」页脚还压在文字上；超过一屏的记录后半段完全看不到。现在预览区内部滚动，长记录可以上下翻阅，页脚也不再被遮挡。按内容高度收缩的搜索命中条（`max-height: 140px`）同样改为内部滚动。
- **切换记录回到第一行**：打开另一条日志时阅读区滚回顶部，不再沿用上一条的滚动位置；「继续加载」追加内容时保持当前位置。
- **回归测试**：新增 `test/logs-scroll.mjs`，钉住预览区与命中条的滚动约定，以及切换记录时的复位。

## 0.2.1 — 2026-11-20

修复私钥导入链路上的两个问题：

- **无扩展名私钥文件可选**：服务器、共享凭据与临时连接三处的私钥选择框不再按 `.pem` / `.key` 等后缀过滤，系统生成的 `1` 这类无扩展名私钥文件可以直接选中；文件大小与内容校验保持不变。
- **OpenSSH 配置导入自动带上私钥**：读取 `~/.ssh/config` 时会解析每个主机的 `IdentityFile`（支持 `~`、`%d`、`%h`、`%n`、`%r`、`%u`、`%p`、`%%` 等 token 和相对路径；多个身份文件按 OpenSSH 顺序取第一个可用项），导入服务器时把私钥写入该资源对应的本机凭据槽。预览会标注「自动导入私钥 / 需填口令 / 无法导入」，加密私钥导入后只需补填口令；私钥内容不经过浏览器，也不会出现在预览返回值里。
- **回归测试**：新增 `test/private-key-import.mjs`，覆盖无扩展名、相对路径与 token 展开、多身份文件、加密私钥、公钥误选、导入后凭据写入与私钥不泄漏等场景。

## 0.2.0 — 2026-11-20

在 0.1.0 的基础上收敛到 SSH 运维：移除数据库控制台，界面与实现对齐 DSH 原生。

- **移除数据库功能**：数据库面板、7 种驱动、数据库 Agent 工具（`db_*`）、数据库资源与凭据域、相关 RPC 契约、样式、文案、测试与第三方驱动依赖全部删除；插件只保留 SSH、SFTP、端口转发、快捷命令、会话日志与资源策略。
- **更轻的安装**：运行期依赖只剩 `ssh2`；`zod` 打进 `lib/`，不再进入安装闭包，宿主包也不再内联数据库驱动。
- **安全策略**：命令行里的破坏性 SQL（`DROP`、`TRUNCATE` 等）仍按「删除数据库数据或对象」拦截，`mysql -e` 之类的绕过同样命中规则。
- **文案清理**：删除约 290 条不再使用的翻译；数据库相关的导航、设置开关、备份说明与引导文案同步更新。
- **主题与配色**：离线预览按选择器保留浅色 / 深色两套色板，浅色主题也能拿到语义别名（`--dsw-alias-*`）；新增 `npm run theme:snapshot` 与 `test/theme-snapshot.mjs` 防回归（含引用不存在的宿主 token）。菜单表面改用真实存在的 `--dsw-menu-surface-fill`；深色下的错误提示与「失败」徽标改用随主题混合的 `--hb-err-soft`，不再是一块亮粉色。
- **统一的确认对话框**：删除、放宽策略、覆盖配色等决定改由同一个主题化 Dialog 处理——取消获得焦点，危险操作用实心红——不再调用浏览器原生 `confirm`；新增 `test/confirmations.mjs` 防回归。
- **布局与密度**：快捷命令与端口转发改用共享行组件与细分隔线，去掉逐行边框；转发地址不再被连接数徽标挤掉，停止按钮回归次要样式。窄侧栏下服务器条横向滚动时连接按钮不再被标签挤出视野，关闭标签改为真正的按钮，支持 Enter / Space。
- **交互修复**：弹窗不再被后台轮询抢占输入焦点；字段标签与输入框正确关联；菜单支持方向键 / Home / End / Esc 与焦点回归；行内操作按钮不再误触整行；窄侧栏下图标签自动收起、文件操作栏换行；关闭最后一台服务器时回到终端空态。
- **稳定性修复**：取消连接的回执符合统一响应包；自然退出的终端不再长期占用会话上限；远程转发的监听端口与实际分配端口一致，停止带活动连接的隧道不再挂起；批量任务不再抢占当前连接；会话日志按预算清理并在卸载时关闭；SFTP 读取达到上限即停止传输；上传目录会创建空目录并如实报告跳过的符号链接。
- **后台开销**：页面不可见时暂停连接、批量任务与 Agent 连接轮询。
- **工程卫生**：`eslint` 忽略生成的 `preview/out`；文档截图按真实侧栏宽度重拍，并新增 `?bare` 预览模式。

## 0.1.0

内部基线：以全新的项目身份、结构与时序重建，功能覆盖：

- **工作台外壳**：服务器条 + 视图切换（终端 / 文件 / 转发 / 快捷命令 / 日志）；面板常驻不卸载，切换视图不丢失终端回看与滚动位置。
- **设计系统**：`src/client/ui` 提供控件、图标与样式表；颜色、圆角、字号全部来自宿主语义 token，深色 / 浅色随 DSH 设置切换；图标几何取自宿主图标集，自带图标与宿主间距一致。
- **终端**：流式推送优先、长轮询兜底；查找、选中即复制、缩放、滚到底部；会话与视图解耦。
- **文件**：SFTP 浏览、上传 / 下载（含目录与冲突处理）、编辑保存备份、远程搜索、收藏、传输任务。
- **转发**：本地 / 远程 / 动态 SOCKS5。
- **会话日志**：按块读取、搜索、下载、按条删除。
- **资源与策略**：分组、共享凭据、跳板链、OpenSSH 导入、加密备份、三档执行策略、远程工作区绑定。
- **Agent 工具**：26 个，默认只作用于当前连接；多机执行必须由操作者勾选目标。
