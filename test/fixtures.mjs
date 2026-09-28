/**
 * Fixture runs shared by the test seeds and the static demo bundle.
 *
 * Keeping one source of truth means the GitHub Pages demo and the test
 * assertions can never drift apart.
 *
 * Timestamps are relative to `Date.now()`, so regenerate the demo bundle on
 * every deploy (the Pages workflow does this) to keep the relative times fresh.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name) => path.join(FIXTURES, name);

export const FIXTURES_DIR = FIXTURES;

function emit(runId, kind, body, seq, tsMs) {
  return { ...body, id: `id-${runId}-${seq}`, runId, seq, ts: new Date(tsMs).toISOString(), kind };
}

/** @returns {{runId: string, records: object[]}[]} */
export function buildRuns() {
  const out = [];

  /* ---- run 1: a completed research run ---- */
  const r1 = "run_20260924051200_aa11bb";
  const b1 = Date.now() - 600000;
  const t1 = (i) => b1 + i * 9000;
  let s = 0;
  out.push({
    runId: r1,
    records: [
      emit(r1, "start", { title: "MCP 报告协议调研与综述", agent: "research-agent", task: "调研现有 agent→human 汇报机制，输出对比表与选型建议", tags: ["research", "mcp"], metadata: { branch: "main", model: "mimo-v2.6" } }, ++s, t1(0)),
      emit(r1, "log", { level: "info", message: "已加载 12 篇候选文献", detail: { sources: ["arXiv", "ACM DL", "GitHub"], count: 12 } }, ++s, t1(1)),
      emit(r1, "progress", { phase: "检索文献", percent: 15, step: 1, totalSteps: 5, message: "关键词扩展中" }, ++s, t1(2)),
      emit(r1, "progress", { phase: "检索文献", percent: 35, step: 2, totalSteps: 5, message: "命中 47 条，去重后 23 条" }, ++s, t1(4)),
      emit(r1, "log", { level: "warn", message: "2 个来源返回 429，已降速重试", detail: { retryAfter: "30s", sources: ["api.x.com"] } }, ++s, t1(5)),
      emit(r1, "progress", { phase: "精读与提取", percent: 60, step: 3, totalSteps: 5, message: "逐篇抽取汇报通道设计" }, ++s, t1(7)),
      emit(r1, "status", { status: "blocked", message: "需要确认：是否包含付费数据库？", detail: { options: ["仅开放获取", "含付费库"] } }, ++s, t1(9)),
      emit(r1, "status", { status: "running", message: "已按开放获取范围继续" }, ++s, t1(11)),
      emit(r1, "log", { level: "error", message: "springer 链接解析失败，已跳过 1 篇", detail: { url: "https://link.springer.com/...", code: "ECONNRESET" } }, ++s, t1(13)),
      emit(r1, "progress", { phase: "撰写综述", percent: 85, step: 4, totalSteps: 5, message: "对比表已成稿" }, ++s, t1(15)),
      emit(r1, "result", {
        title: "agent→human 汇报机制对比",
        summary: "对比了 5 类通道：stdio 直写、结构化日志、Web 面板、通知推送与混合方案。结论是本地 Web 面板 + JSONL 落盘在可审计性和实时性之间最均衡。",
        status: "done",
        markdown:
          "### 评分口径\n\n- 可审计性**权重最高**（0.4）\n- 实时性次之\n\n> 混合方案：Web 面板 + JSONL 落盘\n\n" +
          "<script>alert(1)</script>",
        html:
          '<div style="font:14px system-ui;padding:12px;background:#f5f7fa;color:#222;border-radius:8px">' +
          "<p>各通道综合得分</p><p><strong>Web 面板 + JSONL = 8.6/10</strong></p></div>",
        metrics: [
          { name: "纳入方案", value: 5, unit: "个" },
          { name: "覆盖文献", value: 23, unit: "篇" },
          { name: "对比维度", value: 9, unit: "项" },
          { name: "综合得分", value: 8.6, unit: "/10", hint: "混合方案" },
        ],
        artifacts: [
          { name: "survey.md", path: fixture("survey.md"), type: "markdown", description: "完整综述" },
          { name: "matrix.csv", path: fixture("matrix.csv"), type: "csv", description: "对比矩阵" },
          { name: "评分分布", path: fixture("chart.png"), type: "image", description: "各方案得分热力" },
          { name: "notes.md", path: fixture("notes.md"), type: "markdown", description: "调研笔记" },
          { name: "对比看板", path: fixture("panel.html"), type: "html", description: "自定义 HTML 呈现" },
        ],
        links: [{ label: "原始笔记", url: "https://example.com/notes" }],
        data: { rows: 23, dims: 9, winner: "web-panel+jsonl" },
      }, ++s, t1(17)),
      emit(r1, "progress", { phase: "交付", percent: 100, step: 5, totalSteps: 5 }, ++s, t1(18)),
      emit(r1, "end", { status: "done", summary: "综述与对比矩阵均已交付，遗留 1 篇解析失败的文献未纳入。", durationMs: 162000 }, ++s, t1(19)),
    ],
  });

  /* ---- run 2: still running, indeterminate phase ---- */
  const r2 = "run_20260924060500_cc22dd";
  const b2 = Date.now() - 200000;
  const t2 = (i) => b2 + i * 4000;
  s = 0;
  out.push({
    runId: r2,
    records: [
      emit(r2, "start", { title: "回归测试批次 #482", agent: "ci-agent", task: "跑全量 e2e 并汇总失败用例", tags: ["ci"] }, ++s, t2(0)),
      emit(r2, "progress", { phase: "拉取依赖", percent: 100, step: 1, totalSteps: 4 }, ++s, t2(1)),
      emit(r2, "progress", { phase: "构建镜像", percent: 45, step: 2, totalSteps: 4, message: "layer cache 命中 60%" }, ++s, t2(2)),
      emit(r2, "log", { level: "debug", message: "docker buildx cache hit", detail: { hit: 0.6 } }, ++s, t2(3)),
      emit(r2, "progress", { phase: "等待 runner 空闲", step: 3, totalSteps: 4, message: "队列位置 2" }, ++s, t2(4)),
      emit(r2, "status", { status: "waiting", message: "排队等 runner" }, ++s, t2(5)),
    ],
  });

  /* ---- run 3: failed run ---- */
  const r3 = "run_20260923220100_ee33ff";
  const b3 = Date.now() - 86400000;
  const t3 = (i) => b3 + i * 3000;
  s = 0;
  out.push({
    runId: r3,
    records: [
      emit(r3, "start", { title: "同步 CRM 联系人", agent: "integration-agent", task: "双向同步 Notion ↔ CRM", tags: ["integration"] }, ++s, t3(0)),
      emit(r3, "progress", { phase: "鉴权", percent: 100, step: 1, totalSteps: 3 }, ++s, t3(1)),
      emit(r3, "log", { level: "error", message: "OAuth token 已过期，刷新失败", detail: { status: 401, hint: "需要重新授权" } }, ++s, t3(2)),
      emit(r3, "end", { status: "failed", summary: "API 凭据过期，需人工重新授权后重跑。", durationMs: 9000 }, ++s, t3(3)),
    ],
  });

  return out;
}

export const FIXTURE_RUN_IDS = {
  completed: "run_20260924051200_aa11bb",
  running: "run_20260924060500_cc22dd",
  failed: "run_20260923220100_ee33ff",
};
