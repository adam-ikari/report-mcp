import { JSDOM } from "jsdom";

const ORIGIN = process.env.TEST_PANEL_URL || "http://127.0.0.1:7788";
const html = await (await fetch(ORIGIN + "/")).text();

const results = [];
const check = (name, cond, extra) => {
  results.push(!!cond);
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

const dom = new JSDOM(html, {
  url: ORIGIN + "/#/run/run_20260924051200_aa11bb",
  runScripts: "dangerously",
  pretendToBeVisual: true,
  beforeParse(window) {
    // jsdom has neither fetch nor EventSource; the panel degrades to REST polling.
    window.fetch = (u, o) => fetch(new URL(String(u), ORIGIN), o);
    window.addEventListener("error", (e) => console.log("PAGE ERROR:", e.error?.stack || e.message));
  },
});

const { window } = dom;
const $ = (id) => window.document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await sleep(1200);

console.log("\n--- sidebar ---");
const items = [...window.document.querySelectorAll(".run-item")];
check("3 runs listed", items.length === 3, "got " + items.length);
check("run list ordered by last activity", items[0]?.textContent.includes("回归测试批次 #482"),
  items.map((i) => i.querySelector(".t")?.textContent).join(" | "));
check("stale failed run is last", items[items.length - 1]?.textContent.includes("同步 CRM"));
check("completed run shows progress bar", !!items.find((i) => i.textContent.includes("MCP 报告协议调研"))?.querySelector(".bar i"));
check("failed run shows err marker", !!items.find((i) => i.textContent.includes("同步 CRM"))?.querySelector(".chip.error"));

console.log("\n--- header ---");
check("hash route opened the run", !$("detail").classList.contains("hidden") && $("empty").classList.contains("hidden"));
check("title rendered", $("rTitle").textContent === "MCP 报告协议调研与综述", $("rTitle").textContent);
check("status chip = done", $("rStatus").textContent === "done" && $("rStatus").className.includes("done"), $("rStatus").className);
const meta = $("rMeta").textContent;
check("meta has agent", meta.includes("research-agent"), meta);
check("meta has duration", /耗时/.test(meta), meta.slice(0, 160));
check("meta surfaces last error", meta.includes("springer 链接解析失败"), meta.slice(-120));
check("progress bar at 100%", $("rProgress").querySelector("i").style.width === "100%", $("rProgress").querySelector("i").style.width);
check("progress label = 100%", $("rProgressLabel").textContent === "100%", $("rProgressLabel").textContent);

console.log("\n--- timeline ---");
const entries = [...window.document.querySelectorAll(".entry")];
check("all 13 records rendered", entries.length === 13, "got " + entries.length);
const tl = $("timeline").innerHTML;
check("start entry", tl.includes('class="kind start"') && tl.includes("research-agent"));
check("progress entry w/ bar", tl.includes('class="kind progress"') && tl.includes("mini-progress"));
check("status blocked chip", tl.includes("blocked"));
check("log level badges", tl.includes('class="lv warn"') && tl.includes('class="lv error"'));
check("detail <details> collapsible", $("timeline").querySelectorAll("details").length >= 5,
  "details=" + $("timeline").querySelectorAll("details").length);
check("result card rendered", !!$("timeline").querySelector(".result-card"));
const card = $("timeline").querySelector(".result-card");
check("metrics grid (4)", card.querySelectorAll(".metric").length === 4, "got " + card.querySelectorAll(".metric").length);
check("metric value+unit", card.querySelector(".metric .v").textContent.includes("5"), card.querySelector(".metric .v").textContent);
check("artifact links", card.querySelectorAll("ul.art li").length === 2, "got " + card.querySelectorAll("ul.art li").length);
check("external link", !!card.querySelector('.links a[href="https://example.com/notes"]'));
check("structured data in <details>", card.querySelectorAll("details").length >= 1);
check("end entry w/ duration", tl.includes("耗时 2m 42s"), /耗时[^<]*/.exec(tl)?.[0]);
check("all text is escaped (no raw <script>)", !$("timeline").innerHTML.includes("<script"));
check("no unescaped user angle brackets", !$("timeline").textContent.includes("[object"));

console.log("\n--- filtering ---");
const filterBtn = (label) => [...window.document.querySelectorAll("#filters button")].find((b) => b.textContent === label);
filterBtn("结果").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("result filter → 1 entry", window.document.querySelectorAll(".entry").length === 1,
  "got " + window.document.querySelectorAll(".entry").length);
filterBtn("进度").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("progress filter → 5 entries", window.document.querySelectorAll(".entry").length === 5,
  "got " + window.document.querySelectorAll(".entry").length);
filterBtn("全部").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("back to all → 13", window.document.querySelectorAll(".entry").length === 13,
  "got " + window.document.querySelectorAll(".entry").length);

console.log("\n--- switching runs ---");
const failedItem = items.find((i) => i.textContent.includes("同步 CRM"));
failedItem.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(800);
check("switched to failed run", $("rTitle").textContent === "同步 CRM 联系人", $("rTitle").textContent);
check("failed chip", $("rStatus").textContent === "failed", $("rStatus").className);
check("hash updated", window.location.hash.includes("run_20260923220100_ee33ff"), window.location.hash);
check("failed run timeline = 4", window.document.querySelectorAll(".entry").length === 4,
  "got " + window.document.querySelectorAll(".entry").length);
const m2 = $("rMeta").textContent;
check("failed run surfaces OAuth error as lastError", m2.includes("OAuth token 已过期"), m2.slice(-200));
check("failed run surfaces end summary as failure reason", m2.includes("API 凭据过期，需人工重新授权后重跑"), m2.slice(-200));

console.log("\n--- no-run empty state ---");
const dom2 = new JSDOM(html, {
  url: ORIGIN + "/",
  runScripts: "dangerously",
  pretendToBeVisual: true,
  beforeParse(w) {
    w.fetch = (u, o) => Promise.reject(new Error("offline"));
    w.addEventListener("error", () => {});
  },
});
// No backend and no demo bundle: boot only settles once loadDemo() times out.
await new Promise((r) => setTimeout(r, 3200));
const empty = dom2.window.document.getElementById("empty");
const list = dom2.window.document.getElementById("runList");
check("offline degrades to empty state, no crash", !empty.classList.contains("hidden"));
check("sidebar shows fallback message", list.textContent.includes("暂无运行记录"), list.textContent.trim().slice(0, 40));
check("empty state shows config hint", empty.textContent.includes("mcpServers"));

dom.window.close();
dom2.window.close();

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
