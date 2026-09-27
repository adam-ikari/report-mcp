#!/usr/bin/env node
/**
 * End-to-end: the loop the other suites each cover one half of.
 *
 *   smoke.mjs   a client can call the tools over stdio and read the HTTP API
 *   render.mjs  the panel renders records
 *   live.mjs    the panel reacts to appends — but live.mjs performs the append
 *               itself, hand-writing id/runId/seq/ts, which sidesteps the tool
 *               handlers and RunWriter entirely
 *
 * Nothing therefore checked that a *tool call* becomes something a *human sees*.
 * Every assertion here comes from a real MCP tool call crossing a real process
 * boundary to a real HTTP panel rendered in jsdom. The test never writes a run
 * file; if the writer emitted a malformed envelope, only this suite would fail.
 *
 * Three phases:
 *   1. one agent, one run, full lifecycle start → end, asserted after each call
 *   2. two server processes sharing one run: seq stays gap-free and the panel
 *      sees the other process's records live (the REPORT_MCP_RUN_ID path)
 *   3. SIGKILL both writers mid-run, restart: history intact, seq resumes, run
 *      closes, and a fresh panel still renders it
 *
 * Timing note: the detail view refreshes on the SSE `runs` event immediately,
 * while the sidebar reloads through `reloadRuns()`, which debounces by 600ms
 * (public/index.html). Assertions therefore wait for the state they check
 * instead of assuming both panes move together.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

import { connectMcp, createEventSourceShim, createFetcher, sleep, waitFor } from "./harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.join(here, ".tmp-e2e");
const RUN1 = "run_e2e_lifecycle_0001";
const RUN2 = "run_e2e_multiwriter_0002";

fs.rmSync(HOME, { recursive: true, force: true }); // self-contained: no leftovers from prior runs

const envFor = (runId) => ({
  ...process.env,
  REPORT_MCP_HOME: HOME,
  REPORT_MCP_PORT: "0",
  REPORT_MCP_RUN_ID: runId,
});

const results = [];
const check = (name, cond, extra) => {
  results.push(!!cond);
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra != null ? "  " + extra : ""}`);
};

const readRecords = (runId) =>
  fs
    .readFileSync(path.join(HOME, "runs", `${runId}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

/** Wrap a jsdom instance in the accessors every assertion needs. */
function panelOf(dom) {
  const w = dom.window;
  const el = (id) => w.document.getElementById(id);
  const item = (n) => w.document.querySelectorAll(".run-item")[n];
  return {
    dom,
    window: w,
    $: el,
    // Never-throwing readers for the `extra` argument: a missing node should
    // surface as a FAIL with a readable value, not abort the rest of the phase.
    txt: (id) => el(id)?.textContent ?? `(missing #${id})`,
    bar: (id) => el(id)?.querySelector("i")?.style?.width ?? "(missing bar)",
    entries: () => w.document.querySelectorAll(".entry").length,
    items: () => [...w.document.querySelectorAll(".run-item")],
    itemText: (n) => (item(n)?.textContent ?? "(no item)").replace(/\s+/g, " ").trim(),
    sidebarChip: (n) => item(n)?.querySelector(".chip")?.textContent ?? "(no chip)",
    sidebarBar: (n) => item(n)?.querySelector(".bar i")?.style?.width ?? "(no bar)",
    sidebarErr: (n) => Boolean(item(n)?.querySelector(".chip.error")),
    click: (node) => node.dispatchEvent(new w.MouseEvent("click", { bubbles: true })),
  };
}

/** Open the panel exactly as a human would: at the viewUrl a tool handed us. */
async function openPanel(viewUrl) {
  // viewUrl is `<origin>/#/run/<id>`; strip the fragment AND any trailing slash
  // before re-adding one, or `origin + "/"` becomes a double slash.
  const origin = viewUrl.split("#")[0].replace(/\/+$/, "");
  const html = await (await fetch(origin + "/")).text();
  const nodeFetch = createFetcher(origin);
  const dom = new JSDOM(html, {
    url: viewUrl,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = nodeFetch;
      window.EventSource = createEventSourceShim(nodeFetch);
      window.addEventListener("error", (e) => console.log("PAGE ERROR:", e.error?.stack || e.message));
    },
  });
  return panelOf(dom);
}

const clients = [];
const doms = [];
async function connect(env) {
  const c = await connectMcp(env);
  clients.push(c);
  return c;
}
async function open(viewUrl) {
  const p = await openPanel(viewUrl);
  doms.push(p.dom);
  return p;
}

const TITLE1 = "E2E：agent → 人类";
const TITLE2 = "E2E：双写者共享一个 run";

try {
  /* ---------------- phase 1: one agent, full lifecycle ---------------- */
  console.log("--- phase 1: agent → human, one run ---");
  const A = await connect(envFor(RUN1));
  check("server announces panel + run on stderr",
    A.panelUrl.startsWith("http://127.0.0.1:") && A.runId === RUN1,
    `panel=${A.panelUrl} run=${A.runId}`);

  const start = await A.call("report_start", {
    title: TITLE1,
    agent: "e2e-agent",
    task: "验证 tool 调用能一路出现在面板上",
    tags: ["e2e", "lifecycle"],
    metadata: { phase: 1 },
  });
  check("report_start ok, own run", start.ok && start.runId === RUN1, JSON.stringify(start));
  check("viewUrl points at this panel + run",
    start.viewUrl === `${A.panelUrl}/#/run/${RUN1}`, start.viewUrl);

  // The human follows the link the agent reported.
  const P = await open(start.viewUrl);
  check("panel shows the run title",
    await waitFor(() => P.$("rTitle")?.textContent === TITLE1), P.txt("rTitle"));
  check("sidebar lists exactly this run", await waitFor(() => P.items().length === 1),
    "items=" + P.items().length);
  check("status starts running", P.$("rStatus")?.textContent === "running", P.txt("rStatus"));
  check("one timeline entry (start)", await waitFor(() => P.entries() === 1), "entries=" + P.entries());
  check("sidebar shows the run", P.itemText(0).includes("E2E"), P.itemText(0));

  await A.call("report_progress", { phase: "采集", percent: 20, step: 1, totalSteps: 3, message: "读取输入" });
  check("progress bar moved to 20%", await waitFor(() => P.bar("rProgress") === "20%"), P.bar("rProgress"));
  check("progress label = 20%", await waitFor(() => P.txt("rProgressLabel") === "20%"), P.txt("rProgressLabel"));
  check("sidebar bar tracks progress", await waitFor(() => P.sidebarBar(0) === "20%"), P.sidebarBar(0));
  check("phase visible in timeline", await waitFor(() => P.$("timeline")?.textContent.includes("采集")));

  await A.call("report_status", { status: "blocked", message: "需要人类确认范围" });
  check("status chip = blocked",
    await waitFor(() => P.$("rStatus")?.textContent === "blocked"), P.txt("rStatus"));
  check("chip class matches status", P.$("rStatus")?.className === "chip blocked", P.$("rStatus")?.className);
  check("blocked message shown in timeline",
    await waitFor(() => P.$("timeline")?.textContent.includes("需要人类确认范围")));
  check("sidebar chip = blocked", await waitFor(() => P.sidebarChip(0) === "blocked"), P.sidebarChip(0));

  await A.call("report_log", { level: "error", message: "来源 X 解析失败", detail: { code: 500 } });
  check("header surfaces lastError",
    await waitFor(() => P.txt("rMeta").includes("来源 X 解析失败")), P.txt("rMeta").slice(-120));
  check("sidebar shows err badge", await waitFor(() => P.sidebarErr(0)), P.itemText(0));
  check("log entry in timeline",
    await waitFor(() => P.$("timeline")?.textContent.includes("来源 X 解析失败")));

  await A.call("report_progress", { phase: "分析", percent: 60, step: 2, totalSteps: 3 });
  check("bar advanced to 60%", await waitFor(() => P.txt("rProgressLabel") === "60%"), P.txt("rProgressLabel"));
  check("progress did not clobber the blocked status",
    P.$("rStatus")?.textContent === "blocked", P.txt("rStatus"));

  await A.call("report_status", { status: "running", message: "已确认范围" });
  check("unblocked", await waitFor(() => P.$("rStatus")?.textContent === "running"), P.txt("rStatus"));

  await A.call("report_result", {
    title: "对比矩阵",
    summary: "五个方案横向对比完成。",
    metrics: [{ name: "行数", value: 1284, unit: "条" }, { name: "维度", value: 9, unit: "项" }],
    artifacts: [{ name: "matrix.csv", path: "/tmp/matrix.csv", type: "csv" }],
    links: [{ label: "看板", url: "https://example.com/board" }],
    data: { ok: true },
  });
  check("result card rendered",
    await waitFor(() => Boolean(P.dom.window.document.querySelector(".result-card"))));
  const card = P.dom.window.document.querySelector(".result-card");
  check("metrics rendered", card.querySelectorAll(".metric").length === 2,
    "got " + card.querySelectorAll(".metric").length);
  check("artifact rendered", card.querySelectorAll("ul.art li").length === 1,
    "got " + card.querySelectorAll("ul.art li").length);
  check("result counted in header", await waitFor(() => P.txt("rMeta").includes("结果")), P.txt("rMeta"));

  const end = await A.call("report_end", { status: "done", summary: "全部完成，遗留项见结果卡。" });
  check("report_end computes duration", typeof end.durationMs === "number", "durationMs=" + end.durationMs);
  check("status chip = done", await waitFor(() => P.$("rStatus")?.textContent === "done"), P.txt("rStatus"));
  check("duration shown", await waitFor(() => P.txt("rMeta").includes("耗时")), P.txt("rMeta"));
  check("end summary in timeline",
    await waitFor(() => P.$("timeline")?.textContent.includes("全部完成")));
  check("sidebar flips to done", await waitFor(() => P.sidebarChip(0) === "done"), P.sidebarChip(0));

  const panelInfo = await A.call("report_panel");
  check("report_panel count matches the DOM",
    panelInfo.recordCount === P.entries(), `api=${panelInfo.recordCount} dom=${P.entries()}`);
  check("report_panel status matches the DOM", panelInfo.status === "done", panelInfo.status);

  // The envelope is what live.mjs bypasses by hand-writing records: assert the
  // writer's own contract here, with the tool path as the only writer.
  const r1 = readRecords(RUN1);
  check("8 records on disk", r1.length === 8, "len=" + r1.length);
  check("seq is exactly 1..8", r1.map((r) => r.seq).join(",") === "1,2,3,4,5,6,7,8",
    r1.map((r) => r.seq).join(","));
  check("kind order matches the calls",
    r1.map((r) => r.kind).join(",") === "start,progress,status,log,progress,status,result,end",
    r1.map((r) => r.kind).join(","));
  check("runId uniform across the file", r1.every((r) => r.runId === RUN1));
  check("ids unique (no collisions)", new Set(r1.map((r) => r.id)).size === r1.length);
  check("timestamps are ISO and parseable", r1.every((r) => !Number.isNaN(Date.parse(r.ts))));

  /* ---------------- phase 2: two processes, one run ---------------- */
  console.log("\n--- phase 2: two writers sharing REPORT_MCP_RUN_ID ---");
  const B1 = await connect(envFor(RUN2));
  const B2 = await connect(envFor(RUN2));
  check("both servers joined the same run", B1.runId === RUN2 && B2.runId === RUN2,
    `${B1.runId} / ${B2.runId}`);
  check("each server has its own panel port", B1.panelUrl !== B2.panelUrl,
    `${B1.panelUrl} vs ${B2.panelUrl}`);

  const s2 = await B1.call("report_start", { title: TITLE2, agent: "writer-A" });
  const Q = await open(s2.viewUrl); // human watching writer-A's panel
  check("panel for run 2 opened",
    await waitFor(() => Q.$("rTitle")?.textContent === TITLE2), Q.txt("rTitle"));

  // Interleaved across two processes. Each holds its own in-memory seq, so
  // without the pre-append size check every one of these would be seq 2.
  const seqs = [];
  seqs.push((await B1.call("report_progress", { phase: "A", percent: 30, step: 1, totalSteps: 3 })).seq);
  seqs.push((await B2.call("report_log", { message: "B 写了一条" })).seq);
  seqs.push((await B1.call("report_log", { message: "A 写了一条" })).seq);
  seqs.push((await B2.call("report_progress", { phase: "B", percent: 70, step: 2, totalSteps: 3 })).seq);
  seqs.push((await B2.call("report_status", { status: "waiting", message: "B 在等外部资源" })).seq);
  seqs.push((await B1.call("report_progress", { phase: "A", percent: 90, step: 3, totalSteps: 3 })).seq);
  check("interleaved seqs are contiguous", seqs.join(",") === "2,3,4,5,6,7", seqs.join(","));
  check("no seq assigned twice", new Set(seqs).size === seqs.length, seqs.join(","));

  const r2 = readRecords(RUN2);
  check("one file holds all 7 records", r2.length === 7, "len=" + r2.length);
  check("file seq is exactly 1..7", r2.map((r) => r.seq).join(",") === "1,2,3,4,5,6,7",
    r2.map((r) => r.seq).join(","));
  check("record ids never collide", new Set(r2.map((r) => r.id)).size === r2.length);

  // The panel was opened before those writes and must catch them live — this is
  // the human-visible half: a process they are not watching writes, and they see it.
  check("panel absorbed the other process's records live",
    await waitFor(() => Q.entries() === 7, { timeout: 6000 }), "entries=" + Q.entries());
  check("last writer's progress drives the bar",
    await waitFor(() => Q.txt("rProgressLabel") === "90%"), Q.txt("rProgressLabel"));
  check("cross-process status surfaced", await waitFor(() => Q.txt("rStatus") === "waiting"), Q.txt("rStatus"));
  check("other process's log in timeline",
    await waitFor(() => Q.$("timeline")?.textContent.includes("B 写了一条")));

  /* ---------------- phase 3: crash both, restart, recover ---------------- */
  console.log("\n--- phase 3: SIGKILL mid-run, restart, resume ---");
  B1.close();
  B2.close();
  await sleep(300); // let the SIGKILLs land before the restart

  const B3 = await connect(envFor(RUN2));
  check("restarted server rejoins the same run", B3.runId === RUN2, B3.runId);

  const after = await B3.call("report_panel");
  check("history survives the crash", after.recordCount === 7, "count=" + after.recordCount);
  check("status preserved across restart", after.status === "waiting", after.status);

  // init() recounts lines, so the first post-restart append must continue the
  // sequence rather than restart it or duplicate the last number.
  const resumed = await B3.call("report_log", { message: "重启后继续" });
  check("seq resumes past the crash", resumed.seq === 8, "seq=" + resumed.seq);

  const end2 = await B3.call("report_end", { status: "done", summary: "崩溃后重启并收尾。" });
  check("run closes after restart", end2.ok && end2.runId === RUN2, JSON.stringify({ seq: end2.seq }));

  const R = await open(end2.viewUrl); // a fresh panel, post-restart
  check("fresh panel renders the full run",
    await waitFor(() => R.entries() === 9), "entries=" + R.entries());
  check("chip = done in fresh panel", await waitFor(() => R.$("rStatus")?.textContent === "done"),
    R.txt("rStatus"));
  check("pre-crash records still visible",
    await waitFor(() => R.$("timeline")?.textContent.includes("B 写了一条")
      && R.$("timeline")?.textContent.includes("A 写了一条")));
  check("post-restart record visible",
    await waitFor(() => R.$("timeline")?.textContent.includes("重启后继续")));

  /* ---------------- phase 4: both runs in one sidebar ---------------- */
  console.log("\n--- phase 4: sidebar across processes ---");
  const items = R.items();
  check("both runs listed", items.length === 2, "items=" + items.length);
  check("most recently active run first", items[0]?.textContent.includes("双写者"),
    items.map((i) => i.querySelector(".t")?.textContent).join(" | "));
  check("both runs marked done",
    items.every((i) => i.querySelector(".chip")?.textContent === "done"),
    items.map((i) => i.querySelector(".chip")?.textContent).join(" | "));

  R.click(items[1]);
  check("switching to the other run loads it",
    await waitFor(() => R.$("rTitle")?.textContent === TITLE1), R.txt("rTitle"));
  check("switched run keeps its own record count",
    await waitFor(() => R.entries() === 8), "entries=" + R.entries());
  check("hash follows the switch", R.window.location.hash.includes(RUN1), R.window.location.hash);
} catch (err) {
  check("no exception", false, String(err && err.stack ? err.stack : err));
} finally {
  for (const c of clients) c.close();
  for (const d of doms) {
    try {
      d.window.close();
    } catch {
      /* already closed */
    }
  }
}

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
