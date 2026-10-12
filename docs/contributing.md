# 开发、测试与发布

## 本地开发

```bash
npm install           # prepare 跑 scripts/check-vendor.mjs，只检查 vendor，不重建
npm run build         # tsc → dist/
npm test              # 构建 + 八套测试
npm run typecheck     # tsc --noEmit
npm run serve         # 起宿主，看 dist/ 跑起来是什么样
node dist/index.js start --port 7789   # 同一个宿主，放后台（stop / status 配套）
npm run samples       # examples/*.md → docs/public/reports/
```

日志一律走 **stderr**——stdio transport 下 stdout 只能有 MCP JSON-RPC，`test/milestone.mjs`
有一条断言专门盯这个。

## 依赖面

运行时依赖只有 `@modelcontextprotocol/sdk` 和 `zod`；devDependencies 只有 `typescript`
和 `@types/node`。渲染器不是依赖，是 `vendor/am/am.mjs` 里那份上游生成物。

前端没有构建步骤：v0.4 删掉了 React 面板，索引页是 `src/host.ts` 里服务端渲染的模板字符串。
**不要把它接回任何需要打包的东西**——一个 `no-js` 的静态列表是选择，不是欠账。

## vendor 怎么升版

```bash
node scripts/update-am.mjs --from <path|url> 0.6.0
node scripts/check-vendor.mjs     # sha256 + 版本 + 文件头那句 "do not edit"
npm test                          # am-smoke.mjs 盯的是 CLI 契约
node scripts/render-samples.mjs   # 示例页必须还能从草稿生成出来
```

`vendor/am/am.mjs` 是**生成物，永远不要编辑**。`test/am-smoke.mjs` 直接 spawn 它，
断言 flag、stdin 草稿、`-o` 目标、以及**失败输出的形状**（`✗ L12 [flow]` +
"Correct example:" + `am help flow`）——`src/render.ts` 原样转发那段话，上游改了形状
这里先红，而不是在 agent 手里才红。

## 测试矩阵

`npm test` 覆盖 **186 条断言，分八套**（`test/run.mjs` 顺序跑，`stdio: "inherit"`）：

| 套件 | 断言 | 验证什么 |
|---|---|---|
| `test/vendor.mjs` | 11 | vendor 完整性：sha256 / 版本 / 文件头 / `AM_HOME` 隔离 / 不起 update 子进程 |
| `test/am-smoke.mjs` | 20 | **渲染器 CLI 契约**：spawn 真 am，断言 argv、stdin、`-o`、页面自包含的负向断言、坏草稿的失败形状 |
| `test/render-error.mjs` | 15 | 失败路径：坏草稿 → `isError` 带行号与正确示例、草稿仍落盘、重试是新 seq、收尾页失败也照样关闭 run |
| `test/milestone.mjs` | 41 | **主 e2e**：`report_start` → `report_page` → journal 顺序 → 起 `serve` → 历史页面立刻可达 → 页面内容与响应头 → 索引页 → `report_end` 收尾页 → stdout 纯度 |
| `test/host.mjs` | 30 | 路由与安全：路径穿越、符号链接逃逸、405、无 CORS 头、`X-Frame-Options`、`/api/*` 仅回环、gzip、索引分组与时间戳格式 |
| `test/serve.mjs` | 28 | 宿主生命周期：`host.json` 写与 pid-guarded 清、bind-or-die 的三种提示、陈旧 host 记录 → `url: null`、`REPORT_MCP_PUBLIC_URL`、地址枚举顺序、`parsePageRoute` 的正反例 |
| `test/manage.mjs` | 24 | `start` / `stop` / `status`：幂等、宿主 pid 与 `serve.log`、发布中的页面真的点得开、pid 被回收时拒绝发信号、端口被占时把宿主的原文带出来 |
| `test/e2e.mjs` | 17 | **多进程共享一个 run**：两个真实 server 进程交错写（seq 无重号无断档、无撕裂行）、双写者被 SIGKILL 后重启续号、派生 summary 与索引页 |

共享测试件在 `test/harness.mjs`：MCP stdio 客户端（含 boot 行解析）、`startServe`、
`waitFor`、`freePort`、`parseJournalSafe`。断言等**状态**而不是等固定毫秒数。

草稿 fixture 在 `test/drafts.mjs`，用**行数组**拼而不是模板字符串——草稿里全是三反引号，
在模板字符串里转义是这一族文件最容易自毁的方式。

::: warning 测试里两个容易踩的地方
**一、teardown 用 SIGTERM，不要用 SIGKILL。** SIGKILL 不跑退出处理器，`host.json`
会留在磁盘上，下一套测试看到的就是一个「记录说宿主在跑、其实进程已经没了」的状态。
`test/serve.mjs` 里**故意**用 SIGKILL 的那一条是在测这个场景，别照抄。

**二、断言只盯 am 的稳定输出标记。** `class="am-panel"`、`id="am-source"`、
`<!doctype html>`、字节数、sha256。任何去断言面板具体布局的测试都是在重实现渲染器，
上游一改版就全红。同理**不要**为了测试去解析页面里的 SVG 结构。
:::

## 目录

```
src/
  index.ts      入口分派：--version / --help / serve / MCP；Node 门；bind-or-die
  server.ts     4 个 tool 的 zod schema 与 handler；publish 顺序（journal first）
  render.ts     spawn vendored am：AM_HOME 隔离、超时、输出截断、错误原文透传
  host.ts       serve 的路由、索引页模板、URL 拼接、地址枚举、响应头
  manage.ts     start/stop/status：spawn 宿主、按 host.json 的 pid 收摊、认进程再发信号
  store.ts      RunWriter(append + seq + 锁) / 页面路径 / host.json 读写 / listRuns
  summarize.ts  派生 RunSummary，索引页与 /api/runs 共用
  types.ts      四种记录的判别联合 + RunSummary
vendor/am/      渲染器（上游生成物，sha256 钉住，永不编辑）
scripts/
  check-vendor.mjs      prepare + CI：sha / 版本 / 文件头
  update-am.mjs         --from <path|url> <version>：写入、重算 sha、打印 delta
  render-samples.mjs    examples/*.md → docs/public/reports/，--check 是 CI 门禁
examples/               三份真草稿（站点「示例汇报」的源）
docs/public/reports/    渲染出的示例页，**入库**，CI 重新生成并比对
Dockerfile              两段：build（只有 tsc）→ runtime（dist + vendor），ENTRYPOINT 是 serve
docker-compose.yml      常驻宿主 + 一个共享 volume 的 MCP 客户端示例
docs/                   VitePress 文档站（独立 package.json）
test/                   八套，见上面的矩阵
.github/workflows/pages.yml   测试 + vendor 门禁 + 两道漂移门禁 → 构建站点 → 部署 Pages
```

## 两道漂移门禁

CI 的 test job 里跑，都在 `npm test` 之后：

```bash
git status --porcelain -- dist        # 有输出 = dist/ 与 src/ 不一致 → 红
node scripts/render-samples.mjs --check   # 示例页不是草稿渲染出来的 → 红
```

第二条同时是 vendor 的可用性证明：**示例页生成不出来 = 渲染器坏了**。
am 会在页脚写生成时间（精确到分钟），`--check` 比对时把那一处归一化掉，
否则 CI 会看时钟变红——除此之外页面是草稿的纯函数。

## 文档站开发

文档站在 `docs/`，用 **VitePress**，有自己独立的 `package.json`——文档工具链不该混进被发布的包。

```bash
npm --prefix docs install   # 一次
npm run docs:dev            # 先渲染示例页，再起本地开发服务器
npm run docs:build          # 先渲染示例页，再构建到 docs/.vitepress/dist
npm run docs:preview
```

`docs:dev` / `docs:build` 都会先跑 `npm run samples`，所以直接调 `vitepress build`
只是少了示例页的重新生成，不会像旧版那样产出一个缺页面的站。

## 网站发布

站点部署在 GitHub Pages：<https://adam-ikari.github.io/report-mcp/>

| 路径 | 内容 |
|---|---|
| `/report-mcp/` | VitePress 文档站（就是你现在看的） |
| `/report-mcp/reports/*.html` | 用真渲染器从 `examples/` 生成的示例汇报页 |

链路 `.github/workflows/pages.yml`：

```
push → test(npm test + check-vendor + 两道漂移门禁) → build(vitepress) → deploy
```

- **测试红了就不部署**。
- 示例页**入库**，所以 Pages 上的那三页与仓库里那份是同一个字节序列（除了页脚分钟）。
- 仓库必须是 public 才能用免费 Pages。

手动重发：仓库 → Actions → `Deploy report-mcp site to GitHub Pages` → `Run workflow`。

## 发一个版本

```bash
# 1. 版本号 + 提交（src/ 改过就要重新 build，dist/ 是入库的）
npm version <patch|minor|major> --no-git-tag-version
npm run build && npm test
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
如果 `npm config get registry` 返回镜像地址（如 `registry.npmmirror.com`），`npm publish`
必须显式加 `--registry https://registry.npmjs.org`，否则会推到镜像上。
:::

发布前手工验一次真链路：`report-mcp serve` 起宿主，一个真 agent 会话交三份草稿（其中
一份故意写错，看失败返回），然后 headless Chromium 截图看排版——

```bash
chromium-browser --headless=new --no-sandbox --disable-dev-shm-usage \
  --window-size=1440,900 --screenshot=/tmp/index.png http://127.0.0.1:7788/
chromium-browser --headless=new --no-sandbox --disable-dev-shm-usage \
  --window-size=390,844 --screenshot=/tmp/phone.png http://127.0.0.1:7788/r/<runId>/<seq>-<slug>
```

桌面 + 390px 两张，看的是索引页分组、失败草稿有没有被藏起来、以及手机上表格要不要横推
（v0.4 就是这么发现窄屏版面决定的，见[架构与决策](/reference/architecture#局限)）。最后拿真机
连同一 Wi-Fi 再确认一次：截图能证明排版，证明不了触控与字体渲染。这一段才是这个产品的
验收标准，自动化测试盯不到这一层。
