# 更新日志

版本号遵循 SemVer。安装与升级方式见[安装与接入](/guide/install.html)，渠道始终是 Git：

```bash
npm install -g --install-links=true git+https://github.com/adam-ikari/report-mcp.git
```

## Unreleased

面板渲染修复（截图时暴露出来的两个真 bug）：

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
