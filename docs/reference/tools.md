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
| `artifacts[]` | `object[]` | | `{name, path?, url?, type?, description?, size?}` |
| `metrics[]` | `object[]` | | `{name, value: number\|string, unit?, hint?}` |
| `links[]` | `object[]` | | `{label, url}` |
| `data` | `any` | | 任意结构，面板折叠展示 |

**每个有意义的交付物调一次**，不是每条日志。它**不结束** run。

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

如果链接被挤出上下文，再调一次 `report_panel` 取回来。
