# 安装

Harbor 是 DSH 插件包（`dsh-harbor`）。装进某个 profile 后，重启该 profile 即可生效。

## 从源码安装（本地开发）

```bash
git clone https://github.com/DaozeTang/dsh-harbor.git
cd dsh-harbor
npm install          # 安装依赖并执行 npm run build（prepare 钩子）
dsh plugin --profile web add "$PWD"
dsh web              # 或重启 DSH.app
```

`npm install` 会生成入口产物 `lib/`：`index.js`（宿主半）、`client.js`（浏览器半）、`typert.js` 与 `remote.js`（RPC 契约）、`terminal-backend.js`（官方持久终端分组内的 SSH 后端）。以链接方式安装时，改完代码 `npm run build` 后刷新页面即可；宿主半的改动需重启 profile。

## 从压缩包安装

发布页的 `.tgz` 直接安装；也可以在源码目录用 `npm run pack:release` 自行打包，产物是 `release/` 下的两个文件，用途不同：

- `dsh-harbor-<version>.tgz` 是可安装的运行时包，内容由 `package.json` 的 `files` 决定。
- `dsh-harbor-<version>.zip` 是完整源码归档（`src`、`scripts`、`test`、`docs`、`preview`、ESLint/EditorConfig 与构建产物），供离线阅读或自行构建，**不通过** `dsh plugin add` 安装。

安装用 `.tgz`：

```bash
dsh plugin --profile web add ./dsh-harbor-<version>.tgz
dsh web
```

## 升级

三种安装方式都用同一条 `dsh plugin --profile <profile> add <spec>` 覆盖安装，然后完整重启该 profile（不是只刷新页面）：

- **本地源码 / 链接安装**：先 `npm install`（依赖或构建脚本有变化时）并 `npm run build`，再重启；`npm run install:dev` 会重新注册当前目录。
- **`.tgz`**：下载新版本的包，用 `add` 指向新的 `.tgz`。
- **registry**：`dsh plugin --profile web add dsh-harbor@<version>`。

升级前建议在「设置 → Harbor」导出一次加密备份。服务器资源、已知主机指纹与凭据存放在 DSH 本地存储中，不在插件包里，普通升级不会删除；宿主版本要求见 `package.json` 的 `engines.dsh`。

## 验证

1. 重启后打开任意会话，右上角出现终端图标；点击打开「Harbor」标签（默认落在终端，切到「状态」可看实时读数）。
2. **设置 → Harbor**出现对应分区。
3. 在对话里问「列一下当前连接」，模型应能调用 `ssh_list`。

标签没有出现时，按顺序检查：

- `node_modules/dsh-harbor/lib/client.js` 是否存在。缺失说明构建被包管理器拦下：pnpm ≥ 10 默认阻止依赖包的构建脚本，需在该 profile 的 `pnpm-workspace.yaml` → `allowBuilds`（旧版 pnpm 写作 `package.json` 的 `pnpm.onlyBuiltDependencies`）中放行 `dsh-harbor`，或进入包目录手动 `npm install && npm run build`。
- profile 的 `package.json` 是否在 `dsh.profile.bundles` 中列出 `dsh-harbor`，以及 `cordis.patch.yml` 是否插入了 `harbor` 条目。
- 宿主是否提供右侧边栏服务（`sidebarRightTabs` + `sidebarRight`）——这是界面出现的前提。

## 开发命令

源码目录里的完整命令表（CI 只跑其中的构建、测试、lint 与 i18n 四项）：

```bash
npm install          # 安装依赖并构建（prepare 钩子会跑 build）
npm run build:host   # 只构建宿主侧（scripts/build-host.mjs）
npm run build:client # 只构建浏览器侧（xterm 样式随客户端包内联）
npm run build        # 两半都构建（= build:host && build:client）
npm test             # 单元 / 集成测试（scripts/run-tests.mjs 列出用例并调用 node --test，跨平台）
npm run lint         # 静态检查（eslint）
npm run i18n:extract # 中英文字典与 t() 调用点的一致性检查
npm run clean        # 删除 lib/、preview/out/、release/
npm run preview:ui   # 生成离线预览页到 preview/out
npm run theme:snapshot -- <dsh-ui-theme>/src/styles   # 从宿主主题重生成离线 token 快照
npm run pack:release # 构建并打包 release/dsh-harbor-<version>.tgz 与 .zip
```

CI 在 Ubuntu + Node 22 上执行 `npm ci` → `npm run lint` → `npm run i18n:extract` → `npm run build` → `npm test`，与上面的本地命令一致；工作流文件是仓库里的 `.github/workflows/ci.yml`，发布包里不含它。

构建产物只出现在三个目录，都不进版本库：`lib/`（宿主与浏览器各一个 bundle）、`preview/out/`（离线预览页）、`release/`（打包结果）。源码入口是 `src/index.js` 与 `src/client/index.jsx`，`package.json` 的 `exports` 指向 `lib/`。

预览页的参数（`?capture`、`?bare`）与设计约定见 [docs/ui-guidelines.md](./docs/ui-guidelines.md)。

`npm run install:dev` 是维护者用的本机安装快捷方式：它自己找 `dsh` 可执行文件，再调用 `dsh plugin --profile web add <本目录> -w`（比上面的手动命令多一个 `-w`），不重新构建产物。

## 卸载

```bash
dsh plugin --profile web remove dsh-harbor
```

服务器资源、已知主机指纹与凭据保存在 DSH 本地存储中，卸载插件不会删除；需要彻底清理时，手动删除对应存储与 `~/.dsh/.credentials.yaml` 中的相关条目。
