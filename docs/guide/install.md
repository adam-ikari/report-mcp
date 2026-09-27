# 安装与接入

report-mcp 是一个 MCP server：跑在 agent 侧（stdio），同时在本机开一个 HTTP 面板给「旁观的人」。

```
agent ──report_* tools──▶ MCP(stdio) ──▶ JSONL 落盘 ──▶ 本地面板(SSE) ──▶ 人类
```

## 环境要求

- Node.js ≥ 18
- 一个支持 MCP stdio 的客户端（opencode、Claude Desktop、Cursor 等）

## 安装

### 方式一：npm

```bash
npm install -g report-mcp
report-mcp --version    # report-mcp 0.1.0
```

### 方式二：从源码构建

```bash
git clone https://github.com/adam-ikari/report-mcp.git
cd report-mcp
npm install
npm run build           # tsc → dist/，并生成 demo bundle
```

产物 `dist/index.js` 就是可执行入口。装完可跑一次测试确认：

```bash
npm test                # 5 套，160 条断言
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

`REPORT_MCP_PORT` 可省略——不设就是 `0`（自动挑一个空闲端口），面板 URL 会出现在每个 tool 的返回值里。固定端口只是为了方便收藏。

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
| `REPORT_MCP_PORT` | `0` | 面板端口，`0` = 自动 |
| `REPORT_MCP_HOST` | `127.0.0.1` | 绑定地址 |
| `REPORT_MCP_RUN_ID` | 自动生成 | 固定 run id，让多个 MCP 实例写进同一次运行 |

启动时的诊断信息打到 **stderr**（面板 URL、存储路径、run id），`$REPORT_MCP_HOME/panel.json` 里也会写一份 `{url, pid, runId}`。

## 验证接入成功

```bash
report-mcp --help
report-mcp --version
```

之后 agent 每次调用 `report_*`，返回值里都带 `panelUrl` 和 `viewUrl`，点开就能看。也可以直接问它「在哪看你的汇报」——它会调 [`report_panel`](./usage.md#report-panel)。

下一步：[使用方法](./usage.md)
