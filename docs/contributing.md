# 开发、测试与发布

## 本地开发

```bash
npm install
npm run build           # tsc → dist/，esbuild → public/panel.js，fixtures → demo bundle
npm start               # 起一个空 run（用于手动连）
npm test                # 构建 + 造数据 + 起面板 + 九个套件
npm run typecheck       # 只跑 tsc --noEmit
npm run watch:panel     # 改前端时重新打包
```

日志一律走 **stderr**——stdout 只能有 MCP JSON-RPC。

## 前端构建

`panel/src/**` → `public/panel.js`，esbuild，无配置文件、无插件、无 CSS 管线：

```bash
npm run build:panel     # 一次性
npm run watch:panel     # 监听
```

两个刻意的选择，改动前先读 `panel/build.mjs` 的注释：

- **CSS 不从 JSX import**，留在 `public/index.html` 的 `<style>` 里。窄屏那套规则是承重的，挨着它作用的标记更好读；`<style>` 在 bundle 解析前生效，也没有无样式闪烁
- **`public/panel.js` 入库**，和 `dist/` 同一个理由：全局 git 安装没有 devDependencies，装不了 React 和 esbuild。CI 的漂移门禁同时盯两者

## 测试矩阵

`npm test` 覆盖 **362 条断言，分九套**：

| 套件 | 验证什么 |
|---|---|
| `test/e2e.mjs` | **agent → 人类全链路**：真实 stdio tool 调用 → 进程边界 → 真实面板 DOM，测试全程不碰 JSONL。含两进程共享 `REPORT_MCP_RUN_ID` 交错写（seq 无重号无断档 + 侧栏实时可见）、双写者被 SIGKILL 后重启恢复（历史完好、seq 从 8 续上） |
| `test/smoke.mjs` | MCP 握手、7 个 tool 逐一调用、seq 连续、HTTP API、404、SSE 推送、**stdout 只有 JSON-RPC**；`/panel.js` 真的被服务端送到 |
| `test/render.mjs` | jsdom 里真实渲染：侧栏、分组、头部、时间线、成果卡片、筛选、切换 run、XSS 边界、离线降级；**移动端抽屉开关与窄条同步** |
| `test/live.mjs` | 带 EventSource shim：**在窗口外直接往 JSONL 追加记录，断言 DOM 及时更新**，含状态翻转与筛选 |
| `test/static.mjs` | **无后端路径**（即 Pages 环境）：探测到没有后端、挂 `DEMO` 角标、从 demo bundle 渲染、不开 SSE；以及 bundle 缺失时落到空状态 |
| `test/single.mjs` | **面板单实例**：端口竞选、同 home attach、宿主退出后接管、异物占用退回私有端口、跨 home 不共享 |
| `test/lan.mjs` | **局域网暴露**：`0.0.0.0` 绑定后地址真的可达、health 发布地址、窄配置 attach 后接管地址、默认绑定仍只有回环、异端口/异协议地址被丢弃 |
| `test/remote.mjs` | **远端镜像**：起真的 workerd（miniflare + KV + R2），跑鉴权 / 幂等 / 乱序 / SSE / 制品 / 死链，外加 spawn 真 server 进程的全链路 |
| `test/verify-pages.mjs` | **面板作为静态产物**：按 Pages 的方式服务 `public/`，断言壳与 `panel.js` 一起发布、深链、demo 渲染、资产相对路径 |

共享测试件在 `test/harness.mjs`：MCP stdio 客户端、`EventSource` shim、`waitFor`、`freePort`。断言等**状态**而不是等固定毫秒数。

`test/verify-pages.mjs` 的文档站那半要访问已发布站点，所以 opt-in：

```bash
node test/verify-pages.mjs                            # 只跑本地那半（36 项）
PAGES_URL=… DOCS_URL=… node test/verify-pages.mjs     # 部署后两半都跑
```

它以前**只能部署后跑**，而面板从内联脚本改成 bundle 之后它仍在断言已不存在于 HTML 里的标记——没人能在不部署的情况下运行它，那条断言就烂在那儿。现在本地那半进了 `npm test`。

::: warning 改前端测试时最容易踩的两件事
**一、`resources: "usable"` 不能少。** 面板是外部 bundle，jsdom 默认不去取 `panel.js`，`#root` 一直是空的。少了这个 flag，失败表现是「expected 13 entries, got 0」，看不出真因。`render.mjs` / `live.mjs` / `e2e.mjs` / `verify-pages.mjs` 都设了。

**二、点完按钮要等状态，不能同步读 DOM。** React 批处理，事件处理函数返回时 DOM 还没更新。改之前那些断言之所以是同步的，是因为老面板在处理函数里就重渲染了。
:::

::: tip 写前端测试的两条硬约束
**一、`resources: "usable"` 不能少。** 面板是外部 bundle，jsdom 默认不去取 `panel.js`，`#root` 会一直是空的。少了这个 flag，失败表现是「expected 13 entries, got 0」，而不是任何有诊断价值的信息。`render.mjs` / `live.mjs` / `e2e.mjs` 都设了。

**二、点完按钮要等状态，不能同步读 DOM。** React 批处理，事件处理函数返回时 DOM 还没更新。改之前那些断言之所以是同步的，是因为老面板在处理函数里就重渲染了。
:::

::: tip 窄屏布局为什么只能部分断言
jsdom 没有视口也不做布局，`@media` 求值不了。所以窄屏布局是**两段式**验证的：

- **可断言的部分**进 `test/render.mjs`——抽屉 class 的四条开关路径、窄条与头部标题/状态 chip 的同步、空态回落；另外 grep 住 media query 里的关键声明（`100dvh`、`#app.nav-open aside`、`env(safe-area-inset`、`viewport-fit=cover`），这样删掉整块窄屏样式会红
- **布局本身**靠人工把面板塞进 390×800 / 320×640 的 `iframe` 用 headless Chromium 看（iframe 内的 media query 跟着 frame 的盒子走），确认侧栏 `x=0`、品牌行不换行、时间线无横向溢出

要真正自动化，需要上 Playwright 之类的真浏览器，那是另一个量级的依赖。
:::

## 目录

```
src/
  index.ts    入口：起面板 → 建 MCP server → 接 stdio，处理退出清理
  server.ts   7 个 tool 的 zod schema 与 handler
  store.ts    RunWriter(append/seq 同步) + summarize(派生) + 按文件 watch + 面板状态
  panel.ts    HTTP 路由、SSE、增量 tail、兜底 sweep、单实例仲裁与接管、局域网地址枚举
  remote.ts   可选远端镜像的客户端（攒批、有界、永不阻塞 tool 调用）
  summarize.ts 派生 RunSummary，本机与 Worker 共用同一份实现
  types.ts    六种记录的判别联合 + RunSummary
panel/
  build.mjs        esbuild 驱动，无配置；--watch 支持
  src/
    main.jsx            挂载
    app.jsx             状态、副作用、连线
    components/         sidebar / chrome / detail / theme
    lib/                html · markdown(marked+DOMPurify) · rich · derive · datasource · mypanels
public/
  index.html       面板的壳：样式表 + #root + <script src=panel.js>
  panel.js         生成物，**入库**（scripts → panel/build.mjs 产出）
  demo-data.js     生成物，不入库（scripts/build-demo.mjs 产出，时间戳相对 Date.now()）
scripts/
  build-demo.mjs   从 fixtures 生成 demo bundle，零依赖
  check-panel-build.mjs  prepare 钩子：只检查 bundle 在，不重建
  stage-panel.mjs  把面板 demo 暂存进 docs/public/panel/（站点部署用）
Dockerfile          多阶段：构建（要 tsc + esbuild）→ 运行时（只有 dist/ + public/ + 运行时依赖）
docker-compose.yml MCP 客户端经 stdio 驱动容器的完整配置
docs/               VitePress 文档站（独立 package.json）
test/
  run.mjs          测试编排（起面板、依次跑七套件、清理）
  harness.mjs      共享测试件
  fixtures.mjs     三组 fixture，测试与 demo 共用同一来源
  e2e.mjs / smoke.mjs / render.mjs / live.mjs / static.mjs / single.mjs / lan.mjs
  verify-pages.mjs   部署后线上核验（手动，不进 npm test）
.github/workflows/
  pages.yml        测试门禁 → 构建站点 → 部署 Pages
```

## 文档站开发

文档站在 `docs/`，用 **VitePress**，有自己独立的 `package.json`——文档工具链不该混进被发布的 npm 包。

```bash
npm install            # 根目录依赖（MCP SDK、jsdom …）
npm --prefix docs install   # VitePress

npm run docs:dev       # 暂存面板 demo + 起本地开发服务器
npm run docs:build     # 暂存 + 构建到 docs/.vitepress/dist
npm run docs:preview   # 本地预览构建产物
```

::: warning 构建前必须先 stage
`docs:dev` / `docs:build` 会自动跑 `npm run docs:stage`，把 `public/index.html` 和 `public/demo-data.js` 复制进 `docs/public/panel/`。直接调 `vitepress build` 会得到一个**没有 /panel/ 的站点**。
:::

## 网站发布

站点与面板 demo 同部署在 GitHub Pages：<https://adam-ikari.github.io/report-mcp/>

| 路径 | 内容 |
|---|---|
| `/report-mcp/` | VitePress 文档站（就是你现在看的） |
| `/report-mcp/panel/` | 面板静态 demo（示例数据，挂 `DEMO` 角标） |

链路 `.github/workflows/pages.yml`：

```
push → test(5 套件 160 断言) → build(生成 bundle + stage + vitepress build) → deploy
```

- **测试是发布门禁**：测试红了就不部署。
- demo bundle 在 CI 里现生成，所以 `npm test` 反复跑不会把 git 弄脏。
- 仓库必须是 public 才能用免费 Pages；demo **不含**任何真实运行数据。

手动重发：仓库 → Actions → `Deploy report-mcp site to GitHub Pages` → `Run workflow`。

## 发一个版本

```bash
# 1. 版本号 + 提交
npm version <patch|minor|major> --no-git-tag-version
git commit -am "release: vX.Y.Z"

# 2. npm（需先登录官方 registry）
npm login --registry https://registry.npmjs.org
npm publish --registry https://registry.npmjs.org

# 3. git tag + GitHub Release
git tag vX.Y.Z
git push origin main --tags
gh release create vX.Y.Z --title "vX.Y.Z" --notes-file notes.md
```

::: warning 本机默认 registry 可能不是官方源
如果 `npm config get registry` 返回镜像地址（如 `registry.npmmirror.com`），`npm publish` 必须显式加 `--registry https://registry.npmjs.org`，否则会推到镜像上。
:::
