/**
 * The GitHub Pages path: no backend at all.
 *
 * Serves public/ with a plain static server (unknown paths → 404, exactly like
 * Pages) and asserts the panel detects that, loads the bundled demo data and
 * renders fully — including the case where the bundle is missing entirely.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";

import { waitFor } from "./harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..", "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".css": "text/css",
};

const results = [];
const check = (name, cond, extra) => {
  results.push(!!cond);
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

function serveStatic({ withDemo }) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
      const rel = (p === "/" ? "/index.html" : p).replace(/\.\./g, "");
      if (rel === "/demo-data.js" && !withDemo) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Not Found");
        return;
      }
      const file = path.join(ROOT, rel);
      fs.readFile(file, (err, buf) => {
        if (err || !file.startsWith(ROOT)) {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("Not Found");
          return;
        }
        res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
        res.end(buf);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

function boot(origin) {
  return (async () => {
    const html = await (await fetch(origin + "/")).text();
    const vc = new VirtualConsole();
    if (typeof vc.forwardTo === "function") vc.forwardTo(console);

    const dom = new JSDOM(html, {
      url: origin + "/",
      runScripts: "dangerously",
      // Without this jsdom never fetches <script src>, so demo-data.js would
      // neither load nor 404 and the boot promise would hang until its timeout.
      resources: "usable",
      pretendToBeVisual: true,
      virtualConsole: vc,
      beforeParse(window) {
        window.fetch = (u, o) => fetch(new URL(String(u), origin), o);
        // A static build has no backend, so it must never open an SSE stream.
        window.EventSource = class {
          constructor() { throw new Error("static build must not open an EventSource"); }
        };
        window.addEventListener("error", (e) => console.log("PAGE ERROR:", e.error?.stack || e.message));
      },
    });
    return { dom };
  })();
}

/* ---------------- static site with demo bundle ---------------- */
const { server, url } = await serveStatic({ withDemo: true });
const { dom } = await boot(url);
const $ = (id) => dom.window.document.getElementById(id);
const entries = () => dom.window.document.querySelectorAll(".entry").length;
// Wait for the demo boot to actually render (bundle script + two data loads)
// instead of assuming a fixed delay.
await waitFor(() => dom.window.document.querySelectorAll(".run-item").length === 3 && entries() > 0);

console.log("--- static site (GitHub Pages) ---");
check("no backend → still renders", !$("detail").classList.contains("hidden") || !$("empty").classList.contains("hidden"));
check("DEMO chip shown", !$("modeChip").classList.contains("hidden"), $("modeChip").className);
check("storage line says demo", $("homePath").textContent.includes("演示"), $("homePath").textContent);
check("3 demo runs listed", dom.window.document.querySelectorAll(".run-item").length === 3,
  "got " + dom.window.document.querySelectorAll(".run-item").length);
check("runs ordered by last activity",
  [...dom.window.document.querySelectorAll(".run-item")].map((i) => i.querySelector(".t").textContent).join(" | ")
    === "回归测试批次 #482 | MCP 报告协议调研与综述 | 同步 CRM 联系人",
  [...dom.window.document.querySelectorAll(".run-item")].map((i) => i.querySelector(".t").textContent).join(" | "));
check("auto-opened first run with full timeline", entries() === 6, "entries=" + entries());

const completed = [...dom.window.document.querySelectorAll(".run-item")].find((i) => i.textContent.includes("MCP 报告协议调研"));
completed.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
await waitFor(() => entries() === 13);
check("switch to completed run → 13 entries", entries() === 13, "entries=" + entries());
check("result card rendered from demo data", !!dom.window.document.querySelector(".result-card"));
check("metrics grid rendered", dom.window.document.querySelectorAll(".result-card .metric").length === 4,
  "got " + dom.window.document.querySelectorAll(".result-card .metric").length);
check("header status = done", $("rStatus").textContent === "done", $("rStatus").textContent);
check("progress bar 100%", $("rProgress").querySelector("i").style.width === "100%", $("rProgress").querySelector("i").style.width);

console.log("\n--- static rich content (deployed assets) ---");
const scard = dom.window.document.querySelector(".result-card");
check("artifacts hydrated from site-relative assets", await waitFor(() =>
  scard.querySelector(".artimg") && !scard.querySelector("[data-md-src]") && !scard.querySelector("[data-html-src]")));
const simg = scard.querySelector(".artimg");
check("image uses deployed asset path, not /api/file", !!simg && simg.getAttribute("src") === "assets/chart.png",
  simg?.getAttribute("src"));
const ares = await fetch(url + "/assets/chart.png");
const abytes = new Uint8Array(await ares.arrayBuffer());
check("asset file ships with the static site", ares.status === 200 && abytes[0] === 0x89 && abytes[1] === 0x50,
  "bytes=" + abytes.length);
check("markdown field and md files typeset", scard.querySelectorAll(".md-body").length === 3 &&
  !!scard.querySelector(".md-body strong"));
check("markdown escapes raw HTML", scard.querySelectorAll(".md-body")[0].textContent.includes("<script>alert(1)</script>"));
const sframes = scard.querySelectorAll("iframe.arthtml");
check("html field + html file → sandbox iframes", sframes.length === 2 &&
  [...sframes].every((f) => f.getAttribute("sandbox") === "allow-scripts"), "frames=" + sframes.length);
check("file iframe got the injected CSP", !!sframes[1] &&
  sframes[1].getAttribute("srcdoc").includes("Content-Security-Policy") &&
  sframes[1].getAttribute("srcdoc").includes("script-ran"));

console.log("\n--- 我的面板 (panel bookmark book) ---");
check("我的面板 shown only in static mode", !$("myPanels").classList.contains("hidden"));
$("mpUrl").value = "http://127.0.0.1:7788";
$("mpAdd").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
check("saved URL becomes an out-link", !!dom.window.document.querySelector('#mpList a.mp-item[href="http://127.0.0.1:7788"]'));
check("persisted to localStorage", (dom.window.localStorage.getItem("report-mcp.myPanels") || "").includes("7788"));
$("mpUrl").value = "javascript:alert(1)";
$("mpAdd").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
check("non-http URL rejected",
  !dom.window.document.querySelector('#mpList a[href^="javascript"]') &&
  $("mpList").textContent.includes("http(s)"));
check("only the good URL kept",
  JSON.parse(dom.window.localStorage.getItem("report-mcp.myPanels")).join(",") === "http://127.0.0.1:7788");

[...dom.window.document.querySelectorAll("#filters button")].find((b) => b.textContent === "结果")
  .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
check("filter works with no backend", dom.window.document.querySelectorAll(".entry").length === 1,
  "entries=" + dom.window.document.querySelectorAll(".entry").length);
dom.window.close();

/* ---------------- static site, demo bundle missing ---------------- */
console.log("\n--- static site, demo-data.js absent ---");
const s2 = await serveStatic({ withDemo: false });
const b2 = await boot(s2.url);
// #empty is visible in the initial HTML, so it cannot mark boot as settled.
// The sidebar fallback is the last DOM write of the no-bundle path.
await waitFor(() => b2.dom.window.document.getElementById("runList").textContent.includes("暂无运行记录"),
  { timeout: 8000 });
const empty2 = b2.dom.window.document.getElementById("empty");
check("falls back to empty state, no crash", !empty2.classList.contains("hidden"));
check("empty state offers config hint", empty2.textContent.includes("mcpServers"));
check("sidebar shows no-runs message",
  b2.dom.window.document.getElementById("runList").textContent.includes("暂无运行记录"));
check("DEMO chip still shown", !b2.dom.window.document.getElementById("modeChip").classList.contains("hidden"));
b2.dom.window.close();
server.close();
s2.server.close();

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
