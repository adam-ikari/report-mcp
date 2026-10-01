/**
 * Manual check against the *deployed* GitHub Pages artifact.
 *
 * Not part of `npm test`: it needs network access to the published site, and a
 * gate that depends on someone else's CDN is a gate that flakes. Run it by hand
 * after a deploy:
 *
 *   node test/verify-pages.mjs
 *   PAGES_URL=https://adam-ikari.github.io/report-mcp/panel/ node test/verify-pages.mjs
 *
 * The site has two halves: the VitePress docs at the site root (DOCS_URL) and
 * the panel demo at /panel/ (PAGES_URL, where the demo moved when the docs
 * took over the root path).
 *
 * Assertions are written so that a broken page reports FAILs rather than
 * throwing — a verification script that crashes tells you nothing useful.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JSDOM, VirtualConsole } from "jsdom";

/**
 * Check the panel as a *deployed static artifact*.
 *
 * Two halves. The panel half needs no network and runs inside `npm test` — it
 * serves `public/` the way Pages does (404 on unknown paths, so the panel takes
 * its static-demo branch) and asserts the shipped shape: the shell, the bundle
 * served beside it with a JS content type, the demo rendering, deep links.
 *
 * The docs half can only be checked against a deployed site, so it is opt-in:
 *
 *   node test/verify-pages.mjs                      # local panel only (default)
 *   PAGES_URL=… DOCS_URL=… node test/verify-pages.mjs   # both, after a deploy
 *
 * The panel half used to be deploy-only too, and that is how it rotted: when the
 * panel moved to React it kept asserting on markup that no longer exists in the
 * served HTML, and nothing noticed because nobody could run it without a deploy.
 */
const LOCAL = process.argv.includes("--local") || !process.env.PAGES_URL;
const RUN_DOCS = !LOCAL || !!process.env.DOCS_URL;
const PAGES = process.env.PAGES_URL || "";
const DOCS = process.env.DOCS_URL || "https://adam-ikari.github.io/report-mcp/";

const results = [];
const check = (name, cond, extra) => {
  results.push(!!cond);
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra != null ? "  " + extra : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(label, fn, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await fn()) return true; } catch { /* not yet */ }
    await sleep(100);
  }
  return false;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".map": "application/json; charset=utf-8",
};

/**
 * Serve `public/` the way Pages does: unknown paths 404, which is what makes the
 * panel take its static-demo path. Without that 404 the panel would find no
 * backend and stay in live mode, and the deployed-site assertions would be
 * checking a page nobody deploys.
 */
function serveLocalPanel() {
  const root = path.join(here, "..", "public");
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
      const file = path.join(root, rel === "/" ? "index.html" : rel);
      fs.readFile(file, (err, buf) => {
        if (err || !file.startsWith(root)) {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("Not Found");
          return;
        }
        res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
        res.end(buf);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

/** Where a browser ends up after following GitHub Pages' /repo → /repo/ 301. */
function canonicalize(href) {
  const u = new URL(href);
  if (!u.pathname.endsWith("/")) u.pathname += "/";
  return u.href;
}

async function boot(pageUrl) {
  // Ask for the plain entity: GitHub serves gzip and Node's fetch does not
  // always decode it — we only care that the bytes are readable HTML.
  // GitHub Pages serves /repo → /repo/ (301), but its edge is inconsistent
  // about it: the same URL has been observed returning 301 and returning 200
  // with the page body minutes apart. Rather than depend on fetch's auto-follow
  // — which surfaces the raw 301 when the edge does redirect — canonicalise the
  // URL ourselves. That is exactly where a browser lands after following the
  // redirect, and it is what relative resolution (demo-data.js) depends on.
  const finalUrl = canonicalize(pageUrl);
  const res = await fetch(finalUrl, { headers: { "accept-encoding": "identity" } });
  check(`GET ${finalUrl} → 200`, res.status === 200, `status=${res.status}`);
  const html = await res.text();
  // The served document is a shell now: the panel is a React bundle in
  // public/panel.js. Grepping the HTML for component ids (as this used to do
  // with `modeChip`) is what silently rotted when the panel moved to React.
  check("served document is the panel shell", html.includes('id="root"') && html.includes("panel.js"), "len=" + html.length);
  const bundle = await fetch(new URL("panel.js", finalUrl), { headers: { "accept-encoding": "identity" } });
  check("panel.js is deployed alongside it", bundle.ok && bundle.headers.get("content-type")?.includes("javascript"),
    `status=${bundle.status} type=${bundle.headers.get("content-type")} bytes=${(await bundle.arrayBuffer()).byteLength}`);

  const vc = new VirtualConsole();
  if (typeof vc.forwardTo === "function") vc.forwardTo(console);

  return new JSDOM(html, {
    url: finalUrl,
    runScripts: "dangerously",
    // Required: the panel is an external bundle and loads demo-data.js too.
    resources: "usable",
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      // jsdom ships no fetch; give the page a real one so detect() behaves
      // exactly as it would in a browser (absolute /api/runs → 404 → static).
      window.fetch = (u, o = {}) =>
        fetch(new URL(String(u), finalUrl), {
          ...o,
          headers: { ...(o.headers || {}), "accept-encoding": "identity" },
        });
      window.EventSource = class {
        constructor() {
          throw new Error("deployed static site must not open an EventSource");
        }
      };
      window.addEventListener("error", (e) => console.log("PAGE ERROR:", e.error?.stack || e.message));
    },
  });
}

/** Null-safe text of #id. */
const txt = (doc, id) => doc.getElementById(id)?.textContent ?? null;
/** Null-safe width of the #id progress bar fill. */
const barWidth = (doc, id) => doc.getElementById(id)?.querySelector("i")?.style?.width ?? null;
const entries = (doc) => doc.querySelectorAll(".entry").length;
const runTitles = (doc) =>
  [...doc.querySelectorAll(".run-item")].map((i) => i.querySelector(".t")?.textContent ?? "?");

/* ---- 1. normal entry: trailing slash ---- */
console.log(`--- panel demo: entry with trailing slash (${LOCAL ? "local public/" : PAGES}) ---`);
const local = LOCAL ? await serveLocalPanel() : null;
const PAGES_URL = local ? local.url : PAGES;
const dom = await boot(PAGES_URL);
const doc = dom.window.document;
// Wait for the panel to have mounted and auto-opened a run. A fixed sleep was
// fine when boot was one synchronous script; the panel is a bundle that fetches
// demo-data.js and then re-renders, so gate on the state instead.
const booted = await waitFor("boot", () => doc.querySelectorAll(".run-item").length === 3 && entries(doc) > 0);
check("panel mounted and auto-opened a run", booted,
  `runs=${doc.querySelectorAll(".run-item").length} entries=${entries(doc)}`);

check("page title is the panel", doc.title === "Agent Report", doc.title);
check("DEMO chip visible", !!doc.getElementById("modeChip") && !doc.getElementById("modeChip").classList.contains("hidden"),
  doc.getElementById("modeChip")?.className ?? "(missing)");
check("storage line identifies demo", (txt(doc, "homePath") ?? "").includes("演示"), txt(doc, "homePath"));
check("3 demo runs from the deployed bundle", doc.querySelectorAll(".run-item").length === 3,
  "got " + doc.querySelectorAll(".run-item").length);
check("runs ordered by last activity", runTitles(doc).join(" | ")
  === "回归测试批次 #482 | MCP 报告协议调研与综述 | 同步 CRM 联系人", runTitles(doc).join(" | "));
check("auto-opened first run", entries(doc) === 6, "entries=" + entries(doc));
check("static mode engaged (no live backend)", (txt(doc, "homePath") ?? "").includes("演示"), txt(doc, "rTitle"));

const completed = [...doc.querySelectorAll(".run-item")].find((i) => i.textContent.includes("MCP 报告协议调研"));
if (completed) completed.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
else check("completed run present in sidebar", false, "not found");
// React re-renders after the handler returns, so wait for the record count.
check("switching runs renders 13 records", await waitFor("switch", () => entries(doc) === 13), "entries=" + entries(doc));
check("result card present", !!doc.querySelector(".result-card"));
check("metrics grid present", doc.querySelectorAll(".result-card .metric").length === 4,
  "got " + doc.querySelectorAll(".result-card .metric").length);
check("artifacts present", doc.querySelectorAll(".result-card ul.art > li").length === 5,
  "got " + doc.querySelectorAll(".result-card ul.art > li").length);
// Rich content ships with the static bundle: the image renders from
// panel/assets/, markdown artifacts hydrate, HTML goes into sandbox frames.
const hydrated = await waitFor("hydration", () =>
  doc.querySelector("img.artimg") && doc.querySelectorAll(".md-body").length === 3
  && !doc.querySelector("[data-md-src]"));
check("static assets hydrated", hydrated,
  `imgs=${doc.querySelectorAll("img.artimg").length} md=${doc.querySelectorAll(".md-body").length}`);
const img = doc.querySelector("img.artimg");
check("image renders from site-relative assets/", !!img && /assets\/chart\.png$/.test(new URL(img.getAttribute("src"), PAGES_URL).pathname),
  img?.getAttribute("src"));
check("inline markdown is typeset, raw HTML escaped",
  [...doc.querySelectorAll(".md-body")].some((b) => b.querySelector("strong"))
  && ![...doc.querySelectorAll(".md-body")].some((b) => b.querySelector("script")),
  "md-body count=" + doc.querySelectorAll(".md-body").length);
const frames = [...doc.querySelectorAll("iframe")];
check("two sandboxed HTML frames (inline field + file artifact)", frames.length === 2,
  "got " + frames.length);
check("sandbox is allow-scripts only", frames.every((f) => f.getAttribute("sandbox") === "allow-scripts"),
  frames.map((f) => f.getAttribute("sandbox")).join("|"));
check("file frame carries injected CSP", frames.some((f) => (f.getAttribute("srcdoc") || "").includes("Content-Security-Policy")));
check("panel.html artifact arrived", frames.some((f) => (f.getAttribute("srcdoc") || "").includes("script-ran")));
check("status chip = done", txt(doc, "rStatus") === "done", txt(doc, "rStatus"));
check("progress bar = 100%", barWidth(doc, "rProgress") === "100%", barWidth(doc, "rProgress"));
check("deep link captured in hash", dom.window.location.hash.includes("run_"), dom.window.location.hash);

const resultFilter = [...doc.querySelectorAll("#filters button")].find((b) => b.textContent === "结果");
if (resultFilter) resultFilter.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
check("filter works with no backend", await waitFor("filter", () => entries(doc) === 1), "entries=" + entries(doc));
dom.window.close();

/* ---- 2. deep link straight into a run, no trailing slash ---- */
console.log("\n--- panel demo: deep link, no trailing slash ---");
// Tolerant by design: the Pages edge sometimes 301s to the slashed form and
// sometimes serves the page directly. A browser is fine with either (it follows
// the redirect and keeps the fragment); what must never happen is a hard error.
const bare = await fetch(PAGES_URL.replace(/\/$/, ""), { headers: { "accept-encoding": "identity" } });
check("no-slash URL resolves (2xx/3xx, never 4xx/5xx)", bare.status >= 200 && bare.status < 400,
  "status=" + bare.status);
const deep = PAGES_URL.replace(/\/$/, "") + "#/run/run_20260923220100_ee33ff";
const dom2 = await boot(deep);
const doc2 = dom2.window.document;
check("deep link booted", await waitFor("deep", () => entries(doc2) === 4), "entries=" + entries(doc2));
check("resolves to the failed run", txt(doc2, "rTitle") === "同步 CRM 联系人", txt(doc2, "rTitle"));
check("failed chip", txt(doc2, "rStatus") === "failed", txt(doc2, "rStatus"));
check("4 records rendered", entries(doc2) === 4, "got " + entries(doc2));
check("failure reason surfaced", (txt(doc2, "rMeta") ?? "").includes("API 凭据过期"),
  (txt(doc2, "rMeta") ?? "(no meta)").slice(-140));
check("static mode on deep link", (txt(doc2, "homePath") ?? "").includes("演示"), txt(doc2, "homePath"));
dom2.window.close();

/* ---- 3. docs site at the site root ---- */
// canonicalize() appends a trailing slash, which would corrupt a `.html` path,
// so only the directory-shaped home URL gets it.
const get = async (url) => {
  const res = await fetch(url, { headers: { "accept-encoding": "identity" } });
  return { res, html: res.ok ? await res.text() : "" };
};

console.log("\n--- docs site (site root) ---");
if (!RUN_DOCS) {
  // The docs half is by definition about a site that has shipped, so in local
  // mode it is skipped rather than pointed at a build nobody has deployed.
  console.log("SKIP  local mode: the docs half only applies to a deployed site (set DOCS_URL to force it)");
} else {
  const home = await get(canonicalize(DOCS));
  check(`GET ${DOCS} → 200`, home.res.status === 200, `status=${home.res.status}`);
  check("home is the docs site", home.html.includes("<title>report-mcp</title>"),
    (home.html.match(/<title>[^<]*<\/title>/) || ["(no title)"])[0]);
  check("built by VitePress", /<meta name="generator" content="VitePress/.test(home.html));
  check("hero rendered", home.html.includes("VPHero"));
  check("nav offers the panel demo at /panel/", home.html.includes("/report-mcp/panel/"));

  const install = await get(DOCS + "guide/install.html");
  check("安装与接入 → 200", install.res.status === 200, `status=${install.res.status}`);
  check("installation page rendered", install.html.includes("<title>安装与接入</title>"));
  // Shiki splits code fences into per-token spans (`<span>npm</span><span> install…`),
  // so a raw substring search over the HTML misses commands that are definitely there.
  const plain = (html) => html.replace(/<[^>]+>/g, "");
  // The load-bearing line: this is the exact command users are told to run, and it
  // only works with --install-links=true (see install.md). A regression here
  // ships a documented install that produces a dangling symlink.
  check("installation shows the git install command",
    plain(install.html).includes("npm install -g --install-links=true git+https://github.com/adam-ikari/report-mcp.git"));

  const usage = await get(DOCS + "guide/usage.html");
  check("使用方法 → 200", usage.res.status === 200, `status=${usage.res.status}`);
  check("usage page rendered", usage.html.includes("<title>使用方法</title>"));
  check("usage documents report_start", plain(usage.html).includes("report_start"));

  // Regression guard: VitePress slugifies `report_panel` → `report-panel`, so a
  // hand-written `#report_panel` anchor silently fails to jump.
  check("cross-page anchor resolves",
    install.html.includes("#report-panel") && usage.html.includes('id="report-panel"'),
    install.html.includes("#report_panel") ? "still underscore" : "slug ok");
}

local?.server.close();

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
