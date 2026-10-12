/**
 * Derive a run's read-only view from its records.
 *
 * Two consumers, one implementation: the MCP process answers `report_*` calls with
 * it, and `report-mcp serve` renders the index page from it. Persisting any of this
 * would be a second answer to "what is in this run", which is the failure the
 * recompute-on-read rule exists to prevent.
 */
export function summarize(runId, records) {
    const first = records[0];
    const last = records[records.length - 1];
    let start;
    let status = "running";
    const published = new Map();
    const drafts = [];
    let failureSummary;
    for (const r of records) {
        if (r.kind === "start")
            start = r;
        else if (r.kind === "end") {
            status = r.status;
            // The end summary is a human-written verdict, kept apart from "a page is missing".
            if (r.status !== "done" && r.summary)
                failureSummary = r.summary;
        }
        else if (r.kind === "milestone") {
            drafts.push({ seq: r.seq, title: r.title, ts: r.ts });
        }
        else if (r.kind === "published") {
            published.set(r.for, {
                // The *milestone's* seq names the file, so it names the URL too. The published
                // record's own seq is one later and has no path in it.
                seq: r.for,
                title: r.title,
                slug: r.slug,
                path: r.path,
                ts: r.ts,
                bytes: r.bytes,
                sha256: r.sha256,
            });
        }
    }
    const pages = [...published.values()].sort((a, b) => a.seq - b.seq);
    const rendered = new Set(pages.map((p) => p.seq));
    const pending = drafts.filter((d) => !rendered.has(d.seq));
    const end = last?.kind === "end" ? last : undefined;
    const startedAt = start?.ts ?? first?.ts;
    const updatedAt = last?.ts;
    const summary = {
        runId,
        title: start?.title ?? "未命名汇报",
        status,
        startedAt,
        updatedAt,
        recordCount: records.length,
        pageCount: pages.length,
        pages,
        pending,
        group: start?.tags?.[0] || start?.agent || "未分组",
    };
    if (start?.agent)
        summary.agent = start.agent;
    if (start?.tags)
        summary.tags = start.tags;
    if (end) {
        summary.endedAt = end.ts;
        if (end.durationMs !== undefined)
            summary.durationMs = end.durationMs;
    }
    else if (startedAt) {
        summary.durationMs = Math.max(0, Date.parse(updatedAt ?? startedAt) - Date.parse(startedAt));
    }
    if (failureSummary)
        summary.failureSummary = failureSummary;
    return summary;
}
//# sourceMappingURL=summarize.js.map