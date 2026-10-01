import type { EndRecord, ReportRecord, RunStatus, RunSummary, StartRecord } from "./types.js";
import { EMPTY_LOG_COUNTS } from "./types.js";

/**
 * Derive a run's read-only view from its records.
 *
 * Lives in its own module, with no Node imports, because **two runtimes execute
 * it**: the MCP server (reading JSONL off disk) and the optional Cloudflare
 * Worker mirror (reading records out of KV). A second copy would be a second
 * answer to "what is this run's status", which is the exact failure the
 * `RunSummary`-is-never-persisted rule exists to prevent.
 *
 * The panel has a third implementation, `derive()` in panel/src/lib/derive.js —
 * a JavaScript mirror, because the panel cannot import the server's build. That
 * one is guarded by test/render.mjs and test/static.mjs instead, and it derives
 * from raw records too, so all three see the same input and must agree.
 */
export function summarize(runId: string, records: ReportRecord[]): RunSummary {
  const first = records[0];
  const last = records[records.length - 1];

  const startRecs = records.filter((r): r is StartRecord => r.kind === "start");
  const start = startRecs[startRecs.length - 1];

  let status: RunStatus = "running";
  for (const r of records) {
    if (r.kind === "status") status = r.status;
    else if (r.kind === "end") status = r.status;
  }

  const logCounts = { ...EMPTY_LOG_COUNTS };
  let resultCount = 0;
  let lastError: string | undefined;
  let failureSummary: string | undefined;
  let progress: RunSummary["progress"];

  for (const r of records) {
    if (r.kind === "log") {
      logCounts[r.level]++;
      if (r.level === "error") lastError = r.message;
    } else if (r.kind === "status" && r.status === "error" && r.message) lastError = r.message;
    else if (r.kind === "result") resultCount++;
    else if (r.kind === "end") {
      // Keep lastError pointing at the actual error signal; the end summary is
      // a separate, human-written verdict.
      if (r.status !== "done" && r.summary) failureSummary = r.summary;
    } else if (r.kind === "progress") {
      progress = {
        phase: r.phase,
        percent: r.percent ?? null,
        step: r.step,
        totalSteps: r.totalSteps,
        message: r.message,
      };
    }
  }

  const end = last?.kind === "end" ? (last as EndRecord) : undefined;
  const startedAt = start?.ts ?? first?.ts;
  const updatedAt = last?.ts;

  const summary: RunSummary = {
    runId,
    title: start?.title ?? "Untitled run",
    status,
    startedAt,
    updatedAt,
    recordCount: records.length,
    logCounts,
    resultCount,
  };
  if (start?.agent) summary.agent = start.agent;
  if (start?.tags) summary.tags = start.tags;
  if (end) {
    summary.endedAt = end.ts;
    if (end.durationMs !== undefined) summary.durationMs = end.durationMs;
  } else if (startedAt) {
    summary.durationMs = Math.max(0, Date.parse(updatedAt ?? startedAt) - Date.parse(startedAt));
  }
  if (progress) summary.progress = progress;
  if (lastError) summary.lastError = lastError;
  if (failureSummary) summary.failureSummary = failureSummary;
  return summary;
}
