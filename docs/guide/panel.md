# 面板与 Demo

面板是 **React** 应用，构建成一个文件：esbuild 把 `panel/src/**` 打成 `public/panel.js`，随包一起发布。没有框架、没有 dev server、没有 CDN、没有外部字体——打开即用。

`public/index.html` 保留为**手写的壳**：样式表 + `#root` + 一个 `<script src="panel.js">`。样式表故意留在 HTML 里而不是从 JSX 里 import——窄屏那套规则是承重的，放在它所作用的标记旁边更好读，而且 `<style>` 块在 `panel.js` 解析前就生效，不会有无样式闪烁。

依赖（`react` / `antd` / `marked` / `dompurify` / `esbuild`）全在 `devDependencies`：`public/panel.js` 入库，所以全局 git 安装不需要它们——这和 `dist/` 入库是同一个理由。CI 的漂移门禁同时盯 `dist/` 与 `public/panel.js`。

::: tip 在线 Demo
<https://adam-ikari.github.io/report-mcp/panel/>

**注意那是示例数据**——真正的实时面板跑在你本机，见[安装与接入](./install.md)。左上角有紫色 `DEMO` 角标就说明当前是静态演示。
:::

## 布局

| 区域 | 内容 |
|---|---|
| 左栏 | run 列表**按项目分组**（`tags[0]` → `agent` → `未分组`），组内与组间都按**最后活动时间**排序（不是文件 mtime），带状态 chip、相对时间、进度条、错误角标、附加 tag 与 agent 胶囊；静态模式下还有「我的面板」（见下文） |
| 右栏头部 | 标题、状态 chip、agent / 开始时间 / 耗时 / 记录数 / warn-error 数 / 结果数 / tags / 最后错误 / 失败原因，加一条进度条（不确定态用滑动动画） |
| 时间线 | 按 kind 着色；`result` 渲染成果卡片（可内联图片 / Markdown / sandbox HTML）；`detail` / `data` 进 `<details>` 折叠 |
| 筛选 | 全部 / 进度 / 日志 / 结果 / 状态 |

React 的文本子节点自带转义，属性走 `setAttribute`；唯一手写 HTML 字符串的地方（agent 的 markdown）经 DOMPurify 过滤。

### 侧栏怎么分组

`report_start` 的 `tags` 参数描述写的是「用于在面板里分组」，面板此前只把它当头部一行文本显示。现在按第一个 tag 分桶，没有 tag 就用 `agent`，都没有进「未分组」。

**一个 run 只进一个组。** 把它复制进每个 tag 所在的组，侧栏会谎报 run 数量，找那个真正在意的 run 也变成翻找；其余 tag 作为胶囊挂在条目上，所以信息没丢。

组序按**组内最近活动的那条**排，不看组名——你正在做的那个项目会待在第一个位置。组可折叠，但当前打开的 run 所在的组钉住不折叠：把正在读的东西藏起来，比多显示一行表头要糟。

## 手机上的样子

窄屏不是把桌面版缩小，而是换一套布局——`max-width: 860px` 之内：

| 变化 | 原因 |
|---|---|
| run 列表变成**抽屉**：左上角 ☰ 唤出，点遮罩、按 `Esc`、或选中某个 run 都会收起 | 320–430px 上常驻侧栏吃掉 1/3 屏，只剩两行时间线 |
| 顶部一条 **☰ + 当前 run 标题 + 状态 chip** 的窄条 | 侧栏变成浮层后，它是「我在看哪个 run」的唯一指示；标题太长则省略号 |
| 筛选按钮**横向滚动**（`overflow-x: auto`），不再换行堆三排 | 少一次纵向滚动，按钮之间不至于挤成两行 |
| 按钮 ~38px 高、run 条目内边距加大 | 12px 的控件拇指按不准 |
| 高度用 `100dvh` 而不是 `100vh` | 移动端浏览器地址栏滑动会改变视口高度，`vh` 会把最后几行压在栏下 |
| `env(safe-area-inset-*)` | 刘海与 Home 指示条 |
| `overscroll-behavior: none`、`-webkit-text-size-adjust: 100%` | 页面级橡皮筋会露出后面的空 `body`；iOS 横屏放大字号会顶破布局 |
| 成果卡的 `iframe` 最小高度 480 → 320px | 小屏上别让一个沙箱框吃掉整屏 |

抽屉状态放在 `#app.nav-open` 这个 class 上，**JS 里不判断视口宽度**：样式表本来就只在窄屏 media query 里认这个 class，桌面端它是死的，`.mobar` 同样如此。这样也避开了 `matchMedia`（jsdom 没有这个 API），抽屉逻辑因此可以照常进单元测试——`test/render.mjs` 断言了开关的四条路径，以及移动端窄条与头部标题/状态 chip 的同步。

::: tip 「复制链接」为什么要兜底
`navigator.clipboard` 只在**安全上下文**可用。局域网上的 `http://192.168.1.57:7788` 恰恰不是安全上下文，手机浏览器上 `navigator.clipboard` 直接是 `undefined`——不兜底的话这个按钮在手机上**永远失败**。所以降级到 `document.execCommand("copy")`（隐藏 textarea + `select()`）。
:::

## 富内容成果卡

`report_result` 的产出不再只有文字。面板按内容的**来源**选择渲染方式：

| 来源 | 渲染 |
|---|---|
| `markdown` 字段 | `marked` 渲染后交给 DOMPurify 按白名单过滤。支持完整 GFM（表格、任务列表）；`style` 属性、`iframe`、`svg`、`javascript:` / `data:` URL 全部挡掉 |
| `html` 字段 | 注入 CSP 后写入 `<iframe sandbox="allow-scripts" srcdoc>`：脚本能跑（图表库、交互都可以），但 iframe 是 opaque origin，读不到父页面，也 fetch 不动面板 API |
| `artifacts[]` 里 `type` 为 `image` / `markdown` / `html` 的文件 | live 模式经 `GET /api/file` 取回后按上表同样处理：图片直接 `<img>`，md 排版，html 进 sandbox iframe |
| 其余 artifact / 带 `url` 的 artifact | 维持原样：名称 + 路径或外链 |

下面这张 Demo 成果卡里能看到两代渲染器的差别：表格是 GFM 的产物，metrics 网格、sandbox HTML 记分板、内联图片各自来自不同来源。

![成果卡：metrics 网格 + markdown 综述节选 + sandbox HTML 记分板 + 内联图片](/images/panel-result-card.png)
::: details `/api/file` 为什么算安全
- 路径**从不来自 query**：只接受 `(run, seq, i)` 三元组，去**存储的 result 记录**里取 `artifacts[i].path`。能问出来的文件，都是 agent 已经主动写进记录的文件。
- run id 过字符集校验，`seq`/`i` 必须是整数（400）；记录必须存在且是 result 且索引存在（404）。
- 扩展名白名单（403 拒绝其余）；`realpath` + `isFile()` 挡软链和设备文件；默认 20 MiB 大小上限（413）。
- 图片之外的所有类型（**包括 html**）一律 `text/plain` + `nosniff` 响应，`Cache-Control: no-store`；文件响应不带 CORS 头，sandbox iframe 内的脚本跨源读不到任何 `/api` 数据。
- svg 不在白名单——它是同源脚本载体。
- 已知取舍：面板默认只绑 `127.0.0.1`，暴露面是「agent 已声明的白名单类型文件、只读」。要更紧可以设 `REPORT_MCP_FILE_ROOTS`。
- 开了 `0.0.0.0` 之后，文件响应仍然不带 CORS 头，sandbox iframe 内的脚本跨源读不到 `/api` 数据——但**人是可以直接打开 `/api/runs` 的**，所以这层保护只挡同源脚本，不挡局域网里的浏览器。
:::

::: details agent 的 markdown 为什么两道工序
`marked` 会把 markdown 源码里的原始 HTML **原样透传**。这既是完整 markdown 能用的原因（表格、任务列表、脚注都靠它），也是它不能单独出现的原因——透传意味着 agent 写的 `<script>` 会真的进 DOM。

`DOMPurify` 是第二道，也是面板里唯一一处给 agent HTML 设防的地方：`result.markdown` 字段，以及经 `/api/file` 取回的 `.md` 制品。配置是严格 allowlist（`ALLOWED_TAGS` / `ALLOWED_ATTR` / `FORBID_*`），不放行 `style` 属性。

前一版是手写的「先整体转义再排版」，它也安全，但允许列表要自己维护，遇到没实现的 markdown 特性还会静默退化成纯文本。换成成熟实现之后，攻击面由一个被审过的库负责，而不是这几十行正则。

**往 allowlist 里加东西就是一次安全决策。** 别为了「让 agent 报的东西显示出来」顺手放宽，也别改用 `ADD_TAGS` / `ADD_ATTR`。真需要新标签，先想清楚 agent 为什么能写它。
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
| `GET` | `/api/health` | `{ok, runId, home, urls}` |
| `GET` | `/api/runs?limit=100` | `RunSummary[]`，按最后活动倒序 |
| `GET` | `/api/runs/:id` | `{summary, records[]}` 全量 |
| `GET` | `/api/file?run=:id&seq=:n&i=:k` | 内联渲染用：按 (run, seq, i) 从**存储的 result 记录**解析文件路径，白名单类型 + 大小上限 |
| `GET` | `/api/stream?run=:id` | SSE：`record`（全量预载 + 增量）、`runs`（列表变更） |

绑定 `127.0.0.1`，默认端口 `7788`——**单实例**：同机同存储的多个 agent 进程共享这一个面板，第一个绑上的当宿主，其余 attach；端口被无关程序占用时退回随机端口各自开私有面板。`REPORT_MCP_HOST=0.0.0.0` 可改为局域网可访问，地址会自动枚举并打出来，attach 的进程会从 `/api/health` 的 `urls` 字段接管宿主的地址列表（见[安装与接入](./install.md#让手机能打开局域网访问)）。

::: warning 没有鉴权
面板无鉴权、无 TLS，绑定 `127.0.0.1` 意味着只服务本机。`detail` / `data` 会原样展示 agent 提交的任意负载——**不要把它通过公网隧道暴露出去**。目前唯一的公网形态是上面那个静态 demo，它不含任何真实数据。

`/api/file` 同理：它能把 agent 报告过的本地文件送到浏览器。若确需 `REPORT_MCP_HOST=0.0.0.0`，请同时设置 `REPORT_MCP_FILE_ROOTS` 把可读范围圈进目录白名单——**开了局域网，同网段任何设备都能读全部 run 详情**，这一点不会因为换了绑定地址而变安全。
:::

## 自己看数据

```bash
tail -f ~/.report-mcp/runs/*.jsonl
```

append-only，每行一条记录，任何程序都能直接读。
