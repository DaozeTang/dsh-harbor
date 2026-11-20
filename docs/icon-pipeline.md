# 图标来源

Harbor 不引入通用图标包：它的字形与 DeepSeek Harness 自带的图标同网格、同笔宽，因此侧栏、按钮和空状态里的图标能与宿主界面并排而不打架。

## 取用

1. 从宿主安装包里取出图标精灵表（`ICON_SYMBOLS` 的源对象，形如 `{"search-outline": {size: 16, svg: (w) => "<svg …/>"}}`）。
2. 展开成 `名称 → { size, viewBox, body }`，写进 `src/client/ui/icons.js`。
3. 只保留实际用到的图标；新增图标时同步更新 `docs/ui-guidelines.md` 里的清单。

生成脚本是一次性工具，不随包发布——产物是纯数据，运行时对宿主内部模块没有任何依赖。

## 五个自绘字形

宿主精灵表里没有 `terminal`、`server`、`key`、`tunnel`、`file`，这五个按同样的规则手绘：16×16 网格、1px 描边、圆头圆角、`currentColor`，视觉上与宿主图标没有差别。改这五个字形时，先在同一网格上画出与相邻图标一致的重量，再调路径。
