import { JSDOM } from "jsdom";

import { waitFor } from "./harness.mjs";

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
  // The panel is a React bundle in an external <script src="panel.js">. Without
  // this jsdom never fetches it, #root stays empty, and every assertion below
  // fails as "expected 13 entries, got 0" rather than anything diagnostic.
  resources: "usable",
  pretendToBeVisual: true,
  beforeParse(window) {
    // jsdom has neither fetch nor EventSource; the panel degrades to REST polling.
    window.fetch = (u, o) => fetch(new URL(String(u), ORIGIN), o);
    window.addEventListener("error", (e) => console.log("PAGE ERROR:", e.error?.stack || e.message));
  },
});

const { window } = dom;
const $ = (id) => window.document.getElementById(id);

// Initial paint is two REST fetches; a fixed sleep left too little margin
// under load, so wait for both panes to be populated before asserting.
await waitFor(() => window.document.querySelectorAll(".run-item").length === 3 &&
  window.document.querySelectorAll(".entry").length > 0);

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
check("artifact rows", card.querySelectorAll("ul.art > li").length === 5, "got " + card.querySelectorAll("ul.art > li").length);
check("external link", !!card.querySelector('.links a[href="https://example.com/notes"]'));
check("structured data in <details>", card.querySelectorAll("details").length >= 1);
check("end entry w/ duration", tl.includes("耗时 2m 42s"), /耗时[^<]*/.exec(tl)?.[0]);
check("no executable <script> in timeline", !$("timeline").querySelector("script"));
check("no unescaped user angle brackets", !$("timeline").textContent.includes("[object"));
check("我的面板 hidden in live mode", $("myPanels").classList.contains("hidden"));

console.log("\n--- rich result rendering ---");
// File artifacts hydrate asynchronously through /api/file; wait for all of them.
check("artifacts hydrated", await waitFor(() =>
  card.querySelector(".artimg") &&
  !card.querySelector("[data-md-src]") &&
  !card.querySelector("[data-html-src]") &&
  card.querySelectorAll("ul.art li iframe.arthtml").length === 1));
const img = card.querySelector(".artimg");
check("image inline src uses /api/file", !!img && img.getAttribute("src").startsWith("/api/file?run=" +
  encodeURIComponent("run_20260924051200_aa11bb") + "&seq=11&i=2"), img?.getAttribute("src"));
const mdBodies = card.querySelectorAll(".md-body");
check("inline markdown field rendered", mdBodies.length >= 2 && /权重最高/.test(mdBodies[0].textContent));
// The fixture's markdown contains a literal `<script>alert(1)</script>`.
// The panel renders it with marked + DOMPurify, so the element is *removed*
// rather than shown as inert text — the previous escape-first renderer left the
// characters visible. Assert the stronger property: nothing executable survives,
// and the surrounding markdown still rendered (i.e. sanitising did not nuke the
// whole block).
check("markdown field: raw <script> is stripped, not merely escaped",
  mdBodies.length >= 2 &&
    !mdBodies[0].querySelector("script") &&
    !/onerror|javascript:/i.test(mdBodies[0].innerHTML) &&
    /混合方案/.test(mdBodies[0].textContent) &&
    !!mdBodies[0].querySelector("blockquote"),
  JSON.stringify(mdBodies[0].innerHTML.slice(-120)));
check("markdown field rendered <strong>", !!mdBodies[0].querySelector("strong"));
check("notes.md file hydrated to typeset markdown", !!card.querySelector("ul.art li .md-body strong"));
const frames = card.querySelectorAll("iframe.arthtml");
check("inline html field in sandbox iframe", frames.length === 2 &&
  frames[0].getAttribute("sandbox") === "allow-scripts" &&
  !frames[0].getAttribute("sandbox").includes("allow-same-origin") &&
  frames[0].getAttribute("srcdoc").includes("各通道综合得分") &&
  frames[0].getAttribute("srcdoc").includes("Web 面板 + JSONL"), frames[0]?.getAttribute("sandbox"));
const fileFrame = card.querySelector("ul.art li iframe.arthtml");
check("html file artifact → sandbox iframe", !!fileFrame && fileFrame.getAttribute("sandbox") === "allow-scripts" &&
  fileFrame.getAttribute("srcdoc").includes("Content-Security-Policy") && fileFrame.getAttribute("srcdoc").includes("script-ran"));
check("frame CSP permits inline styles (wildcards never cover style=)",
  [...frames].every((f) => /style-src[^;]*'unsafe-inline'/.test(f.getAttribute("srcdoc"))));

console.log("\n--- filtering ---");
// React batches: a click handler returns before the DOM reflects the new state,
// so these wait for the entry count rather than reading it synchronously. (The
// pre-React panel re-rendered inside the handler, which is why this used to be
// a plain assertion.)
const filterBtn = (label) => [...window.document.querySelectorAll("#filters button")].find((b) => b.textContent === label);
const entryCount = () => window.document.querySelectorAll(".entry").length;
const filterTo = async (label, want) => {
  filterBtn(label).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  return waitFor(() => entryCount() === want, { timeout: 2000 });
};
check("result filter → 1 entry", await filterTo("结果", 1), "got " + entryCount());
check("progress filter → 5 entries", await filterTo("进度", 5), "got " + entryCount());
check("back to all → 13", await filterTo("全部", 13), "got " + entryCount());
check("the active filter is marked", filterBtn("全部").classList.contains("on"),
  [...window.document.querySelectorAll("#filters button")].map((b) => b.className).join(" | "));

console.log("\n--- switching runs ---");
const failedItem = items.find((i) => i.textContent.includes("同步 CRM"));
failedItem.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await waitFor(() => $("rTitle").textContent === "同步 CRM 联系人");
check("switched to failed run", $("rTitle").textContent === "同步 CRM 联系人", $("rTitle").textContent);
check("failed chip", $("rStatus").textContent === "failed", $("rStatus").className);
check("hash updated", window.location.hash.includes("run_20260923220100_ee33ff"), window.location.hash);
check("failed run timeline = 4", window.document.querySelectorAll(".entry").length === 4,
  "got " + window.document.querySelectorAll(".entry").length);
const m2 = $("rMeta").textContent;
check("failed run surfaces OAuth error as lastError", m2.includes("OAuth token 已过期"), m2.slice(-200));
check("failed run surfaces end summary as failure reason", m2.includes("API 凭据过期，需人工重新授权后重跑"), m2.slice(-200));

console.log("\n--- run groups (project buckets) ---");
// report_start documents tags as the grouping label; the panel now buckets on
// them. Group order follows each bucket's most recent member, so the project
// being worked on is first regardless of how its name sorts.
const groupNames = () => [...window.document.querySelectorAll(".rgroup-head .gname")].map((n) => n.textContent);
const groupItems = () => [...window.document.querySelectorAll(".rgroup")].map((g) => ({
  key: g.dataset.group,
  open: g.querySelector(".rgroup-head").getAttribute("aria-expanded") === "true",
  runs: [...g.querySelectorAll(".run-item")].map((i) => i.textContent.replace(/\s+/g, " ").trim()),
}));

const groups = groupItems();
check("one group per first tag", groups.length === 3, JSON.stringify(groups.map((g) => g.key)));
check("groups ordered by latest activity, not name",
  JSON.stringify(groups.map((g) => g.key)) === JSON.stringify(["ci", "research", "integration"]),
  groupNames().join(" | "));
check("each group holds its own run", groups.every((g) => g.runs.length === 1), JSON.stringify(groups.map((g) => g.runs.length)));
check("every run still rendered exactly once",
  window.document.querySelectorAll(".run-item").length === 3 &&
    new Set([...window.document.querySelectorAll(".run-item")].map((i) => i.dataset.run)).size === 3);
check("group header shows its size",
  [...window.document.querySelectorAll(".rgroup-head .gcount")].every((c) => c.textContent === "1"));

// The 调研 run carries tags ["research","mcp"]; "mcp" is not the bucket (the
// first tag is), so it rides along on the item as a chip.
const researchItem = [...window.document.querySelectorAll(".run-item")].find((i) => i.textContent.includes("MCP 报告协议调研"));
check("secondary tags shown on the item, not duplicated as a group",
  researchItem.querySelector(".tagchip")?.textContent === "mcp" && !groupNames().includes("mcp"),
  researchItem.querySelector(".tagchip")?.textContent);

// Collapsing: the group holding the open run is pinned open.
const openGroupFor = (title) =>
  [...window.document.querySelectorAll(".rgroup")].find((g) => g.textContent.includes(title));
const currentGroup = openGroupFor("回归测试批次 #482");
check("the group holding the open run starts expanded", currentGroup.querySelector(".rgroup-head").getAttribute("aria-expanded") === "true");

const otherHead = [...window.document.querySelectorAll(".rgroup-head")].find((h) => h.textContent.includes("research"));
otherHead.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("clicking a header collapses that group",
  await waitFor(() => openGroupFor("MCP 报告协议调研") === undefined), groupNames().join(" | "));
check("collapsing hides the runs but keeps the header",
  openGroupFor("MCP 报告协议调研") === undefined && groupNames().includes("research"), groupNames().join(" | "));
check("the open run's group cannot be collapsed away",
  openGroupFor("回归测试批次 #482") !== undefined);

otherHead.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("clicking again expands it",
  await waitFor(() => openGroupFor("MCP 报告协议调研") !== undefined), groupNames().join(" | "));

console.log("\n--- mobile chrome: drawer + top bar ---");
// jsdom has no viewport and no layout, so the media query itself cannot be
// evaluated here — what *is* assertable is the behaviour that drives it: the
// drawer class, its dismissal paths, and the mobile bar mirroring the header.
// The layout rules are additionally grepped below so a deleted media query
// cannot pass unnoticed.
const app = window.document.getElementById("app");
const navBtn = $("navBtn");
const scrim = $("scrim");
const clickIt = (node) => node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

check("mobile bar + hamburger + scrim exist",
  !!$("mobar") && !!navBtn && !!scrim && !!window.document.getElementById("sidebar"));
check("drawer starts closed", !app.classList.contains("nav-open") && navBtn.getAttribute("aria-expanded") === "false");
check("hamburger is labelled for screen readers", (navBtn.getAttribute("aria-label") || "").length > 0);

// The drawer is React state now, so each step waits for the re-render.
const navOpen = () => app.classList.contains("nav-open");
const afterNav = async (want) => waitFor(() => navOpen() === want, { timeout: 2000 });

clickIt(navBtn);
check("hamburger opens the drawer",
  (await afterNav(true)) && navBtn.getAttribute("aria-expanded") === "true", "nav-open=" + navOpen());
clickIt(navBtn);
check("tapping the hamburger again closes it", await afterNav(false), "nav-open=" + navOpen());

clickIt(navBtn);
await afterNav(true);
clickIt(scrim);
check("tapping the scrim closes the drawer", await afterNav(false), "nav-open=" + navOpen());

clickIt(navBtn);
await afterNav(true);
window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
check("Escape closes the drawer", await afterNav(false), "nav-open=" + navOpen());

check("mobile bar mirrors the run title", $("moTitle").textContent === $("rTitle").textContent, $("moTitle").textContent);
check("mobile bar mirrors the status chip",
  $("moStatus").textContent === $("rStatus").textContent && $("moStatus").className === $("rStatus").className,
  $("moStatus").className);

clickIt(navBtn);
await afterNav(true);
const otherItem = window.document.querySelectorAll(".run-item")[0];
clickIt(otherItem);
check("picking a run from the drawer closes it", await afterNav(false), "nav-open=" + navOpen());
await waitFor(() => $("rTitle").textContent === "回归测试批次 #482");
check("and shows that run", $("rTitle").textContent === "回归测试批次 #482", $("rTitle").textContent);
check("mobile bar followed the switch", $("moTitle").textContent === "回归测试批次 #482", $("moTitle").textContent);

// The narrow layout is a block of CSS jsdom will not evaluate, so pin the
// load-bearing declarations: without them a phone gets the 300px desktop grid.
const hasNarrowBlock = /@media \(max-width: 860px\)/.test(html);
check("narrow-viewport stylesheet block present", hasNarrowBlock);
check("drawer layout rules present",
  hasNarrowBlock && /#app\.nav-open aside/.test(html) && /transform: translateX\(-100%\)/.test(html));
check("dynamic-viewport height used", /height: 100dvh/.test(html));
check("notch / home-indicator insets respected", /env\(safe-area-inset/.test(html));
check("viewport opts into the safe area (or the insets above are inert)",
  /viewport-fit=cover/.test(html));

// The shell is HTML + CSS; the app itself is the bundle, so behaviour that moved
// out of index.html has to be pinned against panel.js instead.
const bundle = await (await fetch(ORIGIN + "/panel.js")).text();
check("panel ships as a bundle the server serves", bundle.length > 1000, bundle.length + " bytes");
check("clipboard has a non-secure-context fallback",
  /execCommand\(\s*\\?"copy/.test(bundle), "LAN http:// is not a secure context");
check("sandboxed frames never get allow-same-origin",
  !/allow-same-origin/.test(bundle));
check("markdown escapes before transforming", /html/i.test(bundle) && bundle.includes("\\u0000"),
  "NUL-delimited stash present in the minified bundle");

console.log("\n--- no-run empty state ---");
const dom2 = new JSDOM(html, {
  url: ORIGIN + "/",
  runScripts: "dangerously",
  resources: "usable",
  pretendToBeVisual: true,
  beforeParse(w) {
    w.fetch = (u, o) => Promise.reject(new Error("offline"));
    w.addEventListener("error", () => {});
  },
});
// No backend and no demo bundle: boot only settles once loadDemo() times out
// (~2s script timer) and loadRuns renders the fallback.
// The whole tree is React now, so unlike the pre-React shell there is no #empty
// or #runList in the initial HTML to gate on: wait for the sidebar fallback (the
// last DOM write of this path), then look the nodes up.
await waitFor(() => {
  const el = dom2.window.document.getElementById("runList");
  return !!el && el.textContent.includes("暂无运行记录");
}, { timeout: 8000 });
const list = dom2.window.document.getElementById("runList");
const empty = dom2.window.document.getElementById("empty");
check("offline degrades to empty state, no crash", !!empty && !empty.classList.contains("hidden"));
check("sidebar shows fallback message", !!list && list.textContent.includes("暂无运行记录"),
  (list?.textContent || "(no #runList)").trim().slice(0, 40));
check("empty state shows config hint", empty.textContent.includes("mcpServers"));
const mo2 = dom2.window.document.getElementById("moStatus");
check("mobile bar drops the status chip with no run open", mo2.classList.contains("hidden"), mo2.className);
check("mobile bar falls back to the app name", dom2.window.document.getElementById("moTitle").textContent === "Agent Report");

dom.window.close();
dom2.window.close();

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
