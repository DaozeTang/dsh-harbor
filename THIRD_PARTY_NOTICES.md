# 第三方组件

Harbor 以 MIT 许可发布。运行期依赖与随包分发的组件如下，均保留原始许可：

| 组件 | 用途 | 许可 |
| --- | --- | --- |
| [ssh2](https://github.com/mscdex/ssh2) | SSH 传输、SFTP | MIT |
| [xterm.js](https://github.com/xtermjs/xterm.js)（含 fit / search addon） | 浏览器终端 | MIT |
| [zod](https://github.com/colinhacks/zod) | RPC 请求 / 响应校验 | MIT |
| [@noble/hashes](https://github.com/paulmillr/noble-hashes) | 资源备份加密（scrypt / HMAC） | MIT |

`ssh2` 在运行时由 profile 的 `node_modules` 提供；`zod` 与 `@noble/hashes` 打进宿主产物，因此随包分发。

xterm.js 的样式表由 `scripts/gen-xterm-css.mjs` 从依赖包中提取，其版权声明保留在生成文件中。
