/**
 * Mirror of the server-side summariser (src/store.ts), so the header updates
 * instantly on SSE without waiting for a refetch.
 *
 * It MUST stay a mirror rather than a second source of truth: the demo bundle
 * ships raw records only, so `derive()` is the single place a RunSummary comes
 * from in both live and static mode. If the two implementations disagree, the
 * panel shows one status and the API another.
 */
export function derive(runId, records) {
  const starts = records.filter((r) => r.kind === "start");
  const start = starts[starts.length - 1];

  let status = "running";
  for (const r of records) {
    if (r.kind === "status") status = r.status;
    else if (r.kind === "end") status = r.status;
  }

  const logCounts = { debug: 0, info: 0, warn: 0, error: 0 };
  let resultCount = 0,
    lastError,
    failureSummary,
    progress;
  for (const r of records) {
    if (r.kind === "log") {
      logCounts[r.level]++;
      if (r.level === "error") lastError = r.message;
    } else if (r.kind === "status" && r.status === "error" && r.message) lastError = r.message;
    else if (r.kind === "result") resultCount++;
    else if (r.kind === "progress")
      progress = {
        phase: r.phase,
        percent: r.percent ?? null,
        step: r.step,
        totalSteps: r.totalSteps,
        message: r.message,
      };
    else if (r.kind === "end" && r.status !== "done" && r.summary) failureSummary = r.summary;
  }

  const first = records[0],
    last = records[records.length - 1];
  const end = last && last.kind === "end" ? last : null;
  const startedAt = (start && start.ts) || (first && first.ts);

  return {
    runId,
    title: (start && start.title) || "Untitled run",
    agent: start && start.agent,
    tags: start && start.tags,
    status,
    startedAt,
    updatedAt: last && last.ts,
    endedAt: end && end.ts,
    durationMs:
      end && end.durationMs != null
        ? end.durationMs
        : startedAt
          ? Date.parse((last && last.ts) || startedAt) - Date.parse(startedAt)
          : undefined,
    recordCount: records.length,
    progress,
    logCounts,
    resultCount,
    lastError,
    failureSummary,
  };
}
