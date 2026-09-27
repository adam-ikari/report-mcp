/**
 * Shared record model.
 *
 * Everything the agent reports is one of six record kinds. The union is
 * append-only: a run is simply an ordered list of `ReportRecord` lines in a
 * JSONL file.
 */
export const EMPTY_LOG_COUNTS = {
    debug: 0,
    info: 0,
    warn: 0,
    error: 0,
};
//# sourceMappingURL=types.js.map