# Tool 一览

全部单向、非阻塞，写完立刻返回，不等待任何人的回应。

**统一返回：**

```jsonc
{ "ok": true,
  "runId": "run_20260924062926_8cf29b",
  "seq": 7,
  "kind": "progress",
  "panelUrl": "http://127.0.0.1:7788",
  "viewUrl": "http://127.0.0.1:7788/#/run/run_20260924062926_8cf29b" }
```

失败时是 `{"ok": false, "error": "..."}`，并且 `isError: true`。

`seq` 是这条记录在 run 内的序号，从 1 开始严格递增。

---

## `report_start`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `title` | `string` | ✅ | 人类看得懂的标题 |
| `agent` | `string` | | 谁在跑，例如 `research-agent` |
| `task` | `string` | | 完整任务描述 |
| `tags` | `string[]` | | 面板分组用 |
| `metadata` | `object` | | 任意结构，原样保存 |

可选调用；不调就用默认标题。重复调用 = 覆盖标题（取最后一条 `start`）。

## `report_progress`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `phase` | `string` | ✅ | 当前阶段名 |
| `percent` | `number` 0–100 | | 缺省 = 不确定态（滑动动画条） |
| `step` / `totalSteps` | `number` | | 2 / 5 这种 |
| `message` | `string` | | 一行人话 |
| `detail` | `object` | | 任意结构，面板折叠展示 |

只在阶段切换或百分比有**实质变化**时调。

## `report_status`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `status` | enum | ✅ | `running` \| `waiting` \| `blocked` \| `error` \| `done` \| `failed` \| `aborted` |
| `message` | `string` | | 一句话说明 |
| `detail` | `object` | | 任意结构 |

`waiting` / `blocked` 是「我需要人」的信号，渲染成琥珀色 chip。

## `report_log`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `level` | enum | | `debug` \| `info` \| `warn` \| `error`，默认 `info` |
| `message` | `string` | ✅ | 事件描述 |
| `detail` | `object` | | 任意结构 |

`error` 级进 `lastError`，在 run 列表里挂红色 `err` 角标。

## `report_result`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `title` | `string` | ✅ | 交付物标题 |
| `summary` | `string` | | 人话总结 |
| `markdown` | `string` | | Markdown 正文，面板内排版渲染（标题/列表/引用/代码块/链接） |
| `html` | `string` | | 一段完整 HTML，面板以 **sandbox iframe** 渲染：脚本可运行，但与父页面完全隔离 |
| `artifacts[]` | `object[]` | | `{name, path?, url?, type?, description?, size?}` |
| `metrics[]` | `object[]` | | `{name, value: number\|string, unit?, hint?}` |
| `links[]` | `object[]` | | `{label, url}` |
| `data` | `any` | | 任意结构，面板折叠展示 |

**每个有意义的交付物调一次**，不是每条日志。它**不结束** run。

### 文件工件规则（`artifacts[].path`）

- `type` 为 `image` / `markdown` / `html` 且只有 `path`（没有 `url`）时，面板会**内联渲染**这个文件：图片直接显示，markdown 排版展开，html 进 sandbox iframe。其余类型仍是文件名 + 路径条目。
- 图片支持 `png` `jpg` `jpeg` `gif` `webp`；文本支持 `md` `markdown` `txt` `html` `htm`。**`svg` 不服务**（它是同源的脚本载体）。
- **建议报绝对路径**。相对路径按 server 进程的 cwd 解析——通常就是 agent 的 cwd，但跨进程共享 run 时未必。
- `html` 文件永远以 `text/plain` 响应；把它渲染成文档是面板的职责（注入 CSP 后进 sandbox iframe），浏览器直接打开文件地址只会看到源码。
- 单文件默认上限 **20 MiB**，用 `REPORT_MCP_MAX_FILE_BYTES` 覆盖。
- 可选加固：`REPORT_MCP_FILE_ROOTS`（冒号分隔的目录白名单），设了之后白名单外的路径一律 403。配 `REPORT_MCP_HOST=0.0.0.0` 暴露面板时建议启用。

例：一份带图、带排版正文的成果卡——

```jsonc
{ "title": "销量分析",
  "markdown": "## 结论\n\n- Q3 环比 **+18%**\n- 华东区贡献最大",
  "artifacts": [
    { "name": "趋势图", "path": "/abs/out/trend.png", "type": "image" },
    { "name": "明细报告", "path": "/abs/out/report.md", "type": "markdown" }
  ],
  "metrics": [{ "name": "环比", "value": 18, "unit": "%" }] }
```

## `report_end`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `status` | enum | | `done` \| `failed` \| `aborted`，默认 `done` |
| `summary` | `string` | | 收尾总结 |

整个 run 调一次，算出 `durationMs` 并置终态。

## `report_panel`

无参数。返回：

```jsonc
{ "panelUrl": "http://127.0.0.1:7788",
  "viewUrl": "http://127.0.0.1:7788/#/run/run_20260924062926_8cf29b",
  "runId": "run_20260924062926_8cf29b",
  "status": "running",
  "recordCount": 7,
  "storage": "/home/you/.report-mcp" }
```

---

## 返回值里的链接

每个 tool 都带 `panelUrl`（面板根地址）和 `viewUrl`（直指当前 run 的深链）。人类拿到 `viewUrl` 点开即可，不需要再导航。

`panelUrl` 可能指向**另一个 agent 进程托管的面板**——同机同存储的多个 report-mcp 进程共享单实例，后来者 attach 到宿主，链接统一指向宿主地址。这是设计行为，不是串号：所有进程写的都是同一份共享 JSONL。

如果链接被挤出上下文，再调一次 `report_panel` 取回来。
