#!/usr/bin/env node
/**
 * Suite: a bad draft, which is the agent's normal failure.
 *
 * The design bet is that am's own error text — line number, component, a correct
 * example, a pointer to `am help` — is enough for one repair attempt, so this suite
 * asserts that nothing is lost on the way through: the text arrives verbatim, the
 * draft stays in the journal, no page appears, and a retry is simply a new seq.
 */
import fs from "node:fs";
import path from "node:path";

import { connectMcp, makeReport, parseJournalSafe } from "./harness.mjs";
import { BAD_FLOW, sheetDraft } from "./drafts.mjs";

const HOME = path.join(process.cwd(), "test", ".tmp-render-error");
fs.rmSync(HOME, { recursive: true, force: true });

const { check, finish } = makeReport();
const client = await connectMcp({ ...process.env, REPORT_MCP_HOME: HOME });

try {
  const runId = client.runId;
  const { rpc, notify, call, errorText } = client;
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "render-error", version: "0.0.0" } });
  notify("notifications/initialized", {});
  await call("report_start", { title: "Failure path" });

  const bad = await call("report_page", { title: "Broken flow", draft: BAD_FLOW });
  check("a bad draft is a tool error, not a crash", bad.isError === true, JSON.stringify(bad).slice(0, 120));
  const text = errorText(bad);
  check("the renderer's line and component survive", /L\d+ \[flow\]/.test(text), text.split("\n")[0]);
  check("a correct example is passed through", /Correct example:/.test(text));
  check("the pointer to am help is passed through", /am help flow/.test(text));
  check("the reply names the journalled seq", /journalled at seq 2/.test(text), text.split("\n")[0]);

  const recs = parseJournalSafe(path.join(HOME, "runs", `${runId}.jsonl`));
  check("the failed draft is kept", recs.length === 2 && recs[1].kind === "milestone" && recs[1].draft === BAD_FLOW, recs.map((r) => r.kind).join(","));
  check("nothing was published", !recs.some((r) => r.kind === "published"));
  const pages = path.join(HOME, "pages", runId);
  check("no page file exists", !fs.existsSync(pages) || fs.readdirSync(pages).length === 0, fs.existsSync(pages) ? fs.readdirSync(pages).join(",") : "(none)");

  const huge = await call("report_page", { title: "Too big", draft: "x\n".repeat(70 * 1024) });
  check("an oversized draft is refused before the renderer runs", huge.isError === true && /draft-too-large/.test(errorText(huge)), errorText(huge).split("\n")[1]);

  // Retry: history is append-only, so the fix is a new record, not an edit.
  const fixed = await call("report_page", { title: "Fixed flow", draft: sheetDraft("Fixed flow") });
  check("a corrected draft publishes", fixed.ok === true && fixed.seq === 4, JSON.stringify(fixed).slice(0, 100));

  const after = parseJournalSafe(path.join(HOME, "runs", `${runId}.jsonl`));
  check(
    "the journal now reads milestone, milestone, milestone, published",
    after.map((r) => r.kind).join(",") === "start,milestone,milestone,milestone,published",
    after.map((r) => `${r.kind}#${r.seq}`).join(","),
  );
  check("only the successful draft has a page", fs.existsSync(path.join(HOME, after[4].path)), after[4].path);

  // A run must be closable even when its closing page will not render.
  const end = await call("report_end", { status: "failed", summary: "flow draft never parsed", draft: BAD_FLOW });
  check("report_end with a bad closing draft reports the render failure", end.isError === true && /closing page failed to render/.test(errorText(end)), errorText(end).split("\n")[0]);

  const closed = parseJournalSafe(path.join(HOME, "runs", `${runId}.jsonl`));
  const last = closed[closed.length - 1];
  check("and the run is closed anyway", last.kind === "end" && last.status === "failed", JSON.stringify(last && { kind: last.kind, status: last.status }));

  const noDraft = await call("report_end", { status: "done" });
  check("report_end without a draft just closes", noDraft.ok === true && noDraft.page === undefined, JSON.stringify(noDraft).slice(0, 100));
} catch (err) {
  check("no exception", false, String(err && err.stack ? err.stack : err));
} finally {
  client.close();
  fs.rmSync(HOME, { recursive: true, force: true });
}

finish();
