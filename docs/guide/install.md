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
npm test                # 可选：7 套，258 条断言
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
| `REPORT_MCP_HOST` | `127.0.0.1` | 绑定地址。`0.0.0.0` = 局域网可访问，见下 |
| `REPORT_MCP_FILE_ROOTS` | 不限 | `/api/file` 可读目录白名单，冒号分隔 |
| `REPORT_MCP_RUN_ID` | 自动生成 | 固定 run id，让多个 MCP 实例写进同一次运行 |
| `REPORT_MCP_REMOTE` | 不推 | Cloudflare Worker 镜像地址，和下一个**必须同时给** |
| `REPORT_MCP_REMOTE_TOKEN` | 不推 | 上面那个 Worker 的 bearer token |
| `REPORT_MCP_REMOTE_FILES` | 关 | `1` 才上传可内联渲染的制品（会披露文件内容） |

启动时的诊断信息打到 **stderr**（面板 URL、存储路径、run id），`$REPORT_MCP_HOME/panel.json` 里也会写一份 `{url, urls, pid, runId}`。配了镜像的话会多一行 `[report-mcp] mirror <url>`。

## 让手机能打开：局域网访问

默认面板只绑 `127.0.0.1`，只有这台机器上能看。想让同一 Wi-Fi 下的手机、平板或另一台电脑打开，加一个环境变量：

```json
{
  "mcpServers": {
    "report": {
      "command": "node",
      "args": ["/absolute/path/report_mcp/dist/index.js"],
      "env": { "REPORT_MCP_HOST": "0.0.0.0" }
    }
  }
}
```

改完重启 agent 会话，**地址会自己算出来打出来**，不用再 `ipconfig` 找 IP：

```
[report-mcp] panel    http://192.168.1.57:7788/#/run/run_2026...  (host)
[report-mcp] lan      http://127.0.0.1:7788/#/run/run_2026...
```

- 枚举本机非回环网卡，**私网地址优先**（192.168 → 10.x → 172.16-31），其次其他 IPv4，最后是不带 scope id 的全局 IPv6。有几个地址就打几行。
- agent 报出来的 `viewUrl` 用的是**第一个地址**——也就是手机能打开的那个。attach 到共享面板的进程会从 `/api/health` 读宿主的地址列表，所以多个 agent 会话给出的链接始终一致。
- 端口仲裁照旧走 `127.0.0.1`，只有对外发布的地址会变。绑定 `::` 等价于绑所有 v4/v6。

::: warning 无鉴权
开了局域网之后，**同一网段任何设备都能读到全部 run 详情**，`detail` / `data` 会原样展示 agent 提交的任意负载。别把它映射到公网。要收紧：

- `REPORT_MCP_FILE_ROOTS` 把 `/api/file` 的可读范围圈进你自己的目录
- 防火墙按来源 IP 限制

面板本身不提供鉴权，也不会因为开了局域网就变得更安全。
:::

## 面板在手机上的样子

面板按窄屏重排过，不是把桌面版缩小：run 列表收成左上角 ☰ 唤出的抽屉，顶部窄条显示「当前 run + 状态」，筛选按钮横向滚动而不是换行堆三排，按钮加高到拇指能按住的尺寸，高度用 `100dvh` 并避开刘海与 Home 指示条。配上 `0.0.0.0` 就能在手机上追 agent 的汇报。细节见[面板与 Demo](./panel.md#手机上的样子)。

## 多个 agent，一块屏

每个 agent 会话都会 spawn 自己的 report-mcp 进程，但**面板只有一个**。仲裁靠端口绑定：第一个绑上 `7788` 的进程当宿主；后来的进程遇到 `EADDRINUSE` 就探测该端口的 `/api/health`，确认是**同一个存储根目录**的活面板后进入 attach 模式——自己不开服务，工具返回值里的链接直接指向宿主面板（连宿主对外发布的地址一起接管，所以开了局域网时链接仍然是手机能打开的那个）。所有进程照常写同一份共享 JSONL，宿主面板的文件监听把它们全部实时推出去。

宿主会话退出后，attach 中的进程会在 **~5 秒内**自动竞选接管，URL 不变、历史不丢。若 `7788` 被无关程序占用（健康探测不通或存储目录不符），各进程退回随机端口开私有面板——行为同旧版，日志里会注明 `(host)` 还是 `(attached · shared host)`。

## 远端面板：Cloudflare Worker 镜像

面板默认只服务本机。**如果你不在跑 agent 的那台机器上**（出差、用手机、另一台电脑），可以让 agent 顺带把记录推到一台 Worker 上，在那儿看同一份时间线。

先说清楚它是什么：**一个镜像，不是替代品。** agent 照旧往本地 JSONL 写，本地面板照旧工作，推送全程不阻塞任何 tool 调用。Worker 挂了什么都不会丢——JSONL 才是真相，重新起一个会话就能补推。

### 部署 Worker

```bash
npm run build                                    # 面板会被打进 Worker
cd worker
npx wrangler kv namespace create REPORTS          # 把返回的 id 填进 wrangler.toml
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
npx wrangler secret put TOKEN                    # 粘上刚生成的那个
npm run --prefix .. run worker:deploy
```

KV 命名空间是必须的：`REPORTS` 存每个 run 的**原始记录**。summary 不落库，读取时用和本机同一个 `summarize()` 重算——所以迟到的、乱序到达的推送不会留下一个过期状态。

R2 是可选的，只有它能让 `image` / `markdown` / `html` 制品内联渲染。

### 让 agent 推给它

```json
{
  "mcpServers": {
    "report": {
      "command": "node",
      "args": ["/absolute/path/report_mcp/dist/index.js"],
      "env": {
        "REPORT_MCP_REMOTE": "https://report-mcp-mirror.<subdomain>.workers.dev",
        "REPORT_MCP_REMOTE_TOKEN": "<和 wrangler secret put 一样的那个>"
      }
    }
  }
}
```

两个变量**必须同时给**。只给一半会变成每条记录都 401，而失败只表现为一个空面板——比干脆不配更难查。

启动时 stderr 会多一行 `[report-mcp] mirror <url>`。推送是攒批的（250ms 或 40 条，先到先发），退出会 flush 一次，所以短会话的最后几条不会丢。

### 打开

```
https://report-mcp-mirror.<subdomain>.workers.dev/?token=<TOKEN>
```

第一次这样开，会种一个 HttpOnly cookie 再跳回 `/`，token 不留在地址栏、history 和 Referer 里。之后直接开根地址就行。

::: warning 这是全项目唯一暴露在公网的端点
本地面板无鉴权是 by design——它只绑回环。Worker 有公网 URL，所以**鉴权在这里是强制的，不是建议**。而且它继承本地面板那个弱点：`detail` / `data` 里的任意负载会原样展示。

别做的事：拿一个和别处相同的弱 token；把 Worker 地址写进公开文档；把 `REPORT_MCP_REMOTE_FILES=1` 当默认。

镜像的已知短板：`/api/stream` 是**披着 SSE 外衣的定时快照**——每条连接各自按 3s 轮询存储，多个观众就是多份上游读取。真要扇出得上 Durable Object。KV 是最终一致的，刚推的记录可能要几秒才在另一个边缘出现，面板自己的 15s 兜底轮询会补上。
:::

::: tip 制品默认不上传
`REPORT_MCP_REMOTE_FILES=1` 才会把 `report_result` 里声明为 `image` / `markdown` / `html` 的文件读出来上传（单个 2 MiB 上限）。这是**披露决定**，所以默认关着——不开的时候制品在远端面板上就是普通链接，面板本来就支持这么显示。

开了也只传这三种类型，`svg` 仍然不传，理由和本机 `/api/file` 一样：它是同源脚本载体。
:::

## 用 Docker 跑

镜像里是 MCP server 和面板同一个进程，`REPORT_MCP_HOME` 挂 volume，面板绑 `0.0.0.0`：

```bash
docker build -t report-mcp:latest .
docker volume create report-mcp
docker run --rm -v report-mcp:/data alpine chown -R 1000:1000 /data   # 镜像里跑的是 uid 1000 的 node
docker run --rm -it -v report-mcp:/data -p 7788:7788 report-mcp:latest
```

MCP 客户端配置里 `command` 指向 `docker`，而不是 node：

```json
{
  "mcpServers": {
    "report": {
      "command": "docker",
      "args": ["run", "--rm", "-i",
               "-v", "report-mcp:/data",
               "-e", "REPORT_MCP_HOST=0.0.0.0",
               "report-mcp:latest"]
    }
  }
}
```

`-i` 必须给，否则容器拿不到 stdin，MCP transport 无从说话。别加 `-t`：它会让 stdio 变成非二进制安全。

`docker-compose.yml` 里已经把这些配好，直接 `docker compose up -d` 也能起面板。**挂载的 volume 是关键**——`REPORT_MCP_HOME` 就是存储根目录，不挂进去 `docker rm` 之后 run 记录会跟着消失；挂了之后重新 `docker run` 历史会接上。

镜像分两段：build 段需要 devDependencies（`tsc` 和 esbuild 都在那儿），runtime 段只留 `dist/`、`public/` 和生产依赖树，以 `node`（uid 1000）身份运行。

::: tip 为什么没做 Cloudflare Worker 版本
面板的数据源是 agent 机器上的 `REPORT_MCP_HOME/runs/*.jsonl`，Worker 没有文件系统。要在 Worker 上跑面板，就得把写入面从「往本地 JSONL append」换成「POST 到 worker」，那会同时破坏断网也能写、JSONL 作为唯一真相、以及零鉴权——那是另一个产品，不是另一种部署方式。

想让外面访问，`REPORT_MCP_HOST=0.0.0.0` 配防火墙，或者 `cloudflared` 隧道，才是对应的东西。
:::

## 验证接入成功

```bash
report-mcp --help
report-mcp --version
```

之后 agent 每次调用 `report_*`，返回值里都带 `panelUrl` 和 `viewUrl`，点开就能看。也可以直接问它「在哪看你的汇报」——它会调 [`report_panel`](./usage.md#report-panel)。

下一步：[使用方法](./usage.md)
