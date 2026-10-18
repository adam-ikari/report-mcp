# 使用方法

四个 tool，一次汇报的形状是「一个 run，几页纸」。

| tool | 什么时候调 | 节奏 |
|---|---|---|
| `report_start` | 任务开跑时定个标题 | 每次 run 一次（可省） |
| `report_page` | **有东西值得让人读了** | 每个里程碑一次 |
| `report_end` | 收尾，附收尾页草稿 | 每次 run 一次 |
| `report_syntax` | 忘了某个围栏怎么写 | 随时，只读 |

判断标准是**可读性**，不是事件性。「阶段 2 完成 40%」不是里程碑，一行日志；
「三种方案测完了，结论是用 Redis，理由如下」是里程碑，一页纸。

::: warning `report_page` 会等一次渲染
它同步跑一个子进程，典型 0.2–1 秒，并且**可能失败**。失败不是灾难，是这套设计的正常
路径：错误原文里有行号和正确示例，改好草稿再调一次就是新的一页。
:::

---

## 一次 run 长什么样

```jsonc
// 1. 开跑
report_start {
  "title": "调研 agent→human 汇报机制",
  "agent": "research-agent",
  "task": "对比 5 类通道并给出选型建议",
  "tags": ["research"]            // 第一个 tag 是索引页的分组名
}

// 2. 第一个里程碑：一页纸
report_page {
  "title": "五种通道的对比矩阵",
  "slug": "matrix",               // 标题是中文时显式给个 slug
  "draft": "---\ntemplate: sheet\ntheme: blueprint\ntitle: 五种 agent→human 汇报通道\n---\n\n## A 结论\n\n| 通道 | 延迟 | 离线可读 | 判定 |\n|---|---|---|---|\n| 单文件 HTML | ok 0 | ok | ok 采用 |\n| REST + SSE | warn 100ms | no | warn 保留 |\n\n```callout ok 决定\n里程碑用单文件 HTML 发，过程留在 JSONL 里。\n```\n"
}
// → { ok, seq: 2, page: "pages/run_…/2-matrix.html", url: "http://127.0.0.1:7788/r/run_…/2-matrix", bytes, sha256, render }

// 3. 第二个里程碑
report_page { "title": "压测结果", "slug": "bench", "draft": "…" }

// 4. 收尾：交一份收尾页草稿
report_end {
  "status": "done",
  "summary": "综述与对比矩阵均已交付，遗留 1 篇待补。",
  "draft": "---\ntemplate: doc\ntitle: 收尾\n---\n\n## 做完了什么\n\n…"
}
```

不调 `report_start` 也能用：页面照发，run 在索引页上显示为未命名，之后补一次
`report_start` 就能改标题（取最后一条）。

## 草稿怎么写

服务端**不改写草稿、不注入 frontmatter、不拼模板**。版面全在草稿里，这是照
*answer-me-with-html* 的那句话的实际含义。

````markdown
---
template: sheet          # sheet: 网格看板（默认，一屏总览）| doc: 单栏长文
theme: auto              # auto | blueprint | shadcn | paper，页面上可切换
title: 页面标题
subtitle: 副标题          # 可选
cols: 3                  # sheet 的列数
style: 80                # STE 检查：off | 80(默认，只告警) | strict(不过就不出页)
---

Intro，显示在标题下面。

## A 面板标题 {span=2 meta="右上角小注"}

普通 Markdown：段落、列表、表格、引用、行内代码。
单元格里写 `ok` / `no` / `warn` 会变成 ✓ / ✗ / ! 角标（后面可以跟文字，如 "ok 已批准"）。

```flow LR
(Client) -> Gateway: HTTPS
Gateway -> *Service
Service -> [(Database)]
group Backend: Gateway, Service
```

```sequence num
Client -> Server: SYN
Server --> Client: SYN-ACK
```

```kv cols=2
* 结论: 用 Redis
负责人: 本组
```

```callout warn 注意
双写队列高峰积压到限额的 2.5 倍。
```

```ask
第 4 周什么时候做？
* 等报表任务改完 | 一次干净移除
- 先关双写再说
```
````

要点：

- 每个 `## ` 是一个面板，字母 ID 可以省（自动编号）。`span` 只给必须突出的面板，
  其余按内容自动配平
- 组件围栏：`flow` `sequence` `er` `tree` `timeline` `limits` `annot` `kv` `callout` `ask`；
  `html` / `svg` 原样嵌入
- 其余围栏是代码块：` ```ts src=相对路径 lines=18-30 hl=22 ` 可以引用真实文件；
  ` ```diff ` 画补丁
- 图片 `![说明](/绝对路径.png)` 会被**嵌进页面**，页面仍是单文件（单图 ≤5 MB）
- **相对路径按 MCP server 的 cwd 解析**，也就是 agent 干活的那个项目目录——这正是你要的
- 一页草稿 ≤64 KB，超了直接拒（`draft-too-large`），拆成两页
- 页面自带草稿原文（`#am-source`）和 Reply / Remark 按钮，读者的批注汇成一段 Markdown
  由他自己粘回来。**这不是回话通道**，服务端没有任何写入口

::: tip 别凭记忆编围栏名字
`report_syntax` 返回的就是渲染器自己的 `am list` / `am help <topic>`。写错组件名的代价
是一次失败的渲染，虽然能重试，但一次调用就白费了。
:::

### 正文按仓库作者的 voice 写

一页汇报的版面归渲染器，**措辞归这套规则**——它随 `report_page` 的 description 送到 agent
手上，也能用 `report_syntax {component:"style"}` 单独取：

- 首句就是事实：机制、变更、坏在哪。不铺垫、不设问
- `——` 后面放让那句成立的东西（实测数字、文件路径、commit sha）
- 错误用陈述句承认（「此前遗漏」「实测 18.2.11 是误读」）。修正是信息，不是道歉
- 术语留在英文，只翻译它周围的句子
- 不要：凑三件套、隔一条加粗、not-X-but-Y、结尾复述、感叹号、销售词、「我们」

自检只有一条：跟本仓库的 CHANGELOG 对读，比它更「精致」就是写错了。

### 模板选哪个

`sheet` 是一屏总览：网格、图多、给还没打算细看的人。`doc` 是单栏长文，3 个面板以上自动出目录，
给要读完的人。**收尾页用 `doc`**——它是人类最先看的那一页，要能从头读到尾。

### 知道人会用手机读

窄屏下面板会收成单列竖着堆，但**表格和图不缩**：渲染器给每个单元格定了 `min-width: 8em`，
图的 SVG 是 `max-width: none`——宁可让你横着推一下，也不把一张表拆成一列一个字。所以一张
四列对比表在 390px 的手机上约 500px 宽。这一页注定了要在手机上读，就：

- 表压到三列以内，长文本挪进单元格下面的一行说明，或者干脆换成 `kv`
- 面板用 `span=1`，别在 `cols: 3` 的看板上放 `span=2` 的宽图
- 宽对比留在 `doc` 页：单栏宽度本来就窄，读者是坐下来读的

### 参考页

本仓库 [`examples/`](https://github.com/adam-ikari/report-mcp/tree/main/examples) 下三份真草稿，
渲染结果就是本站「示例汇报」那三页：[选型看板](/reports/01-cache-selection.html)、
[收尾长文](/reports/02-closeout.html)、[决策页](/reports/03-keep-double-write.html)。

---

## 失败怎么恢复

失败返回的是渲染器自己的话，一个字没改：

```
nothing published — the draft is journalled at seq 2 in /home/you/.report-mcp/runs/run_….jsonl
failure: draft

✗ L3 [flow] 箭头右边没有目标节点
  Correct example:
    A -> B: label
  Full syntax: am help flow
```

- **有行号、有组件名、有正确示例**，照着改草稿，再调一次 `report_page`
- 草稿已经落盘了（那句 `journalled at seq 2`），重试是 seq 3，不是覆盖 seq 2
- 索引页会把「交了草稿但没渲染成」的那些列成 pending，人类看得见你卡在哪
- `report_end` 的收尾页渲染失败时，run **仍然关闭**（返回 `isError` 说明页面没出），
  写不出合法草稿也得能结束汇报

其他失败：`draft-too-large`（拆页）、`timeout`（10 秒没渲染完，通常是草稿太大或机器太忙）、
`no-node`（Node < 20）、`no-bundle`（装坏了，重装）。

## 给 agent 的约定话术

接上之后，往系统提示里加这一段：

> 任务开始时调 `report_start` 给一个我看得懂的标题。每完成一个**值得读的**里程碑，
> 调一次 `report_page`，交一份 am 草稿（frontmatter 自己写 `template` / `theme`，
> 组件围栏不会写就调 `report_syntax` 查，别编）。标题是中文时显式给 `slug`。
> **正文按工具描述里那套写作规范写**，不确定的时候调 `report_syntax {component:"style"}`。
> `report_page` 会同步等渲染并可能失败——失败就按返回里的行号改草稿重调，不要放弃汇报。
> 结束时调 `report_end`，**必须带收尾页草稿**，用 `template: doc`，那一页是我最先读的。
> 不需要我的回应，也不用等我。

规范写一行指引就够，正文规则已经在 `report_page` 的 description 里随工具定义送达；
把它抄进系统提示只会多一份会漂移的副本。

最后一句是单向通道成立的前提：agent 不需要等回复，只需要**说**。

## 人怎么看

`report-mcp serve` 的索引页按分组列出每个 run 的每一页，点开就是页面本体。
链接丢了直接开索引页；页面 URL 由 `runId` + seq + slug 决定，永久不变（`immutable`）。

想查原始记录：`tail -f $REPORT_MCP_HOME/runs/*.jsonl`，或者本机
`curl http://127.0.0.1:7788/api/runs`（**仅回环**，非回环地址一律 404——那是未渲染的
journal，连失败的草稿都在里面；`--tunnel` 开着时整条关闭，因为隧道请求也是从回环进来的）。

## 常见问题

**Q：agent 忘了调 `report_start`？**
没问题，run 以未命名建立，补调一次改标题。

**Q：`url` 是 `null`？**
宿主没在跑。页面已经在 `pages/` 下了，起宿主（`report-mcp start`，或者前台 `serve`）之后所有历史页面在同样的
URL 上立刻可达。容器里则检查 `REPORT_MCP_PUBLIC_URL`（pid 判活不跨 PID namespace）。

**Q：人类没反应，agent 会卡住吗？**
不会。这条通道没有挂起的请求、没有超时、没有入站写入口（非 GET/HEAD 一律 405）。

**Q：能在另一台机器 / 手机上读？**
同一个局域网：`report-mcp start --host 0.0.0.0`，地址自己算出来（见
[安装与接入](./install.md#让手机能打开)）。不在同一网段：`report-mcp start --tunnel`，起一条
Cloudflare Quick Tunnel，agent 返回的链接直接可分享。要更保守就用 `ssh -L` 端口转发。
**没有鉴权**这件事不会变好，那些页面是完整的汇报文档，`--tunnel` 是唯一一条故意把它们放到公网的路径。

**Q：一页能放多少内容？**
放得下就放。真正的约束是「读者一次能不能读完」——读不完就拆两页，索引页会按 seq 排好。

**Q：想改已经发出去的一页？**
发新的一页。v0.4 不就地改页面（`am patch`），因为 URL 是 `immutable` 的，
这是同一个决定的两面。
