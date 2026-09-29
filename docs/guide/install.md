# 安装与接入

report-mcp 是一个 MCP server：跑在 agent 侧（stdio），同时在本机开一个 HTTP 面板给「旁观的人」。

```
agent ──report_* tools──▶ MCP(stdio) ──▶ JSONL 落盘 ──▶ 本地面板(SSE) ──▶ 人类
```

## 环境要求

- Node.js ≥ 18
- 一个支持 MCP stdio 的客户端（opencode、Claude Desktop、Cursor 等）

## 安装

```bash
npm install -g --install-links=true git+https://github.com/adam-ikari/report-mcp.git
report-mcp --version    # report-mcp 0.3.0
```

约 20 秒，装完只保留生产依赖。

::: warning `--install-links=true` 不能省
默认值是 `false`，npm 会把 git 依赖**软链**到 `~/.npm/_cacache/tmp/` 下的克隆目录，而该临时目录在装完就被删除——结果是一条悬空链接：`report-mcp` 报 `command not found`，`npm ls` 里版本显示为空。加上这个 flag，npm 才会真正解包成独立目录。

装完可用这两条确认：

```bash
ls -ld "$(npm root -g)/report-mcp"   # 应是普通目录，后面没有 "-> ..."
report-mcp --version                 # report-mcp 0.3.0
```

:::

::: tip 分发渠道是 Git
仓库**不提交** `public/demo-data.js`——fixture 的时间戳是相对 `Date.now()` 的，只有在安装/部署那一刻生成，Demo 里的相对时间（「3 分钟前」）才准。这由 `prepare` 钩子完成，它是**零依赖**的。

`dist/` 反过来**是入库的**：全局安装拿不到 devDependencies，没有 `tsc` 可跑。CI 会比对 `dist/` 与 `src/` 的构建结果，不一致就红——避免装到昨天的代码。

:::

::: warning npm registry 尚未发布
`npm install -g report-mcp` 目前会 404。**请用上面的 git URL。**
:::

### 另一种方式：克隆源码（开发用）

```bash
git clone https://github.com/adam-ikari/report-mcp.git
cd report-mcp
npm install             # 跑 prepare → 生成 demo bundle
npm run build           # 改了 src/ 才需要：tsc → dist/
npm test                # 可选：5 套，160 条断言
```

## 接入 MCP 客户端

**全局安装**后：

```jsonc
{
  "mcpServers": {
    "report": {
      "command": "report-mcp",
      "env": { "REPORT_MCP_PORT": "7788" }
    }
  }
}
```

**源码构建**后（必须填绝对路径）：

```jsonc
{
  "mcpServers": {
    "report": {
      "command": "node",
      "args": ["/absolute/path/report-mcp/dist/index.js"],
      "env": { "REPORT_MCP_PORT": "7788" }
    }
  }
}
```

配置文件位置：opencode 是 `opencode.json`，Claude Desktop 是 `claude_desktop_config.json`。

`REPORT_MCP_PORT` 可省略——默认 `7788`，这是**共享面板端口**：同机同存储的多个 agent 进程只有第一个成为面板宿主，其余自动 attach 到同一个面板（详见下一节）。只有想要每人一块私屏时才设 `0`（随机私有端口，不共享）。

## 让 agent 知道该在什么时候汇报

接上之后，给 agent 的系统提示加一句使用约定：

> 任务开始时调用 `report_start`；每个阶段切换或进度有实质变化时调用 `report_progress`；
> 需要我决策时调用 `report_status` 设为 `blocked`；每个交付物调用一次 `report_result`；
> 结束时调用 `report_end`。这些调用不阻塞，随手调即可。

这套约定是单向通道能成立的前提：agent 不需要等回复，只需要**说**。

## 配置项

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `REPORT_MCP_HOME` | `~/.report-mcp` | 存储根目录（`runs/*.jsonl`、`panel.json`） |
| `REPORT_MCP_PORT` | `7788` | 面板端口。同端口的多个进程**共享一个面板**：先到者为宿主，后来者 attach；`0` = 私有随机端口，不共享 |
| `REPORT_MCP_HOST` | `127.0.0.1` | 绑定地址 |
| `REPORT_MCP_RUN_ID` | 自动生成 | 固定 run id，让多个 MCP 实例写进同一次运行 |

启动时的诊断信息打到 **stderr**（面板 URL、存储路径、run id），`$REPORT_MCP_HOME/panel.json` 里也会写一份 `{url, pid, runId}`。

### 多个 agent，一块屏

每个 agent 会话都会 spawn 自己的 report-mcp 进程，但**面板只有一个**。仲裁靠端口绑定：第一个绑上 `7788` 的进程当宿主；后来的进程遇到 `EADDRINUSE` 就探测该端口的 `/api/health`，确认是**同一个存储根目录**的活面板后进入 attach 模式——自己不开服务，工具返回值里的链接直接指向宿主面板。所有进程照常写同一份共享 JSONL，宿主面板的文件监听把它们全部实时推出去。

宿主会话退出后，attach 中的进程会在 **~5 秒内**自动竞选接管，URL 不变、历史不丢。若 `7788` 被无关程序占用（健康探测不通或存储目录不符），各进程退回随机端口开私有面板——行为同旧版，日志里会注明 `(host)` 还是 `(attached · shared host)`。

## 验证接入成功

```bash
report-mcp --help
report-mcp --version
```

之后 agent 每次调用 `report_*`，返回值里都带 `panelUrl` 和 `viewUrl`，点开就能看。也可以直接问它「在哪看你的汇报」——它会调 [`report_panel`](./usage.md#report-panel)。

下一步：[使用方法](./usage.md)
