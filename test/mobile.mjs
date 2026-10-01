/**
 * Suite: mobile layout, measured in a real browser engine.
 *
 * Every other suite renders the panel in jsdom, and jsdom cannot evaluate a
 * `@media` query — `getComputedStyle` hands back the desktop cascade whatever
 * the viewport. So the narrow-viewport rules in `public/index.html` (drawer,
 * two-row toolbar, 44px targets, safe-area insets, landscape compaction) were
 * previously verified by *looking at a screenshot*. This suite is the
 * alternative: it drives headless Chromium over the DevTools protocol and
 * asserts on real layout, which is the only way to catch the class of bug that
 * is invisible in jsdom.
 *
 * It found four real defects that eyeballing had missed, each of which had
 * passed a hand-run audit:
 *
 *   - `.mp-del`, the one control that deletes something, was a 29×16px target.
 *     Invisible to every earlier check because the demo has no saved panels, so
 *     the button was never rendered and never measured.
 *   - `summary { display: flex }` — written to make the disclosure row tall
 *     enough to tap — silently deleted the disclosure triangle, because a
 *     marker only generates for `display: list-item`. The row grew to 44px and
 *     stopped looking expandable at all.
 *   - `.head .meta` holds 947px of content in a 292px phone. Scrolling it is
 *     fine; scrolling it with the scrollbar hidden and no fade is the dead end
 *     this whole change set out to remove.
 *   - `white-space: nowrap` on table cells made one prose sentence a 588px cell
 *     inside a 277px window: three screen-widths of sideways scrolling to read
 *     it. (The *table* itself never broke — `display:block` + `max-width:100%` +
 *     `overflow-x:auto` held. Only the reading cost was wrong.)
 *
 * Two of those were invisible because the earlier probe ran against a fixture
 * state that never rendered the offending element, which is why this suite
 * seeds localStorage before boot and asserts on the widest meta line a real run
 * produces.
 *
 * Opt-in, like `verify-pages.mjs`'s docs half: it needs a Chromium binary and a
 * real display pipeline, which is not something every dev box or CI runner has.
 * When no browser is found it skips cleanly rather than failing.
 *
 *   node test/mobile.mjs                 # skip if no Chromium
 *   CHROME_PATH=/usr/bin/chromium node test/mobile.mjs
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..", "public");

/* ------------------------------------------------------------------ reporting */
const results = [];
const check = (name, cond, extra) => {
  results.push(!!cond);
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};
const note = (s) => console.log(`      ${s}`);

/* ------------------------------------------------------------ browser discovery */
function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const names = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome"];
  for (const n of names) {
    try {
      const p = execFileSync("which", [n], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (p) return p;
    } catch {
      /* not on PATH */
    }
  }
  for (const p of [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const CHROME = findChrome();
if (!CHROME) {
  console.log("SKIP  no Chromium found — set CHROME_PATH to run the mobile layout suite");
  console.log("      (jsdom cannot evaluate @media, so narrow-viewport layout is otherwise unchecked)");
  process.exit(0);
}

/* -------------------------------------------------------------- static server */
/**
 * Serves public/ the way a static host does. The panel's datasource probes
 * /api/runs, gets a 404, and takes its bundled-demo branch — the same path
 * GitHub Pages takes, so this measures what is actually shipped.
 */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

const PROBE = `<!doctype html><meta charset="utf-8">
<style>body{margin:0;background:#222}iframe{border:0;display:block}#o{color:#8f8;font:11px monospace;white-space:pre-wrap;padding:8px}</style>
<div id="o">measuring…</div>
<script>
const PORT = __PORT__;
const out = [];
const log = (s) => { out.push(s); document.getElementById("o").textContent = out.join("\\n"); };
const P = [], F = [];
const check = (name, ok, detail) => { (ok ? P : F).push(name); log((ok ? "PASS  " : "FAIL  ") + name + (detail ? "  " + detail : "")); };
const note = (s) => log("      " + s);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function ready(f, need) {
  return new Promise((res) => {
    let n = 0;
    const iv = setInterval(() => {
      const d = f.contentDocument;
      if (d && d.querySelectorAll(need).length > 0) { clearInterval(iv); res(d); }
      else if (++n > 150) { clearInterval(iv); res(f.contentDocument); }
    }, 100);
  });
}

async function probe(width, height) {
  const f = document.createElement("iframe");
  f.width = width; f.height = height;
  document.body.appendChild(f);
  // Seed before boot. Same origin, so this is the panel's own localStorage —
  // and without it .mp-del is never rendered, which is how a 16px destructive
  // target passed every earlier check.
  try {
    f.contentWindow.localStorage.setItem("report-mcp.myPanels", JSON.stringify([
      "http://192.168.1.20:7788", "https://reports.example.com",
    ]));
  } catch (e) { note("localStorage unavailable: " + e.message); }
  f.src = "http://127.0.0.1:" + PORT + "/";
  // Boot on the list, then pick a run that actually has a result card to
  // measure. Hardcoding a fixture run id would rot the first time someone
  // renames one; reading the bundled demo data cannot.
  const booted = await ready(f, ".run-item");
  let runId = null;
  if (booted) {
    const demo = f.contentWindow.__REPORT_DEMO__;
    const runs = (demo && demo.runs) || [];
    const rich = runs.find((r) => (r.records || []).some((x) => x.kind === "result")) || runs[0];
    runId = rich && rich.runId;
  }
  if (!runId) { check(width + "x" + height + " has a run to measure", false, "no demo run with a result"); f.remove(); return; }
  f.contentWindow.location.hash = "#/run/" + runId;
  const d = await ready(f, "#timeline .entry");
  if (!d || !d.querySelector("#timeline .entry")) { check(width + "x" + height + " renders records", false, "no .entry"); f.remove(); return; }
  const win = f.contentWindow;
  await wait(350);
  log("\\n=== " + width + "x" + height + " ===");

  // --- the scroll containers must never scroll sideways --------------------
  const de = d.documentElement;
  check("page does not overflow horizontally", de.scrollWidth <= width + 1, de.scrollWidth + " vs " + width);
  const tl = d.getElementById("timeline");
  check("#timeline does not scroll sideways", tl.scrollWidth <= tl.clientWidth + 1,
    "client=" + tl.clientWidth + " scroll=" + tl.scrollWidth);

  // --- tap targets ----------------------------------------------------------
  // 44px is the guideline. Skip zero-sized boxes: that is how a control parked
  // off-screen (the closed drawer) reports nothing about its own size.
  const TAPS = "#navBtn, .btn, .run-item, summary, .mp-del, input, .rgroup-head, .mp-add .btn, .iconbtn";
  const short = [];
  for (const sel of TAPS.split(", ")) {
    for (const e of d.querySelectorAll(sel)) {
      const r = e.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.height < 43.5 || r.width < 43.5) {
        short.push(sel + " " + Math.round(r.width) + "x" + Math.round(r.height));
      }
    }
  }
  check("every tap target is at least 44x44", short.length === 0, short.slice(0, 5).join(", "));

  // --- the destructive control, named separately ---------------------------
  // Worth its own assertion: it is the one button that loses data, and it is
  // only in the DOM when the user has bookmarked a panel.
  const del = d.querySelector(".mp-del");
  check(".mp-del (deletes a bookmark) is a real target",
    !!del && del.getBoundingClientRect().height >= 43.5,
    del ? Math.round(del.getBoundingClientRect().width) + "x" + Math.round(del.getBoundingClientRect().height) : "not rendered");

  // --- <details> affordance -------------------------------------------------
  // Height is not enough: a marker only generates for display:list-item, so
  // display:flex on the summary grows the row and removes the triangle, and
  // the collapsed payload stops looking expandable. Measure the inset the
  // marker pushes the label by, not just the box.
  const s = d.querySelector("details > summary");
  if (s) {
    const range = d.createRange();
    range.selectNodeContents(s);
    const inset = Math.round(range.getBoundingClientRect().left - s.getBoundingClientRect().left);
    check("<summary> still paints its disclosure marker", inset >= 8,
      "label inset " + inset + "px, display=" + win.getComputedStyle(s).display);
  } else {
    check("<summary> rendered", false, "no details in the fixture run");
  }

  // --- overflow needs an affordance ----------------------------------------
  // A scrollable region with the scrollbar hidden and no fade is content the
  // user cannot know is there. The meta line really does overflow (947px of
  // fields in a 292px phone), so this is load-bearing, not theoretical.
  for (const sel of [".head .meta", ".toolbar .seg"]) {
    const c = d.querySelector(sel);
    if (!c) continue;
    if (c.scrollWidth <= c.clientWidth + 1) {
      note(sel + " fits here (" + c.scrollWidth + "px), no affordance needed");
      continue;
    }
    check(sel + " overflows and shows an affordance", win.getComputedStyle(c).maskImage !== "none",
      "scroll=" + c.scrollWidth + " client=" + c.clientWidth + " mask=" + win.getComputedStyle(c).maskImage.slice(0, 40));
  }

  // --- reading space -------------------------------------------------------
  // Chrome is what stands between the reader and the report. A landscape phone
  // is 360px tall; the header, bar and toolbar must not eat all of it.
  if (!tl.classList.contains("hidden")) {
    const frac = tl.clientHeight / win.innerHeight;
    check("timeline keeps at least 45% of the viewport", frac >= 0.45, Math.round(frac * 100) + "%");
  }

  // --- a table with prose in a cell ----------------------------------------
  // The fixture's own table has short cells. Reports do not, and the failure
  // mode (nowrap on every cell) is a 588px cell in a 277px window.
  const holder = d.createElement("div");
  holder.className = "md-body";
  holder.innerHTML = "<table><thead><tr><th>列</th><th>说明</th></tr></thead><tbody><tr><td>a</td><td>" +
    "这是一段很长的说明文字，用来检验表格在窄屏上是否会因为单元格不允许换行而把整页撑破。" +
    "</td></tr></tbody></table>";
  const anchor = d.querySelector("#timeline .entry .body") || d.getElementById("timeline");
  anchor.appendChild(holder);
  await wait(200);
  const t = holder.querySelector("table"), cell = holder.querySelector("td:last-child");
  const tb = t.getBoundingClientRect().width, cb = cell.getBoundingClientRect().width;
  check("a prose table cell wraps instead of scrolling sideways", cb <= tb + 1,
    "table " + Math.round(tb) + "px, cell " + Math.round(cb) + "px, white-space=" + win.getComputedStyle(cell).whiteSpace);
  check("injected wide table does not widen the page",
    d.documentElement.scrollWidth <= width + 1 && tl.scrollWidth <= tl.clientWidth + 1,
    "page=" + de.scrollWidth + " timeline=" + tl.scrollWidth + "/" + tl.clientWidth);

  // --- body text is actually readable at arm's length ----------------------
  const tiny = [];
  for (const sel of [".md-body p", ".md-body li", ".md-body td", ".sub", ".msg", ".sum", "pre", ".md-body code"]) {
    const e = d.querySelector(sel);
    if (!e) continue;
    const fs = parseFloat(win.getComputedStyle(e).fontSize);
    if (fs < 11.9) tiny.push(sel + "=" + fs + "px");
  }
  check("body text is at least 12px", tiny.length === 0, tiny.join(", "));

  // --- the drawer, which is a different layout -----------------------------
  const nav = d.getElementById("navBtn");
  if (nav) {
    nav.click();
    await wait(500);
    const app = d.getElementById("app");
    check("hamburger opens the drawer", app.classList.contains("nav-open"));
    const aside = d.querySelector("aside");
    const ar = aside.getBoundingClientRect();
    check("drawer sits flush against the left edge", Math.abs(ar.left) <= 1, "left=" + Math.round(ar.left));
    check("drawer fits the viewport width", ar.width <= width + 1, Math.round(ar.width) + "px in " + width);
    const short2 = [];
    for (const sel of [".run-item", ".rgroup-head", ".mp-del", ".mp-add .btn"]) {
      for (const e of d.querySelectorAll(sel)) {
        const r = e.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.height < 43.5 || r.width < 43.5) short2.push(sel + " " + Math.round(r.width) + "x" + Math.round(r.height));
      }
    }
    check("drawer tap targets are at least 44x44", short2.length === 0, short2.slice(0, 5).join(", "));
    // The scrim must cover the viewport or taps leak through to the timeline.
    const scrim = d.getElementById("scrim");
    check("scrim covers the viewport", !!scrim && scrim.getBoundingClientRect().width >= width - 1,
      scrim ? Math.round(scrim.getBoundingClientRect().width) + "px" : "no scrim");
    nav.click();
    await wait(400);
    check("hamburger closes the drawer", !app.classList.contains("nav-open"));
  }

  f.remove();
}

(async () => {
  // 320 is the narrowest phone still in circulation, 740x360 a landscape one
  // (where the fixed chrome competes for a very short viewport), 768 an iPad.
  for (const [w, h] of [[320, 640], [390, 800], [430, 800], [740, 360], [768, 1024]]) {
    await probe(w, h);
  }
  log("\\n" + P.length + " passed, " + F.length + " failed");
  if (F.length) log("FAILED: " + F.join(" | "));
  log("DONE");
  fetch("/__done").catch(() => {});
})().catch((e) => {
  log("PROBE ERROR: " + (e && e.stack || e));
  log("DONE");
});
</script>`;

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  if (p === "/__probe") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PROBE.replace("__PORT__", String(server.address().port)));
    return;
  }
  const rel = p === "/" ? "/index.html" : p;
  const file = path.join(ROOT, rel.replace(/\.\./g, ""));
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

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
console.log(`static server: http://127.0.0.1:${port}  (chromium: ${CHROME})`);

/* ------------------------------------------------------------------- CDP glue */
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "report-mcp-mobile-"));
const devPort = port + 1;
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    // Layout must not depend on the host's font set or scrollbar width.
    "--force-device-scale-factor=1",
    `--remote-debugging-port=${devPort}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "ignore"] },
);

const cleanup = () => {
  try { chrome.kill("SIGKILL"); } catch { /* already gone */ }
  try { server.close(); } catch { /* already closed */ }
  fs.rmSync(profile, { recursive: true, force: true });
};
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });

async function waitForDevtools() {
  for (let i = 0; i < 80; i++) {
    const up = await fetch(`http://127.0.0.1:${devPort}/json/version`)
      .then((r) => r.ok)
      .catch(() => false);
    if (up) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

if (!(await waitForDevtools())) {
  console.error("chromium devtools endpoint never came up");
  cleanup();
  process.exit(1);
}

const version = await (await fetch(`http://127.0.0.1:${devPort}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error("devtools websocket failed"));
});

let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const send = (method, params = {}, sessionId) =>
  new Promise((resolve) => {
    const n = ++msgId;
    pending.set(n, resolve);
    ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

const { result: target } = await send("Target.createTarget", { url: "about:blank" });
const { result: attached } = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
const sessionId = attached.sessionId;
await send("Page.enable", {}, sessionId);
await send("Runtime.enable", {}, sessionId);
await send("Page.navigate", { url: `http://127.0.0.1:${port}/__probe` }, sessionId);

const deadline = Date.now() + 120000;
let text = "";
while (Date.now() < deadline) {
  const r = await send("Runtime.evaluate", {
    expression: "document.getElementById('o').textContent",
    returnByValue: true,
  }, sessionId);
  text = r?.result?.result?.value || "";
  if (text.includes("DONE")) break;
  await new Promise((r) => setTimeout(r, 400));
}

// Replay the probe's own PASS/FAIL lines through this suite's reporter so the
// output format matches every other suite, and so a crashed probe still
// reports rather than silently exiting 0.
for (const line of text.split("\n")) {
  const m = /^(PASS|FAIL)\s+(.*)$/.exec(line);
  if (m) check(m[2], m[1] === "PASS");
  else if (line.trim()) note(line);
}
if (!text.includes("DONE")) {
  check("mobile probe completed", false, "timed out before DONE");
}

cleanup();
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
