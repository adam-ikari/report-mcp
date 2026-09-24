import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import type {
  EndRecord,
  LogLevel,
  ReportRecord,
  RunStatus,
  RunSummary,
  StartRecord,
} from "./types.js";
import { EMPTY_LOG_COUNTS } from "./types.js";

/** Where runs live. Override with REPORT_MCP_HOME. */
export function reportHome(): string {
  return process.env.REPORT_MCP_HOME?.trim() || path.join(os.homedir(), ".report-mcp");
}

export function newRunId(): string {
  const t = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `run_${t}_${crypto.randomBytes(3).toString("hex")}`;
}

function newId(): string {
  return crypto.randomUUID();
}

const VALID_KINDS = new Set<ReportRecord["kind"]>([
  "start",
  "progress",
  "status",
  "log",
  "result",
  "end",
]);

/** Count newline-terminated records; tolerates a trailing partial line. */
function countLines(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

export function parseRecords(text: string): ReportRecord[] {
  const out: ReportRecord[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const rec = JSON.parse(line) as ReportRecord;
      if (rec && typeof rec === "object" && typeof rec.kind === "string") out.push(rec);
    } catch {
      // A torn last line from a concurrent writer is expected; skip it.
    }
  }
  return out;
}

/**
 * Append-only writer for a single run.
 *
 * One MCP connection normally owns one run, so the sequence counter is kept in
 * memory. If another process writes to the same file (REPORT_MCP_RUN_ID shared
 * across servers) the size check before each append detects it and re-syncs.
 */
export class RunWriter {
  readonly runId: string;
  readonly filePath: string;

  private seq = 0;
  private expectedSize = 0;
  private startedAt?: string;

  constructor(runsDir: string, runId: string) {
    this.runId = runId;
    this.filePath = path.join(runsDir, `${runId}.jsonl`);
  }

  async init(): Promise<void> {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    let text = "";
    try {
      text = await fsp.readFile(this.filePath, "utf8");
    } catch {
      /* new file */
    }
    this.seq = countLines(text);
    this.expectedSize = Buffer.byteLength(text);
    const first = parseRecords(text)[0];
    this.startedAt = first?.ts;
  }

  /**
   * Append one record.
   *
   * The body is accepted untyped and the record kind is validated at runtime:
   * callers pass heterogeneous bodies through a single dispatch helper, so the
   * discriminated-union type would collapse to `never` anyway.
   */
  async append(kind: ReportRecord["kind"], body: Record<string, unknown>): Promise<ReportRecord> {
    if (!VALID_KINDS.has(kind)) throw new Error(`unknown record kind: ${String(kind)}`);
    let size = 0;
    try {
      size = (await fsp.stat(this.filePath)).size;
    } catch {
      size = 0;
    }

    // Someone else appended since our last write: re-sync so seq stays unique.
    if (size !== this.expectedSize) {
      const text = await fsp.readFile(this.filePath, "utf8").catch(() => "");
      this.seq = countLines(text);
      this.expectedSize = Buffer.byteLength(text);
      if (!this.startedAt) this.startedAt = parseRecords(text)[0]?.ts;
    }

    const ts = new Date().toISOString();
    if (!this.startedAt) this.startedAt = ts;

    const rec = {
      ...body,
      id: newId(),
      runId: this.runId,
      seq: this.seq + 1,
      ts,
      kind,
    } as ReportRecord;

    const line = `${JSON.stringify(rec)}\n`;
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    await fsp.appendFile(this.filePath, line, "utf8");

    this.seq = rec.seq;
    this.expectedSize = size + Buffer.byteLength(line);
    return rec;
  }

  /** Duration of the run so far, in ms. */
  elapsedMs(): number | undefined {
    return this.startedAt ? Date.now() - Date.parse(this.startedAt) : undefined;
  }
}

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

  const logCounts: Record<LogLevel, number> = { ...EMPTY_LOG_COUNTS };
  let resultCount = 0;
  let lastError: string | undefined;
  let failureSummary: string | undefined;
  let progress: RunSummary["progress"];

  for (const r of records) {
    if (r.kind === "log") {
      logCounts[r.level]++;
      if (r.level === "error") lastError = r.message;
    } else if (r.kind === "status" && r.status === "error" && r.message) {
      lastError = r.message;
    } else if (r.kind === "result") {
      resultCount++;
    } else if (r.kind === "end") {
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

  const end = last?.kind === "end" ? last : undefined;
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

export class Store {
  readonly home: string;
  readonly runsDir: string;
  readonly statePath: string;
  readonly runId: string;
  private writer?: RunWriter;
  private watching = new Set<(file: string) => void>();
  private watcher?: fs.FSWatcher;
  private fileWatchers = new Map<string, { w?: fs.FSWatcher; cbs: Set<() => void> }>();
  private debounce?: NodeJS.Timeout;

  constructor(runId?: string) {
    this.home = reportHome();
    this.runsDir = path.join(this.home, "runs");
    this.statePath = path.join(this.home, "panel.json");
    this.runId = runId?.trim() || process.env.REPORT_MCP_RUN_ID?.trim() || newRunId();
    fs.mkdirSync(this.runsDir, { recursive: true });
    this.startWatcher();
  }

  private startWatcher() {
    try {
      this.watcher = fs.watch(this.runsDir, () => {
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => {
          for (const fn of this.watching) fn("*");
        }, 40);
      });
      this.watcher.on("error", () => {
        /* runs dir gone or unsupported fs: panel falls back to polling */
      });
    } catch {
      /* polling fallback in the panel covers this */
    }
  }

  onChange(fn: (file: string) => void): () => void {
    this.watching.add(fn);
    return () => this.watching.delete(fn);
  }

  /**
   * Watch one run file for appends.
   *
   * Directory watchers on Linux only report create/delete entries, not content
   * changes to files that already exist — so the per-file watch is what actually
   * makes the panel live. Refcounted: the first subscriber opens it, the last
   * one closes it.
   */
  watchRun(runId: string, cb: () => void): () => void {
    let entry = this.fileWatchers.get(runId);
    if (!entry) {
      const created: { w?: fs.FSWatcher; cbs: Set<() => void> } = { cbs: new Set() };
      try {
        created.w = fs.watch(this.filePath(runId), { persistent: true }, () => {
          for (const fn of created.cbs) fn();
        });
        created.w.on("error", () => {
          /* file removed or fs unsupported: the periodic sweep still updates */
        });
      } catch {
        created.w = undefined;
      }
      this.fileWatchers.set(runId, created);
      entry = created;
    }
    entry.cbs.add(cb);

    return () => {
      const cur = this.fileWatchers.get(runId);
      if (!cur) return;
      cur.cbs.delete(cb);
      if (cur.cbs.size > 0) return;
      try {
        cur.w?.close();
      } catch {
        /* ignore */
      }
      this.fileWatchers.delete(runId);
    };
  }

  async writerFor(runId = this.runId): Promise<RunWriter> {
    if (runId === this.runId && this.writer) return this.writer;
    const w = new RunWriter(this.runsDir, runId);
    await w.init();
    if (runId === this.runId) this.writer = w;
    return w;
  }

  filePath(runId: string): string {
    return path.join(this.runsDir, `${runId}.jsonl`);
  }

  async readRecords(runId: string): Promise<ReportRecord[]> {
    const text = await fsp.readFile(this.filePath(runId), "utf8").catch(() => "");
    return parseRecords(text);
  }

  async readRun(runId: string): Promise<{ summary: RunSummary; records: ReportRecord[] } | null> {
    const records = await this.readRecords(runId);
    if (!records.length) return null;
    return { summary: summarize(runId, records), records };
  }

  /**
   * Runs ordered by last activity (not by file mtime), so restoring or copying
   * a run file does not reorder the sidebar. mtime is only used to pick which
   * files are worth reading.
   */
  async listRuns(limit = 100): Promise<RunSummary[]> {
    let names: string[] = [];
    try {
      names = await fsp.readdir(this.runsDir);
    } catch {
      return [];
    }
    const files: { name: string; mtimeMs: number }[] = [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      try {
        const st = await fsp.stat(path.join(this.runsDir, name));
        files.push({ name, mtimeMs: st.mtimeMs });
      } catch {
        /* raced with a delete */
      }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const out: RunSummary[] = [];
    for (const f of files.slice(0, limit * 2)) {
      const runId = f.name.slice(0, -".jsonl".length);
      const records = await this.readRecords(runId);
      if (records.length) out.push(summarize(runId, records));
    }
    out.sort((a, b) => Date.parse(b.updatedAt ?? b.startedAt ?? "0") - Date.parse(a.updatedAt ?? a.startedAt ?? "0"));
    return out.slice(0, limit);
  }

  /** Read appended bytes starting at `offset`. Returns a whole-line chunk. */
  readTail(runId: string, offset: number): Promise<{ chunk: string; next: number } | null> {
    return (async () => {
      let size = 0;
      try {
        size = (await fsp.stat(this.filePath(runId))).size;
      } catch {
        return null;
      }
      if (offset > size) offset = 0; // truncated or rotated
      if (offset === size) return { chunk: "", next: offset };

      const fh = await fsp.open(this.filePath(runId), "r").catch(() => null);
      if (!fh) return null;
      try {
        const len = size - offset;
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, offset);
        const text = buf.subarray(0, bytesRead).toString("utf8");
        const lastNl = text.lastIndexOf("\n");
        if (lastNl < 0) return { chunk: "", next: offset }; // wait for a full line
        return { chunk: text.slice(0, lastNl + 1), next: offset + lastNl + 1 };
      } finally {
        await fh.close();
      }
    })();
  }

  writePanelState(url: string): void {
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(
        this.statePath,
        JSON.stringify({ url, pid: process.pid, runId: this.runId, startedAt: new Date().toISOString() }, null, 2),
        "utf8",
      );
    } catch {
      /* best effort */
    }
  }

  clearPanelState(): void {
    try {
      const cur = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
      if (cur.pid === process.pid) fs.unlinkSync(this.statePath);
    } catch {
      /* best effort */
    }
  }

  close(): void {
    clearTimeout(this.debounce);
    this.watcher?.close();
    this.watching.clear();
    for (const entry of this.fileWatchers.values()) {
      try {
        entry.w?.close();
      } catch {
        /* ignore */
      }
      entry.cbs.clear();
    }
    this.fileWatchers.clear();
  }
}
