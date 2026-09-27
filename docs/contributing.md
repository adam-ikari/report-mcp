# 开发、测试与发布

## 本地开发

```bash
npm install
npm run build           # tsc → dist/，并生成 demo bundle
npm start               # 起一个空 run（用于手动连）
npm test                # 构建 + 造数据 + 起面板 + 五个套件
npm run typecheck       # 只跑 tsc --noEmit
```

日志一律走 **stderr**——stdout 只能有 MCP JSON-RPC。

## 测试矩阵

`npm test` 覆盖 **160 条断言，分五套**：

| 套件 | 验证什么 |
|---|---|
| `test/e2e.mjs` | **agent → 人类全链路**：真实 stdio tool 调用 → 进程边界 → 真实面板 DOM，测试全程不碰 JSONL。含两进程共享 `REPORT_MCP_RUN_ID` 交错写（seq 无重号无断档 + 侧栏实时可见）、双写者被 SIGKILL 后重启恢复（历史完好、seq 从 8 续上） |
| `test/smoke.mjs` | MCP 握手、7 个 tool 逐一调用、seq 连续、HTTP API、404、SSE 推送、**stdout 只有 JSON-RPC** |
| `test/render.mjs` | jsdom 里真实渲染：侧栏、头部、时间线、成果卡片、筛选、切换 run、XSS 转义、离线降级 |
| `test/live.mjs` | 带 EventSource shim：**在窗口外直接往 JSONL 追加记录，断言 DOM 及时更新**，含状态翻转与筛选 |
| `test/static.mjs` | **无后端路径**（即 Pages 环境）：探测到没有后端、挂 `DEMO` 角标、从 demo bundle 渲染、不开 SSE；以及 bundle 缺失时落到空状态 |

共享测试件在 `test/harness.mjs`：MCP stdio 客户端、`EventSource` shim、`waitFor`。断言等**状态**而不是等固定毫秒数。

线上核验 `node test/verify-pages.mjs` 覆盖另外 25 项（深链、成果卡片、筛选、无尾斜杠入口）。它**故意不进 `npm test`**，原因见[设计决策](./reference/design.md)。

## 目录

```
src/
  index.ts    入口：起面板 → 建 MCP server → 接 stdio，处理退出清理
  server.ts   7 个 tool 的 zod schema 与 handler
  store.ts    RunWriter(append/seq 同步) + summarize(派生) + 按文件 watch + 面板状态
  panel.ts    HTTP 路由、SSE、增量 tail、兜底 sweep
  types.ts    六种记录的判别联合 + RunSummary
public/
  index.html       面板（单文件，无依赖，live/static 双模式）
  demo-data.js     生成物，不入库（scripts/build-demo.mjs 产出）
scripts/
  build-demo.mjs   从 fixtures 生成 demo bundle，零依赖
  stage-panel.mjs  把面板 demo 暂存进 docs/public/panel/（站点部署用）
docs/               VitePress 文档站（独立 package.json）
test/
  run.mjs          测试编排（起面板、依次跑五套件、清理）
  harness.mjs      共享测试件
  fixtures.mjs     三组 fixture，测试与 demo 共用同一来源
  e2e.mjs / smoke.mjs / render.mjs / live.mjs / static.mjs
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
