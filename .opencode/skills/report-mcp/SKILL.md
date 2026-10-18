---
name: Report with report-mcp
description: 用 report-mcp 的四个工具（report_start / report_page / report_end / report_syntax）把里程碑发成一页可读的 HTML 汇报。多步任务里完成了一件值得读的事——结论、对比、计划、交付物、复盘——或用户要「汇报 / 报告 / 里程碑 / 写完给我看 / write up what you did」时用。不要用于对话回复、日志行、一句话进度。
---

# report-mcp

一个里程碑 = 一页 HTML。你交的是一份 ~600 token 的草稿（Markdown + 组件围栏），渲染器算版面，
页面自包含落盘，宿主给一个手机上能点的链接。全程单向：不阻塞对话、不等回复、不要人点确认。

本 skill 不抄语法和措辞——那是渲染器和 `STYLE_RULES` 的事，抄一份就多一处会漂的副本。
不确定就调 `report_syntax`。

## 什么时候发

发：多步任务里完成了一件**值得读**的事——一个结论、一次对比、一份计划、一件交付物、一次复盘。
不发：对话回复、日志行、一句话进度、还没有结论的中间状态。**一页 = 一个里程碑**，不是每步一页。

## 调用顺序

1. `report_start { title, agent?, task?, tags?, metadata? }` —— 一个 run 调一次。第一个 tag 是索引页的分组名。不调也能发页，只是 run 显示为未命名。
2. `report_page { title, draft, slug? }` —— 每个里程碑一次。**它同步等一次渲染（0.2–1 s），并且会失败。** 标题非 ASCII 时显式给 `slug`。
3. `report_end { status?, summary?, draft? }` —— 收尾。**给 `draft`**：那是人先看的那一页，不给就只剩一串链接。收尾页建议 `template: doc`。

`report_syntax { component? }` 随时查语法：不给参数是组件清单，`component:"image"|"flow"|...` 是单个主题，
`component:"style"` 是本仓库的正文写作规范。

## 草稿骨架

````markdown
---
template: sheet        # sheet（面板网格，默认）| doc（单列长文，收尾页用）
theme: auto            # auto | blueprint | shadcn | paper
title: 标题
subtitle: 一句话结论
---

## 结论 {span=2 meta="一页读完"}

正文。表格是 GFM，单元格写 ok / no / warn 变成 ✓ / ✗ / ! 角标。

```flow LR
(改动) -> 服务: 部署
服务 -> *数据库: 命中
```

```ts src=src/cache.ts lines=18-30 hl=22
```
````

- 服务端**不改草稿**：版面全在草稿里。`## ` 是一个面板，`{span=2 meta="…"}` 是可选属性。
- 组件围栏：`flow` `sequence` `er` `tree` `timeline` `limits` `annot` `kv` `callout` `ask`；`html` / `svg` 原样嵌入；其余围栏是代码块，` ```ts src=path lines=18-30 ` 从项目真实文件切片。
- 图片 `![说明](/绝对路径.png)` 会被 **base64 嵌进页面**（单文件，单图 ≤5 MB）。`http(s)` 图片不会被内嵌，别依赖它。
- **别凭记忆编围栏名字**：写错就是一次失败渲染。不确定先 `report_syntax`。

## 正文怎么写

调 `report_syntax {component:"style"}` 拿完整规范，或直接照 `report_page` 的 description（两者是同一份常量）。
一句话版本：首句就是事实；点名具体物（路径、命令、HTTP 状态码、字节数、sha）；错误用陈述句承认；
术语留英文；短句单因果链。禁三件套、隔条加粗、not-X-but-Y、结尾复述、销售词、「我们」、感叹号。

## 链接怎么给

返回值里 `url` 是给人类点的（来自 `host.json`，可能是本机 / 局域网 / 公网隧道地址的第一条）。
**不要自己拼 URL**。`url: null` 表示宿主没在跑——页面已经在磁盘上，让用户跑 `report-mcp start`，
之后每一页在同一个地址可达。要分享到别的网段，用户用 `report-mcp start --tunnel`。

## 渲染失败怎么办

`report_page` 失败时返回的是**渲染器的原文**，带行号、组件名、正确示例、指路 `am help`：

```
✗ L3 [flow] 箭头右边没有目标节点
  Correct example:
    A -> B: label
  Full syntax: am help flow
```

草稿无论成败都已落盘（重试是一条新 seq）。**照着错误改草稿，再调一次**，不要问用户、不要改成 HTML。
反复失败就先 `report_syntax` 查该组件。

## 反模式

- 每做一步就发一页——那是日志流，不是汇报。
- 发明图片、数据或引用。图片只用于真实截图。
- 交 HTML 或整篇日志。交草稿。
- `report_end` 不给收尾页草稿。
