/**
 * Shared record model.
 *
 * Everything the agent reports is one of six record kinds. The union is
 * append-only: a run is simply an ordered list of `ReportRecord` lines in a
 * JSONL file.
 */

/** Run-level lifecycle, as understood by a human reader. */
export type RunStatus =
  | "running"
  | "waiting"
  | "blocked"
  | "error"
  | "done"
  | "failed"
  | "aborted";

/** Terminal statuses, set by `report_end`. */
export type EndStatus = "done" | "failed" | "aborted";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type RecordKind = "start" | "progress" | "status" | "log" | "result" | "end";

export interface Artifact {
  /** Human-readable name, e.g. "Final report". */
  name: string;
  /** Local filesystem path. Absolute is recommended; relative resolves against the server's cwd. */
  path?: string;
  /** Remote or local URL. */
  url?: string;
  /**
   * Free-form type hint. `image`, `markdown` and `html` artifacts with a
   * `path` are rendered inline by the panel via `GET /api/file`.
   */
  type?: string;
  description?: string;
  size?: number;
}

export interface Metric {
  name: string;
  value: number | string;
  unit?: string;
  /** Optional qualifier shown next to the value, e.g. "p95", "target > 200". */
  hint?: string;
}

export interface Link {
  label: string;
  url: string;
}

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

export interface ProgressRecord extends BaseRecord {
  kind: "progress";
  phase: string;
  /** 0..100. Omit for an indeterminate phase. */
  percent?: number;
  step?: number;
  totalSteps?: number;
  message?: string;
  detail?: unknown;
}

export interface StatusRecord extends BaseRecord {
  kind: "status";
  status: RunStatus;
  message?: string;
  detail?: unknown;
}

export interface LogRecord extends BaseRecord {
  kind: "log";
  level: LogLevel;
  message: string;
  detail?: unknown;
}

export interface ResultRecord extends BaseRecord {
  kind: "result";
  title: string;
  summary?: string;
  status?: RunStatus;
  /** Markdown body, rendered with typography in the panel. */
  markdown?: string;
  /** Standalone HTML fragment/document, rendered in a sandboxed iframe. */
  html?: string;
  artifacts?: Artifact[];
  metrics?: Metric[];
  links?: Link[];
  /** Arbitrary structured payload for machine consumption. */
  data?: unknown;
}

export interface EndRecord extends BaseRecord {
  kind: "end";
  status: EndStatus;
  summary?: string;
  durationMs?: number;
}

export type ReportRecord =
  | StartRecord
  | ProgressRecord
  | StatusRecord
  | LogRecord
  | ResultRecord
  | EndRecord;

/** Derived, read-only view of a run. Never persisted; recomputed on read. */
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
  progress?: {
    phase?: string;
    percent?: number | null;
    step?: number;
    totalSteps?: number;
    message?: string;
  };
  logCounts: Record<LogLevel, number>;
  resultCount: number;
  /** Most recent error-level signal (log line or status=error). */
  lastError?: string;
  /** The wrap-up text of a non-successful `report_end`. */
  failureSummary?: string;
}

export const EMPTY_LOG_COUNTS: Record<LogLevel, number> = {
  debug: 0,
  info: 0,
  warn: 0,
  error: 0,
};
