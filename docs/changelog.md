# 更新日志

版本号遵循 SemVer。安装与升级方式见[安装与接入](/guide/install.html)，渠道始终是 Git：

```bash
npm install -g --install-links=true git+https://github.com/adam-ikari/report-mcp.git
```

## Unreleased

### 新增

- **`report-mcp start` / `stop` / `status`**：宿主的启停不再要一个空终端。`start` spawn
  的就是同一个 `serve`，诊断放 `$REPORT_MCP_HOME/serve.log`；`stop` 对 `host.json` 里的
  pid 发 SIGTERM；`status` 回答「在不在跑、哪个地址、几次汇报几页」，`--json` 给 agent，
  退出码 0/1 就是它的答案。链接的判定依据没变：还是 `host.json`，命令面没有第二套真相
- 这三条是**幂等**的：`start` 遇到已在跑的宿主就复用，`stop` 遇到没在跑也返回成功，
  agent 每次会话各起一次不会撞端口
- **`stop` 拒绝动不是宿主的 pid**：pid 会被回收。`/proc/<pid>/cmdline` 认不出 `serve` 时
  直接报错退出，而不是照着记录杀进程（没有 procfs 的平台退化成只判活）
- 绑 `0.0.0.0` 的警告由 `start` 打在终端上，不会随着 banner 一起沉进日志
- **`start` 在同一个用户账户下只放一个宿主，跨 home 也认。** `host.json` 按 home 存放，看不见
  别的 home 的宿主，于是换个 `REPORT_MCP_HOME` 就能悄悄攒出两份索引页、两套互不相认的链接。
  `serve` 监听从成功后再写一条按账户的登记 `$XDG_STATE_HOME/report-mcp/hosts/<pid>-<port>.json`，
  `start` 查到活宿主且调用方没显式给 `--port` 就**拒绝**（退出码 4，区别于 3 的「起不来」），
  报出对方的地址与 home；`stop --all` 一次停干净。显式 `--port` 按字面意思放行第二个实例。
  死登记（pid 没了或 pid 已被别的进程占去）由下一个读到它的命令删除，没有 `clean` 子命令
- **汇报正文的写作规范进了工具面。** `src/server.ts` 的 `STYLE_RULES` 一份常量同时拼进
  `report_page` 的 description，并作为 `report_syntax {component:"style"}` 返回——agent 不查
  也能看到，写长草稿时对照一次即可。规则：首句就是事实、`——` 后面放让那句成立的东西、
  点名具体物（路径 / 命令 / 状态码 / 字节数 / sha）、错误用陈述句承认、取舍写成因果、
  术语留英文；禁三件套、隔条加粗、not-X-but-Y、结尾复述、销售词、「我们」、感叹号
- `report_syntax` 的 `style` 与 am 的 frontmatter `style`（STE 检查等级 `off|80|strict`）
  不是一回事，`docs/reference/tools.md` 把这两个写在一起免得混
- **`--tunnel`：需要穿透时给宿主挂一条 Cloudflare Quick Tunnel。** `report-mcp start --tunnel`
  （或 `serve --tunnel`）在监听起来之后 spawn `cloudflared tunnel --url`，从它的输出里认出
  `https://<words>.trycloudflare.com`，插到 `urls` 第一位再写 `host.json`——agent 返回的链接、
  索引页、手机浏览器都走它。不用 Cloudflare 账号、不用配 DNS；地址每次随机。`start --tunnel`
  碰上**没有隧道的活宿主**会先停掉再重起（加隧道改变了宿主对外是什么），已经是隧道则保持幂等；
  隧道起不来就退出码 3 且不起本地宿主，不给「看起来在跑其实只对内」的假象；退出时 cloudflared
  跟宿主一起收走。`REPORT_MCP_TUNNEL` 等于开关，`REPORT_MCP_CLOUDFLARED` 指可执行文件路径。
  **安全边界**：cloudflared 从 `127.0.0.1` 连回宿主，所以「来源是回环」不再等于「来自本机」；
  宿主把 `CF-Connecting-IP` / `X-Forwarded-*` 当代理信号，并在隧道开着时关掉 `/api/runs*`，
  journal JSON 不跟着出去
- **配套 skill：把「给 agent 的约定」从系统提示变成一个可加载的 SKILL。**
  `.opencode/skills/report-mcp/SKILL.md` 装上四个工具的调用时机、草稿骨架、失败怎么修与反模式，
  OpenCode 在项目内自动发现；别的项目拷到 `~/.config/opencode/skills/`，或把本仓库的
  `.opencode/skills` 加进 `skills` 配置。skill 不抄语法和措辞——它让 agent 调 `report_syntax` /
  `report_syntax {component:"style"}`，真相仍只有渲染器和 `STYLE_RULES` 两处

### 修掉

- **一条缺字段的登记能让 `status` 整个抛出来。** `otherHosts` 按 `startedAt` 排序，而
  `registeredHosts` 的校验只过 pid / port / url / home：别的 home 留下一条没有 `startedAt`
  的登记（手改的，或者版本改了字段名），`status` / `start` / `stop --all` 三条命令一起
  `TypeError` 退出——而它们本来正是查这件事的入口。校验改成逐字段对着 `HostRegistration`
  过，不合格的按原有规则删掉
- **`registerHost` 写不进去不再静默**：往 stderr 打一行。单实例门禁悄悄消失比多起一个宿主
  难查——宿主本身没坏，坏的是「知道它存在」这件事
- `stop --all` 在本 home 没有宿主时打印 `已停止（pid —）`，现在说清停的是别的 home 的 pid

### 变更

- `examples/` 三份草稿按上面这套重写开头：`这一页回答一个问题：…` /
  `这一页说清楚三件事：…` 这类元叙述删掉，首句直接给数据和结论；正文里的「我们」一并清掉
- 宿主未运行时的 `hint` 从「跑 `report-mcp serve`」改成 `report-mcp start`——agent 照着
  提示 spawn 前台宿主会占住自己的一次工具调用直到超时
- 访问范围写成一张能照抄的表放进 README 与[安装与接入](/guide/install.html)：本机 /
  局域网（`--host 0.0.0.0`）/ 公网隧道（`--tunnel`）/ 三者都开（`--host 0.0.0.0 --tunnel`），
  `--help` 也列出这四条——`host.json` 的 `urls` 第一个就是 agent 返回的链接

### 测试

- 新增 `test/tunnel.mjs`（24）：`--tunnel` 的地址成为 `host.json` 首选且与 `/api/health` 一致、
  隧道开着时 `/api/runs` 关掉（伪造 `CF-Connecting-IP` 的回环请求也认作代理）、退出时收掉
  cloudflared 进程、缺 cloudflared 与「起来就退」两种失败都退出码 3 且不留宿主、`start --tunnel`
  会重启没有隧道的活宿主而不会重启已有隧道的（走同一条路）、隧道地址不误报成 `0.0.0.0` 绑定
- 新增 `test/manage.mjs`（36）：三条命令的幂等、pid 被回收时拒绝下手、陈旧记录清掉后能接管、
  端口被别人占时的失败路径与 `serve.log` 尾巴、**跨 home 的第二个 `start` 被拒绝（4）而显式
  `--port` 放行**、`stop --all` 打到别的 home 的 pid、死登记与缺 `startedAt` 的登记都被下一个
  读者清掉（后者就是上面那条崩溃的回归测试）；
  `test/serve.mjs` 补 SIGTERM 退出清 `host.json` 与登记、SIGKILL 两者都留（31）
- `test/milestone.mjs`（44）补两条：`report_syntax style` 返回的是规范而不是渲染器的错误，
  以及规范确实出现在 `report_page` 的 description 里（同一段出现不止一次就红）
- 现在 **228 条断言 / 九套**

## v0.4.0 · 2026-10-10

**从「实时面板」改成「里程碑汇报」。** agent 交一份精简草稿，工具把它渲染成**一页自包含
HTML** 落盘，`report-mcp serve` 作为唯一的 HTTP 宿主给它一个手机上能点的链接。人真正想看的
不是一屏滚动的日志，是一页能读完的汇报。

v0.3.1 从未发布到 npm，这一版**不做兼容**：没有旧 tool 的别名层，没有旧记录格式的读取垫片。
装过的仓库请重新 `report_start`。

### 破坏性变更

- **工具面 7 → 4**：`report_start` / `report_page` / `report_end` / `report_syntax`。
  删 `report_progress`、`report_status`、`report_log`、`report_result`、`report_panel`
- **记录 kind 6 → 4**：`start` / `milestone` / `published` / `end`。草稿与它渲染出的页面
  是两条记录，重试是新 seq，不覆盖历史
- **实时面板整体删除**：React 前端与 `public/`、SSE 与 `fs.watch`、**整套端口仲裁
  （promote / attach / 5s 接管）**、`/api/file` 与 `REPORT_MCP_FILE_ROOTS` /
  `MAX_FILE_BYTES`、marked + DOMPurify 那条渲染链
- **Cloudflare Worker 镜像删除**（`src/remote.ts`、`worker/`、`REPORT_MCP_REMOTE*`）
- **`report-mcp` 不再监听任何端口，也不 spawn 后台进程。** 托管是 `serve` 子命令的事，
  由人或 Docker 常驻。MCP 进程跟着 agent 会话生灭，页面留在磁盘上
- **`engines.node: ">=20"`**（渲染器用 `Array.prototype.toSorted`）。低版本下 `serve` 照跑，
  `report_page` 返回一句说明
- 页面 URL 形态 `/r/<runId>/<seq>-<slug>`，`Cache-Control: immutable`

### 新增

- **vendored 渲染器**：`vendor/am/am.mjs`（answer-me-with-html 0.5.0，575 KB，MIT，上游生成物）。
  `manifest.json` 钉 sha256，`scripts/check-vendor.mjs` 进 `prepare` 与 CI，
  `scripts/update-am.mjs` 升版。**不自建第二套渲染器**
- **`report_page` 会同步等一次渲染并可能失败**——它是这套工具里唯一的 commit point。
  失败返回渲染器原文（`✗ L12 [flow]` + 正确示例 + `am help flow`），一个字不改
- **`report_syntax`**：直接返回渲染器自己的 `am list` / `am help <topic>`，
  不手写第二份会漂移的语法规范
- **`report-mcp serve`**：只读静态宿主。索引页服务端渲染、无 JS、不在请求时渲染任何东西；
  页面带 gzip、`nosniff`、`no-referrer`、`X-Frame-Options: DENY`、
  `Cross-Origin-Resource-Policy: same-origin`；`/api/runs*` **仅回环**；非 GET/HEAD 一律 405
- **`host.json` + pid 判活**决定返回值里的链接：宿主在跑才给 URL，否则 `url: null` 加一句
  起什么命令。零 HTTP 探测，链接从不撒谎
- **局域网地址枚举**从 v0.3 那条未发布的线继承下来（只枚举 IPv4，私网优先，link-local 丢弃），
  `0.0.0.0` 时逐行打印可点地址并在索引页顶部挂无鉴权警告
- **Docker**：`ENTRYPOINT` 是 `serve`（容器就是那个常驻宿主），MCP 客户端容器
  `--entrypoint node … dist/index.js` 共享同一个 volume
- **`examples/` 三份真草稿** + `scripts/render-samples.mjs`，渲染进 `docs/public/reports/`
  并入库；`--check` 是 CI 门禁——**示例页生成不出来 = vendor 坏了**。文档站导航上
  「在线 Demo」换成「示例汇报」
- 环境变量：新增 `REPORT_MCP_PUBLIC_URL`（容器端口映射 / 反代后面必须设）；
  `REPORT_MCP_HOST` / `PORT` 现在只作用于 `serve`

### 修掉

- **`published` 的 seq 用错**：原来取 `published` 记录自己的 seq，而文件名和 URL 用的是
  `milestone` 的——索引页会指向一个不存在的地址。现在两边都是 milestone 的号
- **`pending` 判定跟着修**：上面那个错位让每一份已渲染的草稿都被当成待渲染
- **收尾页固定 slug `close`**：标题是 run 的、通常非 ASCII，slugify 出来的混合脚本 URL
  没人记得住
- **草稿里的相对 `src=` 与相对图片路径按 agent 的 cwd 解析**（渲染子进程的 cwd），
  以前落在 report home，指不到 agent 正在干的那个项目的文件
- **并发 append 加锁**：`<run>.jsonl.lock` 罩住「量尾巴 → 定 seq → append」。
  改之前 `test/e2e.mjs` 实测能撞出两个 seq 12（check-then-act 竞态），改后连跑九次全绿
- `report_syntax` 描述里一个多引号导致的 TS 语法错误
- **索引页不再打出字面 `undefined`**：`end.status` 是磁盘上的数据，`kind` 在读取时验了、`status` 没验。
  联合之外的值（旧版本写的 `success`）取不到徽章文案，就这么进了人读的那一页。现在未知的状态照
  原文显示、且不挂不存在的 CSS class，`test/host.mjs` 有一条钉住
- **索引页的时间戳不再跟着服务器的 locale 走**：`toLocaleString()` 在 `LANG` 未设时打出
  `10/10/2026, 2:36:38 PM`——中文页面上的一串英文格式。现在是固定 `YYYY-MM-DD HH:MM`，
  与 am 盖在每页页脚的时间同形
- **`report_end` 的返回与 `report_page` 同形**：收尾页也带 `bytes`/`sha256`/`render`/`am`。
  它手里已经有那份 `PublishResult`，之前却拼了个更瘦的 JSON，调用方得按工具名分支才能拿到
  页面指纹。手机上的那次实跑就是分支走进了缺字段的一边，才发现的

### 测试

- **432 条断言 / 10 套 → 161 条 / 7 套**。删掉的 231 条几乎全是面板 DOM 断言
- 新增 `test/milestone.mjs`（41，主 e2e：草稿 → 页面 → journal 顺序 → 宿主 → 链接 → 索引页）、
  `test/host.mjs`（30，路由与安全）、`test/serve.mjs`（27，宿主生命周期与 bind-or-die）、
  `test/render-error.mjs`（15，失败路径）、`test/am-smoke.mjs`（20，渲染器 CLI 契约）、
  `test/vendor.mjs`（11，vendor 完整性）
- `test/e2e.mjs` 重写为多进程共享 run 的交错写与崩溃恢复（17）
- 端口绑定与地址枚举这套 v0.3 里零测试的逻辑，现在有 `test/serve.mjs` 盯
- **手工走了一遍真链路**（`serve` + 一次 stdio 会话：`report_start` → 好草稿 → 坏草稿 →
  `report_end` 带收尾页），headless Chromium 在 1440 与 390px 上截图看排版。当场发现上面
  那个时间戳格式，以及一条要写进文档的上游版面决定：**窄屏上面板竖排，但表格与图不缩**
  （单元格 `min-width: 8em`、SVG `max-width: none`），四列表在 390px 上约 500px 宽要横推。
  vendor 由 sha 钉死，不 fork 它改版面，能改的是草稿（见[使用方法](/guide/usage#知道人会用手机读)）

## v0.3.1 · 2026-09-29

里程碑汇报节奏约定 + 面板渲染修复：

- **`report_progress` 提示词：不要频繁汇报。** tool 描述现明确要求仅在里程碑完成时调用——阶段切换、交付物落地、进度有实质变化；避免 agent 逐条刷进度，污染时间线
- **sandbox iframe 的内联样式不再被吞。** iframe 注入的 CSP 里通配符并不覆盖 `style=` 属性，agent 提供的 HTML 只要靠内联样式就会掉进裸文本渲染；`style-src` 现在显式放行 `'unsafe-inline'`（iframe 本就是 opaque origin，风险不变）
- **时间线的 `PROGRESS` 徽章不再被裁半。** 它与顶栏进度条的 `.progress`（固定 7px 高 + overflow hidden）撞了类名，规则收窄到 `.progress-wrap` 之内
- Demo 的自定义 HTML 记分板改为深色全幅排版，与面板主题一致

## v0.3.0 · 2026-09-29

**面板单实例：多个 agent 共享一块屏。**

- 默认端口 `7788`。第一个进程抢到端口当宿主，后来的进程探测 `/api/health` 确认是**同一个存储目录**的面板后 attach——多个 agent 会话写进同一块屏，各 run 在侧栏并列
- 宿主退出后约 5 秒内，某个 attach 中的进程自动接管：URL 不变、历史不丢、面板不需要任何人点按钮
- 端口被**别的东西**（或另一个 home 的面板）占着时，退回私有随机端口，行为同旧版——共享是增益，不是绑架
- `REPORT_MCP_PORT=0` = 显式要一块私有面板
- 仲裁零新协议：端口绑定本身就是锁，health + home 就是身份。写入面（JSONL append）本来就去中心化，只有服务面需要单实例
- 新增 `test/single.mjs`（19 项）：attach、接管、异物占用、跨 home 隔离

## v0.2.0 · 2026-09-28

**成果卡支持网页形式的内容。**

- `report_result` 的 `markdown` 字段进零依赖排版器（先整体转义再排版，agent 写的原始 `<script>` 只会作为纯文本出现）
- `html` 字段注入 CSP 后进 `<iframe sandbox="allow-scripts">`：脚本能跑，但 iframe 是 opaque origin，读不到父页面
- 新增 `GET /api/file`：`artifacts[]` 里 `image` / `markdown` / `html` 类型的文件按声明就地渲染。路径只从存储的 `(run, seq, i)` 三元组解析，扩展名白名单 + `realpath` + 20 MiB 上限，非图片一律 `text/plain` + `nosniff`
- Demo 站随带示例资产（图片、综述 md、对比矩阵 csv、自定义 HTML 看板）

## v0.1.1 · 2026-09-28

**Git 成为安装渠道 + 文档站上线。**

- `dist/` 入库、`prepare` 钩子跑构建：`npm install -g --install-links=true git+…` 约 20 秒装完，只带生产依赖
- VitePress 文档站部署到 GitHub Pages；面板单文件同一份代码在 Pages 上以静态 Demo 形态运行（左上角 DEMO 角标）
- 测试去固定 sleep，改为等待面板状态与 boot 行，跨机器稳定性收敛

## v0.1.0 · 2026-09-24

**初始版本：单向的 agent → 人类汇报通道。**

- 7 个 tool：`report_start` / `report_progress` / `report_status` / `report_log` / `report_result` / `report_end` / `report_panel`，全部 fire-and-forget，写完即返回
- 每条汇报是 `$REPORT_MCP_HOME/runs/*.jsonl` 里 append 的一行 JSON：可 diff、可审计，别的程序一行代码读走
- localhost 面板：文件监听 + SSE，写入到看见的典型延迟 <100ms；绑定 `127.0.0.1`，无鉴权（by design，单机工具）
- stdio transport 的 stdout 纪律：所有诊断走 stderr，有一条测试专门盯着

