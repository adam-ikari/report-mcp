#!/usr/bin/env node
/**
 * Suite: the optional remote mirror.
 *
 * Two halves, because they can fail independently:
 *
 *   a. the Worker itself, run for real under miniflare (workerd) with KV and R2
 *      bindings, driven by the *actual* agent mirror over HTTP
 *   b. the mirror's own contract — that it cannot affect a tool call, that it
 *      bounds its queue, that it is off unless fully configured
 *
 * The Worker half is the point of the suite. A Worker that is only ever
 * typechecked is a Worker nobody has run; the previous deploy-only verifier
 * rotted for exactly that reason, so this one is in `npm test`.
 *
 * `summarize()` is shared with the server rather than reimplemented, so the
 * mirror cannot answer "what is this run's status" differently from local.
 */
import { Miniflare } from "miniflare";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, rm } from "node:fs/promises";

import { connectMcp, waitFor } from "./harness.mjs";
import { RemoteMirror, mirrorFromEnv } from "../dist/remote.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const TOKEN = "test-token-0123456789";
// Pinned to the oldest date the installed workerd still accepts: a newer date
// fails at boot with "newest date supported by this server binary".
const COMPAT_DATE = "2026-08-06";

let passed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) passed++;
  else failures.push(name);
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra != null ? "  " + extra : ""}`);
}

/* ---------------------------------------------------------------- worker up */

const workerOut = path.join(here, ".tmp-worker", "index.js");
await build({
  entryPoints: [path.join(root, "worker", "src", "index.ts")],
  outfile: workerOut,
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  mainFields: ["module", "main"],
  conditions: ["workerd", "worker", "browser"],
  logLevel: "error",
});

const mf = new Miniflare({
  modules: true,
  scriptPath: workerOut,
  // No `assets` binding on purpose — the Worker serves the panel itself, which is
  // what makes this suite test the deployed code path. Miniflare 4 never falls
  // through to the Worker on an asset miss, so an assets-binding Worker could not
  // be tested at all.
  kvNamespaces: { REPORTS: "test-reports" },
  r2Buckets: { ARTIFACTS: "test-artifacts" },
  bindings: { TOKEN, MIRROR_LABEL: "report-mcp mirror (test)" },
  compatibilityDate: COMPAT_DATE,
});

// mf.ready is a URL object, not a string.
const ORIGIN = String(await mf.ready);
// miniflare's HTTP server is in-process, so the real `fetch` cannot reach it.
// Routing the mirror's requests through dispatchFetch keeps the mirror's own
// code path (batching, auth header, timeouts, error handling) fully exercised.
const dispatch = (u, i) => mf.dispatchFetch(String(u), i);
const api = (p, init) => dispatch(ORIGIN + p, init);
const authed = (extra = {}) => ({ headers: { authorization: `Bearer ${TOKEN}`, ...(extra.headers ?? {}) }, ...extra });

const rec = (over = {}) => ({
  id: `id-${Math.random().toString(36).slice(2, 10)}`,
  runId: "run_remote_0001",
  seq: 1,
  ts: new Date().toISOString(),
  kind: "log",
  level: "info",
  message: "hello",
  ...over,
});

try {
  /* ---- 1. auth is enforced ---- */
  console.log("--- token gate ---");
  check("reads without a token are 401", (await api("/api/runs")).status === 401);
  check("writes without a token are 401",
    (await api("/api/runs/run_remote_0001/records", { method: "PUT", body: JSON.stringify({ records: [rec()] }) })).status === 401);
  check("a wrong token is 401", (await api("/api/runs", { headers: { authorization: "Bearer nope" } })).status === 401);
  check("health is open (the panel boots on it)", (await api("/api/health")).status === 200);
  const shell = await api("/");
  check("the panel shell needs the token", shell.status === 401, "status=" + shell.status);

  // The cookie handshake is what keeps the secret out of the address bar.
  const login = await api(`/?token=${TOKEN}`, { redirect: "manual" });
  check("login sets an HttpOnly cookie and redirects",
    login.status === 302 && /rmp=/.test(login.headers.get("set-cookie") ?? "") &&
      /HttpOnly/.test(login.headers.get("set-cookie") ?? ""),
    login.headers.get("set-cookie"));

  /* ---- 2. a real push from the real mirror ---- */
  console.log("\n--- round trip: agent mirror → Worker → panel API ---");
  const RUN = "run_remote_0001";
  const mirror = new RemoteMirror({
    baseUrl: ORIGIN,
    token: TOKEN,
    cwd: root,
    flushMs: 5,
    fetchImpl: dispatch,
  });
  const t0 = Date.now();
  mirror.push(rec({ id: "r1", seq: 1, kind: "start", title: "远端镜像冒烟", agent: "ci-agent", tags: ["remote"] }));
  mirror.push(rec({ id: "r2", seq: 2, kind: "progress", phase: "跑", percent: 50, level: undefined, message: undefined }));
  mirror.push(rec({ id: "r3", seq: 3, kind: "log", level: "error", message: "boom" }));
  await mirror.close();
  check("push() returned before the network did", Date.now() - t0 < 200, `${Date.now() - t0}ms`);
  check("mirror reports what it pushed", mirror.stats.pushed === 3 && mirror.stats.failed === 0,
    JSON.stringify(mirror.stats));

  // Read back the way the panel does: bearer on the fetch side.
  const runsRes = await api("/api/runs", authed());
  const runs = await runsRes.json();
  check("Worker lists the run", runs.some((r) => r.runId === RUN), JSON.stringify(runs.map((r) => r.runId)));
  const sum = runs.find((r) => r.runId === RUN);
  check("summary is derived, not stored: title from the start record", sum?.title === "远端镜像冒烟", sum?.title);
  check("summary sees the log levels", sum?.logCounts?.error === 1 && sum?.logCounts?.info === 0,
    JSON.stringify(sum?.logCounts));
  check("summary carries the latest progress", sum?.progress?.percent === 50, JSON.stringify(sum?.progress));
  check("summary surfaces lastError", sum?.lastError === "boom", sum?.lastError);

  const one = await (await api(`/api/runs/${RUN}`, authed())).json();
  check("full run returns all 3 records in seq order",
    one.records.length === 3 && one.records.map((r) => r.seq).join(",") === "1,2,3",
    one.records.map((r) => r.seq).join(","));
  check("run is still 'running' with no end record", one.summary.status === "running", one.summary.status);

  /* ---- 3. idempotency: a retried batch must not duplicate ---- */
  console.log("\n--- idempotency ---");
  const again = new RemoteMirror({ baseUrl: ORIGIN, token: TOKEN, cwd: root, flushMs: 5 });
  again.push(rec({ id: "r3", seq: 3, kind: "log", level: "error", message: "boom" }));
  again.push(rec({ id: "r4", seq: 4, kind: "end", status: "done", summary: "好", durationMs: 1000 }));
  await again.close();
  const after = await (await api(`/api/runs/${RUN}`, authed())).json();
  check("a retried record is not duplicated", after.records.length === 4, "n=" + after.records.length);
  check("the end record flips the status", after.summary.status === "done", after.summary.status);
  check("duration comes from the end record", after.summary.durationMs === 1000, String(after.summary.durationMs));

  /* ---- 4. out-of-order arrival ---- */
  console.log("\n--- out-of-order push ---");
  const ooo = new RemoteMirror({ baseUrl: ORIGIN, token: TOKEN, cwd: root, flushMs: 5 });
  // seq 6 before seq 5, in separate batches.
  ooo.push(rec({ id: "r6", seq: 6, kind: "log", level: "info", message: "later" }));
  await ooo.flush();
  ooo.push(rec({ id: "r5", seq: 5, kind: "log", level: "info", message: "middle" }));
  await ooo.flush();
  const oooRun = await (await api(`/api/runs/${RUN}`, authed())).json();
  check("a late record lands in seq position, not at the end",
    oooRun.records.map((r) => r.seq).join(",") === "1,2,3,4,5,6",
    oooRun.records.map((r) => r.seq).join(","));

  /* ---- 5. junk is rejected, not stored ---- */
  console.log("\n--- input validation ---");
  const bad = await api(`/api/runs/${RUN}/records`, authed({ method: "PUT", body: JSON.stringify({ records: "nope" }) }));
  check("a non-array body is 400", bad.status === 400, "status=" + bad.status);
  const badRec = await api(`/api/runs/${RUN}/records`, authed({
    method: "PUT",
    body: JSON.stringify({ records: [{ nope: true }, rec({ id: "good", seq: 7, kind: "log", level: "info", message: "ok" })] }),
  }));
  check("malformed records are filtered, valid ones kept", (await badRec.json()).stored === 1);
  const badId = await api("/api/runs/..%2Fetc/records", authed({ method: "PUT", body: JSON.stringify({ records: [rec()] }) }));
  check("a traversal-shaped run id is 400", badId.status === 400, "status=" + badId.status);

  /* ---- 6. the panel loads against the Worker, unchanged ---- */
  console.log("\n--- the panel is served, unmodified ---");
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const withCookie = { headers: { cookie } };
  const shellOk = await api("/", withCookie);
  const shellHtml = await shellOk.text();
  check("shell served once authenticated", shellOk.status === 200, "status=" + shellOk.status);
  check("shell is the same build the local panel uses",
    shellHtml.includes('id="root"') && shellHtml.includes("panel.js"));
  const js = await api("/panel.js", withCookie);
  check("the bundle is served beside it", js.ok && js.headers.get("content-type").includes("javascript"),
    "status=" + js.status);
  // The panel is in live mode iff /api/runs answers JSON — which is what makes
  // this Worker need zero panel changes.
  const live = await api("/api/runs", withCookie);
  check("panel's live-mode probe gets JSON, so no front-end change was needed",
    live.ok && (live.headers.get("content-type") || "").includes("json"), live.headers.get("content-type"));

  /* ---- 7. artifacts go through R2, and only when asked ---- */
  console.log("\n--- artifacts ---");
  const before = (await (await api(`/api/runs/${RUN}`, authed())).json()).records.length;
  const noFiles = new RemoteMirror({ baseUrl: ORIGIN, token: TOKEN, cwd: root, flushMs: 5 });
  noFiles.push(rec({ id: "a1", seq: 8, kind: "result", level: undefined, message: undefined, title: "图", artifacts: [{ name: "chart", path: "public/index.html", type: "image" }] }));
  await noFiles.close();
  const noR2 = await (await api(`/api/runs/${RUN}`, authed())).json();
  check("the result record is still stored with its artifact", noR2.records.length === before + 1,
    `records=${noR2.records.length} want=${before + 1}`);
  check("the artifact is NOT uploaded unless opted in (it is a disclosure decision)",
    (await api(`/api/file?run=${RUN}&seq=8&i=0`, authed())).status === 404);

  const withFiles = new RemoteMirror({ baseUrl: ORIGIN, token: TOKEN, cwd: root, files: true, flushMs: 5 });
  withFiles.push(rec({ id: "a2", seq: 9, kind: "result", level: undefined, message: undefined, title: "图", artifacts: [{ name: "chart", path: "public/index.html", type: "image" }] }));
  await withFiles.close();
  const fileRes = await api(`/api/file?run=${RUN}&seq=9&i=0`, authed());
  const fileBody = fileRes.status === 200 ? await fileRes.text() : "";
  check("an opted-in artifact is readable through /api/file", fileRes.status === 200, "status=" + fileRes.status);
  check("a non-image artifact is text/plain + nosniff, like the local handler",
    (fileRes.headers.get("content-type") || "").startsWith("text/plain") &&
      fileRes.headers.get("x-content-type-options") === "nosniff",
    fileRes.headers.get("content-type"));
  check("the bytes round-tripped", fileBody.includes('id="root"'), fileBody.length + " chars");
  check("a bad (run, seq, i) is rejected", (await api(`/api/file?run=${RUN}&seq=x&i=0`, authed())).status === 400);

  /* ---- 8. the stream is what the panel actually listens to ---- */
  console.log("\n--- SSE ---");
  const ac = new AbortController();
  const sse = await dispatch(`${ORIGIN}/api/stream?run=${RUN}`, {
    headers: { ...authed().headers, accept: "text/event-stream" },
    signal: ac.signal,
  });
  check("stream responds as text/event-stream",
    sse.ok && (sse.headers.get("content-type") || "").includes("text/event-stream"),
    sse.headers.get("content-type"));
  const reader = sse.body.getReader();
  const dec = new TextDecoder();
  let seen = "";
  // Read until the first `runs` event: that proves the panel's reconnect path
  // gets records, not just an open socket.
  const gotSome = (async () => {
    while (!seen.includes("event: runs")) {
      const { value, done } = await reader.read();
      if (done) return false;
      seen += dec.decode(value, { stream: true });
      if (seen.length > 200000) return false;
    }
    return true;
  })();
  check("stream replays the run's records then the run list",
    (await Promise.race([gotSome, new Promise((r) => setTimeout(() => r(false), 6000))])) &&
      seen.includes("event: record") && seen.includes('"runId":"' + RUN + '"'),
    seen.slice(0, 80).replace(/\n/g, " "));
  check("records are framed as SSE, one JSON object per event",
    /event: record\ndata: \{[^\n]*"seq"/.test(seen), "framing ok");
  ac.abort();

  /* ---- 10. the whole path, through a real MCP server process ---- */
  console.log("\n--- end to end: a real agent process pushing to the real Worker ---");
  // Everything above drives the mirror class directly. This spawns the actual
  // server binary, calls the actual tools over stdio, and lets the ordinary
  // shutdown path flush — so the wiring in src/index.ts and src/server.ts is
  // covered too, not just the class.
  //
  // miniflare's workerd listens on a real port, so the child process reaches it
  // with plain fetch; no transport shim needed here.
  const E2E_RUN = "run_remote_e2e_0002";
  const E2E_HOME = path.join(here, ".tmp-remote-home");
  const child = await connectMcp({
    ...process.env,
    REPORT_MCP_HOME: E2E_HOME,
    REPORT_MCP_PORT: "0",
    REPORT_MCP_RUN_ID: E2E_RUN,
    REPORT_MCP_REMOTE: ORIGIN,
    REPORT_MCP_REMOTE_TOKEN: TOKEN,
  });
  check("the server announces the mirror on stderr", /\[report-mcp\] mirror\s+\S+/.test(child.stderr),
    (child.stderr.match(/\[report-mcp\] mirror.*/) || ["(none)"])[0]);
  check("the local panel URL is still the loopback one", !!child.panelUrl?.startsWith("http://127.0.0.1:"),
    String(child.panelUrl));

  await child.call("report_start", { title: "真实 agent 推到 Worker", agent: "e2e-agent", tags: ["remote"] });
  await child.call("report_progress", { phase: "推送", percent: 40 });
  await child.call("report_log", { level: "warn", message: "远端链路抖了一下" });
  const end = await child.call("report_end", { status: "done", summary: "镜像成功" });
  check("tool calls succeed with a mirror configured", end.ok === true, JSON.stringify(end).slice(0, 120));

  // SIGTERM runs the shutdown handler, which is what flushes the queue.
  child.proc.kill("SIGTERM");
  const arrived = await waitFor(async () => {
    const r = await api(`/api/runs/${E2E_RUN}`, authed()).catch(() => null);
    if (!r || !r.ok) return false;
    return (await r.json()).records.length === 4;
  }, 15000);
  check("all 4 records reached the Worker", arrived, "flush on shutdown");
  child.close();

  const mirrored = await (await api(`/api/runs/${E2E_RUN}`, authed())).json();
  check("the Worker agrees the run finished", mirrored.summary.status === "done", mirrored.summary.status);
  check("the Worker-derived summary matches what the agent reported",
    mirrored.summary.title === "真实 agent 推到 Worker" &&
      mirrored.summary.agent === "e2e-agent" &&
      mirrored.summary.logCounts.warn === 1 &&
      mirrored.summary.recordCount === 4,
    JSON.stringify({ t: mirrored.summary.title, a: mirrored.summary.agent, w: mirrored.summary.logCounts.warn }));
  const localText = await readFile(path.join(E2E_HOME, "runs", `${E2E_RUN}.jsonl`), "utf8");
  check("the local JSONL still holds every record — the mirror replaced nothing",
    localText.trim().split("\n").length === 4, "local lines=" + localText.trim().split("\n").length);

  /* ---- 11. the mirror cannot affect a tool call ---- */
  console.log("\n--- the mirror is fire-and-forget ---");
  const down = new RemoteMirror({
    baseUrl: "http://127.0.0.1:1", token: "x", cwd: root, flushMs: 5, timeoutMs: 200,
    log: () => {},
  });
  const t1 = Date.now();
  down.push(rec({ id: "z1" }));
  const pushMs = Date.now() - t1;
  check("push() against a dead mirror returns immediately", pushMs < 50, `${pushMs}ms`);
  await down.close();
  check("a dead mirror does not throw out of close()", down.stats.failed === 1, JSON.stringify(down.stats));
  check("the failure is recorded with a reason", !!down.stats.lastError, down.stats.lastError);

  const bounded = new RemoteMirror({ baseUrl: "http://127.0.0.1:1", token: "x", cwd: root, maxQueue: 10, flushMs: 100000 });
  for (let i = 0; i < 50; i++) bounded.push(rec({ id: `q${i}` }));
  check("the queue is bounded and the overflow is counted, not the heap",
    bounded.stats.dropped === 40, "dropped=" + bounded.stats.dropped);

  /* ---- 9. off unless fully configured ---- */
  console.log("\n--- configuration gate ---");
  check("no env → no mirror", mirrorFromEnv({}) === null);
  check("URL without token → no mirror (a half-configured mirror 401s forever)",
    mirrorFromEnv({ REPORT_MCP_REMOTE: ORIGIN }) === null);
  check("token without URL → no mirror", mirrorFromEnv({ REPORT_MCP_REMOTE_TOKEN: TOKEN }) === null);
  check("both → mirror", mirrorFromEnv({ REPORT_MCP_REMOTE: ORIGIN, REPORT_MCP_REMOTE_TOKEN: TOKEN }) !== null);
} catch (err) {
  check("suite completed without throwing", false, err instanceof Error ? err.stack : String(err));
} finally {
  await mf.dispose();
  await rm(path.join(here, ".tmp-worker"), { recursive: true, force: true });
  await rm(path.join(here, ".tmp-remote-home"), { recursive: true, force: true });
}

const failed = failures.length;
console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
