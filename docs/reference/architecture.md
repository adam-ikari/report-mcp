# 架构与决策

这里写的是**机制**和**取舍**：每条机制说清它为什么长这样，每条取舍都能回答「为什么不选另一条路」。

## 架构

```
agent ──report_page(draft)──▶ MCP server（stdio，不监听端口）
                                │ 1. append 草稿到 runs/<runId>.jsonl（真相，先落盘）
                                │ 2. spawn node vendor/am/am.mjs render - -o pages/…
                                │ 3. append published{path,bytes,sha256,am}
                                │ 4. 读 host.json 判活 → 有链接就给链接
                                ▼
                        $REPORT_MCP_HOME/pages/<runId>/<seq>-<slug>.html
                                ▲
                        report-mcp serve   ← 唯一的 HTTP 宿主，人或者 Docker 起
                          GET /            索引页（服务端渲染，无 JS）
                          GET /r/<run>/<seq>-<slug>   页面本体
                          GET /api/health  banner 与测试用
                          GET /api/runs*   journal JSON，仅回环
```

一次汇报 = 一个 run；一个里程碑 = 一页 HTML；`report_end` 交的那份草稿就是收尾页。

**两个入口，一个二进制。** agent 侧是 stdio（MCP 标准），人类侧是 HTTP。
合成一个进程意味着「agent 会话结束，人类就看不到已经写完的汇报」——而汇报的价值恰恰在事后。
拆开则让 MCP 进程可以随便死：页面在磁盘上，不依赖写它的那个进程活着。

**没有端口仲裁。** v0.3 里每个 agent 进程都可能成为面板宿主，于是需要一整套
promote / attach / 5s 接管协议去抢一个端口。现在 agent 进程根本不绑端口，
`EADDRINUSE` 只可能是两个 `serve` 撞上——那就 bind-or-die 并打印可操作提示（退出码 3），
不需要协商。前提没了，协议就该整个消失，而不是留着当保险。这是这一版最大的减法，
也是最大的风险来源：端口绑定与地址枚举在 v0.3 里是零测试的，现在有 `test/serve.mjs` 盯。

**链接从哪来：`host.json`，不探测。** `serve` 启动时写 `$REPORT_MCP_HOME/host.json`
= `{url, urls, pid, home, startedAt, version}`，退出时按 pid 校验后清掉。
agent 进程在 publish 时读这个文件 + `process.kill(pid, 0)` 判活：活的拼 URL，死的返回
`url: null` + 一句 hint。零 HTTP 探测、零额外延迟、链接不撒谎——
给了就点得开，没给就明说。页面本身永远落盘，宿主起来的那一刻所有历史页面立刻可达。

代价写在 `docker-compose.yml` 里：pid 判活不跨 PID namespace，容器里 agent 看不到宿主机
进程的 pid，得用 `REPORT_MCP_PUBLIC_URL` 显式给地址。

**`start` / `stop` / `status` 是 `serve` 的壳，不是守护进程。** 让人为一个小工具腾出一个
终端是多余的摩擦，所以 `start` 把同一个 `serve` spawn 成后台进程、诊断写 `serve.log`，
然后等 `host.json` 出现——那个文件本来就是「宿主在跑」的唯一定义，就绪信号用它已经够了，
不需要再加一层 pidfile、心跳或 socket。`stop` 读同一个文件里的 pid 发 SIGTERM，
`serve` 收到就自己关自己、自己清记录（这条退出路径由 `test/serve.mjs` 钉，命令面由
`test/manage.mjs` 钉）。唯一的净新增是 `stop` 前认一次
`/proc/<pid>/cmdline`：pid 会被回收，照着一条陈旧记录杀进程是这个命令唯一能造成的
真实损害，认不出来就拒绝动手（没有 procfs 的平台退化成只判活，这条在测试里也钉着）。
`start` 幂等，因为 agent 也会用它——每次会话起一次，不能因为上一次还在跑就报失败。

**拼 URL 就是一个函数，不是一层接口。** `pageIndexUrl(store)` 读 host.json，
`pageUrl(store, ref)` 把 `pages/<runId>/<seq>-<slug>.html` 换成 `/r/<runId>/<seq>-<slug>`。
v0.4 只有一种托管形态，所以没有 `HostAdapter`、没有 `REPORT_MCP_HOST_ADAPTER`：
一屏宽的实现不需要接缝。将来真要接对象存储，要改的是这两个函数，而不是提前给它们套壳。

## 数据模型

一个 run = `$REPORT_MCP_HOME/runs/<runId>.jsonl`，一行一条记录，append-only。四种 `kind`：

```jsonc
// 公共字段
{ "id": "uuid", "runId": "run_20261010062926_8cf29b", "seq": 3,
  "ts": "2026-10-10T06:29:26.301Z", "kind": "published" }
```

| kind | 语义 | 关键字段 |
|---|---|---|
| `start` | 开跑，定标题 | `title`, `agent`, `task`, `tags`, `metadata` |
| `milestone` | agent 交来的草稿 | `title`, `draft`, `slug` |
| `published` | 草稿渲染成的页面 | `for`(= milestone 的 seq), `title`, `slug`, `path`, `bytes`, `sha256`, `am`, `render` |
| `end` | 收尾 | `status`, `summary`, `durationMs` |

**`milestone` 后面没有 `published` 是合法的终态**：草稿写坏了，或者渲染器不可用。
journal 故意留着它——agent 重试是一条新记录，而不是改写历史。

`published.path` 是 home 相对路径（`pages/<runId>/<seq>-<slug>.html`），永不落绝对路径，
所以整个存储目录可以整体搬走。

```
~/.report-mcp/                      REPORT_MCP_HOME
  runs/
    run_20261010062926_8cf29b.jsonl   一行一条记录（真相）
    run_20261010062926_8cf29b.jsonl.lock  写入期间的临界区，写完即删
  pages/
    run_20261010062926_8cf29b/
      2-cache-selection.html          渲染出的页面，写一次不改
      6-close.html
  am/                                 渲染器自己的家（AM_HOME），0700
  host.json                           {url, urls, pid, home, startedAt, version}
```

`seq` 的唯一性靠那个锁目录：`mkdir` 是原子的，临界区罩住「量文件尾巴 → 定 seq → append」。
多个进程共用一个 `REPORT_MCP_RUN_ID` 时不会双双挑中同一个号。等锁超过 2 秒就降级为无锁
append（宁可撞号也不让一次汇报挂掉），锁残留超过 2 秒会被接管。

### 派生视图 `RunSummary`

不落盘，每次读取从记录重算（`src/summarize.ts`），所以晚到的页面不可能留下脏状态：

- `status` —— 最后一条 `end` 决定，没有则 `running`
- `title` / `agent` / `tags` —— 最后一条 `start`
- `pages[]` —— 每条 `published`，`seq` 取 **milestone 的 seq**（文件名和 URL 用的就是它）
- `pageCount` / `recordCount`
- `pending[]` —— 交了草稿但没渲染成的那些，索引页会显式标出来
- `failureSummary` —— 非成功 `end` 的总结文本
- `group` —— 索引页的分组名：第一个 tag → agent → 兜底
- `durationMs` —— 有 `end` 用它，否则用首尾记录跨度

## 渲染管线（`src/render.ts`）

```
spawn(node, [vendor/am/am.mjs, "render", "-", "--no-open", "-o", <abs outPath>])
  cwd   = MCP 进程的 cwd（agent 的项目目录）—— 草稿里的 src= 和相对图片路径指的是它的文件
  env   += AM_HOME=$REPORT_MCP_HOME/am   am 自己的 pages/config/主题草稿不污染 ~/.answer-me-with-html，
                                         多个 REPORT_MCP_HOME 之间也不互串
         += AM_NO_OPEN=1, AM_NO_UPDATE_CHECK=1   服务端进程绝不每周去 GitHub 查版本
  stdin = 草稿，然后 end
  超时   10s（一次渲染）/ 5s（一次语法查询），到点 SIGKILL
  输出   stdout/stderr 各截 64 KB，防止跑飞的渲染器撑大堆
  草稿   >64 KB 直接拒，不劳 am 去猜
```

失败时 `message` 是 am 的原文，一行不改。那段话里有行号、组件名、一个正确示例和
`am help <component>` 的指路——它就是 agent 的修复指令，改写它会丢信息。
agent 一次就能改对，这比我们自己校验草稿格式便宜得多。

**顺序是 journal-first**：先 append 草稿，再渲染，成功才 append `published`。
渲染失败不丢工作，重试只是新 seq。

## 宿主（`src/host.ts`）

| 路由 | 行为 |
|---|---|
| 非 GET/HEAD | 405。没有写入口，这条通道是单向的 |
| `GET /api/health` | `{ok, home, pid, urls, version}` |
| `GET /api/runs[/:id]` | journal JSON，**仅回环**，非回环一律 404 |
| `GET /`（或 `/index.html`） | 索引页，服务端渲染，无 JS、无 SSE、不在请求时渲染任何东西，`no-cache` |
| `GET /r/<runId>/<seq>-<slug>[.html]` | 页面本体 |

页面路径**不由客户端给**：`runId` 过字符集校验、`seq` 必须是整数、`slug` 过字符集校验，
然后服务端自己拼出 `pages/<runId>/<seq>-<slug>.html`。拼不出来就 404，
所以 `..%2f` 这类穿越在解析阶段就死了。此外 `realpath` 必须仍在 `pages/` 的 realpath 之内，
挡住有人往目录里塞一个指向 `/etc/passwd` 的符号链接。

响应头：

```
Content-Type: text/html; charset=utf-8
Cache-Control: public, max-age=31536000, immutable
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
X-Frame-Options: DENY
Cross-Origin-Resource-Policy: same-origin
Vary: Accept-Encoding          （请求带 gzip 时）
```

`immutable` 成立的前提是页面写一次就不改——v0.4 不接 `am patch`，改内容就是发新 seq，
同一 URL 永远是同一份内容，手机上第二次打开才不卡。
带 `Accept-Encoding: gzip` 时用 `node:zlib` 压，一页 100 KB 的图裸传会把「手机上打开」
这个故事打死。

**没有 `Access-Control-Allow-Origin`。** v0.3 那个通配是给跨源 SPA 用的；现在页面本身就是
文档，通配等于允许任意网页读你的汇报。同理 `/api/runs` 只回环——它是未渲染的原始 journal，
连失败草稿都在里面。

## Vendoring

```
vendor/am/am.mjs        上游生成物，575 KB，MIT
vendor/am/LICENSE
vendor/am/manifest.json {name, version, file, bytes, sha256, license, source, upstreamPath, vendoredAt, node}
vendor/am/README.md
scripts/check-vendor.mjs   包 prepare 与 CI 都跑：sha256 + 版本 + 文件头那句 "do not edit" 还在
scripts/update-am.mjs      --from <path|url> <version>：写入、重算 sha、打印 delta
```

不自建第二套渲染器是刻意的：模型手写 HTML 的成本是写草稿的 8 倍（4893 token vs ~600），
而布局、SVG、主题、对比度这些活儿上游已经做完并测过；自己画一遍要几千行代码和一整份
测试资产去追。vendor 换来的代价是包里有 575 KB 生成物，
所以漂移门禁对它只能盯 sha256。

`examples/*.md` 三份真草稿由 `scripts/render-samples.mjs` 渲染进 `docs/public/reports/`，
`--check` 是 CI 的一道门禁：示例页生成不出来 = vendor 坏了。这是 vendor 可用性的活证据。

## 运行环境

`engines.node: ">=20"`——am.mjs 用了 `Array.prototype.toSorted`（V8 11）。
低版本下 `report-mcp --version` 和 `serve` 照跑，`report_page` 返回 `isError` 说明原因，
MCP 启动时在 stderr 上先警告一句。npm 依赖仍然只有 MCP SDK 和 zod。

## 关键决策

**为什么是「一页一里程碑」而不是实时时间线。** 人读汇报要的是结论，不是滚动日志。
v0.3 那套 SSE + 面板把工程投在「让人盯着看」上，而真实需求是「三小时后我能看懂发生了什么」。
代价很实在：删掉 231 条面板 DOM 断言，等于删掉大半个测试资产；补回来的 186 条里，
`milestone` / `host` / `serve` / `manage` 占 123 条，盯的是路由、
安全头和 URL 稳定性，不再盯任何布局。

**为什么服务端不改写草稿、不注入 frontmatter、不拼模板。** 这是「照 am」这句话的实际含义。
一旦服务端补一个字段，版面决定权就回到了我们手里，草稿作者不再对最终页面负责，
而我们对布局的判断远不如那套渲染器。所以 `report_page` 只做三件事：落盘、spawn、给链接。

**`report_page` 会阻塞，这是明说的。** 它同步等一次渲染（典型 0.2–1 s），并且可能失败。
v0.3 的叙事是「所有 tool 永不阻塞」，那一版成立是因为写一行 JSON 真的不会失败。
现在它是一次 commit point，坦白比维持旧叙事重要——tool description 里就写着「can fail:
fix the draft and call again」。单向通道的价值是「人类不在场时 agent 不卡死」，
不是「一次调用都不能有延迟」。

**为什么 JSONL 而不是 SQLite。** append-only、崩溃安全、`tail -f` 就能看、别的程序一行代码
就能读走。代价是它没有事务，所以「两个进程写同一个 run」这件事得自己解决，见上面的锁。
选 SQLite 换来的是原子性和并发，代价是一个需要迁移、需要 `sqlite3` 打开才能审计的二进制文件——
而汇报的第一需求是「事后看得懂、机器读得走」。

**为什么删掉 `/api/file` 和 `REPORT_MCP_FILE_ROOTS`。** 那条路径白名单是幻觉防护：
披露边界从来不在文件系统的哪个位置，而在 agent 写了什么草稿——它想把图 base64 进正文就
进得了正文。既然真相源是草稿，白名单只是给一个已经做了决定的系统加戏。
现在页面只从 `pages/` 下按 `runId`/`seq`/`slug` 拼出来的路径读，没有第二种来源。

**为什么默认绑 `127.0.0.1`，而 `0.0.0.0` 的后果要说得更狠。** 同一个环境变量，
现在发出去的是**一份份完整的汇报文档**，不再是一屏进度条。可读性更高，敏感度也更高。
banner 会警告，索引页顶部会挂一行「同一网段的任何设备都能打开这些汇报，没有鉴权也没有
HTTPS」。收紧靠回环默认值 + `ssh -L 7788:127.0.0.1:7788 host`，上游 am 自己的建议也是这个。

**为什么宿主不由 agent 顺手 spawn。** 「agent 把宿主拉起来」听着体贴，实际是三个新问题：
孤儿进程、端口占用的责任归属、以及人类不知道某个后台进程为什么在自己机器上活着。
让人起一次 `serve`，或者交给 Docker。

**Reply / Remark 不是回话通道。** 那两个按钮是人在页面上批注、把结果拼成一段 Markdown
**自己**粘给 agent。服务端没有任何入站写入口（非 GET/HEAD 一律 405），这条边单向。

**stdout 纪律。** stdio transport 下 stdout 只能有 JSON-RPC，所有诊断走 stderr。
测试里有一条断言专门盯这一点。

## 局限

- **并发 append 靠一个锁目录，不是靠原子写。** `<run>.jsonl.lock`（`mkdir` 在所有我们关心的
  文件系统上是原子的）罩住「量文件尾巴 → 定 seq → append」这段临界区，等待预算 2 秒；
  等不到就**降级为无锁 append**——宁可在极端争用下撞号，也不让一次汇报调用挂掉或报错。
  锁目录超过 2 秒视为死锁残留，会被下一个写者接管。`test/e2e.mjs` 覆盖两个真实进程交错写
  同一个 run（seq 无重号无断档）和双写者被 SIGKILL 后重启续号。剩下的窗口很小但非零：
  单次 `appendFile` 本身不是原子的，同一毫秒内两个进程真同时落到临界区仍可能撞号。
  一次 MCP 连接对应一个 run，`REPORT_MCP_RUN_ID` 共享时建议低频写入。
  跨机器共享 `REPORT_MCP_HOME`（NFS 之类）不在保证范围内。
- **`report_end` 不给草稿就没有终页。** 索引页只能列链接。这是「服务端不拼模板」这个决定的
  直接代价，写在 [安装与接入](/guide/install.html) 的 agent 约定里：结束前交一份收尾页草稿。
- **一次渲染 0.2–1 s，且会失败。** agent 得会读那段错误并改草稿。遇到一个不会重试的 agent，
  这个 run 就留下一堆 `pending` 草稿——索引页会把它们显式列出来，不藏。
- **窄屏上表格和图不缩。** 版面归渲染器，而它在 ≤760px 时只把面板收成单列，表格单元格仍
  是 `min-width: 8em`、SVG 仍是 `max-width: none`——一张四列表在 390px 手机上约 500px 宽，
  要横着推。这是上游的决定，vendor 由 sha 钉死，我们不 fork 它来改。能改的是草稿：
  给手机读的页面把表压到三列以内（[使用方法](/guide/usage#知道人会用手机读)）。
- **局域网暴露无鉴权、无 TLS。** `REPORT_MCP_HOST=0.0.0.0` 之后同网段任何设备都能读全部
  页面；DHCP 换址会让历史链接失效。链接即凭证。
- **索引页无 JS，因此不自动刷新。** 新页面要刷新才出现。这是选择：一个静态的、
  能在手机浏览器里秒开的列表，不值得为它再养一套前端。
- **宿主单点。** 它挂了页面还在磁盘上，`tail -f` 还能看 journal；但没有 URL 可点，直到再起一个。
- **页面是单文件，图会 base64 进去。** 一页可能几 MB。草稿上限 64 KB，但嵌进去的图不受
  这个上限约束（am 自己限单图 5 MB）。
- **vendor 与「运行时零依赖」这句卖点冲突。** 准确说法是：运行时零 npm 依赖 + 一个 vendored
  渲染器（MIT，上游生成物，sha256 门禁）。
- **pid 判活不跨 PID namespace。** 容器里的 agent 看不见宿主机进程的 pid，
  必须用 `REPORT_MCP_PUBLIC_URL` 显式给地址，否则链接一律为 `null`（页面照写）。
- **没有人类 → agent 的回话通道**（by design，见上）。
- **没有外部通知。** 人不在屏幕前时不会被打扰。

## 后续方向

1. **第二个托管形态**：对象存储或 Pages 上传。改 `pageUrl()` 的拼法，或者按 home 分派——
   但不预先给它套接口。
2. **`am patch`**：要就地改页面就得放弃 `immutable`，或者引入「同 seq 新版本 + 索引页重链」
   的第三种方案。没想清楚之前不发。
3. **页面保留策略**：按天数或总字节滚动清理 `pages/` 与 `runs/`。
4. **静态导出**：`serve` 之外再加一个「把整个 home 导出成一份可离线分发的静态站」的命令，
   索引页已经是纯 HTML，几乎白送。
5. 真要做双向，另开一个 `ask_*` tool 家族，别污染汇报通道。
