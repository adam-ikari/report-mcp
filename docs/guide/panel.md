# 面板与 Demo

面板是单文件 `public/index.html`：无构建、无 CDN、无外部字体，打开即用。

::: tip 在线 Demo
<https://adam-ikari.github.io/report-mcp/panel/>

**注意那是示例数据**——真正的实时面板跑在你本机，见[安装与接入](./install.md)。左上角有紫色 `DEMO` 角标就说明当前是静态演示。
:::

## 布局

| 区域 | 内容 |
|---|---|
| 左栏 | run 列表，按**最后活动时间**排序（不是文件 mtime），带状态 chip、相对时间、进度条、错误角标；静态模式下还有「我的面板」（见下文） |
| 右栏头部 | 标题、状态 chip、agent / 开始时间 / 耗时 / 记录数 / warn-error 数 / 结果数 / tags / 最后错误 / 失败原因，加一条进度条（不确定态用滑动动画） |
| 时间线 | 按 kind 着色；`result` 渲染成果卡片（可内联图片 / Markdown / sandbox HTML）；`detail` / `data` 进 `<details>` 折叠 |
| 筛选 | 全部 / 进度 / 日志 / 结果 / 状态 |

所有 agent 提交的文本都经过 HTML 转义后再插入 DOM。

## 富内容成果卡

`report_result` 的产出不再只有文字。面板按内容的**来源**选择渲染方式：

| 来源 | 渲染 |
|---|---|
| `markdown` 字段 | 零依赖排版器：标题、列表、引用、代码块、粗斜体、链接。先整体 HTML 转义再做块级/行内变换，agent 写的原始 HTML（包括 `<script>`）只会作为纯文本出现。链接只放行 `http(s):` / `mailto:` |
| `html` 字段 | 注入 CSP 后写入 `<iframe sandbox="allow-scripts" srcdoc>`：脚本能跑（图表库、交互都可以），但 iframe 是 opaque origin，读不到父页面，也 fetch 不动面板 API |
| `artifacts[]` 里 `type` 为 `image` / `markdown` / `html` 的文件 | live 模式经 `GET /api/file` 取回后按上表同样处理：图片直接 `<img>`，md 排版，html 进 sandbox iframe |
| 其余 artifact / 带 `url` 的 artifact | 维持原样：名称 + 路径或外链 |

::: details `/api/file` 为什么算安全
- 路径**从不来自 query**：只接受 `(run, seq, i)` 三元组，去**存储的 result 记录**里取 `artifacts[i].path`。能问出来的文件，都是 agent 已经主动写进记录的文件。
- run id 过字符集校验，`seq`/`i` 必须是整数（400）；记录必须存在且是 result 且索引存在（404）。
- 扩展名白名单（403 拒绝其余）；`realpath` + `isFile()` 挡软链和设备文件；默认 20 MiB 大小上限（413）。
- 图片之外的所有类型（**包括 html**）一律 `text/plain` + `nosniff` 响应，`Cache-Control: no-store`；文件响应不带 CORS 头，sandbox iframe 内的脚本跨源读不到任何 `/api` 数据。
- svg 不在白名单——它是同源脚本载体。
- 已知取舍：面板默认只绑 `127.0.0.1`，暴露面是「agent 已声明的白名单类型文件、只读」。要更紧可以设 `REPORT_MCP_FILE_ROOTS`。
:::

## 「我的面板」：静态站兼任本地面板的入口簿

GitHub Pages 上的面板没有后端，但你的每个 agent 会话都在本机跑着自己的 live 面板。静态模式会在左栏显示「我的面板」：把 live 地址（如 `http://127.0.0.1:7788`）存进浏览器 localStorage，之后从 Pages 一键新窗口打开。Pages 只做入口簿——真实数据始终只在你本机，静态站演示数据里的富内容（图片 / markdown / sandbox HTML）与资产文件（`panel/assets/`）随站点一并部署。

## 三种使用方式

1. **人类（web）**：agent 报出 `viewUrl`（每个 tool 的返回里都有），点开即是那个 run 的实时视图；根地址看全部 run。
2. **人类（CLI）**：`report_panel` 的返回里有 `storage` 路径，`tail -f ~/.report-mcp/runs/*.jsonl` 直接在终端看同一份数据。
3. **agent → agent → 人类**：子 agent 把 `viewUrl` 原样转交给主 agent / 人类；多个进程设同一个 `REPORT_MCP_RUN_ID` 就汇入同一个 run，面板无需任何配置就能看到（见[架构](../reference/architecture.md)）。

## 实时是怎么做到的

- **SSE** 推增量记录，客户端本地重算 summary，所以头部立即更新
- 另有 **15s 全量兜底**轮询
- SSE 断线时 `EventSource` **自动重连**
- `fs.watch` 不可靠的文件系统靠 **5s sweep** 兜底

::: details 侧栏比头部晚 600ms 是正常的
SSE 的 `runs` 事件同时触发 `loadRun()`（详情，立刻读）和 `reloadRuns()`（侧栏，`setTimeout` 600ms 防抖）。防抖是必要的：agent 连报五条进度就会打五次 `/api/runs` 全量重读。

代价是**两栏在时间上不同步**——头部已经 `blocked`、侧栏还显示 `running` 是正常现象，不是 bug。
:::

## 双模式：同一个文件既能连后端，也能当静态站

启动时先探 `/api/runs`（要求 200 + `application/json`）：

| 探测结果 | 模式 | 行为 |
|---|---|---|
| 有后端 | **live** | 走 REST + SSE，实时，`homePath` 显示存储路径 |
| 没后端 | **static** | 加载同目录 `demo-data.js`，纯内存渲染；挂 `DEMO` 角标 |

static 模式**不发任何 `/api` 请求、不开 EventSource、不跑轮询**——三者都有测试断言盯着。

demo bundle 只带原始 `records`，`RunSummary` 依然由页面里同一个 `derive()` 算，所以 live 和 static 不可能算出两套状态。`demo-data.js` 由 `scripts/build-demo.mjs` 生成（零依赖），生成物不入库，部署前现做一份，顺带保证里面的相对时间永远新鲜。

`loadDemo()` 带 2s 超时兜底：脚本标签卡住不会把整个面板吊死在启动阶段。

## HTTP API

只读。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/` | 面板 HTML |
| `GET` | `/api/health` | `{ok, runId, home}` |
| `GET` | `/api/runs?limit=100` | `RunSummary[]`，按最后活动倒序 |
| `GET` | `/api/runs/:id` | `{summary, records[]}` 全量 |
| `GET` | `/api/file?run=:id&seq=:n&i=:k` | 内联渲染用：按 (run, seq, i) 从**存储的 result 记录**解析文件路径，白名单类型 + 大小上限 |
| `GET` | `/api/stream?run=:id` | SSE：`record`（全量预载 + 增量）、`runs`（列表变更） |

绑定 `127.0.0.1`，默认端口 `0`（自动分配空闲端口；配置的端口被占则自动降级到随机端口）。

::: warning 没有鉴权
面板无鉴权、无 TLS，绑定 `127.0.0.1` 意味着只服务本机。`detail` / `data` 会原样展示 agent 提交的任意负载——**不要把它通过公网隧道暴露出去**。目前唯一的公网形态是上面那个静态 demo，它不含任何真实数据。

`/api/file` 同理：它能把 agent 报告过的本地文件送到浏览器。若确需 `REPORT_MCP_HOST=0.0.0.0`，请同时设置 `REPORT_MCP_FILE_ROOTS` 把可读范围圈进目录白名单。
:::

## 自己看数据

```bash
tail -f ~/.report-mcp/runs/*.jsonl
```

append-only，每行一条记录，任何程序都能直接读。
