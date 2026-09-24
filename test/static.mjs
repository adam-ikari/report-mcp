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
import { setTimeout as sleep } from "node:timers/promises";
import { JSDOM, VirtualConsole } from "jsdom";

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
await sleep(1200);

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
await sleep(400);
check("switch to completed run → 13 entries", entries() === 13, "entries=" + entries());
check("result card rendered from demo data", !!dom.window.document.querySelector(".result-card"));
check("metrics grid rendered", dom.window.document.querySelectorAll(".result-card .metric").length === 4,
  "got " + dom.window.document.querySelectorAll(".result-card .metric").length);
check("header status = done", $("rStatus").textContent === "done", $("rStatus").textContent);
check("progress bar 100%", $("rProgress").querySelector("i").style.width === "100%", $("rProgress").querySelector("i").style.width);

[...dom.window.document.querySelectorAll("#filters button")].find((b) => b.textContent === "结果")
  .dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
check("filter works with no backend", dom.window.document.querySelectorAll(".entry").length === 1,
  "entries=" + dom.window.document.querySelectorAll(".entry").length);
dom.window.close();

/* ---------------- static site, demo bundle missing ---------------- */
console.log("\n--- static site, demo-data.js absent ---");
const s2 = await serveStatic({ withDemo: false });
const b2 = await boot(s2.url);
await sleep(900);
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
