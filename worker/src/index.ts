/**
 * report-mcp — optional remote panel mirror, on Cloudflare Workers.
 *
 * ## What this is, and what it is not
 *
 * It is a **mirror**, not the host. The local design is untouched: the agent
 * still appends to `$REPORT_MCP_HOME/runs/*.jsonl` and the local panel still
 * serves that. This Worker exists for the case the local panel cannot cover —
 * you are not on the machine the agent runs on.
 *
 * It is not a replacement store. If this Worker is deleted, nothing is lost:
 * the JSONL is the source of truth and every record here can be re-pushed by a
 * fresh agent session. That is why the agent treats the push as fire-and-forget
 * and never lets a failure here affect a tool call.
 *
 * ## Why the panel needs no changes here
 *
 * The panel decides live vs static by asking `/api/runs` for JSON. Serve that
 * at the same origin as the panel and it is already in live mode — so this
 * Worker serves the *same* `public/` build, and the front end is byte-identical
 * to the local one. Nothing in panel/src knows this exists.
 *
 * ## Storage
 *
 * KV, one key per run, holding that run's **raw records** (never a summary).
 * Summaries are recomputed on read with the same `summarize()` the server uses,
 * so a late or out-of-order push cannot leave a stale status behind. KV values
 * are capped (see MAX_RECORDS); past that the oldest records are dropped and the
 * run is flagged truncated rather than silently losing its tail.
 *
 * R2 holds artifact bytes for the inline-render path, when the binding exists.
 * Without it, artifacts degrade to plain links — which is what the panel already
 * does for types it cannot render inline.
 *
 * ## Auth
 *
 * This is the one endpoint in the project that is reachable from the internet,
 * and the panel has no auth of its own, so the token check is mandatory here
 * rather than advisory. One shared secret, two roles distinguished only by which
 * method needs it: writes require it in a header, reads accept the browser's
 * HttpOnly cookie. The cookie is minted by `/api/login?token=…` and the token is
 * immediately stripped from the address bar, so it does not linger in history or
 * leak through Referer.
 *
 * ## Known limits
 *
 * - `/api/stream` is a **snapshot poll wearing an SSE costume**: each connection
 *   re-reads storage on an interval. It updates the panel, but N viewers cost N
 *   upstream reads. Real fan-out needs a Durable Object.
 * - KV is eventually consistent, so a just-pushed record can take a few seconds
 *   to appear on a different edge. The panel's 15s poll covers it.
 */

import { summarize } from "../../src/summarize.js";
import type { ReportRecord, RunSummary } from "../../src/types.js";
import { PANEL_JS, SHELL_HTML } from "./panel-assets.js";

/* ------------------------------------------------------------------ config */

/** KV: one entry per run, holding raw records. */
interface Env {
  REPORTS: KVNamespace;
  /** Optional. Artifact bytes for the inline-render path. */
  ARTIFACTS?: R2Bucket;
  /** Shared secret. Required for every /api route. */
  TOKEN: string;
  /** Shown in the panel's storage line, so a remote mirror is never mistaken for local. */
  MIRROR_LABEL?: string;
}

/**
 * Records kept per run. KV values are 25 MiB; a run with very large `data`
 * payloads would hit that, and the panel has no virtual scrolling anyway, so
 * dropping the oldest is the honest failure.
 */
const MAX_RECORDS = 2000;
/** Runs listed in the sidebar, matching the local panel's cap. */
const MAX_RUNS = 500;
/** Snapshot cadence for /api/stream. */
const STREAM_INTERVAL_MS = 3000;
const RUN_KEY = (id: string) => `run:${id}`;
const ARTIFACT_KEY = (run: string, seq: number, i: number) => `${run}/${seq}/${i}`;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/* ------------------------------------------------------------------- types */

interface StoredRun {
  runId: string;
  records: ReportRecord[];
  /** Oldest records were dropped to stay under the KV cap. */
  truncated?: boolean;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

/* -------------------------------------------------------------------- auth */

function bearer(req: Request, env: Env): boolean {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  const presented = m ? m[1] : req.headers.get("x-report-token");
  return typeof presented === "string" && timingSafeEqual(presented, env.TOKEN);
}

/**
 * Constant-time-ish compare. Not a real defence against a network attacker (TLS
 * does that job) — it is here so a wrong token cannot be discovered one
 * character at a time from response timing.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function hasReadCookie(req: Request, env: Env): boolean {
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === "rmp" && timingSafeEqual(v.join("="), env.TOKEN)) return true;
  }
  return false;
}

const cookieHeader = (token: string) =>
  `rmp=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;

/* ------------------------------------------------------------------ storage */

async function readRun(env: Env, runId: string): Promise<StoredRun | null> {
  const raw = await env.REPORTS.get(RUN_KEY(runId), "json");
  if (!raw || typeof raw !== "object") return null;
  return raw as StoredRun;
}

/**
 * Merge pushed records into a run.
 *
 * Idempotent by record `id`: the agent retries on timeout, and a retried batch
 * must not duplicate timeline entries. Records are stored sorted by `seq` so a
 * late arrival lands in the right place instead of at the end.
 */
async function mergeRun(env: Env, runId: string, incoming: ReportRecord[]): Promise<{ run: StoredRun; stored: number }> {
  const existing = (await readRun(env, runId)) ?? { runId, records: [] };
  const byId = new Map<string, ReportRecord>();
  for (const r of existing.records) byId.set(r.id, r);
  let added = 0;
  for (const r of incoming) {
    if (!byId.has(r.id)) {
      byId.set(r.id, r);
      added++;
    }
  }
  let records = [...byId.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  let truncated = false;
  if (records.length > MAX_RECORDS) {
    records = records.slice(records.length - MAX_RECORDS);
    truncated = true;
  }
  const run: StoredRun = { runId, records, truncated };
  await env.REPORTS.put(RUN_KEY(runId), JSON.stringify(run));
  return { run, stored: added };
}

/** Run ids, newest first. KV has no ordering, so every listing pays a full read. */
async function listRunIds(env: Env): Promise<{ id: string; updatedAt: number }[]> {
  const out: { id: string; updatedAt: number }[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.REPORTS.list({ prefix: "run:", cursor });
    for (const key of page.keys) {
      const run = (await env.REPORTS.get<StoredRun>(key.name, "json")) ?? null;
      if (!run) continue;
      const last = run.records[run.records.length - 1];
      out.push({ id: run.runId, updatedAt: Date.parse(last?.ts ?? "") || 0 });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

const summaryOf = (run: StoredRun): RunSummary => summarize(run.runId, run.records);

/* ------------------------------------------------------------------ routing */

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/{2,}/g, "/");

    try {
      if (p === "/" || p === "/index.html") return serveShell(req, env, url);
      if (p === "/panel.js") return panelJs();

      if (p.startsWith("/api/")) return await api(req, env, p, url);
      return json({ error: "not found", path: p }, 404);
    } catch (err) {
      return json({ error: String((err as Error)?.message ?? err) }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * The bundled panel.
 *
 * No source map: it is ~1 MB of the same bytes, and a mirror is not where you go
 * to debug the panel. The local build still ships one.
 */
function panelJs(): Response {
  return new Response(PANEL_JS, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
}

/**
 * The panel shell, plus the cookie handshake.
 *
 * `/api/login?token=…` sets the HttpOnly cookie and redirects to `/`, which is
 * what keeps the secret out of the address bar, the history stack and any Referer
 * the panel's outbound links might produce.
 */
function serveShell(req: Request, env: Env, url: URL): Promise<Response> | Response {
  const t = url.searchParams.get("token");
  if (t && timingSafeEqual(t, env.TOKEN)) {
    return new Response(null, { status: 302, headers: { location: url.pathname, "set-cookie": cookieHeader(env.TOKEN) } });
  }
  if (!hasReadCookie(req, env)) {
    return new Response(
      "report-mcp mirror\n\nThis panel is token-protected. Open it as:\n  /?token=<REPORT_MCP_TOKEN>\n",
      { status: 401, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  return new Response(SHELL_HTML, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
  });
}

async function api(req: Request, env: Env, p: string, url: URL): Promise<Response> {
  if (p === "/api/health") {
    // Unauthenticated on purpose: the panel's boot calls it to find the storage
    // home, and it discloses nothing beyond liveness.
    return json({ ok: true, home: env.MIRROR_LABEL ?? "report-mcp mirror (Cloudflare Worker)", mirror: true });
  }

  // ---- writes (agent → worker) ----
  if (req.method === "PUT" || req.method === "POST") {
    if (!bearer(req, env)) return json({ error: "unauthorized" }, 401);
    const m = /^\/api\/runs\/([^/]+)\/records$/.exec(p);
    if (!m) return json({ error: "not found" }, 404);
    const runId = decodeURIComponent(m[1]);
    if (!RUN_ID_RE.test(runId)) return json({ error: "invalid run id" }, 400);
    const body = (await req.json().catch(() => null)) as { records?: unknown } | null;
    if (!body || !Array.isArray(body.records)) return json({ error: "records must be an array" }, 400);
    const records = body.records.filter(isRecord);
    if (!records.length) return json({ error: "no valid records" }, 400);

    // Artifact bytes ride along as base64 so one request covers a whole batch.
    const files = (body as { files?: unknown }).files;
    if (env.ARTIFACTS && Array.isArray(files)) {
      for (const f of files as { run?: string; seq?: number; i?: number; b64?: string }[]) {
        if (!f?.b64 || !RUN_ID_RE.test(String(f.run))) continue;
        try {
          await env.ARTIFACTS.put(ARTIFACT_KEY(String(f.run), Number(f.seq), Number(f.i)), Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)));
        } catch {
          /* an artifact that will not upload must not fail the record push */
        }
      }
    }
    const { run, stored } = await mergeRun(env, runId, records);
    return json({ ok: true, runId, stored, recordCount: run.records.length, truncated: !!run.truncated });
  }

  // ---- reads (browser → worker) ----
  if (!hasReadCookie(req, env) && !bearer(req, env)) return json({ error: "unauthorized" }, 401);

  if (p === "/api/runs" && req.method === "GET") {
    const limit = Math.min(MAX_RUNS, Number(url.searchParams.get("limit") ?? 100) || 100);
    const ids = await listRunIds(env);
    const out: RunSummary[] = [];
    for (const { id } of ids.slice(0, limit)) {
      const run = await readRun(env, id);
      if (run) out.push(summaryOf(run));
    }
    // The sidebar's order is last activity, and the local Store sorts on the
    // records' own timestamps rather than file mtime; keep the two identical.
    out.sort((a, b) => Date.parse(b.updatedAt ?? b.startedAt ?? "0") - Date.parse(a.updatedAt ?? a.startedAt ?? "0"));
    return json(out);
  }

  const one = /^\/api\/runs\/([^/]+)$/.exec(p);
  if (one && req.method === "GET") {
    const runId = decodeURIComponent(one[1]);
    const run = await readRun(env, runId);
    if (!run) return json({ error: "run not found", runId }, 404);
    return json({ summary: summaryOf(run), records: run.records });
  }

  if (p === "/api/stream" && req.method === "GET") return stream(req, env, url);

  if (p === "/api/file" && req.method === "GET") {
    return await file(req, env, url);
  }

  return json({ error: "not found", path: p }, 404);
}

/** Reject anything that is not shaped like a record, so junk cannot reach the timeline. */
function isRecord(v: unknown): v is ReportRecord {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.runId === "string" &&
    typeof r.seq === "number" &&
    typeof r.ts === "string" &&
    typeof r.kind === "string" &&
    ["start", "progress", "status", "log", "result", "end"].includes(r.kind)
  );
}

/**
 * SSE that re-reads storage on an interval.
 *
 * The panel treats `record` events as an append stream and de-duplicates by id,
 * so re-sending the whole run is safe — and it means a viewer recovers from a
 * dropped connection without the agent having to replay anything. This is the
 * one honest shortcut: there is no shared state between connections, so a
 * Durable Object would be the real answer at scale.
 */
function stream(req: Request, env: Env, url: URL): Response {
  const runId = url.searchParams.get("run")?.trim() ?? "";
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      const tick = async () => {
        try {
          if (runId) {
            const run = await readRun(env, runId);
            if (!run) {
              send("runs", { runIds: "*" });
              return;
            }
            for (const rec of run.records) send("record", rec);
            send("runs", { runIds: [runId] });
          } else {
            send("runs", { runIds: "*" });
          }
        } catch {
          /* a transient KV read must not tear the stream down */
        }
      };
      await tick();
      timer = setInterval(() => void tick(), STREAM_INTERVAL_MS);
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });

  req.signal.addEventListener("abort", () => {
    if (timer) clearInterval(timer);
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

/**
 * Artifact bytes from R2.
 *
 * Same (run, seq, i) contract as the local `/api/file`, deliberately: the panel
 * asks for artifacts by that triple and never sends a path, so a mirror cannot
 * be talked into reading something off the agent's disk. Non-images are returned
 * as text/plain with nosniff, matching the local handler.
 */
async function file(req: Request, env: Env, url: URL): Promise<Response> {
  if (!env.ARTIFACTS) return json({ error: "artifacts are not mirrored (no R2 binding)" }, 404);
  const runId = url.searchParams.get("run") ?? "";
  const seq = Number(url.searchParams.get("seq"));
  const i = Number(url.searchParams.get("i"));
  if (!RUN_ID_RE.test(runId)) return json({ error: "invalid run id" }, 400);
  if (!Number.isInteger(seq) || !Number.isInteger(i) || seq < 1 || i < 0) {
    return json({ error: "seq and i must be integers" }, 400);
  }
  const obj = await env.ARTIFACTS.get(ARTIFACT_KEY(runId, seq, i));
  if (!obj) return json({ error: "artifact not mirrored", runId, seq, i }, 404);

  const type = obj.httpMetadata?.contentType ?? "application/octet-stream";
  const isImage = /^image\/(png|jpeg|gif|webp)$/.test(type);
  return new Response(obj.body, {
    headers: {
      "content-type": isImage ? type : "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}
