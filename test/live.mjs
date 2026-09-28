import fs from "node:fs";
import path from "node:path";

import { createEventSourceShim, createFetcher, waitFor } from "./harness.mjs";
import { FIXTURES_DIR } from "./fixtures.mjs";

const { JSDOM, VirtualConsole } = await import("jsdom");
const vc = new VirtualConsole();
if (typeof vc.forwardTo === "function") vc.forwardTo(console);
else vc.on("jsdomError", (e) => console.log("JSDOM ERROR:", e.stack || e));

const ORIGIN = process.env.TEST_PANEL_URL || "http://127.0.0.1:7788";
const RUN = "run_20260924060500_cc22dd";
const HOME = process.env.REPORT_MCP_HOME || "/tmp/opencode/report-home";
const FILE = `${HOME}/runs/${RUN}.jsonl`;

const results = [];
const check = (name, cond, extra) => {
  results.push(!!cond);
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

const html = await (await fetch(ORIGIN + "/")).text();
const nodeFetch = createFetcher(ORIGIN);

const dom = new JSDOM(html, {
  url: `${ORIGIN}/#/run/${RUN}`,
  runScripts: "dangerously",
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    window.fetch = nodeFetch;
    // jsdom ships no EventSource; bridge SSE over fetch. The transcript hooks
    // keep the suite's original output so a failure shows what actually arrived.
    window.EventSource = createEventSourceShim(nodeFetch, {
      onEvent: (type, data) => console.log(`  [sse] ${type} ${data.slice(0, 90)}`),
      onListenerError: (e) => console.log("  [sse] LISTENER THREW:", e && e.stack ? e.stack : e),
      onError: (e) => console.log("  [sse] STREAM ERROR:", e && e.message ? e.message : e),
      onClose: () => console.log("  [sse] CLOSED by client"),
    });
    window.addEventListener("error", (e) => console.log("PAGE ERROR:", e.error?.stack || e.message));
  },
});

const { window } = dom;
const $ = (id) => window.document.getElementById(id);
const entries = () => window.document.querySelectorAll(".entry").length;

// The panel updates through SSE plus a 600ms debounced sidebar reload, so a
// fixed sleep only clears the debounce by ~100ms and fails under load. Wait
// for the state each assertion checks instead (same contract as e2e.mjs).
check("initial render via REST", await waitFor(() => entries() === 6), "entries=" + entries());
check("initial phase", $("rMeta").textContent.includes("等待 runner") || $("rProgressLabel").textContent === "等待 runner 空闲",
  `label=${$("rProgressLabel").textContent}`);
check("running chip while open", $("rStatus").textContent === "waiting", $("rStatus").className);

// --- simulate the agent appending a progress record ---
const base = JSON.parse(fs.readFileSync(FILE, "utf8").trim().split("\n").pop());
const mk = (seq, kind, body) =>
  JSON.stringify({ ...body, id: `live-${seq}`, runId: RUN, seq, ts: new Date().toISOString(), kind });

let next = base.seq + 1;
const append = (rec) => fs.appendFileSync(FILE, rec + "\n");

append(mk(next++, "progress", { phase: "运行 e2e", percent: 75, step: 3, totalSteps: 4, message: "已跑 128/170 例" }));

check("SSE appended progress entry", await waitFor(() => entries() === 7), "entries=" + entries());
check("header phase updated live", $("rTitle").textContent === "回归测试批次 #482", $("rTitle").textContent);
check("progress bar moved to 75%", await waitFor(() => $("rProgress").querySelector("i").style.width === "75%"), $("rProgress").querySelector("i").style.width);
check("progress label 75%", $("rProgressLabel").textContent === "75%", $("rProgressLabel").textContent);
check("status still waiting", $("rStatus").textContent === "waiting", $("rStatus").textContent);
check("timeline shows new phase", $("timeline").textContent.includes("运行 e2e"));
check("record count grew in meta", $("rMeta").textContent.includes("记录 7"), $("rMeta").textContent.slice(0, 120));

// --- agent logs an error live ---
append(mk(next++, "log", { level: "error", message: "case_092_flaky 失败", detail: { retries: 3 } }));
check("error log appears", await waitFor(() => $("timeline").textContent.includes("case_092_flaky 失败")), "entries=" + entries());
check("lastError surfaces in header", $("rMeta").textContent.includes("case_092_flaky 失败"), $("rMeta").textContent.slice(-140));
const currentItem = () =>
  [...window.document.querySelectorAll(".run-item")].find((i) => i.textContent.includes("回归测试批次"));
check("sidebar shows err badge for this run",
  await waitFor(() => !!currentItem()?.querySelector(".chip.error")),
  currentItem()?.textContent.replace(/\s+/g, " ").trim().slice(0, 90));

// --- agent reports a rich result live ---
append(mk(next++, "result", {
  title: "对比图已生成",
  summary: "得分分布见附图。",
  markdown: "- **混合方案**胜出",
  artifacts: [{ name: "chart", path: path.join(FIXTURES_DIR, "chart.png"), type: "image" }],
}));
check("result entry appears live", await waitFor(() => entries() === 9), "entries=" + entries());
const artImg = $("timeline").querySelector(".artimg");
check("image artifact inlined in live render", !!artImg &&
  String(artImg.getAttribute("src")).startsWith("/api/file?"), artImg?.getAttribute("src"));
check("markdown field typeset live", !!$("timeline").querySelector(".result-card .md-body strong"),
  $("timeline").querySelector(".result-card .md-body")?.textContent.trim().slice(0, 40));
if (artImg) {
  const pngRes = await fetch(ORIGIN + artImg.getAttribute("src"));
  const pngBytes = new Uint8Array(await pngRes.arrayBuffer());
  check("live-served image is the PNG", pngRes.status === 200 && pngBytes[0] === 0x89 && pngBytes[3] === 0x47,
    "bytes=" + pngBytes.length);
} else {
  check("live-served image is the PNG", false, "no .artimg");
}

// --- agent finishes the run live ---
append(mk(next++, "end", { status: "done", summary: "e2e 全绿。", durationMs: 204000 }));
check("end flips status chip",
  await waitFor(() => $("rStatus").textContent === "done" && $("rStatus").className.includes("chip done")),
  $("rStatus").className);
check("end entry rendered", $("timeline").textContent.includes("e2e 全绿"), "entries=" + entries());
check("duration shown", await waitFor(() => $("rMeta").textContent.includes("3m 24s")), $("rMeta").textContent.slice(0, 140));
check("final count 10", $("rMeta").textContent.includes("记录 10"), $("rMeta").textContent.slice(0, 140));
check("sidebar status updated", await waitFor(() => window.document.querySelectorAll(".run-item .chip.done").length >= 1));

console.log("\nfinal: entries=" + entries() + " meta=" + $("rMeta").textContent);

// --- filter still works against live-appended records ---
[...window.document.querySelectorAll("#filters button")].find((b) => b.textContent === "日志")
  .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("log filter sees live log", window.document.querySelectorAll(".entry").length === 2,
  "entries=" + window.document.querySelectorAll(".entry").length);

dom.window.close();
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
