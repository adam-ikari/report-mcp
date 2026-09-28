import http from "node:http";
import path from "node:path";
import fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { Store } from "./store.js";
import { parseRecords, summarize } from "./store.js";
import type { ReportRecord } from "./types.js";

const HTML_PATH = fileURLToPath(new URL("../public/index.html", import.meta.url));

export interface Panel {
  url: string;
  port: number;
  close(): Promise<void>;
}

interface Client {
  res: http.ServerResponse;
  runId?: string;
  offset: number;
  alive: boolean;
}

function sseHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "X-Accel-Buffering": "no",
  };
}

/**
 * Queue one SSE event. Returns false only when the connection is gone —
 * `res.write()`'s own false (backpressure) must not be mistaken for that.
 */
function send(res: http.ServerResponse, event: string, data: unknown): boolean {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(text);
}

/** Extension → Content-Type for inline artifact rendering. SVG is deliberately absent. */
const FILE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".html", ".htm"]);

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Serve one file artifact of a stored result record. The path never comes
 * from the query string — it is read back out of `artifacts[i]` of the record
 * the caller names by (run, seq), so this can only ever disclose files the
 * agent already reported. HTML is served as text/plain: rendering it as a
 * document is the panel's job, inside a sandboxed iframe.
 */
async function serveArtifactFile(store: Store, url: URL, res: http.ServerResponse): Promise<void> {
  const runId = url.searchParams.get("run") ?? "";
  const seqRaw = url.searchParams.get("seq") ?? "";
  const idxRaw = url.searchParams.get("i") ?? "";
  if (!RUN_ID_RE.test(runId)) {
    json(res, 400, { error: "invalid run id" });
    return;
  }
  const seq = Number(seqRaw);
  const idx = Number(idxRaw);
  if (!Number.isInteger(seq) || !Number.isInteger(idx) || seq < 1 || idx < 0) {
    json(res, 400, { error: "seq and i must be integers" });
    return;
  }

  const records: ReportRecord[] = await store.readRecords(runId);
  const rec = records.find((r) => r.seq === seq);
  if (!rec || rec.kind !== "result") {
    json(res, 404, { error: "result record not found", runId, seq });
    return;
  }
  const artifact = rec.artifacts?.[idx];
  if (!artifact?.path) {
    json(res, 404, { error: "artifact not found", runId, seq, i: idx });
    return;
  }

  const ext = path.extname(artifact.path).toLowerCase();
  const contentType = FILE_TYPES[ext];
  const isText = TEXT_EXTENSIONS.has(ext);
  if (!contentType && !isText) {
    json(res, 403, { error: "file type not allowed", ext });
    return;
  }

  const maxBytes = Number(process.env.REPORT_MCP_MAX_FILE_BYTES ?? 0) || 20 * 1024 * 1024;
  const roots = (process.env.REPORT_MCP_FILE_ROOTS ?? "")
    .split(":")
    .map((r) => r.trim())
    .filter(Boolean);

  let real: string;
  try {
    real = await fsp.realpath(path.resolve(artifact.path));
  } catch {
    json(res, 404, { error: "file not found", runId, seq, i: idx });
    return;
  }
  if (roots.length) {
    const allowed = roots.some((rootRaw) => {
      const root = path.resolve(rootRaw);
      return real === root || real.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
    });
    if (!allowed) {
      json(res, 403, { error: "file outside allowed roots" });
      return;
    }
  }
  const stat = await fsp.stat(real).catch(() => null);
  if (!stat?.isFile()) {
    json(res, 404, { error: "file not found", runId, seq, i: idx });
    return;
  }
  if (stat.size > maxBytes) {
    json(res, 413, { error: "file too large", size: stat.size, maxBytes });
    return;
  }

  const buf = await fsp.readFile(real);
  res.writeHead(200, {
    "Content-Type": contentType || "text/plain; charset=utf-8",
    "Content-Length": buf.length,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  });
  res.end(buf);
}

/** Push newly appended records for `runId` to every watcher of it. */
async function flushTail(store: Store, client: Client): Promise<void> {
  if (!client.runId) return;
  // A few iterations is enough to drain a burst without starving the event loop.
  for (let i = 0; i < 20; i++) {
    const t = await store.readTail(client.runId, client.offset).catch(() => null);
    if (!t) return;
    if (!t.chunk) {
      client.offset = t.next;
      return;
    }
    client.offset = t.next;
    for (const rec of parseRecords(t.chunk)) {
      if (!send(client.res, "record", rec)) return;
    }
  }
}

export async function startPanel(store: Store): Promise<Panel> {
  const clients = new Set<Client>();
  const preferred = Number(process.env.REPORT_MCP_PORT ?? 0);
  const host = process.env.REPORT_MCP_HOST?.trim() || "127.0.0.1";

  let html = "";
  try {
    html = await fsp.readFile(HTML_PATH, "utf8");
  } catch {
    html = "<!doctype html><title>report-mcp</title><p>public/index.html missing — rebuild the package.</p>";
  }

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      if (!res.headersSent) json(res, 500, { error: String(err && err.message ? err.message : err) });
      else res.end();
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    // Tolerate "//api/runs" from clients that concatenated a trailing slash.
    const p = url.pathname.replace(/\/{2,}/g, "/");

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Headers": "*",
      });
      res.end();
      return;
    }

    if (p === "/" || p === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(html);
      return;
    }
    if (p === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (p === "/api/health") {
      json(res, 200, { ok: true, runId: store.runId, home: store.home });
      return;
    }

    if (p === "/api/runs" && req.method === "GET") {
      const limit = Math.min(500, Number(url.searchParams.get("limit") ?? 100) || 100);
      json(res, 200, await store.listRuns(limit));
      return;
    }

    const runMatch = /^\/api\/runs\/([^/]+)$/.exec(p);
    if (runMatch && req.method === "GET") {
      const runId = decodeURIComponent(runMatch[1]);
      const data = await store.readRun(runId);
      if (!data) {
        json(res, 404, { error: "run not found", runId });
        return;
      }
      json(res, 200, data);
      return;
    }

    if (p === "/api/file" && req.method === "GET") {
      await serveArtifactFile(store, url, res);
      return;
    }

    if (p === "/api/stream") {
      const runId = url.searchParams.get("run")?.trim() || undefined;
      if (runId) {
        const exists = await store
          .readRecords(runId)
          .then((r) => r.length > 0)
          .catch(() => false);
        if (!exists) {
          json(res, 404, { error: "run not found", runId });
          return;
        }
      }

      res.writeHead(200, sseHeaders());
      res.write(`retry: 2000\n\n`);
      const st = runId ? await store.readTail(runId, 0).catch(() => null) : null;
      const client: Client = { res, runId, offset: st ? st.next : 0, alive: true };
      // Seed with everything already on disk so the browser need not refetch.
      if (runId && st?.chunk) {
        for (const rec of parseRecords(st.chunk)) {
          if (!send(res, "record", rec)) return;
        }
      }
      send(res, "runs", { runIds: runId ? [runId] : "*" });
      clients.add(client);

      // Per-file watch is what makes this live; the sweep below is the fallback.
      const unwatch = runId
        ? store.watchRun(runId, () => {
            void flushTail(store, client);
            send(client.res, "runs", { runIds: [runId] });
          })
        : null;
      // Close the window between the seed read and the watch starting.
      if (unwatch) void flushTail(store, client);

      req.on("close", () => {
        unwatch?.();
        clients.delete(client);
        try {
          res.end();
        } catch {
          /* already gone */
        }
      });
      return;
    }

    json(res, 404, { error: "not found", path: p });
  }

  // Fan out store changes to every live SSE client.
  const unsubscribe = store.onChange(() => {
    for (const c of clients) {
      if (c.runId) void flushTail(store, c);
      send(c.res, "runs", { runIds: "*" });
    }
  });

  // Fallback sweep: covers filesystems where fs.watch is unreliable, and
  // re-announces the run list so a client that missed an event self-heals.
  const sweep = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) continue;
      if (c.runId) void flushTail(store, c);
      send(c.res, "runs", { runIds: c.runId ? [c.runId] : "*" });
    }
  }, 5000);
  sweep.unref?.();

  const ping = setInterval(() => {
    for (const c of clients) {
      if (c.res.writableEnded || c.res.destroyed) {
        c.alive = false;
        continue;
      }
      try {
        c.res.write(": ping\n\n");
      } catch {
        c.alive = false;
      }
    }
  }, 20000);
  ping.unref?.();

  const port = await listen(server, preferred, host);
  const url = `http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${port}`;
  store.writePanelState(url);

  return {
    url,
    port,
    async close() {
      clearInterval(sweep);
      clearInterval(ping);
      unsubscribe();
      store.clearPanelState();
      for (const c of clients) {
        try {
          c.res.end();
        } catch {
          /* ignore */
        }
      }
      clients.clear();
      store.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function listen(server: http.Server, preferred: number, host: string): Promise<number> {
  const tryPort = (p: number) =>
    new Promise<number>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : p);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(p, host);
    });

  try {
    return await tryPort(preferred);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE" && preferred !== 0) {
      // Someone already holds the configured port; fall back to an ephemeral one.
      return await tryPort(0);
    }
    throw err;
  }
}

/** Convenience for tests / CLI use. */
export { summarize };
