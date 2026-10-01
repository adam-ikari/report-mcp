import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import type { ReportRecord, RunSummary } from "./types.js";
import { summarize } from "./summarize.js";

// Re-exported so the existing `import { summarize } from "./store.js"` sites
// (and the panel's equivalence test) keep resolving; the implementation lives in
// ./summarize.js so the Worker mirror can import it without pulling in node:fs.
export { summarize };

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

  /**
   * Publish where the panel lives for the human. `urls` is informational — the
   * single `url` stays the one agents and scripts read; `urls` additionally
   * carries the LAN addresses when the panel is bound wide.
   */
  writePanelState(url: string, urls: string[] = [url]): void {
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(
        this.statePath,
        JSON.stringify(
          { url, urls, pid: process.pid, runId: this.runId, startedAt: new Date().toISOString() },
          null,
          2,
        ),
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
