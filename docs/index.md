---
layout: home

hero:
  name: report-mcp
  text: agent 向人类汇报
  tagline: 单向推送进度、状态、日志与结构化成果，落盘为 JSONL，实时呈现在本地面板。不阻塞、不等待、不要人类点确认。
  actions:
    - theme: brand
      text: 安装
      link: /guide/install
    - theme: alt
      text: 使用方法
      link: /guide/usage
    - theme: alt
      text: 在线 Demo
      link: /panel/
      target: _blank

features:
  - title: 单向，不阻塞
    icon: 🎯
    details: 所有 tool 都是 fire-and-forget，写完立刻返回。没有挂起的请求、没有超时、没有「人类不在场 agent 就卡死」。

  - title: 落盘可审计
    icon: 🧾
    details: 每条汇报是磁盘上的一行 JSON，append-only。事后可以 diff、可以审计，别的程序一行代码就能读走。

  - title: 实时面板
    icon: ⚡
    details: 文件监听 + SSE，写入到人类看见的典型延迟低于 100ms。跨 run 汇总、筛选、深链分享。

  - title: stdout 纪律
    icon: 🔒
    details: stdio transport 下 stdout 只能有 JSON-RPC，所以所有日志走 stderr。有一条测试专门盯这个。

  - title: 零依赖前端
    icon: 📦
    details: 面板是单文件 index.html——无构建、无 CDN、无外部字体，打开即用。

  - title: 同一份代码，两种形态
    icon: 🔌
    details: 既有后端就走 REST + SSE 当实时面板；没后端（比如 GitHub Pages）自动切静态 demo，左上角挂 DEMO 角标。
---
