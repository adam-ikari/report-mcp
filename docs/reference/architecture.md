# 架构与数据模型

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│  单进程 report-mcp                                          │
│                                                             │
│  ┌──────────────────┐          ┌─────────────────────────┐  │
│  │ MCP Server       │          │ HTTP Panel (localhost)  │  │
│  │ stdio transport  │          │  GET /            面板  │  │
│  │                  │          │  GET /api/runs    列表  │  │
│  │ report_start     │  append  │  GET /api/runs/:id      │  │
│  │ report_progress  ├─────────▶│  GET /api/stream  SSE   │  │
│  │ report_status    │          └───────────┬─────────────┘  │
│  │ report_log       │                      │ fs.watch + 增量读 │
│  │ report_result    │                      ▼                │
│  │ report_end       │          ~/.report-mcp/runs/*.jsonl   │
│  │ report_panel     │                                       │
│  └──────────────────┘                                       │
└─────────────────────────────────────────────────────────────┘
```

**为什么两个端口面合在一个进程里：** agent 侧走 stdio（MCP 标准），人类侧走 HTTP。分开成两个服务会引入进程发现、端口协商、生命周期同步三个新问题；合在一起，面板 URL 可以直接塞进每个 tool 的返回值里，人类拿到链接就能看。

**为什么面板跑在 stdio server 里而不是单独起：** 同上，且这样 `report_*` 写入和面板读取共享同一个 `Store`，不需要 IPC。

## 数据模型

一次汇报 = 一条记录 = JSONL 里的一行。六种 `kind`，append-only，不可修改、不可删除。

```jsonc
// 公共字段
{ "id": "uuid", "runId": "run_20260924062926_8cf29b", "seq": 7,
  "ts": "2026-09-24T06:29:26.301Z", "kind": "..." }
```

| kind | 语义 | 关键字段 |
|---|---|---|
| `start` | 开跑，定标题 | `title`, `agent`, `task`, `tags`, `metadata` |
| `progress` | 阶段进度 | `phase`, `percent`(0–100，缺省=不确定), `step`/`totalSteps`, `message` |
| `status` | run 级状态切换 | `status`, `message` |
| `log` | 中间事件 | `level`, `message`, `detail` |
| `result` | 结构化成果交付 | `title`, `summary`, `markdown`, `html`, `artifacts[]`, `metrics[]`, `links[]`, `data` |
| `end` | 收尾 | `status`, `summary`, `durationMs` |

**`detail` / `data` 是 `any`**：agent 想带什么带什么，面板用 `<details>` 折叠展示，不参与派生计算。

### 派生视图 `RunSummary`

`RunSummary` 不落盘，读取时从记录重算（服务端 `store.ts#summarize`，面板端 `index.html#derive`，两边逻辑保持一致）：

- `status` —— 最后一条 `status`/`end` 决定
- `title` / `agent` / `tags` —— 最后一条 `start`
- `progress` —— 最后一条 `progress`
- `logCounts` / `resultCount` —— 计数
- `lastError` —— 最近一条 error 级信号（**不**被 `end.summary` 覆盖）
- `failureSummary` —— 非成功 `end` 的人写总结，和 `lastError` 分开展示
- `durationMs` —— 有 `end` 用它，否则用到最后一条记录的跨度

单向设计的好处在这里显出来：**没有状态同步问题**。面板随时可以从头重放，客户端和服务端的分歧最多是「少看到几条」，下一次读取自愈。

## 富内容：文件面与渲染面

结果卡支持网页形态的内容，安全边界切在 server 与浏览器两侧：

- **`GET /api/file?run=&seq=&i=`（server 侧）**：路径不来自请求参数，只从存储的 result 记录 `artifacts[i].path` 反查——可寻址面 = agent 已主动写进记录的文件。校验链：run id 字符集 + 整数 seq/i（400）→ 记录存在且为 result 且索引存在（404）→ 扩展名白名单，无 svg（403）→ `realpath` + `isFile()`（404）→ ≤20 MiB（413，`REPORT_MCP_MAX_FILE_BYTES`）。图片按真实 Content-Type，其余全部 `text/plain; charset=utf-8`（html 也不例外），恒发 `nosniff` + `no-store`，且**不附 CORS 头**。可选 `REPORT_MCP_FILE_ROOTS` 圈定目录白名单。
- **渲染（浏览器侧）**：markdown 走零依赖转义优先排版器（原始 HTML 变纯文本，链接只放行 `http(s)`/`mailto:`）；agent 的 HTML——无论来自 `html` 字段还是 `type:"html"` 文件——先注入保守 CSP，再进 `<iframe sandbox="allow-scripts" srcdoc>`。不给 `allow-same-origin`：iframe 是 opaque origin，脚本能运行，但读不到父页面 DOM，跨源 fetch 面板 API 又被无 CORS 头的响应挡住。两层各挡一半：server 挡「任意路径披露」，sandbox 挡「注入执行」。
- **静态（Pages）模式**：没有 `/api/file` 可取，demo bundle 里的工件路径在构建时被重写为站点相对 `assets/…`，`scripts/build-demo.mjs` 把资产文件一并复制进 `public/assets/`（部署时随 `docs/public/panel/` 发布），所以线上 demo 的图片、markdown、sandbox HTML 都能真实渲染。

## 存储

```
~/.report-mcp/
  runs/
    run_20260924062926_8cf29b.jsonl   一行一条记录
    run_20260924060500_cc22dd.jsonl
  panel.json                           {url, pid, runId}
```

`REPORT_MCP_HOME` 可以改根目录。

## 单实例：仲裁、attach 与接管

每台机器 × 每个存储根目录只有**一个**面板进程。仲裁不引入任何协商协议——**端口绑定本身就是锁**（`src/panel.ts#promote`）：

1. 启动即尝试 `listen(REPORT_MCP_PORT)`（默认 `7788`）。成功 → 宿主，写 `panel.json`。
2. `EADDRINUSE` → 探测 `GET /api/health`：`ok` 且 **`home` 与自己一致** → **attach**：不监听、不写 `panel.json`，工具返回值动态读宿主 URL（`createServer` 拿的是 `getUrl()` 而不是字符串）。各进程的记录照常直接写共享 JSONL，宿主的 `fs.watch` + SSE 把它们全部推出去——**写入面本来就去中心化，只有服务面需要单实例**。
3. attach 状态每 5s 探测宿主；宿主死了（会话退出/SIGTERM）→ 重新 `listen`（200ms×5 退避）。多个 attach 者同时竞选时 OS 序列化绑定，恰好一个成功晋升为新宿主，其余下一轮探测重新 attach。URL 全程不变。
4. 探测失败（异物占用 / 跨 home）→ 随机端口私有面板。`home` 校验挡的是「不同 `REPORT_MCP_HOME` 的实例互相误认」——否则 A 项目的 agent 链接会指到只有 B 项目数据的面板上。

::: warning 已知边界
宿主让出端口与新宿主绑定之间有 ~5s 窗口；此期间浏览器 `EventSource` 会重连循环，页面本身不报错，接管后自动续上。若期间有**新**进程启动，它会因为端口短暂无人监听而直接成为宿主——接管竞态的最终一致靠「先绑上者优先」。
:::
