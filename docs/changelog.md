# 更新日志

版本号遵循 SemVer。安装与升级方式见[安装与接入](/guide/install.html)，渠道始终是 Git：

```bash
npm install -g --install-links=true git+https://github.com/adam-ikari/report-mcp.git
```

## Unreleased

**面板改用 React、可以开到局域网、适配手机。**

### 前端

- **面板是 React 19 应用**，esbuild 打成**一个** `public/panel.js`（gzip ~189 kB）。没有框架和 dev server，不拉 CDN，不用外部字体
- `public/index.html` 缩成手写的壳：样式表 + `#root` + 一个 `<script src="panel.js">`。样式表不从 JSX import——窄屏规则是承重的，放在它作用的标记旁边更好读，而且 `<style>` 在 bundle 解析前就生效
- **产物入库**，与 `dist/` 同一个理由：全局 git 安装没有 devDependencies。CI 门禁从只盯 `dist/` 扩到同时盯 `public/panel.js`；`prepare` 多跑一个 `scripts/check-panel-build.mjs`，只在 bundle 缺失时失败
- **agent 的 markdown 换成 `marked` + `DOMPurify`。** `marked` 会把源码里的原始 HTML 原样透传（完整 markdown 因此可用），`DOMPurify` 按严格 allowlist 过滤——`style` 属性、`iframe`、`svg`、`javascript:` / `data:` URL 全部挡掉。取代那版手写的「先整体转义再排版」：它也安全，但允许列表要自己维护，遇到没实现的特性还会静默退化成纯文本
- 用了 Ant Design 6 的 `ConfigProvider` / `Button` / `Tag` / `Tooltip` / `Empty` / `Skeleton` / `Progress`，主题 token 从现有 CSS 变量推导，不引入第二套视觉。**时间线、成果卡、抽屉、run 列表保持手写**——它们承载文档和截图里的那套设计，且整个断言套件是照它们的 DOM 写的
- 迁移中修掉的问题：服务端原本只路由 `/` 和 `/api/*`，`panel.js` 会 404；`env(safe-area-inset-*)` 因 viewport meta 缺 `viewport-fit=cover` 而恒为 0；深链进来时侧栏不刷新（老代码靠 `open()` 的副作用顺带做掉）

### 侧栏按项目分组

- `report_start` 的 `tags` 一直标着「用于在面板里分组」，面板此前只把它当头部一行文本显示。现在按 `tags[0]` → `agent` → `未分组` 分桶
- **一个 run 只进一个组**，其余 tag 作为胶囊挂在条目上。复制进每个 tag 所在的组会让侧栏谎报 run 数量
- 组序按组内最近活动的那条排，不看组名；**当前打开的 run 所在组钉住不可折叠**

### 局域网

- **`REPORT_MCP_HOST=0.0.0.0` 即局域网可访问**，且**所有可点地址自动算出来打出来**——不用再 `ipconfig` 找 IP：

  ```
  [report-mcp] panel    http://192.168.1.57:7788/#/run/run_2026...  (host)
  [report-mcp] lan      http://127.0.0.1:7788/#/run/run_2026...
  ```

  枚举本机非回环网卡，私网地址优先（192.168 → 10.x → 172.16-31），其次其他 IPv4，最后是不带 scope id 的全局 IPv6；link-local 被丢弃，因为粘出来的链接必然打不开

- **多个 agent 报出来的链接始终一致。** 宿主的地址列表走 `/api/health` 的 `urls` 字段发布，attach 的进程接管它（每个探测周期重读），配置更窄的后来者不会把 `127.0.0.1` 发给用户。采纳前过滤：只收 `http(s)` 且端口与刚探测到的那个一致
- **端口仲裁不受影响**：探测恒走 `127.0.0.1`，只有对外发布的地址会变
- `panel.json` 多写一个 `urls` 字段（`url` 保持原义不变）

### 手机

- **窄屏重排，不是把桌面版缩小。** run 列表变成左上角 ☰ 唤出的抽屉（点遮罩 / `Esc` / 选中 run 都收起），顶部窄条承载「当前 run 标题 + 状态 chip」，筛选按钮横向滚动而非换行堆三排，按钮加高到 ~38px，高度改用 `100dvh` 并避开 `env(safe-area-inset-*)`，另加 `overscroll-behavior: none` 与 `-webkit-text-size-adjust: 100%`
- **抽屉状态走 `#app.nav-open` class，JS 不判断视口宽度**——样式表只在窄屏 media query 里认它，桌面端是死的；顺带避开了 jsdom 没有的 `matchMedia`，抽屉逻辑因此可测
- **「复制链接」加 `execCommand` 兜底**：`navigator.clipboard` 只在安全上下文可用，局域网上的 `http://192.168.x.x` 恰恰不是，不兜底的话这个按钮在手机上永远失败

### 远端面板（Cloudflare Worker 镜像）

- **新增 `worker/`：一个可选的远端面板镜像。** agent 攒批把记录推到 Worker，在那儿能看到同一份时间线。**它是镜像不是替代品**——本地 JSONL 仍是唯一真相，本地面板不受影响，推送全程不阻塞任何 tool 调用
- **`summarize()` 抽到 `src/summarize.ts`，两个运行时共用。** 本机（读 JSONL）和 Worker（读 KV）跑同一份实现，避免出现「同一个 run 两边状态不一样」。`store.ts` 仍然 re-export，现有引用不变
- **面板零改动。** 面板靠问 `/api/runs` 要 JSON 来决定 live/static；Worker 在同源提供这个接口，panel/src 完全不知道它的存在。Worker 自己 serve `index.html` + `panel.js`（`scripts/build-worker-assets.mjs` 烘进去），**不用 static-assets binding**——Miniflare 4 在资源未命中时自己 404 且不调用 Worker，那样 `/api/*` 和带 token 的壳在测试里全部够不着，等于只测了没部署的那份
- **鉴权是强制的。** 这是全项目唯一暴露在公网的端点。写入走 header 里的 bearer，读取走浏览器 cookie；`/?token=…` 种下 HttpOnly cookie 后立刻 302，把 token 从地址栏、history 和 Referer 里摘掉。比较是定长逐字符的
- **KV 存原始记录，不存 summary。** 读取时重算，所以迟到的、乱序到达的推送不会留下过期状态；按 record id 去重，重试不会重复时间线。超出 2000 条/run 会丢最旧的并标记 `truncated`，不静默
- **制品默认不上传。** `REPORT_MCP_REMOTE_FILES=1` 才上传 `image` / `markdown` / `html` 三种类型（单个 2 MiB），走可选的 R2；`svg` 仍然不传。这是披露决定，所以默认关着
- 队列有上限，溢出丢最旧的并计数；退出时 flush，所以短会话最后几条不丢。推送失败只记进 stderr 和一个计数
- 已知短板写进文档：`/api/stream` 是定时快照不是真扇出（要 Durable Object），KV 最终一致，R2 未配时制品退化成普通链接

### 部署

- 新增 `Dockerfile`（多阶段）与 `docker-compose.yml`。MCP 客户端的 `command` 指向 `docker run -i`，`REPORT_MCP_HOME` 挂 volume，宿主侧 `ports` 暴露面板

### 测试

- **`test/verify-pages.mjs` 的本地那半进了 `npm test`（36 项）。** 它此前**只能在部署后运行**；面板从内联脚本改成 bundle 之后它仍在断言已不存在于 HTML 里的标记（`html.includes("modeChip")`），而没人能在不部署的情况下执行它，那条断言就烂在仓库里。现在按 Pages 的方式本地服务 `public/`（未知路径 404，让面板走静态分支），断言壳与 `panel.js` 一起发布、深链、demo 渲染、资产相对路径。文档站那半仍需网络，`PAGES_URL` / `DOCS_URL` 显式给出时才跑
- 修掉那条腐烂断言的同时，把脚本里三处「固定 sleep + 同步读 DOM」换成等状态——React 批处理下它们本来也过不了
- 新增 `test/lan.mjs`（19 项）：宽绑定、地址真的可达、health 发布、窄配置 attach 后接管地址、默认绑定仍只有回环、异端口/异协议地址被丢弃
- `test/render.mjs` 增加 24 项：抽屉的四条开关路径、窄条与头部同步、分组的分桶/排序/折叠、media query 里的关键声明、bundle 里的安全属性（不再 `allow-same-origin`、markdown 净化器在位）
- `render.mjs` / `live.mjs` / `e2e.mjs` 补 `resources: "usable"`：面板成了外部 bundle，不加这个 jsdom 不会去取它，DOM 会是空的
- **`freePort()` 提到 `test/harness.mjs`**，`single.mjs` 与 `lan.mjs` 共用
- **新增 `test/remote.mjs`（50 项）**，用 miniflare 起**真的 workerd**（带 KV 和 R2 binding），拿真的 mirror 打真的 HTTP：鉴权四道门、round trip、summary 由记录重算、重试幂等、乱序到达、垃圾输入被过滤、`(run, seq, i)` 穿越被拒、SSE 帧格式、制品默认不上传而 opt-in 后可读、死掉的 mirror 不影响 tool call、队列有界、半配置不启用。最后一段 spawn 真的 server 进程走 stdio 调 tool，靠正常 shutdown flush 验证全链路，并断言本地 JSONL 一条没少
- 断言总数 258 → 362，套件 7 → 9


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
