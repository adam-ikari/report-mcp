/**
 * Record and view models.
 *
 * A run is an append-only list of these records, one JSON line each in
 * `$REPORT_MCP_HOME/runs/<runId>.jsonl`. Four kinds: the run's header, a draft the
 * agent submitted, the page that draft became, and the closing record.
 *
 * A `milestone` with no matching `published` is a legitimate end state — the draft
 * was bad, or the renderer was unavailable — and the journal keeps it on purpose:
 * the agent retries as a new record rather than rewriting history.
 */
export {};
//# sourceMappingURL=types.js.map