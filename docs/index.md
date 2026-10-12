---
layout: home

hero:
  name: report-mcp
  text: agent 向人类交汇报
  tagline: 一个里程碑一页纸。agent 交一份精简草稿，渲染成一页自包含 HTML 落盘，常驻宿主给它一个手机上能点的链接。不阻塞、不等待、不要人类点确认。
  image:
    src: /report-mcp/images/report-page.png
    alt: report-mcp 渲染出的一页汇报：面板网格里有结论表、流程图和时序图
  actions:
    - theme: brand
      text: 安装
      link: /guide/install
    - theme: alt
      text: 使用方法
      link: /guide/usage
    - theme: alt
      text: 示例汇报
      link: /reports/01-cache-selection.html
      target: _blank

features:
  - title: 一页一个里程碑
    icon: 📄
    details: agent 写 ~600 token 的精简草稿：frontmatter 定模板与主题，`## ` 分面板，flow / sequence / tree / timeline / kv / callout / ask 围栏画图和给结论。版面决定权全在草稿，服务端一个字都不改。

  - title: 页面自包含
    icon: 📦
    details: 一页 = 一个 HTML 文件，图 base64 在里面，没有 CDN、没有外链、没有外部字体。拷走单个文件离线也能开，页面还带着自己的草稿原文。

  - title: 托管，链接永久不变
    icon: 🔗
    details: report-mcp serve 是唯一的 HTTP 宿主。页面 URL 由 run id + seq + slug 拼出来，immutable 缓存，宿主起来的那一刻历史页面全部立刻可达。

  - title: 手机上能读
    icon: 📱
    details: REPORT_MCP_HOST=0.0.0.0 就开到局域网，可点地址自己枚举出来（私网优先）。没有鉴权也没有 TLS，所以默认值是回环，索引页顶部也会挂着这句提醒。

  - title: 落盘可审计
    icon: 🧾
    details: 草稿和页面都在磁盘上：runs/*.jsonl 一行一条（append-only），pages/<runId>/<seq>-<slug>.html 是渲染结果。tail -f 能看，别的程序一行代码读走。

  - title: 失败是可恢复的
    icon: 🛠
    details: 草稿写坏了，返回的是渲染器自己的话：行号、组件名、一个正确示例、am help 指路，一个字不改。改好再调就是新的一页，失败的草稿留在 journal 里，索引页显式列出 pending。

  - title: 单向，不阻塞
    icon: 🎯
    details: 没有挂起的请求、没有超时、没有入站写入口（非 GET/HEAD 一律 405）。页面上的 Reply / Remark 是读者自己粘回来的，不构成回话通道。

  - title: 依赖面很小
    icon: 🔒
    details: 运行时两个 npm 依赖（MCP SDK、zod）加一个 vendored 渲染器（MIT，生成物，sha256 门禁）。示例汇报页由真渲染器生成，CI 重新渲染比对——生成不出来就是 vendor 坏了。
---
