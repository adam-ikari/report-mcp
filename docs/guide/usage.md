# 使用方法

七个 tool 全部单向、非阻塞，返回统一为一行 JSON：

```jsonc
{ "ok": true, "runId": "run_20260924062926_8cf29b", "seq": 7, "kind": "progress",
  "panelUrl": "http://127.0.0.1:7788", "viewUrl": "http://127.0.0.1:7788/#/run/run_20260924062926_8cf29b" }
```

`viewUrl` 是给人看的深链——直接点开就是这一次 run。

## 什么时候调哪个

| tool | 什么时候调 | 节奏 |
|---|---|---|
| `report_start` | 任务开跑时 | 每次 run 一次（可省，省了用默认标题） |
| `report_progress` | 阶段切换、百分比有实质变化 | 低频，别每步都调 |
| `report_status` | 状态真的变了；需要人时设 `blocked` | 状态切换时 |
| `report_log` | 中间事件，尤其出错、降级、重试 | 按需 |
| `report_result` | **每个有意义的交付物**（不是每条日志） | 每个交付物一次 |
| `report_end` | 收尾 | 每个 run 一次 |
| `report_panel` | 人类问「在哪看」，或链接被挤出上下文 | 随时 |

::: warning 调用频率
每次调用 = 一行磁盘记录 + 一次面板刷新。`report_progress` **只在阶段切换或百分比有实质变化时调**——每步都调会把时间线刷成噪音，也会让「进度」失去信号意义。
:::

---

## 一次 run 的时间线

```jsonc
// 1. 开跑
{ "title": "调研 agent→human 汇报机制", "agent": "research-agent",
  "task": "对比 5 类通道并给出选型建议", "tags": ["research"] }

// 2. 阶段推进
{ "phase": "检索文献", "percent": 35, "step": 2, "totalSteps": 5, "message": "命中 47 条" }

// 3. 卡住了，要人
{ "status": "blocked", "message": "需要确认要不要把 2020 年前的文献算进来" }

// 4. 人回应了，继续 —— 期间的异常
{ "level": "warn", "message": "2 个来源返回 429，已降速重试", "detail": { "retryAfter": "30s" } }

// 5. 交付物
{ "title": "agent→human 汇报机制对比", "summary": "对比了 5 类通道，结论是……",
  "artifacts": [ { "name": "survey.md", "path": "/abs/report.md", "type": "markdown" } ],
  "metrics":  [ { "name": "综合得分", "value": 8.6, "unit": "/10", "hint": "混合方案" } ],
  "links":    [ { "label": "看板", "url": "https://…" } ] }

// 6. 收尾
{ "status": "done", "summary": "综述与对比矩阵均已交付，遗留 1 篇待补。" }
```

面板上的样子见[在线 Demo](/panel/)（那是示例数据）。

---

## 逐个 tool

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

`percent` 缺省就是「不确定态」——面板显示滑动动画而不是填满的条。**不知道就别瞎填**，一个假的 80% 比动画条更误导人。

### `report_status`

```jsonc
{ "status": "waiting",                 // running|waiting|blocked|error|done|failed|aborted
  "message": "排队等 runner",
  "detail": { "queuePosition": 2 } }
```

`waiting` / `blocked` 是「我需要人」的信号，会变成醒目的琥珀色 chip。

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

## 面板上看什么

| 位置 | 内容 |
|---|---|
| 左栏 | run 列表，按**最后活动时间**排序；状态 chip、相对时间、进度条、错误角标 |
| 右栏头部 | 标题、状态 chip、agent/开始/耗时/记录数/warn-error 数/结果数/tags/最后错误/失败原因、进度条 |
| 时间线 | 按 kind 着色；`result` 渲染成果卡片；`detail`/`data` 进 `<details>` 折叠 |
| 筛选 | 全部 / 进度 / 日志 / 结果 / 状态 |

详见[面板与 Demo](./panel.md)。

---

## 常见问题

**Q：agent 忘了调 `report_start` 直接调 `report_progress`？**
没问题。run 会以默认标题建立，`start` 随时可以补调来改标题——取最后一条。

**Q：链接过期/丢了？**
再调一次 `report_panel`，或者直接看 `$REPORT_MCP_HOME/runs/*.jsonl`，`tail -f` 即可。

**Q：人类没反应，agent 会卡住吗？**
不会。这就是单向设计的意义：没有挂起的请求、没有超时。人类不在场时 agent 照常推进，事后回看时间线。见[设计决策](../reference/design.md)。

**Q：能在两台机器之间用吗？**
不能，默认绑 `127.0.0.1`，也没有鉴权。它是本机旁观通道，不是服务端。
