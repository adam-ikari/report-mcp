# report-mcp

**agent 向人类汇报的 MCP server。** 侧写的是单向通道：agent 只管往里写，人类在本地 Web 面板上看，全程不阻塞、不等待、不要人类点确认。

```
agent ──report_* tools──▶ MCP(stdio) ──▶ JSONL 落盘 ──▶ 本地面板(SSE) ──▶ 人类
```

---

## 1. 要解决的问题

agent 干活的时候，人类那边是黑盒：要么刷终端日志，要么等它一次性吐结果。中间发生了什么、卡在哪、有没有已经跑偏，都看不到。

这个 MCP 把「汇报」抽成一个独立的、可被 agent 随手调用的出口，并且：

- **不打断 agent 的执行**。所有 tool 都是 fire-and-forget，写完立刻返回。
- **留痕**。每条汇报都是磁盘上的一行 JSON，事后可以审计、可以 diff、可以被别的程序读。
- **实时**。写入到人类看见，走的是文件监听 + SSE，典型延迟 < 100ms。

### 目标

| | |
|---|---|
| ✅ | 单向推送：进度、状态、日志、结构化成果 |
| ✅ | 落盘可审计（JSONL，append-only） |
| ✅ | 本地 Web 面板实时展示，跨 run 汇总 |
| ✅ | 零依赖前端，零配置起步 |
| ✅ | stdout 纯净，不污染 MCP JSON-RPC |

### 非目标

| | |
|---|---|
| ❌ | 阻塞式审批 / 人类回话（见 §9） |
| ❌ | 外部通知渠道（Webhook / IM / 邮件） |
| ❌ | 服务端部署、多用户鉴权 |
| ❌ | 替代 agent 自己的对话输出——这是给「旁观的人」看的 |

---

## 2. 架构

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

---

## 3. 数据模型

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
| `status` | run 级状态切换 | `status`(running/waiting/blocked/error/done/failed/aborted), `message` |
| `log` | 中间事件 | `level`(debug/info/warn/error), `message`, `detail` |
| `result` | 结构化成果交付 | `title`, `summary`, `artifacts[]`, `metrics[]`, `links[]`, `data` |
| `end` | 收尾 | `status`(done/failed/aborted), `summary`, `durationMs` |

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

---

## 4. Tool 清单

全部单向、非阻塞，返回统一为一行 JSON：`{"ok":true,"runId","seq","kind","panelUrl","viewUrl"}`。

### `report_start`
```jsonc
{ "title": "必填，人类看得懂的标题",
  "agent": "research-agent",          // 可选，谁在跑
  "task": "完整任务描述",              // 可选
  "tags": ["research"],               // 可选，面板分组用
  "metadata": { "branch": "main" } }  // 可选，任意结构
```
可选调用；不调就用默认标题。重复调用 = 覆盖标题（取最后一条 `start`）。

### `report_progress`
```jsonc
{ "phase": "检索文献",                 // 必填
  "percent": 35,                       // 可选 0–100；不填 = 不确定态(动画条)
  "step": 2, "totalSteps": 5,          // 可选
  "message": "命中 47 条",             // 可选，一行人话
  "detail": { "filters": {...} } }     // 可选
```
**只在阶段切换或百分比有实质变化时调**——每次调用都是一行磁盘记录 + 一次面板刷新。

### `report_status`
```jsonc
{ "status": "waiting",                 // running|waiting|blocked|error|done|failed|aborted
  "message": "排队等 runner",
  "detail": { "queuePosition": 2 } }
```
`waiting`/`blocked` 是「我需要人」的信号，会变成醒目的琥珀色 chip。

### `report_log`
```jsonc
{ "level": "warn",                     // 可选，默认 info
  "message": "2 个来源返回 429，已降速重试",
  "detail": { "retryAfter": "30s" } }
```
error 级会进 `lastError`，在 run 列表里挂红色 `err` 角标。

### `report_result` —— 成果交付
```jsonc
{ "title": "agent→human 汇报机制对比",
  "summary": "对比了 5 类通道，结论是……",
  "status": "done",
  "artifacts": [ { "name": "survey.md", "path": "/abs/report.md",
                   "type": "markdown", "description": "完整综述" } ],
  "metrics":  [ { "name": "综合得分", "value": 8.6, "unit": "/10", "hint": "混合方案" } ],
  "links":    [ { "label": "看板", "url": "https://…" } ],
  "data":     { "rows": 23, "dims": 9 } }
```
**每个有意义的交付物调一次**（不是每条日志）。渲染成面板里高亮的成果卡片。它**不结束** run。

### `report_end`
```jsonc
{ "status": "done",                    // done|failed|aborted，默认 done
  "summary": "综述与对比矩阵均已交付，遗留 1 篇……" }
```
整个 run 调一次，算出 `durationMs`，置终态。

### `report_panel`
无参数。返回 `panelUrl` / `viewUrl` / 当前状态 / 记录数 / 存储路径——当人类问「在哪看」，或者链接被挤出上下文时用。

---

## 5. 面板

单文件 `public/index.html`，无构建、无 CDN、无外部字体。

- **左栏**：run 列表，按**最后活动时间**排序（不是文件 mtime），状态 chip、相对时间、进度条、错误角标
- **右栏头部**：标题、状态 chip、agent/开始时间/耗时/记录数/warn-error 数/结果数/tags/最后错误/失败原因，加一条进度条（不确定态用滑动动画）
- **时间线**：按 kind 着色，`result` 渲染成果卡片，`detail`/`data` 进 `<details>` 折叠
- **筛选**：全部 / 进度 / 日志 / 结果 / 状态
- **实时**：SSE 推增量记录，客户端本地重算 summary 所以头部立即更新；另有 15s 全量兜底
- **自愈**：SSE 断线 `EventSource` 自动重连；`fs.watch` 不可靠的文件系统靠 5s sweep 兜底

所有 agent 提交的文本都经过 HTML 转义后再插入 DOM。

---

## 6. HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/` | 面板 HTML |
| `GET` | `/api/health` | `{ok, runId, home}` |
| `GET` | `/api/runs?limit=100` | `RunSummary[]`，按最后活动倒序 |
| `GET` | `/api/runs/:id` | `{summary, records[]}` 全量 |
| `GET` | `/api/stream?run=:id` | SSE：`record`（全量预载 + 增量）、`runs`（列表变更） |

只读。绑定 `127.0.0.1`，默认端口 `0`（自动分配空闲端口；若配置的端口被占则自动降级到随机端口）。

---

## 7. 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `REPORT_MCP_HOME` | `~/.report-mcp` | 存储根目录（`runs/*.jsonl`、`panel.json`） |
| `REPORT_MCP_PORT` | `0` | 面板端口，`0` = 自动 |
| `REPORT_MCP_HOST` | `127.0.0.1` | 绑定地址 |
| `REPORT_MCP_RUN_ID` | 自动生成 | 固定 run id，让多个 MCP 实例写进同一次运行 |

启动时会把诊断信息打到 **stderr**（面板 URL、存储路径、run id），`$REPORT_MCP_HOME/panel.json` 里也会写一份 `{url, pid, runId}`。

---

## 8. 接入

```jsonc
// opencode.json / claude_desktop_config.json
{
  "mcpServers": {
    "report": {
      "command": "node",
      "args": ["/absolute/path/report_mcp/dist/index.js"],
      "env": { "REPORT_MCP_PORT": "7788" }   // 可选：固定端口方便收藏
    }
  }
}
```

然后在 agent 的系统提示里给一句使用约定，例如：

> 任务开始时调用 `report_start`；每个阶段切换或进度有实质变化时调用 `report_progress`；
> 需要我决策时调用 `report_status` 设为 `blocked`；每个交付物调用一次 `report_result`；
> 结束时调用 `report_end`。这些调用不阻塞，随手调即可。

---

## 9. 关键设计决策

**为什么是单向的。** 用户明确不需要阻塞审批。单向让整条链路没有分布式状态：没有挂起的请求、没有超时、没有人类不在场时 agent 卡死。代价是 agent 拿不到人类的回复——那属于对话通道的职责，不该塞进汇报通道。

**为什么 JSONL 而不是 SQLite。** append-only、崩溃安全、`tail -f` 就能看、别的程序一行代码就能读。`seq` 在每次 append 前用「文件大小是否等于我上次写完的大小」检测外部写入，不一致就重读行数重同步，所以多个进程共用 `REPORT_MCP_RUN_ID` 时 seq 仍然单调。

**stdout 纪律。** stdio transport 下 stdout 只能有 JSON-RPC，所以所有日志走 stderr。测试里有一条断言专门检查这一点。

**按文件 watch，而不是按目录 watch。** 这是实测踩出来的坑：Linux 上 `fs.watch(目录)` 只报告增删改名条目，**不会**报告目录内已有文件的内容变化。最初用目录 watch，实时性其实是靠 5s 兜底扫描在撑，测试里表现为「记录延迟到下一个扫描周期才出现」。改成 `fs.watch(单个 run 文件)`（引用计数，首个订阅者开启、最后一个离开时关闭）之后，700ms 断言窗口内稳定通过。

**`send()` 不能把背压当断线。** `res.write()` 返回 `false` 只表示内核缓冲区满，不表示连接死了。早期代码把它当错误返回，会在第一次背压时停止推流。同理 ping 里也不能用返回值判定客户端存活。

**侧栏排序用最后活动时间而非 mtime。** 文件被复制/恢复后 mtime 会变，语义上「最新」应该指「最后一条记录的时间」。

---

## 10. 局限与后续方向

已知局限：

- **并发 append 无锁**。两个进程同时写同一个 run，`seq` 可能撞。实际场景里一次 MCP 连接对应一个 run，影响面很小；`REPORT_MCP_RUN_ID` 共享时建议低频写入。
- **单机 localhost**。没有鉴权，也没有 TLS；绑定 `127.0.0.1` 意味着只服务本机。
- **没有人类 → agent 的回话通道**（by design，见 §9）。
- **没有外部通知**。人不在面板前时不会被打扰。
- 面板对超大 run（上万条记录）会一次性全量加载，没有虚拟滚动。

如果后续要扩，优先级建议：

1. **外部通知**：`report_status` 落到 `blocked`/`error` 时发 Webhook —— 纯增量，不动现有模型
2. **通知渠道配置化**（邮件 / IM），走同一个 `endpoints` 数组
3. **run 归档与保留策略**（按天数或条数滚动）
4. **虚拟滚动 + 分页读取**，撑住超长 run
5. 真要做双向，另开一个 `ask_*` tool 家族，别污染汇报通道

---

## 11. 开发

```bash
npm install
npm run build       # tsc → dist/
npm start           # 起一个空 run（用于手动连）
npm test            # 构建 + 造数据 + 起面板 + 三个套件
```

`npm test` 覆盖 78 条断言，分三套：

| 套件 | 验证什么 |
|---|---|
| `test/smoke.mjs` | MCP 握手、7 个 tool 逐一调用、seq 连续、HTTP API、404、SSE 推送、**stdout 只有 JSON-RPC** |
| `test/render.mjs` | jsdom 里真实渲染：侧栏、头部、时间线 13 条记录、成果卡片、筛选、切换 run、XSS 转义、离线降级 |
| `test/live.mjs` | 带 EventSource shim：**在窗口外直接往 JSONL 追加记录，断言 DOM 在 700ms 内更新**，含状态翻转与筛选 |

### 目录

```
src/
  index.ts    入口：起面板 → 建 MCP server → 接 stdio，处理退出清理
  server.ts   7 个 tool 的 zod schema 与 handler
  store.ts    RunWriter(append/seq 同步) + summarize(派生) + 文件监听 + 面板状态
  panel.ts    HTTP 路由、SSE、按文件 watch、增量 tail、兜底 sweep
  types.ts    六种记录的判别联合 + RunSummary
public/
  index.html  面板（单文件，无依赖）
test/
  run.mjs     测试编排   seed.mjs  造三组 fixture
  smoke.mjs / render.mjs / live.mjs
```
