import fs from "node:fs/promises";
import path from "node:path";

import type { ReportRecord, ResultRecord } from "./types.js";

/**
 * Optional remote mirror: push records to a report-mcp Worker so the panel is
 * readable off-box.
 *
 * ## It is a mirror, and it stays one
 *
 * The local JSONL is the source of truth. Every tool call has already returned
 * by the time anything here runs, and **nothing in this file can fail a tool
 * call**: the queue is fire-and-forget, every failure path is swallowed, and the
 * only thing shutdown waits for is a best-effort flush.
 *
 * That matters because the tools promise to be fire-and-forget. A synchronous
 * POST here would put a network round-trip on that promise and make an agent's
 * throughput depend on the mirror's uptime — the exact inversion of what this
 * project is for.
 *
 * ## Batching
 *
 * One HTTP request per record would be one request per tool call. Records are
 * queued and flushed on a short timer, or early once a batch is big enough, so a
 * burst of progress updates costs a handful of requests instead of dozens.
 *
 * ## Bounded, and honest about dropping
 *
 * The queue is capped. A mirror that is down for an hour must not grow the
 * agent's heap: past the cap the oldest queued records are dropped and counted.
 * The count is what `report_mcp`'s stderr says at shutdown, so a silently
 * incomplete remote timeline is visible rather than merely surprising.
 *
 * ## Artifacts
 *
 * Files are only uploaded when `REPORT_MCP_FILE_ROOTS`-style mirroring is asked
 * for (`REPORT_MCP_REMOTE_FILES=1`) *and* the record is a result with
 * inline-renderable artifacts, because uploading a report's attachments is a
 * disclosure decision the operator has to make, not a default.
 */

const DEFAULTS = {
  /** Flush this long after the first record of a batch. */
  flushMs: 250,
  /** ...or this many records, whichever comes first. */
  maxBatch: 40,
  /** Hard cap on the queue; oldest records are dropped past it. */
  maxQueue: 2000,
  /** Give up on a single request after this long. */
  timeoutMs: 8000,
  /** Skip files larger than this (KV/R2 uploads of 20 MiB images are not the point). */
  maxFileBytes: 2 * 1024 * 1024,
};

const INLINE_TYPES = new Set(["image", "markdown", "html"]);

export interface MirrorOptions {
  baseUrl: string;
  token: string;
  /** Process cwd, used to resolve relative artifact paths. */
  cwd: string;
  /** Upload inline-renderable artifacts. Off unless explicitly asked for. */
  files?: boolean;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
  /** Overrides, mostly so tests do not have to wait on the real timers. */
  flushMs?: number;
  maxBatch?: number;
  maxQueue?: number;
  timeoutMs?: number;
  maxFileBytes?: number;
}

type Resolved = Required<Omit<MirrorOptions, "flushMs" | "maxBatch" | "maxQueue" | "timeoutMs" | "maxFileBytes">> & {
  flushMs: number;
  maxBatch: number;
  maxQueue: number;
  timeoutMs: number;
  maxFileBytes: number;
};

export interface MirrorStats {
  pushed: number;
  dropped: number;
  failed: number;
  lastError?: string;
}

export class RemoteMirror {
  private readonly o: Resolved;
  private queue: ReportRecord[] = [];
  private timer?: NodeJS.Timeout;
  private inFlight: Promise<void> = Promise.resolve();
  private closed = false;

  readonly stats: MirrorStats = { pushed: 0, dropped: 0, failed: 0 };

  constructor(opts: MirrorOptions) {
    this.o = {
      baseUrl: opts.baseUrl.replace(/\/+$/, ""),
      token: opts.token,
      cwd: opts.cwd,
      files: !!opts.files,
      log: opts.log ?? (() => {}),
      fetchImpl: opts.fetchImpl ?? fetch,
      flushMs: opts.flushMs ?? DEFAULTS.flushMs,
      maxBatch: opts.maxBatch ?? DEFAULTS.maxBatch,
      maxQueue: opts.maxQueue ?? DEFAULTS.maxQueue,
      timeoutMs: opts.timeoutMs ?? DEFAULTS.timeoutMs,
      maxFileBytes: opts.maxFileBytes ?? DEFAULTS.maxFileBytes,
    };
  }

  /**
   * Queue one record. Returns immediately and never throws — the caller is an
   * MCP tool handler that has already done its real work.
   */
  push(record: ReportRecord): void {
    if (this.closed) return;
    this.queue.push(record);
    if (this.queue.length > this.o.maxQueue) {
      const over = this.queue.length - this.o.maxQueue;
      this.queue.splice(0, over);
      this.stats.dropped += over;
    }
    if (this.queue.length >= this.o.maxBatch) {
      void this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.o.flushMs);
      this.timer.unref?.();
    }
  }

  /**
   * Send everything queued. Serialised through one chain so two flushes cannot
   * interleave and double-send a batch.
   */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.queue.length) return this.inFlight;
    const batch = this.queue;
    this.queue = [];
    this.inFlight = this.inFlight.then(() => this.send(batch)).catch(() => {});
    return this.inFlight;
  }

  /**
   * Flush and stop. Called from the shutdown path so a short session's last
   * record is not lost to the process exiting first.
   */
  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
  }

  private async send(batch: ReportRecord[]): Promise<void> {
    // One run per request: that is the unit the Worker stores and the unit a
    // record belongs to. Batches spanning runs would need splitting anyway.
    const byRun = new Map<string, ReportRecord[]>();
    for (const r of batch) {
      if (!byRun.has(r.runId)) byRun.set(r.runId, []);
      byRun.get(r.runId)!.push(r);
    }

    for (const [runId, records] of byRun) {
      const files = this.o.files ? await this.collectFiles(runId, records) : [];
      const body: Record<string, unknown> = { records };
      if (files.length) body.files = files;
      try {
        const res = await this.o.fetchImpl(`${this.o.baseUrl}/api/runs/${encodeURIComponent(runId)}/records`, {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.o.token}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.o.timeoutMs),
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 120)}`);
        }
        this.stats.pushed += records.length;
      } catch (err) {
        this.stats.failed += records.length;
        this.stats.lastError = err instanceof Error ? err.message : String(err);
        this.o.log(`[report-mcp] mirror push failed (${records.length} record(s)): ${this.stats.lastError}`);
      }
    }
  }

  /**
   * Read the inline-renderable artifacts of a batch and base64 them.
   *
   * Bounded and best-effort per file: a missing or unreadable artifact skips
   * that one upload, and the record push still happens — the panel then shows it
   * as a plain link, which is its documented fallback.
   */
  private async collectFiles(
    runId: string,
    records: ReportRecord[],
  ): Promise<{ run: string; seq: number; i: number; b64: string }[]> {
    const out: { run: string; seq: number; i: number; b64: string }[] = [];
    for (const rec of records) {
      if (rec.kind !== "result") continue;
      const arts = (rec as ResultRecord).artifacts ?? [];
      for (let i = 0; i < arts.length; i++) {
        const a = arts[i];
        if (!a.path || a.url) continue;
        if (!INLINE_TYPES.has(String(a.type || "").toLowerCase())) continue;
        try {
          const abs = path.resolve(this.o.cwd, a.path);
          const st = await fs.stat(abs);
          if (!st.isFile() || st.size > this.o.maxFileBytes) continue;
          const buf = await fs.readFile(abs);
          out.push({ run: runId, seq: rec.seq, i, b64: buf.toString("base64") });
        } catch {
          /* unreadable here is not an error worth failing the push over */
        }
      }
    }
    return out;
  }
}

/**
 * Build a mirror from the environment, or null when remote reporting is off.
 *
 * Off by default and off unless *both* the URL and the token are present: a
 * half-configured mirror that silently 401s on every record is worse than no
 * mirror, because the failure surfaces as an empty remote panel.
 */
export function mirrorFromEnv(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): RemoteMirror | null {
  const baseUrl = env.REPORT_MCP_REMOTE?.trim();
  const token = env.REPORT_MCP_REMOTE_TOKEN?.trim();
  if (!baseUrl || !token) return null;
  return new RemoteMirror({
    baseUrl,
    token,
    cwd,
    files: env.REPORT_MCP_REMOTE_FILES === "1",
    log: (m) => console.error(m),
  });
}
