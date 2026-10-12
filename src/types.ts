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

/** Terminal statuses, set by `report_end`. */
export type EndStatus = "done" | "failed" | "aborted";

export type RunStatus = "running" | EndStatus;

export type RecordKind = "start" | "milestone" | "published" | "end";

interface BaseRecord {
  id: string;
  runId: string;
  /** Monotonic per run, 1-based. */
  seq: number;
  /** ISO-8601 timestamp. */
  ts: string;
}

export interface StartRecord extends BaseRecord {
  kind: "start";
  title: string;
  agent?: string;
  task?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

/** A draft as submitted, before anybody tried to render it. */
export interface MilestoneRecord extends BaseRecord {
  kind: "milestone";
  title: string;
  /** The answer-me-with-html draft: frontmatter + `##` panels + fenced components. */
  draft: string;
  /** Path segment of the page; derived from the title when the agent omits it. */
  slug: string;
  tags?: string[];
}

/** The rendered page. `for` is the seq of the `milestone` it came from. */
export interface PublishedRecord extends BaseRecord {
  kind: "published";
  for: number;
  title: string;
  slug: string;
  /** Home-relative, e.g. `pages/run_…/3-cache-choice.html`. Never absolute. */
  path: string;
  bytes: number;
  sha256: string;
  /** Version of the vendored renderer that produced the page. */
  am: string;
  /** One line from the renderer's own report (template · theme · panels · STE). */
  render?: string;
}

export interface EndRecord extends BaseRecord {
  kind: "end";
  status: EndStatus;
  summary?: string;
  durationMs?: number;
}

export type ReportRecord = StartRecord | MilestoneRecord | PublishedRecord | EndRecord;

export interface PublishedPage {
  /** The milestone seq — which is also the file's and the URL's seq. */
  seq: number;
  title: string;
  slug: string;
  path: string;
  ts: string;
  bytes: number;
  sha256: string;
}

/**
 * Derived, read-only view of a run. Never persisted; recomputed on every read, so
 * a page that arrives late cannot leave stale state behind.
 */
export interface RunSummary {
  runId: string;
  title: string;
  agent?: string;
  tags?: string[];
  status: RunStatus;
  startedAt?: string;
  updatedAt?: string;
  endedAt?: string;
  durationMs?: number;
  recordCount: number;
  pageCount: number;
  pages: PublishedPage[];
  /** Drafts submitted but never rendered — the human's "something is missing" signal. */
  pending: { seq: number; title: string; ts: string }[];
  /** The wrap-up text of a non-successful `report_end`. */
  failureSummary?: string;
  /** How the run is grouped in the index: first tag, then agent, then a fallback. */
  group: string;
}
