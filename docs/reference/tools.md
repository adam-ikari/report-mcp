# Tool 一览

四个 tool。三个写，一个查。

**统一返回：**

```jsonc
{ "ok": true, "runId": "run_20261010062926_8cf29b", "seq": 2,
  "page": "pages/run_20261010062926_8cf29b/2-cache-selection.html",
  "url": "http://127.0.0.1:7788/r/run_20261010062926_8cf29b/2-cache-selection",
  "indexUrl": "http://127.0.0.1:7788/" }
```

失败时是 `{"ok": false, "error": "..."}` 且 `isError: true`；草稿渲染失败时不是 JSON，
而是渲染器自己的那段话（见 `report_page`）。

`seq` 是这个 run 内的序号，从 1 开始严格递增，同时是页面文件名和 URL 里的那个数字。

---

## `report_start`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `title` | `string` | ✅ | 人类看得懂的标题（≤120 字） |
| `agent` | `string` | | 谁在跑，例如 `research-agent` |
| `task` | `string` | | 完整任务描述 |
| `tags` | `string[]` | | **第一个 tag 是索引页的分组名** |
| `metadata` | `object` | | 任意结构，原样保存 |

可选调用。不调就页面照发，run 在索引页上显示为未命名；重复调用 = 覆盖标题（取最后一条 `start`）。

返回 `runId`、`indexUrl`、`pagesDir`。宿主没在跑时 `indexUrl` 为 `null` 并附一句 `hint`。

## `report_page`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `title` | `string` | ✅ | 这一页汇报什么 |
| `draft` | `string` | ✅ | am 草稿，≤64 KB |
| `slug` | `string` | | URL 段，`[a-z0-9-]`；标题非拉丁文时**建议显式给** |

一个里程碑一页。有东西值得让人读的时候调——一个结论、一次对比、一份计划、一件交付物——
日志行不要调它。

**这个调用会同步等一次渲染（典型 0.2–1 s），并且可能失败。** 它是这套工具里唯一的
commit point，不是 fire-and-forget。

失败时返回的是渲染器的原文，形如：

```
nothing published — the draft is journalled at seq 2 in /home/you/.report-mcp/runs/run_….jsonl
failure: draft

✗ L3 [flow] 箭头右边没有目标节点
  Correct example:
    A -> B: label
  Full syntax: am help flow
```

行号、组件名、正确示例、指路 `am help`，一个字都没改。**改好草稿再调一次就行**，
重试是一条新 seq，不是覆盖旧的。草稿本身无论渲染成败都已落盘。

成功返回 `seq`、`page`（home 相对路径）、`bytes`、`sha256`、`render`（模板·主题·面板数·STE 一行）、
`am`（渲染器版本），以及 `url` / `indexUrl`。

### 草稿怎么写

服务端**不改写草稿、不注入 frontmatter、不拼模板**。版面全在草稿里：

````markdown
---
template: sheet
theme: blueprint
title: 缓存迁移 · 里程碑 1：选型
subtitle: 三个候选，一个结论
---

## A 结论 {span=2 meta="一页读完"}

| 候选 | p99 | 崩溃恢复 | 判定 |
|---|---|---|---|
| Redis 7 | 1.8 ms | ok 重放 AOF | ok 采用 |

```flow LR
(Client) -> Gateway: 读请求
Gateway -> *Redis: 命中?
```
````

- frontmatter：`title`、`subtitle`、`template: sheet|doc`、`theme: auto|blueprint|shadcn|paper`、`cols`、`style`、`mode`、`source`
- 每个 `## ` 是一个面板，`{span=2 meta="…"}` 是面板属性；span 只给必须突出的面板
- 组件围栏：`flow` `sequence` `er` `tree` `timeline` `limits` `annot` `kv` `callout` `ask`，`html` / `svg` 原样嵌入
- 其余围栏是代码块：` ```ts src=path lines=18-30 hl=22 ` 可以引用真实文件；` ```diff ` 画补丁
- 表格是 GFM；单元格里写 `ok` / `no` / `warn` 变成 ✓ / ✗ / ! 角标
- 图片 `![说明](/绝对路径.png)` 会被嵌进页面，页面仍是单文件（≤5 MB）；相对 `src=` 与相对图片路径按 **MCP server 进程的 cwd** 解析，也就是 agent 干活的那个项目目录
- 页面自带草稿原文和 Reply / Remark 按钮，读者的批注汇成一段 Markdown 由**他自己**粘回来——这不是回话通道

完整语法用 `report_syntax` 取，别凭记忆编围栏名字。正文的写作规范随 `report_page` 的
description 一起送到 agent 手上，也可单独查（见下面 `report_syntax`）。


::: tip 参考页
本仓库 `examples/` 下有三份真草稿，渲染结果就是文档站「示例汇报」那三页。
:::

## `report_end`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `status` | enum | | `done` \| `failed` \| `aborted`，默认 `done` |
| `summary` | `string` | | 一段话收尾（≤4000 字） |
| `draft` | `string` | | 收尾页草稿，渲染方式同 `report_page` |

**交草稿。** 收尾页是人类最先看的那一页；不给草稿，这个 run 就以「一串链接、没有结论」
收场——这是选择，不是兜底，索引页只能列链接。

给了草稿但渲染失败时，返回 `isError`，但**run 已经关闭**（终态记录已落盘）：
写不出合法收尾页的 agent 仍然要能结束汇报。

返回 `status`、`durationMs`、`pageCount`，加上收尾页那一组字段——与 `report_page` 成功时
同形（`page`、`bytes`、`sha256`、`render`、`am`、`url` / `indexUrl`）。没给草稿就少这一组，
其余照旧。

## `report_syntax`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `component` | `string` | | 一个语法主题；缺省 = 组件清单 |

返回的是**渲染器自己的**帮助文本（`am list` / `am help <topic>`），不是手抄的第二份规范。
主题：`format` `code` `image` `theme` 和每个组件名。

`style` 是唯一的例外——它答的不是渲染器，是这个仓库：正文的写作规范（首句给事实、`——` 追修正、
点名具体物、错误用陈述句承认、术语留英文、禁感叹号与销售词）。别跟 frontmatter 里的 `style` 混，
那一个是 am 的 STE 检查等级（`off|80|strict`）。同一份常量也拼在 `report_page` 的 description
里，所以 agent 不查也能看到；查一次是为了在写长草稿时对照，两个来源不会漂。

---

## 返回值里的链接

`url` 只在有宿主在跑的时候非空。判断方式很土：`$REPORT_MCP_HOME/host.json` 里记着宿主的
pid，`report_page` 用 `process.kill(pid, 0)` 判活。活的就把它的地址拼成 URL 返回，
死的返回 `url: null` + 一句 `hint`。

**页面永远会落盘**，链接只是「现在点得开吗」。宿主起来的那一刻，之前所有页面在同样的
URL 上立刻可达——URL 由 journal 里的 seq 和 slug 决定，与谁在什么时候服务它无关。

所以 agent 侧不需要常驻进程：MCP server 不监听任何端口、不 spawn 后台进程，
跟着会话生灭没问题。
