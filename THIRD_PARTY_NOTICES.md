# 第三方组件

Harbor 以 MIT 许可发布。运行期依赖与随包分发的组件如下，均保留原始许可：

| 组件 | 用途 | 许可 |
| --- | --- | --- |
| [ssh2](https://github.com/mscdex/ssh2) | SSH 传输、SFTP | MIT |
| [xterm.js](https://github.com/xtermjs/xterm.js)（含 fit / search addon） | 浏览器终端 | MIT |
| [zod](https://github.com/colinhacks/zod) | RPC 请求 / 响应校验 | MIT |
| [@noble/hashes](https://github.com/paulmillr/noble-hashes) | 浏览器端下载完整性校验（SHA-256） | MIT |

`ssh2` 在运行时由 profile 的 `node_modules` 提供；`zod` 打进宿主产物与客户端包，`@noble/hashes` 只打进客户端包，二者随包分发。资源备份加密使用 Node 内置的 `node:crypto`，不属于第三方组件。

xterm.js 的样式表由客户端构建直接从依赖包内联进 bundle，其版权声明保留在样式中。
