import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";

import { connectMcp } from "./harness.mjs";

const HOME = process.env.SMOKE_HOME || "/tmp/opencode/report-home-smoke";
fs.rmSync(HOME, { recursive: true, force: true }); // self-contained: no leftovers from prior runs

const client = await connectMcp({ ...process.env, REPORT_MCP_HOME: HOME, REPORT_MCP_PORT: "0" });
const { rpc, notify, text, notifications } = client;
let panelUrl = client.panelUrl;

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond, extra });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
}

try {
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0.0.0" },
  });
  check("initialize", init.serverInfo?.name === "report-mcp", JSON.stringify(init.serverInfo));
  notify("notifications/initialized", {});

  const tools = await rpc("tools/list", {});
  const names = tools.tools.map((t) => t.name).sort();
  const expected = ["report_end", "report_log", "report_panel", "report_progress", "report_result", "report_start", "report_status"].sort();
  check("tools/list", JSON.stringify(names) === JSON.stringify(expected), names.join(","));

  const start = text(await rpc("tools/call", { name: "report_start", arguments: {
    title: "冒烟测试运行", agent: "smoke-agent", task: "验证 report-mcp 全链路",
    tags: ["smoke", "e2e"], metadata: { branch: "main" },
  } }));
  check("report_start returns ok+url", start.ok && start.panelUrl && start.seq === 1, JSON.stringify(start));
  panelUrl = panelUrl || start.panelUrl;

  const p1 = text(await rpc("tools/call", { name: "report_progress", arguments: {
    phase: "收集输入", percent: 20, step: 1, totalSteps: 4, message: "正在读取源数据",
  } }));
  check("report_progress", p1.ok && p1.seq === 2, "seq=" + p1.seq);

  const p2 = text(await rpc("tools/call", { name: "report_progress", arguments: {
    phase: "分析", step: 2, totalSteps: 4, detail: { files: 3 },
  } }));
  check("report_progress indeterminate", p2.ok && p2.seq === 3, "seq=" + p2.seq);

  const lg = text(await rpc("tools/call", { name: "report_log", arguments: {
    level: "warn", message: "有一条记录被跳过", detail: { id: 42 },
  } }));
  check("report_log", lg.ok && lg.seq === 4, "seq=" + lg.seq);

  const st = text(await rpc("tools/call", { name: "report_status", arguments: {
    status: "waiting", message: "等待外部 API",
  } }));
  check("report_status", st.ok && st.seq === 5, "seq=" + st.seq);

  const res = text(await rpc("tools/call", { name: "report_result", arguments: {
    title: "分析完成", summary: "共处理 3 个文件，产出 1 份报告。",
    metrics: [{ name: "记录数", value: 1284, unit: "条" }, { name: "耗时", value: 3.2, unit: "s", hint: "p95" }],
    artifacts: [{ name: "report.md", path: "/tmp/report.md", type: "markdown" }],
    links: [{ label: "看板", url: "https://example.com/board" }],
    data: { ok: true, rows: 1284 },
  } }));
  check("report_result", res.ok && res.seq === 6, "seq=" + res.seq);

  const end = text(await rpc("tools/call", { name: "report_end", arguments: {
    status: "done", summary: "全部完成。",
  } }));
  check("report_end has duration", end.ok && typeof end.durationMs === "number", "durationMs=" + end.durationMs);

  const panel = text(await rpc("tools/call", { name: "report_panel", arguments: {} }));
  check("report_panel", panel.ok && panel.recordCount === 7 && panel.status === "done",
    "count=" + panel.recordCount + " status=" + panel.status);
  check("panelUrl consistent", panel.panelUrl === start.panelUrl, panel.panelUrl);

  // --- HTTP panel ---
  await sleep(300);
  const runs = await (await fetch(panelUrl + "/api/runs")).json();
  check("GET /api/runs", runs.length === 1 && runs[0].title === "冒烟测试运行", JSON.stringify(runs[0]));
  const s = runs[0];
  check("summary derived", s.status === "done" && s.recordCount === 7 && s.logCounts.warn === 1
    && s.resultCount === 1 && s.progress?.phase === "分析" && s.progress.percent === null
    && s.agent === "smoke-agent" && s.tags?.join(",") === "smoke,e2e",
    `status=${s.status} progress=${JSON.stringify(s.progress)}`);

  const runId = s.runId;
  const full = await (await fetch(panelUrl + "/api/runs/" + encodeURIComponent(runId))).json();
  check("GET /api/runs/:id", full.records.length === 7 && full.summary.runId === runId, "records=" + full.records.length);

  const missing = await fetch(panelUrl + "/api/runs/nope");
  check("404 for unknown run", missing.status === 404, "status=" + missing.status);

  const health = await (await fetch(panelUrl + "/api/health")).json();
  check("GET /api/health", health.ok === true && health.home === HOME, JSON.stringify(health));

  const html = await (await fetch(panelUrl + "/")).text();
  check("GET / serves panel", html.includes("Agent Report") && html.includes("report_progress"), html.length + " bytes");

  // --- SSE tail of a *new* record ---
  const ac = new AbortController();
  const seen = [];
  const streamDone = (async () => {
    const r = await fetch(panelUrl + "/api/stream?run=" + encodeURIComponent(runId), { signal: ac.signal });
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let acc = "";
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      acc += dec.decode(value, { stream: true });
      let idx;
      while ((idx = acc.indexOf("\n\n")) >= 0) {
        const block = acc.slice(0, idx);
        acc = acc.slice(idx + 2);
        const em = /^event: (.+)$/m.exec(block);
        const dm = /^data: (.+)$/m.exec(block);
        if (em && dm) seen.push({ event: em[1], data: dm[1] });
      }
      if (seen.some((x) => x.event === "record" && JSON.parse(x.data).kind === "log" && JSON.parse(x.data).message === "sse-tail")) break;
    }
    ac.abort();
  })();

  await sleep(500);
  await rpc("tools/call", { name: "report_log", arguments: { message: "sse-tail" } });
  await streamDone.catch(() => {});
  const tailed = seen.find((x) => x.event === "record" && JSON.parse(x.data).message === "sse-tail");
  check("SSE streams new records", !!tailed, `events=${seen.length}`);

  // --- stdout purity ---
  check("stdout carried only JSON-RPC", notifications.every((m) => m.startsWith("notifications/")),
    "notifications=" + notifications.join(","));
} catch (err) {
  check("no exception", false, String(err && err.stack ? err.stack : err));
} finally {
  client.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
