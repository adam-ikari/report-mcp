# 面板与 Demo

面板是单文件 `public/index.html`：无构建、无 CDN、无外部字体，打开即用。

::: tip 在线 Demo
<https://adam-ikari.github.io/report-mcp/panel/>

**注意那是示例数据**——真正的实时面板跑在你本机，见[安装与接入](./install.md)。左上角有紫色 `DEMO` 角标就说明当前是静态演示。
:::

## 布局

| 区域 | 内容 |
|---|---|
| 左栏 | run 列表，按**最后活动时间**排序（不是文件 mtime），带状态 chip、相对时间、进度条、错误角标 |
| 右栏头部 | 标题、状态 chip、agent / 开始时间 / 耗时 / 记录数 / warn-error 数 / 结果数 / tags / 最后错误 / 失败原因，加一条进度条（不确定态用滑动动画） |
| 时间线 | 按 kind 着色；`result` 渲染成果卡片；`detail` / `data` 进 `<details>` 折叠 |
| 筛选 | 全部 / 进度 / 日志 / 结果 / 状态 |

所有 agent 提交的文本都经过 HTML 转义后再插入 DOM。

## 实时是怎么做到的

- **SSE** 推增量记录，客户端本地重算 summary，所以头部立即更新
- 另有 **15s 全量兜底**轮询
- SSE 断线时 `EventSource` **自动重连**
- `fs.watch` 不可靠的文件系统靠 **5s sweep** 兜底

::: details 侧栏比头部晚 600ms 是正常的
SSE 的 `runs` 事件同时触发 `loadRun()`（详情，立刻读）和 `reloadRuns()`（侧栏，`setTimeout` 600ms 防抖）。防抖是必要的：agent 连报五条进度就会打五次 `/api/runs` 全量重读。

代价是**两栏在时间上不同步**——头部已经 `blocked`、侧栏还显示 `running` 是正常现象，不是 bug。
:::

## 双模式：同一个文件既能连后端，也能当静态站

启动时先探 `/api/runs`（要求 200 + `application/json`）：

| 探测结果 | 模式 | 行为 |
|---|---|---|
| 有后端 | **live** | 走 REST + SSE，实时，`homePath` 显示存储路径 |
| 没后端 | **static** | 加载同目录 `demo-data.js`，纯内存渲染；挂 `DEMO` 角标 |

static 模式**不发任何 `/api` 请求、不开 EventSource、不跑轮询**——三者都有测试断言盯着。

demo bundle 只带原始 `records`，`RunSummary` 依然由页面里同一个 `derive()` 算，所以 live 和 static 不可能算出两套状态。`demo-data.js` 由 `scripts/build-demo.mjs` 生成（零依赖），生成物不入库，部署前现做一份，顺带保证里面的相对时间永远新鲜。

`loadDemo()` 带 2s 超时兜底：脚本标签卡住不会把整个面板吊死在启动阶段。

## HTTP API

只读。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/` | 面板 HTML |
| `GET` | `/api/health` | `{ok, runId, home}` |
| `GET` | `/api/runs?limit=100` | `RunSummary[]`，按最后活动倒序 |
| `GET` | `/api/runs/:id` | `{summary, records[]}` 全量 |
| `GET` | `/api/stream?run=:id` | SSE：`record`（全量预载 + 增量）、`runs`（列表变更） |

绑定 `127.0.0.1`，默认端口 `0`（自动分配空闲端口；配置的端口被占则自动降级到随机端口）。

::: warning 没有鉴权
面板无鉴权、无 TLS，绑定 `127.0.0.1` 意味着只服务本机。`detail` / `data` 会原样展示 agent 提交的任意负载——**不要把它通过公网隧道暴露出去**。目前唯一的公网形态是上面那个静态 demo，它不含任何真实数据。
:::

## 自己看数据

```bash
tail -f ~/.report-mcp/runs/*.jsonl
```

append-only，每行一条记录，任何程序都能直接读。
