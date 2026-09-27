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
| `result` | 结构化成果交付 | `title`, `summary`, `artifacts[]`, `metrics[]`, `links[]`, `data` |
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

## 存储

```
~/.report-mcp/
  runs/
    run_20260924062926_8cf29b.jsonl   一行一条记录
    run_20260924060500_cc22dd.jsonl
  panel.json                           {url, pid, runId}
```

`REPORT_MCP_HOME` 可以改根目录。
