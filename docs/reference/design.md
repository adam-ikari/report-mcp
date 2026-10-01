# 设计决策与局限

这里记录的是**取舍**，不是功能列表——每条都能回答「为什么不选另一条路」。

## 关键设计决策

**为什么是单向的。** 不需要阻塞审批。单向让整条链路没有分布式状态：没有挂起的请求、没有超时、没有人类不在场时 agent 卡死。代价是 agent 拿不到人类的回复——那属于对话通道的职责，不该塞进汇报通道。

**为什么 JSONL 而不是 SQLite。** append-only、崩溃安全、`tail -f` 就能看、别的程序一行代码就能读。`seq` 在每次 append 前用「文件大小是否等于我上次写完的大小」检测外部写入，不一致就重读行数重同步，所以多个进程共用 `REPORT_MCP_RUN_ID` 时 seq 仍然单调。这条路径由 `test/e2e.mjs` 覆盖：两个真实 server 进程交错写同一个 run，断言 seq 无重号无断档。

**stdout 纪律。** stdio transport 下 stdout 只能有 JSON-RPC，所以所有日志走 stderr。测试里有一条断言专门检查这一点。

**按文件 watch，而不是按目录 watch。** 这是实测踩出来的坑：Linux 上 `fs.watch(目录)` 只报告增删改名条目，**不会**报告目录内已有文件的内容变化。最初用目录 watch，实时性其实是靠 5s 兜底扫描在撑，测试里表现为「记录延迟到下一个扫描周期才出现」。改成 `fs.watch(单个 run 文件)`（引用计数，首个订阅者开启、最后一个离开时关闭）之后，700ms 断言窗口内稳定通过。

**`send()` 不能把背压当断线。** `res.write()` 返回 `false` 只表示内核缓冲区满，不表示连接死了。早期代码把它当错误返回，会在第一次背压时停止推流。同理 ping 里也不能用返回值判定客户端存活。

**侧栏排序用最后活动时间而非 mtime。** 文件被复制/恢复后 mtime 会变，语义上「最新」应该指「最后一条记录的时间」。

**详情立刻刷新，侧栏晚 600ms。** SSE 的 `runs` 事件同时触发 `loadRun()`（详情，直接读）和 `reloadRuns()`（侧栏，`setTimeout` 600ms 防抖）。防抖是必要的：agent 连报五条进度就会打五次 `/api/runs` 全量重读，而 `/api/runs` 要读所有 run 文件再重新汇总。代价是**两栏在时间上不同步**——头部已经 `blocked`、侧栏还显示 `running` 是正常现象，不是 bug。

**派生状态不在两边各存一份。** `RunSummary` 不落盘，服务端 `summarize()` 和面板 `derive()` 各自从记录重算，逻辑保持一致。所以 live 和 static 不可能算出两套状态——demo 站只带原始 `records` 就是这个原因。

**XSS 防线交给一个库，而不是几十行正则。** 早先面板自带的 markdown 排版器走「先整体转义、再对惰性文本做块级/行内变换」，这条路是安全的，代价有两处：允许列表得自己维护；没实现的 markdown 特性会静默退化成纯文本。现在换成 `marked` 渲染 + `DOMPurify` 白名单过滤。`marked` 会原样透传源码里的 HTML（完整 GFM 因此可用），DOMPurify 是第二道，也是面板里唯一一处给 agent HTML 设防的地方。迁移时那两条断言从「script 标签以文本形式可见」改成「script 元素不可能存在」——后者是更强的性质。

**面板产物入库，和 `dist/` 同一个理由。** 全局 git 安装不装 devDependencies，装不了 React 也装不了 esbuild，所以 `public/panel.js` 必须跟着包走，CI 的漂移门禁同时盯 `dist/` 与它。`prepare` 钩子只检查 bundle 在，不重建——它没有重建的能力。

**用组件库不等于交出视觉。** Ant Design 6 提供 `ConfigProvider` / `Button` / `Tag` / `Tooltip` / `Empty` / `Skeleton` / `Progress`，主题 token 从现有 CSS 变量推导，不引入第二套外观。时间线、成果卡、抽屉和 run 列表仍然手写：它们承载文档和截图里的那套设计，且整个断言套件是照它们的 DOM 写的。抽屉尤其不该换成组件库的 Drawer——它 portal 到 `body`，会毁掉「窄屏 media query 里认 `.nav-open`」这条已经测住的规则。

**面板产物入库，和 `dist/` 同一个理由。** 全局 git 安装不装 devDependencies，装不了 React 也装不了 esbuild，所以 `public/panel.js` 必须跟着包走，CI 的漂移门禁同时盯 `dist/` 与它。`prepare` 钩子只检查 bundle 在，不重建——它没有重建的能力。

**远端镜像是只写、可丢的一条边。** 有了 Worker，「推送记录」这个动作必须被当成网络操作看待：它在本地 append 成功之后排队，不在任何 tool 的返回路径上，超时和失败都吞掉，队列有上限（溢出丢最旧的并计数，而不是把 agent 的堆撑大），退出时 flush 一次让短会话不丢尾巴。这些约束不是保守，是为了让「镜像挂了」和「agent 慢了一点」这两件事在体验上彻底分开。

**Worker 自己 serve 面板，不用 static-assets binding。** Miniflare 4 在资源未命中时自己回 404 且不调用 Worker，所以用 binding 的 Worker 在测试里 `/api/*` 全部够不着——只测了一份没部署的配置。把 `index.html` 和 `panel.js` 烘进 Worker（`scripts/build-worker-assets.mjs`）换来一条代码路径，`test/remote.mjs` 跑的就是线上那份。代价是前端改动要重新部署 Worker 才在远端生效，而本地面板不受影响。

**远端面板的鉴权是强制的，不是建议。** 本地面板无鉴权是因为它只绑回环；Worker 有公网 URL，同样的默认在那里等于把 run 详情公开。写入走 header、读取走 HttpOnly cookie，`/?token=…` 立刻 302 把 token 从地址栏摘掉。

**发布门禁不挂在别人的 CDN 上。** `test/verify-pages.mjs` 的文档站那半要访问线上站点，因此 opt-in；它的本地那半进了 `npm test`。把发布门禁绑在第三方可用性上，等于给自己装了一个会随机变红的闸机。

## 局限

- **并发 append 无锁。** `seq` 重同步靠「append 前比对文件大小」，这是 check-then-act 而非原子操作：两个进程**真正同时**落到同一个窗口仍可能撞号。`test/e2e.mjs` 覆盖的是**交错**写入——agent 逐条 await tool 调用，即实际使用节奏——证明这种情况无重号无断档；真并发不在保证范围内。一次 MCP 连接对应一个 run，`REPORT_MCP_RUN_ID` 共享时建议低频写入。
- **数据流与 DOM 结构在 jsdom 里测住，布局在真浏览器里测住，两者不重叠。** 其余套件跑在 jsdom 上，而 jsdom 不求值 `@media`——视口多窄，`getComputedStyle` 给的都是桌面级联，窄屏规则在那一层根本求值不到。布局因此交给 `test/mobile.mjs`：headless Chromium + DevTools 协议，把面板塞进 `iframe`（`iframe` 内的 media query 跟着 frame 的盒子走），在 320×640 / 390×800 / 430×800 / 740×360 / 768×1024 上断言真实布局。无 Chromium 时干净跳过。
  - 这套断言抓出的问题里有一个共同的教训：**手工看截图会漏掉「元素压根没渲染」**。`.mp-del`（唯一会删东西的按钮）只有 29×16px，但 demo 数据里没有书签，按钮不存在，于是每一道检查都量不到它。所以 `mobile.mjs` 在 boot 前先写 `localStorage` 造出书签，并且断言真实 run 产生的那条最长 meta 行，而不是拿一个退化状态凑合。
  - React 迁移后 jsdom 那一侧还多了一层依赖：`resources: "usable"` 不加，jsdom 不会去取 `panel.js`，所有断言会以「expected 13 entries, got 0」的形式失败，看不出真因。
- **iOS Safari 实机未验证。** Chromium 的布局结论不能直接搬过去，`env(safe-area-inset-*)`、`-webkit-overflow-scrolling`、`100dvh` 在地址栏收起时的实际表现都需要真机确认。
- **agent markdown 的 XSS 防线是别人的库。** DOMPurify 的 allowlist 由我们配置、由它执行，配置本身就是攻击面。`marked` 透传原始 HTML 这件事不会变，所以第二道工序不能省。
- **共享面板跟着 agent 会话生灭。** 面板由第一个抢到 `7788` 的 report-mcp 进程托管，没有独立的常驻 `serve` 命令：所有宿主会话都退出后面板就没了（数据仍在磁盘，`tail -f` 可看）。宿主退出时 attach 中的进程有 **~5s 接管窗口**，期间链接短暂不可达。
- **`7788` 被无关程序占用时共享退化。** 健康探测（`/api/health` + 同 `home` 校验）不通过，各进程退回随机端口开私有面板——可用，但「一块屏」没了。自定义 `REPORT_MCP_PORT` 同理：只有共用同一个端口的进程之间才谈共享。
- **默认只服务本机，开局域网也没有鉴权。** 默认绑 `127.0.0.1`；`REPORT_MCP_HOST=0.0.0.0` 可以开到局域网，地址自动枚举并打出来，但没有鉴权也没有 TLS——**同网段任何设备都能读全部 run 详情**。收紧靠 `REPORT_MCP_FILE_ROOTS` 加防火墙，不是靠面板本身。跨公网请用 SSH 端口转发，或者用可选的 Worker 镜像（那里 token 是强制的）。
- **远端镜像的推送会丢记录，而且这是有意的取舍。** 队列有上限，镜像长时间不可用时最旧的记录会被丢掉并计数（stderr 退出时可见）。选「丢远端」而不是「拖慢 agent」或「把堆撑爆」。KV 单 run 2000 条上限同理。
- **Worker 上的 `/api/stream` 不是真扇出。** 每条连接各自按 3s 轮询存储，多个观众就是多份上游读取。KV 也是最终一致的。真要多人同时盯一个 run，得上 Durable Object。
- **Worker 只在部署那一刻的面板版本上正确。** 面板被烘进 bundle，前端改动要重新部署 Worker 才在远端生效。本地面板照旧即时更新。
- **远端镜像是单 token 的。** 没有按 run 授权、没有多用户、没有审计。一台机器一个 token 就到头了；多人共用会把彼此的 `detail` / `data` 都看光。
- **没有人类 → agent 的回话通道**（by design，见上）。
- **没有外部通知。** 人不在面板前时不会被打扰。
- **超大 run 会一次性全量加载**，没有虚拟滚动（上万条记录会卡）。

## 后续方向

优先级建议：

1. **外部通知**：`report_status` 落到 `blocked`/`error` 时发 Webhook —— 纯增量，不动现有模型
2. **通知渠道配置化**（邮件 / IM），走同一个 `endpoints` 数组
3. **run 归档与保留策略**（按天数或条数滚动）
4. **虚拟滚动 + 分页读取**，撑住超长 run
5. 真要做双向，另开一个 `ask_*` tool 家族，别污染汇报通道
