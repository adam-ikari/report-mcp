#!/usr/bin/env node
/**
 * Suite: the main path, end to end.
 *
 * agent tool call → journal → real renderer → page on disk → `serve` URL → fetched
 * bytes. It is the only suite that runs the whole chain, so it is also the one that
 * proves the two-process design: the MCP process publishes a page with no host running,
 * and the link appears once a host starts reading the same home.
 *
 * Assertions are on am's *stable output markers* (doctype, panel markup, its own draft
 * embedded, nothing fetched from outside) — never on its layout, which we do not own.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { connectMcp, freePort, makeReport, parseJournalSafe, startServe, waitFor } from "./harness.mjs";
import { closingDraft, imageDraft, sheetDraft } from "./drafts.mjs";

const HOME = path.join(process.cwd(), "test", ".tmp-milestone");
fs.rmSync(HOME, { recursive: true, force: true });

const { check, finish } = makeReport();
const port = await freePort();
let client = null;
let host = null;

/** The journal of this run, as the file on disk — the truth the panel is derived from. */
function journal(runId) {
  return parseJournalSafe(path.join(HOME, "runs", `${runId}.jsonl`));
}

try {
  client = await connectMcp({ ...process.env, REPORT_MCP_HOME: HOME });
  const runId = client.runId;
  const { rpc, notify, call, notifications } = client;

  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "milestone", version: "0.0.0" },
  });
  check("initialize", init.serverInfo?.name === "report-mcp", JSON.stringify(init.serverInfo));
  notify("notifications/initialized", {});

  const tools = await rpc("tools/list", {});
  const names = tools.tools.map((t) => t.name).sort().join(",");
  check(
    "tools/list is the milestone surface",
    names === "report_end,report_page,report_start,report_syntax",
    names,
  );

  // --- no host yet: a page is written, and no link is claimed ---
  const start = await call("report_start", {
    title: "Cache migration",
    agent: "milestone-agent",
    task: "decide and land the cache",
    tags: ["infra", "e2e"],
  });
  check("report_start seq 1", start.ok && start.seq === 1, JSON.stringify(start).slice(0, 120));
  check("no host → indexUrl is null", start.indexUrl === null && /report-mcp start/.test(start.hint || ""), String(start.hint).slice(0, 60));

  const page1 = await call("report_page", { title: "Cache selection", draft: sheetDraft("Cache selection") });
  check("report_page ok", page1.ok === true, JSON.stringify(page1).slice(0, 200));
  check("no host → page url is null", page1.url === null && typeof page1.hint === "string");
  check("page bytes are real", page1.bytes > 50_000, `${page1.bytes} bytes`);

  const file1 = path.join(HOME, page1.page);
  check("page is on disk", fs.existsSync(file1), page1.page);
  const raw1 = fs.readFileSync(file1);
  check("journal sha256 matches the file", crypto.createHash("sha256").update(raw1).digest("hex") === page1.sha256);

  const recs = journal(runId);
  check(
    "journal order is start, milestone, published",
    recs.map((r) => r.kind).join(",") === "start,milestone,published",
    recs.map((r) => `${r.kind}#${r.seq}`).join(","),
  );
  check("published points at its milestone", recs[2].for === recs[1].seq && recs[2].path === page1.page, JSON.stringify(recs[2]?.path));
  check("the draft is kept verbatim", recs[1].draft === sheetDraft("Cache selection"));

  // --- the host starts: everything already published becomes reachable ---
  host = await startServe({ home: HOME, port });
  check("serve health reports this home", host.health.home === HOME && host.health.pid === host.proc.pid, JSON.stringify(host.health));
  const state = JSON.parse(fs.readFileSync(path.join(HOME, "host.json"), "utf8"));
  check("host.json points at the loopback origin", state.url === host.origin, state.url);

  const url1 = `${host.origin}/r/${encodeURIComponent(runId)}/${recs[1].seq}-${encodeURIComponent(recs[1].slug)}`;
  const r1 = await fetch(url1);
  check("a page published before the host existed is now reachable", r1.ok, `${r1.status} ${url1}`);
  const html1 = await r1.text();
  check("page starts with <!doctype html>", /^\s*<!doctype html>/i.test(html1), html1.slice(0, 40));
  check("page carries panel markup", (html1.match(/class="am-panel/g) || []).length >= 2, String((html1.match(/class="am-panel/g) || []).length));
  check("page says what it decided", html1.includes("Memcached") && html1.includes("Redis"));
  check("page embeds its own draft", html1.includes('id="am-source"') && html1.includes("```flow LR"));
  check("page fetches nothing from outside", !/<script[^>]+src=/i.test(html1) && !/<link[^>]+stylesheet/i.test(html1) && !/\ssrc="\//.test(html1));

  const h1 = r1.headers;
  check("page is immutable + nosniff + no-referrer", h1.get("cache-control")?.includes("immutable") && h1.get("x-content-type-options") === "nosniff" && h1.get("referrer-policy") === "no-referrer");
  check("page carries no CORS wildcard", h1.get("access-control-allow-origin") === null);
  check("page type is html", (h1.get("content-type") || "").startsWith("text/html"), h1.get("content-type"));

  // --- with a host running, the tool reply carries a live link ---
  const page2 = await call("report_page", { title: "Measured latency", draft: imageDraft(), slug: "latency" });
  check("report_page with a host returns a url", page2.ok && page2.url === `${host.origin}/r/${encodeURIComponent(runId)}/4-latency`, String(page2.url));

  const r2 = await fetch(page2.url);
  const html2 = await r2.text();
  check("an image in the draft is embedded, not linked", r2.ok && html2.includes("data:image/png;base64,"), `${html2.length} bytes`);
  check("gzip is used when the client asks it", (await fetch(page2.url, { headers: { "Accept-Encoding": "gzip" } })).headers.get("content-encoding") === "gzip");

  const index = await (await fetch(host.origin + "/")).text();
  check("index lists the run by title", index.includes("Cache migration"));
  check("index groups by the first tag", index.includes(">infra<"), /infra/.test(index));
  check("index links both pages", index.includes(`/r/${encodeURIComponent(runId)}/2-`) && index.includes(`/r/${encodeURIComponent(runId)}/4-latency`));
  check("index has no script and no event stream", !/<script/i.test(index) && !/EventSource/.test(index));

  const end = await call("report_end", { status: "done", summary: "landed", draft: closingDraft("Wrap-up") });
  check("report_end closes with a page", end.ok && end.status === "done" && typeof end.durationMs === "number" && /\/6-close$/.test(String(end.url)), JSON.stringify(end).slice(0, 160));
  check("report_end counts the pages", end.pageCount === 3, String(end.pageCount));
  check(
    "the closing reply describes its page the way report_page does",
    typeof end.bytes === "number" && /^[0-9a-f]{64}$/.test(String(end.sha256)) && !!end.am,
    JSON.stringify({ bytes: end.bytes, sha256: String(end.sha256).slice(0, 12), am: end.am }),
  );

  const after = journal(runId);
  check("journal ends with the end record", after[after.length - 1].kind === "end" && after.length === 8, after.map((r) => `${r.kind}#${r.seq}`).join(","));
  check("the closing page is named by its milestone seq", after[6].path === `pages/${runId}/6-close.html` && after[6].for === 6, String(after[6]?.path));

  // The index is derived from the journal on every read, so a late record shows up
  // without the host being told anything. The closing page's title is the run's, not
  // the draft's frontmatter — `report_end` names the page after the report it ends.
  await waitFor(async () => (await (await fetch(host.origin + "/")).text()).includes("收尾"));
  check("the closing page reached the index", (await (await fetch(host.origin + "/")).text()).includes("收尾"));

  const runs = await (await fetch(host.origin + "/api/runs")).json();
  const summary = runs.runs.find((r) => r.runId === runId);
  check("api/runs derives the summary", summary && summary.pageCount === 3 && summary.status === "done" && !summary.pending.length, JSON.stringify(summary && { p: summary.pageCount, s: summary.status }));

  check("stdout carried only JSON-RPC", notifications.every((m) => m.startsWith("notifications/")), "notifications=" + notifications.join(","));

  const syntax = await rpc("tools/call", { name: "report_syntax", arguments: {} });
  const syntaxText = (syntax.content?.[0]?.text || "") + (syntax.content?.[1]?.text || "");
  check("report_syntax returns the renderer's own component list", !syntax.isError && /flow/.test(syntaxText) && /kv/.test(syntaxText), syntaxText.split("\n")[0]);

  const one = await rpc("tools/call", { name: "report_syntax", arguments: { component: "flow" } });
  check("report_syntax names fences on the way fences are named", !one.isError && /```flow/.test(one.content[0].text), String(one.content[0].text).split("\n")[0]);

  // `style` is the one topic the renderer does not answer. The prose rules live in this
  // repo, so they are a constant here — and the same constant goes into the report_page
  // description, which is what makes the two impossible to drift apart.
  const style = await rpc("tools/call", { name: "report_syntax", arguments: { component: "style" } });
  const styleText = String(style.content?.[0]?.text || "");
  check("report_syntax style is the prose rules, not a renderer error", !style.isError && /首句就是事实/.test(styleText) && /——/.test(styleText), styleText.split("\n")[1]);
  check("report_syntax style names what it forbids", /感叹号/.test(styleText) && /「我们」/.test(styleText));

  const pageTool = tools.tools.find((t) => t.name === "report_page");
  check(
    "the prose rules ship inside report_page, so no agent has to ask for them",
    (pageTool.description.match(/首句就是事实/g) || []).length === 1 && /自检：跟仓库自己的 CHANGELOG 对读/.test(pageTool.description),
    `description is ${pageTool.description.length} chars`,
  );
} catch (err) {
  check("no exception", false, String(err && err.stack ? err.stack : err));
} finally {
  client?.close();
  if (host) {
    // SIGTERM, not SIGKILL: removing host.json is the shutdown path's job, and a
    // process that is killed cannot do anything on its way out.
    await host.stop("SIGTERM");
    check("serve removed host.json on exit", !fs.existsSync(path.join(HOME, "host.json")));
  }
  fs.rmSync(HOME, { recursive: true, force: true });
}

finish();
