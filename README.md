# report-mcp

**里程碑汇报的 MCP server。** agent 每完成一件值得读的事，就交一份精简草稿；工具把它渲染成**一页自包含 HTML** 落到磁盘；一个常驻的 `serve` 给这一页一个手机上能点的链接。全程单向：不阻塞对话、不等待回复、不要人类点确认。

- 📖 **文档站**：<https://adam-ikari.github.io/report-mcp/>（安装、用法、草稿语法、架构与决策）
- 📄 **示例汇报页**：<https://adam-ikari.github.io/report-mcp/reports/01-cache-selection.html>（用真的渲染器生成，不是截图）

这个 README 只讲**是什么、怎么装、怎么配**。为什么这么设计、局限在哪，在
[`docs/reference/architecture.md`](docs/reference/architecture.md)——同一件事不写两遍。

---

## 它解决什么

agent 干活的时候，人类那边是黑盒。旧解法是实时时间线：进度条、日志流，一路滚动。可人真正想看的不是滚动日志，是**一页能读完的汇报**——有结论、有对比、有图，手机上打开就能读，事后能转给别人。

所以形态是**一个里程碑 = 一页 HTML**。agent 写的不是 HTML，是一份 ~600 token 的精简草稿（frontmatter + 面板 + `flow`/`sequence`/`tree`/`timeline`/`kv`/`callout` 组件块），版面交给渲染器算——模型手写 HTML 要 4893 token，是草稿的 8 倍，而且丑。

| | |
|---|---|
| ✅ 里程碑粒度的一页汇报，读完即止 | ❌ 实时进度流（v0.3 的面板已整体删除） |
| ✅ 落盘可审计：JSONL append-only + 自包含 HTML | ❌ 阻塞式审批 / 人类回话 |
| ✅ 常驻只读宿主给可点链接（本机或局域网） | ❌ 鉴权、多租户、公网部署 |
| ✅ 运行时零 npm 依赖，渲染器 vendored | ❌ 替代 agent 自己的对话输出 |

## 架构

```
┌──────────────────────────────┐     ┌──────────────────────────────────┐
│  report-mcp   (MCP, stdio)   │     │  report-mcp serve  (常驻 HTTP)   │
│                              │     │                                  │
│  report_start                │     │  GET /            索引页         │
│  report_page   ── spawn ──▶  │     │  GET /r/<run>/<seq>-<slug>       │
│  report_end      am.mjs      │     │  GET /api/health                 │
│  report_syntax               │     │  GET /api/runs…   仅回环         │
│           │                  │     │                                  │
└───────────┼──────────────────┘     └───────────────▲──────────────────┘
            ▼                                        │ 只读
   $REPORT_MCP_HOME/ ──── runs/*.jsonl ──────────────┤
                    └──── pages/<run>/<seq>-<slug>.html
                    └──── host.json  ◀── serve 启动时写，agent 读它拼链接
```

三个要点，展开在[架构与决策](docs/reference/architecture.md)：

- **MCP 进程不监听任何端口、不 spawn 后台进程**，跟 agent 会话同生共死也无所谓——页面在磁盘上。托管是 `serve` 唯一的职责，撞上已有宿主就 bind-or-die。
- **链接来自 `host.json` + pid 判活**，不做 HTTP 探测。宿主在跑才给 URL，否则 `url: null` 加一句该起什么命令。给一个打不开的链接比不给更糟。
- **服务端一个字不改草稿**：不注入 frontmatter、不拼模板，版面决定权全在草稿。`report_page` 只做三件事——落盘、spawn、给链接。

## 数据模型

一次汇报 = 一个 run = `runs/<runId>.jsonl`，四种 `kind`（`start` / `milestone` / `published` / `end`），append-only。草稿和它渲染出的页面分两条记录，是因为失败也要留痕：重试是一条新 seq，而不是覆盖旧的。字段表见 [架构与决策](docs/reference/architecture.md#数据模型)。

页面路径在 journal 里存 home 相对路径（`pages/<runId>/<seq>-<slug>.html`），所以整个存储目录可以整体搬走。

## Tools

四个，返回统一为一行 JSON。

### `report_start`

`{ title*, agent, task, tags, metadata }` → `runId`、`seq`、`indexUrl`、`pagesDir`。第一个 tag 决定索引页里的分组。可选调用，不调就用默认标题。

### `report_page`

```jsonc
{ "title": "缓存选型：为什么是 Redis 而不是本地 LRU",
  "draft": "---\ntemplate: sheet\ntheme: blueprint\ncols: 3\n---\n\n## Panel {span=2}\n```flow LR\n  ...",
  "slug": "cache" }                   // 可选；标题非 ASCII 时建议给
```

→ `seq`、`page`（home 相对路径）、`bytes`、`sha256`、`render`、`am`、`url`、`indexUrl`。

**它会阻塞**：同步等一次子进程渲染，0.2–1 s。**它会失败**，失败原样带回渲染器的报告：

```
nothing published — the draft is journalled at seq 2 in /home/you/.report-mcp/runs/run_….jsonl
failure: draft

✗ L3 [flow] 箭头右边没有目标节点
  Correct example:
    A -> B: label
  Full syntax: am help flow
```

行号、组件名、正确示例、指路 `am help`，一个字都没改。改好草稿再调一次就行。

### `report_end`

`{ status, summary, draft? }`。**收尾页要交**——不给就只有一串链接、没有结论页，这是「服务器不替你拼模板」的直接代价。收尾页固定 slug `close`，标题非 ASCII 也能有个凭记忆打得出来的 URL。即使收尾页渲染失败，run 照样关闭。

### `report_syntax`

`{ component? }` → 渲染器自己的 `am list` / `am help <topic>` 原文。agent 学草稿语法的入口，我们不手写第二份规范。

## 渲染器

草稿格式属于 [Answer me with HTML](https://github.com/answer-me-with-html)（下称 am），本仓库 **vendor** 它的渲染器（`vendor/am/am.mjs`，~575 KB 上游生成物 + `manifest.json` 钉 sha256），不自建第二套。

一份草稿能声明 `template: sheet|doc`、`theme`、`cols`、`## Panel {span=2}`、`flow`/`sequence`/`er`/`tree`/`timeline`/`kv`/`callout`/`ask` 围栏、` ```ts src=src/x.ts lines=18-30 hl=22 `（从 agent 项目的真实文件里切片）、内联图片。完整语法调 `report_syntax`。

渲染契约：`spawn(node, [am.mjs, "render", "-", "--no-open", "-o", <绝对路径>])`，草稿走 stdin；`cwd` 是 agent 的项目目录，所以 `src=` 和相对图片路径指的是*它的*文件；`AM_HOME` 指向 `$REPORT_MCP_HOME/am`，不污染 `~/.answer-me-with-html`；`AM_NO_UPDATE_CHECK=1` 掐掉 am 的每周版本查询（**不是 `CI=1`**，那会顺手改掉子进程其他行为）。

`scripts/check-vendor.mjs` 是 `prepare` 钩子：sha256、版本号、文件头那句 "generated … do not edit" 三样都对得上才装。示例页是它的第二道门禁（见文档站）。

**Node ≥ 20 是硬门**（am.mjs 用了 `Array.prototype.toSorted`）。低于 20 时进程照常起、`--version`/`serve` 照常，只有 `report_page` 会失败并说明原因。

## 宿主

`report-mcp serve` 是唯一的 HTTP 入口，默认 `127.0.0.1:7788`，只读（非 GET/HEAD 一律 405）。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/` | 索引页：服务端渲染，按 run 分组列出已发布页面。无 JS、无 SSE、不在请求时渲染任何东西 |
| `GET` | `/r/<runId>/<seq>-<slug>[.html]` | 页面本体 |
| `GET` | `/api/health` | `{ok, home, pid, urls, version}`，不含 run 内容 |
| `GET` | `/api/runs` · `/api/runs/:id` | journal JSON，**仅回环**（调试与测试） |

页面路径不由客户端给（`runId`/`seq`/`slug` 各自过校验后自己拼），realpath 必须仍在 `pages/` 内，响应头带 `immutable` + `nosniff` + `no-referrer` + `X-Frame-Options: DENY` + `CORP: same-origin`，**没有 CORS 通配**。`Accept-Encoding: gzip` 时压缩——一页几 MB 的内联图在局域网裸传会把「手机上打开」这个故事打死。

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `REPORT_MCP_HOME` | `~/.report-mcp` | 存储根目录（`runs/`、`pages/`、`host.json`、`am/`） |
| `REPORT_MCP_RUN_ID` | 自动生成 | 多个 MCP 进程写进同一次运行 |
| `REPORT_MCP_HOST` | `127.0.0.1` | **serve** 的绑定地址，`0.0.0.0` = 局域网 |
| `REPORT_MCP_PORT` | `7788` | **serve** 的监听端口 |
| `REPORT_MCP_PUBLIC_URL` | 自动发现 | 对外宣传的地址。容器端口映射 / 反代后面必须设 |

诊断信息全部打 **stderr**，stdout 只有 JSON-RPC。

### 手机上打开

```bash
report-mcp serve --host 0.0.0.0
```

```
[report-mcp] serve    http://192.168.1.57:7788/
[report-mcp]          http://10.0.4.12:7788/
[report-mcp] home     /home/adam/.report-mcp
[report-mcp] 注意      绑的是 0.0.0.0：同网段任何设备都能读这些汇报，没有鉴权也没有 TLS。
```

**无鉴权，而且后果比旧版直观**：`0.0.0.0` 现在意味着同一网段任何设备都能读到一份份**完整的汇报文档**。别把它映射到公网；要收紧就回到回环 + `ssh -L 7788:127.0.0.1:7788 host`。

容器里 pid 判活跨不过 namespace（`Dockerfile` 的 `ENTRYPOINT` 就是 `serve`），这时给 agent 侧设 `REPORT_MCP_PUBLIC_URL`，链接照拼。

## 接入

```bash
npm install -g --install-links=true git+https://github.com/adam-ikari/report-mcp.git
report-mcp --version    # report-mcp 0.4.0
```

> `--install-links=true` **不能省**：默认 `false` 时 npm 把 git 依赖软链到临时克隆目录，装完该目录被删，只剩悬空链接——`report-mcp: command not found`。
>
> **Node ≥ 20**。npm registry 尚未发布，`npm install -g report-mcp` 会 404。
>
> `dist/` 和 `vendor/` **都入库**：全局安装拿不到 devDependencies，既没有 `tsc` 也没有东西去生成 vendor。

```jsonc
// opencode.json / claude_desktop_config.json —— 注意没有端口了
{ "mcpServers": { "report": { "command": "report-mcp" } } }
```

然后给 agent 的系统提示加一句约定：

> 任务开始时调 `report_start`。**每完成一件值得读的事**就调一次 `report_page`：交一份 am 草稿
> （frontmatter + `## Panel` + 组件围栏），不要交 HTML，也不要交日志行；不确定语法就调
> `report_syntax`。这个调用会同步等一次渲染，失败会带行号和正确示例——改好草稿再调一次，
> 不用问我。结束时调 `report_end`，**并且给它一份收尾页草稿**（`template: doc`），那是我先看的那一页。

关键差别要说清：`report_page` 不是纯 fire-and-forget，它是一次 commit point。

## 开发

```bash
npm install
npm run build       # tsc → dist/
npm test            # 构建 + 七套测试（160 条断言）
npm run typecheck
node dist/index.js serve --port 7789   # 本地起宿主
```

```
src/
  index.ts      入口分派：MCP / serve / --version / --help
  server.ts     四个 tool 的 zod schema 与 handler
  store.ts      RunWriter(锁 + append/seq 同步) + Store(路径/列表) + host.json
  render.ts     一次 spawn：草稿进、页面出、错误原样带回
  host.ts       serve：路由、索引页、地址枚举、响应头
  summarize.ts  从记录重算 RunSummary
  types.ts      四种记录的判别联合
vendor/am/      am.mjs + LICENSE + manifest.json + README.md（生成物，sha 门禁）
examples/       三份真草稿 → docs/public/reports/
scripts/        update-am.mjs / check-vendor.mjs / render-samples.mjs
docs/           VitePress 文档站（独立 package.json）
Dockerfile / docker-compose.yml   常驻宿主
test/           run.mjs 编排 + 七套
```

测试套件、vendor 升版、CI 门禁、Pages 发布链路，见 [docs/contributing.md](docs/contributing.md)。

**已知局限**（并发锁可放弃、不交收尾页就没有终页、窄屏宽表要横推、局域网无鉴权、就地更新没有……）列在 [docs/reference/architecture.md](docs/reference/architecture.md#局限)，不在这里重复。
