# 安装与接入

report-mcp 是两个东西共用一个二进制：

```
report-mcp           MCP server（stdio）。agent 调它，草稿落盘，页面渲染出来。
report-mcp serve     只读 HTTP 宿主。人起它，页面就有可点的链接（前台，Ctrl-C 停）。
report-mcp start     同一个宿主放后台。配套的 stop / status 见「起宿主」。
```

```
agent ──report_page──▶ MCP(stdio) ──▶ JSONL + pages/*.html ──▶ serve ──▶ 人类（手机 / 电脑）
```

MCP 那一半**不监听任何端口、不 spawn 后台进程**，跟着 agent 会话生灭；页面在磁盘上，
它死了汇报还在。

## 环境要求

- **Node.js ≥ 20**（渲染器用了 `Array.prototype.toSorted`）。低版本下 `serve` 照跑，
  `report_page` 会返回一句说明而不是页面。
- 一个支持 MCP stdio 的客户端（opencode、Claude Desktop、Cursor 等）。

## 安装

```bash
npm install -g --install-links=true git+https://github.com/adam-ikari/report-mcp.git
report-mcp --version    # report-mcp 0.4.0
```

::: warning `--install-links=true` 不能省
默认值 `false` 会让 npm 把 git 依赖**软链**到 `~/.npm/_cacache/tmp/` 下的克隆目录，
而那个目录装完就删——结果是一条悬空链接：`report-mcp` 报 `command not found`。
加上这个 flag，npm 才会真正解包成独立目录。

```bash
ls -ld "$(npm root -g)/report-mcp"   # 应是普通目录，后面没有 "-> ..."
report-mcp --version
```

:::

::: warning npm registry 尚未发布
`npm install -g report-mcp` 目前会 404。**请用上面的 git URL。**
:::

### 装完磁盘上有什么

```
dist/          编译产物，入库
vendor/am/     渲染器本体，575 KB，MIT，上游生成物，sha256 由 manifest.json 钉住
```

`dist/` 和 `vendor/` 都入库，理由相同：全局 git 安装不装 devDependencies，
那儿既没有 `tsc` 也没有别的东西去生成它们。CI 的漂移门禁同时盯两边——
`dist/` 比对构建结果，`vendor/` 比对 sha256，另外 `examples/` 三份草稿渲染不出页面也算红。

### 另一种方式：克隆源码（开发用）

```bash
git clone https://github.com/adam-ikari/report-mcp.git
cd report-mcp
npm install      # prepare 钩子跑 scripts/check-vendor.mjs，只检查不重建
npm run build    # 改了 src/ 才需要：tsc → dist/
npm test         # 8 套
```

## 接入 MCP 客户端

**全局安装**后：

```jsonc
{
  "mcpServers": {
    "report": { "command": "report-mcp" }
  }
}
```

**源码构建**后（必须填绝对路径）：

```jsonc
{
  "mcpServers": {
    "report": {
      "command": "node",
      "args": ["/absolute/path/report-mcp/dist/index.js"]
    }
  }
}
```

配置文件位置：opencode 是 `opencode.json`，Claude Desktop 是 `claude_desktop_config.json`。

这里**没有端口配置**——MCP 那一半不绑端口。端口属于 `serve`，见下面。

## 起宿主

```bash
report-mcp serve                    # http://127.0.0.1:7788/
report-mcp serve --port 8080        # 换端口
REPORT_MCP_HOST=0.0.0.0 report-mcp serve    # 开到局域网
```

不想为它腾一个终端，就交给这三条：

```bash
report-mcp start                    # 后台起同一个 serve，诊断写 $HOME/serve.log
report-mcp status                   # 在不在跑、哪个地址、home、几次汇报几页
report-mcp stop                     # 停掉，host.json 与登记表一起清；--all 连别的 home 的宿主
```

`start` 是幂等的（已在跑就复用同一个 pid），`stop` 也是（没在跑返回成功），
所以 agent 自己 shell 出去起宿主也行，会话重连一百次不会撞端口。
`status --json` 是给机器读的，退出码 0/1 就是「在不在跑」。

```
[report-mcp] serve    http://127.0.0.1:7788/
[report-mcp] home     /home/you/.report-mcp
```

它只做静态服务：索引页 + 页面 + 两个 API，**不在请求时渲染任何东西**，也不写任何数据。
停掉它（Ctrl-C）页面仍然在磁盘上，重新起来时历史链接一个不少地全部可达。

端口被占用时它**直接退出**（退出码 3）并告诉你占用者是谁：

```
[report-mcp] serve   端口 7788 已被占用，本进程退出。
[report-mcp]           这个 home 已经有宿主在跑：http://127.0.0.1:7788（pid 4112，版本 0.4.0）
[report-mcp]           不需要第二个。要看内容直接开那个地址。
```

如果 `host.json` 里没有活的宿主记录，提示会改成「占用端口的不是本 home 的 report-mcp」，
并给出换端口或者 `REPORT_MCP_PUBLIC_URL` 的办法。**没有 attach、没有接管、没有选举**：
撞了就退。

`start` 还多管一层：同一个用户账户一个宿主。`serve` 监听从成功后往
`$XDG_STATE_HOME/report-mcp/hosts/` 记一条，所以换一个 home 也悄悄起不出第二个：

```
· 没有起新的宿主：这个账户下已经有宿主在跑：http://127.0.0.1:7788（home /home/you/.report-mcp，
pid 4112）。start 只起一个实例——先停掉它（report-mcp stop --all），确实要第二个就显式给 --port
home    /home/you/.report-mcp-lan
```

退出码 **4**，与 3 的「起不来」分开：这里什么都没坏，只是这个账户已经有了它要起的那个宿主。
显式 `--port` 就是「我确实要第二个」，登记表不再拦。死掉的登记（pid 没了，或者那个 pid
已经被别的进程占去）由下一个读到它的命令删掉，不需要谁来 `clean`。

## 让手机能打开

```bash
report-mcp start --host 0.0.0.0     # 或者前台的 REPORT_MCP_HOST=0.0.0.0 report-mcp serve
```

地址会自己算出来打出来，不用再 `ip a` 找 IP；绑的不是回环时，那句「同网段任何人都能读」
的警告打在**终端**上，不会跟着 banner 沉进日志：

```
[report-mcp] serve    http://192.168.1.57:7788/
[report-mcp]          http://10.0.4.2:7788/
[report-mcp]          http://127.0.0.1:7788/
[report-mcp] 注意      绑的是 0.0.0.0：同网段任何设备都能读这些汇报，没有鉴权也没有 TLS。
```

（这是前台 `serve` 的 banner。放后台时它写进 `serve.log`，而 `start` 会把同一句警告
打在终端上：）

```
✓ 宿主在跑 http://192.168.1.57:7788/ (pid 2415288 · v0.4.0 · 自 2026-10-12T06:53:15Z)
    备选  http://10.0.4.2:7788/
    备选  http://127.0.0.1:7788/
home    /home/you/.report-mcp
内容    3 次汇报 · 7 页
日志    /home/you/.report-mcp/serve.log
注意    这个宿主绑在了 0.0.0.0：同一网段的任何设备都能打开这些汇报，没有鉴权也没有 HTTPS。
```

枚举本机非回环网卡的 **IPv4** 地址，**私网地址优先**（192.168 → 10.x → 172.16-31），
其次其他 IPv4，link-local 的 `169.254.*` 直接丢弃（它拼出来的链接必然打不开）。
IPv6 不参与枚举：同一 Wi-Fi 下的手机要够到它，得处理 scope id 和防火墙，收益不抵复杂度。
agent 侧返回的链接取的就是第一个地址，所以手机打开它给的那条就行。

页面是单文件、自包含的，手机上打开不需要外网；一张图 base64 在里面，
所以第二次打开靠 `immutable` 缓存，不重传。

窄屏上**面板会竖着堆叠**（`@media (max-width: 760px)` 把网格收成单列），但表格和图
**不缩**——渲染器给每个单元格定了 `min-width: 8em`，图的 SVG 是 `max-width: none`。
这是上游的版面决定：宁可让你横着推一下，也不把一张表拆成一列一个字。所以一张四列对比表
在 390px 的手机上会有约 500px 宽，需要左右拖动。想让某一页在手机上不用推，
就把表压到三列以内、面板用 `span=1`，或者把宽表放进度页、结论页只留短表。

### 不在同一网段：`--tunnel`

手机不在同一个 Wi-Fi，或者要随手把链接发给别人时，加 `--tunnel`：

```bash
report-mcp start --tunnel           # 或前台 report-mcp serve --tunnel
```

宿主在监听起来之后顺带起一条 [Cloudflare Quick Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)：

```
[report-mcp] serve    https://random-words-1234.trycloudflare.com/
[report-mcp]          http://127.0.0.1:7788/
[report-mcp] home     /home/you/.report-mcp
[report-mcp] 注意      隧道地址公网可达：拿到链接的人都能读，无鉴权。
```

- 需要本机有 **`cloudflared`**（`cloudflared` 在 PATH 上，或用 `REPORT_MCP_CLOUDFLARED` 指路径）。
  不用 Cloudflare 账号、不用登录、不用配 DNS——这是它的 Quick Tunnel 模式，地址每次都随机。
- 隧道地址写进 `host.json` 的 **第一位**：agent 返回的链接、索引页、手机浏览器都用它；本地回环地址
  排在后面当备选。
- 宿主**已经在跑、但还没有隧道**时，`start --tunnel` 会先停掉它再重起，并在输出里说一句
  「已重启并加上」。加隧道改变了宿主对外是什么，所以这里不做「悄悄忽略」。已经是隧道的宿主
  仍然幂等，不重启。
- 起来失败（没装 `cloudflared`、连不上 Cloudflare、超时）就**退出码 3，且不起本地宿主**，
  并把 cloudflared 的原文带出来——不会留一个「看起来在跑、其实对内」的宿主骗你。
- 退出（Ctrl-C / `report-mcp stop`）时 cloudflared 跟宿主一起收走。被 **SIGKILL** 时和 `host.json`
  一样会留下孤儿进程，自己 `pkill cloudflared`。
- `/api/runs` · `/api/runs/:id`（journal JSON）在隧道开着时**整条关掉**。cloudflared 是从
  `127.0.0.1` 连回宿主的，光看来源地址分不出「本地」和「隧道」；宿主把 `CF-Connecting-IP`
  这类转发头当作代理信号，两者都挡。

::: warning 无鉴权，而且后果比旧版直观
`0.0.0.0` 现在发出去的是**一份份完整的汇报文档**，同网段任何设备都能读，没有鉴权也没有
HTTPS。索引页顶部会挂一行同样的提醒。别把它映射到公网。要收紧：

- 默认值就是 `127.0.0.1`，别为了省事改配置
- 防火墙按来源 IP 限制
- 跨公网用 SSH 端口转发：`ssh -L 7788:127.0.0.1:7788 host`，然后开 `http://127.0.0.1:7788/`

`--tunnel` 是唯一一条**故意**把内容放到公网的路径：地址不可猜，但拿到它的人都能读完整页面。
宿主本身不提供鉴权。
:::

## 用 Docker 跑

镜像的 `ENTRYPOINT` 是 **`serve`**——容器就是那个常驻宿主：

```bash
docker build -t report-mcp:latest .
docker volume create report-mcp
docker run -d --name report-mcp -v report-mcp:/data -p 7788:7788 report-mcp:latest
```

MCP 客户端配置里覆盖 entrypoint，让 agent 侧跑同一个镜像的 MCP 那一半，
**共享同一个 volume**：

```json
{
  "mcpServers": {
    "report": {
      "command": "docker",
      "args": ["run", "--rm", "-i",
               "-v", "report-mcp:/data",
               "--entrypoint", "node",
               "report-mcp:latest", "dist/index.js"]
    }
  }
}
```

`-i` 必须给，否则容器拿不到 stdin，MCP transport 无从说话。别加 `-t`：
它会让 stdio 变成非二进制安全。

`docker-compose.yml` 里这两条都配好了，`docker compose up -d` 起宿主。

::: warning 容器里 pid 判活不成立
宿主 URL 是 agent 进程读 `host.json` + `process.kill(pid, 0)` 判活的，**pid 不跨
PID namespace**。容器里的 agent 看不见宿主机上那个 serve 的 pid，链接一律返回
`url: null`（页面照写不误）。解法是显式给地址：

```yaml
environment:
  REPORT_MCP_PUBLIC_URL: http://192.168.1.57:7788
```

两个容器都设同一个值（agent 侧用它拼链接，宿主侧把它排在地址列表第一位）。
:::

## 配置项

| 环境变量 | 默认 | 用在哪 | 说明 |
|---|---|---|---|
| `REPORT_MCP_HOME` | `~/.report-mcp` | 两边 | 存储根目录：`runs/`、`pages/`、`am/`、`host.json` |
| `REPORT_MCP_RUN_ID` | 自动生成 | MCP | 固定 run id，让多个 MCP 实例写进同一次汇报 |
| `REPORT_MCP_HOST` | `127.0.0.1` | serve / start | 绑定地址，`0.0.0.0` 见上 |
| `REPORT_MCP_PORT` | `7788` | serve / start | 监听端口（`--port` 同义）。给 `start` 显式设 = 「我承认这个账户还要第二个宿主」 |
| `REPORT_MCP_PUBLIC_URL` | 无 | serve | 对外宣传的地址；容器端口映射、反向代理后面必须设 |
| `REPORT_MCP_TUNNEL` | 无 | serve / start | 非空即等于 `--tunnel`：起一条 Cloudflare Quick Tunnel，地址进 `host.json` |
| `REPORT_MCP_CLOUDFLARED` | `cloudflared` | serve / start | `--tunnel` 用的可执行文件路径（默认从 PATH 找） |
| `XDG_STATE_HOME` | `~/.local/state` | serve / start | 宿主登记表落在 `report-mcp/hosts/`。容器各自一个宿主时指到各自的可写目录 |

v0.3 的 `REPORT_MCP_FILE_ROOTS` / `MAX_FILE_BYTES` / `REMOTE*` 全部删除：
`/api/file` 没了（页面只从 `pages/` 下拼出来的路径读），Worker 镜像没了。

诊断信息一律打到 **stderr**（stdio transport 下 stdout 只能有 JSON-RPC，有一条测试专门盯）。

## 验证接入成功

```bash
report-mcp --version
report-mcp serve --port 0 &      # 随机端口，只为看 banner
```

让 agent 发一页试试：

```
调 report_start 标题为「接入自检」，然后调 report_page 交一份三行的小草稿，把 url 念给我
```

返回值里 `page` 是 home 相对路径，`url` 是否非空取决于宿主在不在跑——两者都算接入成功。
`url` 为 `null` 时看 stderr 那行 `host 未运行`，起个 `serve` 再刷新索引页就有链接了。

下一步：[使用方法](./usage.md)
