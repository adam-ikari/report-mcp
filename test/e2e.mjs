#!/usr/bin/env node
/**
 * Suite: two MCP processes writing one run.
 *
 * This is the append-only guarantee under the only concurrency the tool actually
 * sees: several agents sharing `REPORT_MCP_RUN_ID`, each awaiting its own tool calls.
 * The seq re-sync (compare the file size, recount the lines) is what keeps their
 * records from colliding, and a page named by its milestone seq is what keeps their
 * *files* from colliding.
 *
 * It also covers the crash case: a writer killed mid-session, and a new process that
 * must pick up the numbering from the file rather than from memory.
 */
import fs from "node:fs";
import path from "node:path";

import { connectMcp, freePort, makeReport, parseJournalSafe, startServe, waitFor } from "./harness.mjs";
import { sheetDraft } from "./drafts.mjs";

const HOME = path.join(process.cwd(), "test", ".tmp-e2e");
fs.rmSync(HOME, { recursive: true, force: true });
const RUN = "run_e2e_shared_000001";

const { check, finish } = makeReport();
const clients = [];
let host = null;

async function agent(name, tag) {
  const c = await connectMcp({ ...process.env, REPORT_MCP_HOME: HOME, REPORT_MCP_RUN_ID: RUN });
  clients.push(c);
  await c.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name, version: "0" } });
  c.notify("notifications/initialized", {});
  return c;
}

/** Both agents run at the same time; the awaits inside each call keep the writes interleaved. */
async function publishPages(c, n, label) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    out.push(await c.call("report_page", { title: `${label} ${i}`, slug: `${label}-${i}`, draft: sheetDraft(`${label} page ${i}`) }));
  }
  return out;
}

try {
  const a = await agent("e2e-a", "alpha");
  const b = await agent("e2e-b", "beta");
  check("both processes share one run id", a.runId === RUN && b.runId === RUN, `${a.runId} / ${b.runId}`);

  await a.call("report_start", { title: "Two agents, one run", tags: ["e2e"] });

  const [pa, pb] = await Promise.all([publishPages(a, 3, "alpha"), publishPages(b, 3, "beta")]);
  check("every page published", [...pa, ...pb].every((p) => p.ok === true), JSON.stringify([...pa, ...pb].filter((p) => !p.ok).map((p) => p.error)).slice(0, 200));

  // one start + six milestones + six published records
  const JOURNAL = path.join(HOME, "runs", `${RUN}.jsonl`);
  await waitFor(() => parseJournalSafe(JOURNAL).length === 13, { timeout: 30000 });
  const recs = parseJournalSafe(JOURNAL);

  check("the journal holds 13 records with no torn line", recs.length === 13 && !recs.some((r) => r.kind === "UNPARSEABLE"), `${recs.length} records`);
  const seqs = recs.map((r) => r.seq).sort((x, y) => x - y);
  check("seq is unique across both writers", new Set(seqs).size === seqs.length, seqs.join(","));
  check("seq has no gap", seqs.every((s, i) => s === i + 1), seqs.join(","));
  check("every record carries the shared run id", recs.every((r) => r.runId === RUN));
  check("milestones and published records pair up", recs.filter((r) => r.kind === "milestone").length === 6 && recs.filter((r) => r.kind === "published").length === 6);

  const files = fs.readdirSync(path.join(HOME, "pages", RUN)).sort();
  check("six pages, six files, no overwrite", files.length === 6, files.join(","));
  check("each page is named by its own milestone seq", files.every((f) => /^\d+-(alpha|beta)-\d\.html$/.test(f)), files.join(","));
  const refs = new Set(recs.filter((r) => r.kind === "published").map((r) => r.path));
  check("no two published records share a path", refs.size === 6, String(refs.size));

  // --- a writer dies mid-run; the next one must re-sync from the file ---
  const before = parseJournalSafe(path.join(HOME, "runs", `${RUN}.jsonl`)).length;
  a.proc.kill("SIGKILL");
  await waitFor(() => a.proc.exitCode !== null);
  const c = await agent("e2e-c", "gamma");
  const late = await c.call("report_page", { title: "After the crash", slug: "gamma-1", draft: sheetDraft("gamma after crash") });
  check("a new writer continues the numbering", late.ok === true && late.seq > before, `seq=${late.seq} before=${before}`);
  const after = parseJournalSafe(path.join(HOME, "runs", `${RUN}.jsonl`));
  const afterSeqs = after.map((r) => r.seq);
  check("still no duplicates after the restart", new Set(afterSeqs).size === afterSeqs.length, afterSeqs.sort((x, y) => x - y).join(","));
  check("the crashed agent's records survived", after.filter((r) => r.kind === "milestone" && r.title.startsWith("alpha")).length === 3);

  // --- the host reads the same journal both writers built ---
  host = await startServe({ home: HOME, port: await freePort() });
  const detail = await (await fetch(`${host.origin}/api/runs/${RUN}`)).json();
  check("the derived summary counts all seven pages", detail.summary.pageCount === 7, String(detail.summary.pageCount));
  check("and finds nothing pending", detail.summary.pending.length === 0, JSON.stringify(detail.summary.pending));
  check("status is still running with no end record", detail.summary.status === "running");
  await c.call("report_end", { status: "done", summary: "two agents, one journal" });
  check("the index reflects the close", await waitFor(async () => (await (await fetch(`${host.origin}/api/runs`)).json()).runs.some((r) => r.status === "done")));
} catch (err) {
  check("no exception", false, String(err && err.stack ? err.stack : err));
} finally {
  for (const cl of clients) cl.close();
  if (host) await host.stop("SIGTERM");
  fs.rmSync(HOME, { recursive: true, force: true });
}

finish();
