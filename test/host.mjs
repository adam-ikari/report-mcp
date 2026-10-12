#!/usr/bin/env node
/**
 * Suite: the host's routing table and its security edges.
 *
 * The host used to be a live panel with a CORS wildcard, an artifact file endpoint, and
 * an SSE stream. All three are gone, and this suite is what keeps them gone: a report
 * page that is framable, or a journal readable from another subnet, is a disclosure —
 * not a bug in a feature nobody used.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { connectMcp, freePort, makeReport, startServe, waitFor } from "./harness.mjs";
import { sheetDraft } from "./drafts.mjs";

const HOME = path.join(process.cwd(), "test", ".tmp-host");
fs.rmSync(HOME, { recursive: true, force: true });

const { check, finish } = makeReport();
const port = await freePort();
const clients = [];
let host = null;

/** The first non-internal IPv4 this machine has — i.e. "not loopback", from the kernel's view. */
function lanIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal && !ni.address.startsWith("169.254.")) return ni.address;
    }
  }
  return null;
}

try {
  // Two runs in one home, published through the real pipeline: the index has to group
  // by run, and one run is not a grouping.
  const runs = [];
  for (const [tag, title] of [["infra", "First report"], ["research", "Second report"]]) {
    const c = await connectMcp({ ...process.env, REPORT_MCP_HOME: HOME });
    clients.push(c);
    await c.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "host", version: "0.0.0" } });
    c.notify("notifications/initialized", {});
    const start = await c.call("report_start", { title, tags: [tag] });
    const page = await c.call("report_page", { title: `${title} · page`, draft: sheetDraft(title) });
    check(`published a page for ${tag}`, page.ok === true, String(page.error || page.page));
    runs.push({ runId: start.runId, page });
  }

  host = await startServe({ home: HOME, port });
  const origin = host.origin;
  const { runId, page } = runs[0];
  const ref = path.basename(page.page, ".html"); // "<seq>-<slug>", the route's second segment
  const good = `${origin}/r/${runId}/${ref}`;

  check("GET /r/<runId>/<seq>-<slug> serves the page", (await fetch(good)).ok, good);
  check("the same page with .html also resolves", (await fetch(good + ".html")).ok);
  check("HEAD works and sends no body", await (async () => {
    // fetch advertises gzip, so the length is the compressed one: assert the body is
    // empty and the header is a plausible page size, not an exact byte count.
    const r = await fetch(good, { method: "HEAD" });
    return r.ok && Number(r.headers.get("content-length")) > 10_000 && (await r.text()) === "";
  })());

  // --- the path never comes from the client ---
  check("percent-encoded traversal is 404", (await fetch(`${origin}/r/${runId}/..%2f..%2f..%2fetc%2fpasswd`)).status === 404);
  check("raw traversal is 404", (await fetch(`${origin}/r/..%2F..%2Fetc/passwd`)).status === 404);
  check("a run id that is not a filename is 404", (await fetch(`${origin}/r/no_such_run/1-page`)).status === 404);
  check("a non-integer seq is 404", (await fetch(`${origin}/r/${runId}/x-page`)).status === 404);
  check("a slug with a separator is 404", (await fetch(`${origin}/r/${runId}/1-a%2fb`)).status === 404);
  check("a three-segment route is 404", (await fetch(`${origin}/r/${runId}/1-page/extra`).then((r) => r.status)) === 404);
  check("an unknown top-level route is 404", (await fetch(`${origin}/nope`)).status === 404);

  // A symlink inside pages/ is the only way out of a directory the agent controls.
  const link = path.join(HOME, "pages", runId, "99-escape.html");
  fs.writeFileSync(path.join(HOME, "secret.txt"), "do not read me");
  try {
    fs.symlinkSync(path.join(HOME, "secret.txt"), link);
  } catch {
    /* platform without symlinks: the check below says so */
  }
  const esc = await fetch(`${origin}/r/${runId}/99-escape`);
  const escText = await esc.text();
  check("a symlink out of pages/ is refused", esc.status === 404 || !escText.includes("do not read me"), `${esc.status}`);

  // --- read-only, and quiet about it ---
  check("POST is refused", (await fetch(good, { method: "POST", body: "x" })).status === 405);
  check("no CORS wildcard anywhere", (await fetch(good)).headers.get("access-control-allow-origin") === null);
  check("page frames are refused", (await fetch(good)).headers.get("x-frame-options") === "DENY");

  // --- journals are for this machine ---
  const runsJson = await (await fetch(`${origin}/api/runs`)).json();
  check("GET /api/runs is loopback JSON", Array.isArray(runsJson.runs) && runsJson.runs.length === 2, JSON.stringify(runsJson.runs?.map((r) => r.title)));
  check("GET /api/runs/:id returns the drafts", (await (await fetch(`${origin}/api/runs/${runId}`)).json()).records.some((r) => r.kind === "milestone"));
  check("GET /api/runs with a bad id is 400", (await fetch(`${origin}/api/runs/not%20an%20id`)).status === 400);

  const lan = lanIPv4();
  if (lan) {
    const wide = await startServe({ home: HOME, port: await freePort(), host: "0.0.0.0" });
    try {
      const off = await fetch(`http://${lan}:${wide.port}/api/runs`).catch(() => null);
      check("a non-loopback client does not get the journal", !off || off.status === 404, off ? String(off.status) : "no route");
      const idx = await (await fetch(`http://${lan}:${wide.port}/`)).text();
      check("the index warns when the host is bound wide", idx.includes("没有鉴权"), idx.slice(0, 60));
      check("a bound-wide host still serves its pages off loopback", (await fetch(`http://127.0.0.1:${wide.port}/r/${runId}/${ref}`)).ok);
      check("and it advertises the LAN address first", wide.health.urls[0] === `http://${lan}:${wide.port}` || /^http:\/\/(192\.168\.|10\.|172\.)/.test(wide.health.urls[0]), JSON.stringify(wide.health.urls));
    } finally {
      await wide.stop("SIGTERM");
    }
  } else {
    console.log("SKIP  non-loopback checks (this machine has no LAN IPv4 address)");
  }

  // --- the index is a list, not an app ---
  const index = await (await fetch(`${origin}/`)).text();
  check("index groups by tag", index.includes(">infra<") && index.includes(">research<"));
  check("index lists both run titles", index.includes("First report") && index.includes("Second report"));
  check("index has no inline event stream or module script", !/<script/i.test(index));
  check(
    "timestamps are fixed-format, not the server's locale",
    /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(index) && !/[AP]M\b/.test(index),
    (index.match(/开始[^<]*/) || [""])[0],
  );

  // A journal is data on disk, not a typed value: an `end` written by another build can
  // carry a status this version's union does not have. The index must show it, not print
  // the string "undefined" into a badge a human reads.
  fs.mkdirSync(path.join(HOME, "runs"), { recursive: true });
  fs.writeFileSync(
    path.join(HOME, "runs", "run_foreign_000001.jsonl"),
    [
      JSON.stringify({ id: "f1", runId: "run_foreign_000001", seq: 1, ts: "2026-01-01T00:00:00.000Z", kind: "start", title: "Foreign run" }),
      JSON.stringify({ id: "f2", runId: "run_foreign_000001", seq: 2, ts: "2026-01-01T00:01:00.000Z", kind: "end", status: "success", summary: "from an older build" }),
      "",
    ].join("\n"),
  );
  const withForeign = await (await fetch(`${origin}/`)).text();
  check("an unknown status is shown as what it says, never as undefined", !withForeign.includes("undefined") && withForeign.includes("Foreign run") && withForeign.includes("success"), withForeign.match(/badge[^>]*>[^<]*/g)?.join(" | "));

  // A page added after the host started must show up with no notification at all.
  const c = clients[0];
  const late = await c.call("report_page", { title: "Late page", slug: "late", draft: sheetDraft("Late page") });
  check("a page published while the host runs is served at once", await waitFor(async () => (await fetch(`${origin}/r/${late.runId}/${path.basename(late.page, ".html")}`)).ok));
  check("and it reaches the index", await waitFor(async () => (await (await fetch(`${origin}/`)).text()).includes("Late page")));
} catch (err) {
  check("no exception", false, String(err && err.stack ? err.stack : err));
} finally {
  for (const c of clients) c.close();
  if (host) await host.stop("SIGTERM");
  fs.rmSync(HOME, { recursive: true, force: true });
}

finish();
