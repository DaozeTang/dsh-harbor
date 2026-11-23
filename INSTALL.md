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

`npm install` 会生成入口产物 `lib/`：`index.js`（宿主半）、`client.js`（浏览器半）、`typert.js` 与 `remote.js`（RPC 契约）。以链接方式安装时，改完代码 `npm run build` 后刷新页面即可；宿主半的改动需重启 profile。

## 从压缩包安装

发布页的 `.tgz` 直接安装；也可以在源码目录用 `npm run pack:release` 自行打包，产物为 `release/dsh-harbor-<version>.tgz`（同时生成同名 `.zip`）：

```bash
dsh plugin --profile web add ./dsh-harbor-<version>.tgz
dsh web
```

## 验证

1. 重启后打开任意会话，右上角出现终端图标；点击打开「远程主机」标签（默认落在终端，切到「状态」可看实时读数）。
2. **设置 → 远程主机**出现对应分区。
3. 在对话里问「列一下当前连接」，模型应能调用 `ssh_list`。

标签没有出现时，按顺序检查：

- `node_modules/dsh-harbor/lib/client.js` 是否存在。缺失说明构建被包管理器拦下：pnpm ≥ 10 默认阻止依赖包的构建脚本，需在该 profile 的 `onlyBuiltDependencies` 中放行 `dsh-harbor`，或进入包目录手动 `npm install && npm run build`。
- profile 的 `package.json` 是否在 `dsh.profile.bundles` 中列出 `dsh-harbor`，以及 `cordis.patch.yml` 是否插入了 `harbor` 条目。
- 宿主是否提供右侧边栏服务（`sidebarRightTabs` + `sidebarRight`）——这是界面出现的前提。

## 卸载

```bash
dsh plugin --profile web remove dsh-harbor
```

服务器资源、已知主机指纹与凭据保存在 DSH 本地存储中，卸载插件不会删除；需要彻底清理时，手动删除对应存储与 `~/.dsh/.credentials.yaml` 中的相关条目。
