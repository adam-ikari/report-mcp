import http from "node:http";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import zlib from "node:zlib";

import type { Store } from "./store.js";
import type { RunSummary } from "./types.js";

/**
 * The hosting side: the one HTTP server that serves report pages
 * (`report-mcp serve`), and the two functions the MCP process uses to turn a
 * journalled page into a link.
 *
 * The MCP process never binds a port. It writes pages under `$REPORT_MCP_HOME/pages`
 * and asks "is something serving this home right now?" — which is why a tool reply
 * can return `url: null` instead of a link that 404s the moment the agent's session
 * ends.
 */

/** `pages/<runId>/<seq>-<slug>.html` — the shape `Store.pageRef` writes. */
const REF_RE = /^pages\/([^/]+)\/(\d+)-(.+)\.html$/;

export function pageIndexUrl(store: Store): string | null {
  return store.readHostState()?.url ?? null;
}

export function pageUrl(store: Store, ref: string): string | null {
  const base = pageIndexUrl(store);
  if (!base) return null;
  const m = REF_RE.exec(ref);
  if (!m) return null;
  const [, runId, seq, slug] = m;
  return `${base}/r/${encodeURIComponent(runId)}/${seq}-${encodeURIComponent(slug)}`;
}

/** A run id is a filename here, so it gets the same strict shape the journal has always used. */
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** The slug `slugify()` produces: letters, digits, dot, dash, underscore — and never a path segment. */
const SLUG_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;

/**
 * `/r/<runId>/<seq>-<slug>` back into a journal ref.
 *
 * The path is rebuilt from validated components rather than used as given, so a request
 * cannot name a file: no `..`, no encoding tricks, no extension beyond `.html`.
 */
export function parsePageRoute(pathname: string): string | null {
  const parts = pathname.replace(/^\/r\/?/, "").split("/");
  if (parts.length !== 2) return null;
  let runId: string;
  let tail: string;
  try {
    runId = decodeURIComponent(parts[0]);
    tail = decodeURIComponent(parts[1]);
  } catch {
    return null;
  }
  if (!RUN_ID_RE.test(runId)) return null;
  const m = /^(\d+)-(.+)\.html$/i.exec(tail) ?? /^(\d+)-(.+)$/.exec(tail);
  if (!m) return null;
  const seq = Number(m[1]);
  if (!Number.isSafeInteger(seq) || seq < 1) return null;
  const slug = m[2];
  if (!SLUG_RE.test(slug)) return null;
  return path.posix.join("pages", runId, `${seq}-${slug}.html`);
}

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

/**
 * Host addresses a phone on the same Wi-Fi could open a report at, best first.
 *
 * Only used when the host is bound to a wildcard, and only to *advertise* addresses —
 * nothing here decides what to bind. IPv4 only: the LAN story is a device on the same
 * Wi-Fi, and a global IPv6 address is neither reachable from a phone nor pasteable.
 * 169.254/16 is the autoconfigured link-local range — not reachable in the ordinary
 * case, so advertising it produces a link that silently fails. RFC1918 sorts first:
 * 192.168, then 10.x, then 172.16-31, then whatever else answered.
 */
export function lanAddresses(): string[] {
  const found: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (!ni || ni.internal || ni.family !== "IPv4") continue;
      if (!IPV4_RE.test(ni.address) || ni.address.startsWith("169.254.")) continue;
      if (!found.includes(ni.address)) found.push(ni.address);
    }
  }
  const priv = (a: string) =>
    a.startsWith("192.168.") || a.startsWith("10.") || /^172\.(1[6-9]|2\d|3[01])\./.test(a);
  return found.sort((a, b) => Number(priv(b)) - Number(priv(a)) || a.localeCompare(b));
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function bytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
}

function clock(ts: string | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  // Not toLocaleString(): the index page is Chinese while the server's locale is
  // whatever the daemon inherited, and a date is the one thing here that should
  // read the same to everyone. Matches the stamp am puts in each page.
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const STATUS_LABEL: Record<RunSummary["status"], string> = {
  running: "进行中",
  done: "已完成",
  failed: "失败",
  aborted: "已中止",
};

const INDEX_CSS = [
  ":root{--bg:#0b0d10;--panel:#12161b;--line:#222a33;--text:#e6e9ee;--muted:#8d99a8;--accent:#4c9be8}",
  "*{box-sizing:border-box}",
  "body{margin:0;padding:24px 16px 64px;background:var(--bg);color:var(--text);font:15px/1.6 ui-sans-serif,system-ui,-apple-system,\"Segoe UI\",sans-serif}",
  "main{max-width:820px;margin:0 auto}",
  "h1{font-size:20px;margin:0 0 4px}",
  ".sub{color:var(--muted);font-size:13px;margin:0 0 24px}",
  ".group{color:var(--accent);font:600 12px/1 ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;margin:28px 0 8px}",
  "section{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;margin:0 0 12px}",
  "section h2{font-size:16px;margin:0 0 6px}",
  ".meta{color:var(--muted);font-size:12px;margin:0 0 10px}",
  ".badge{display:inline-block;padding:1px 7px;border-radius:999px;border:1px solid var(--line);font-size:11px;color:var(--muted);vertical-align:2px;margin-left:8px}",
  ".badge.done{color:#5ec97f;border-color:#245034}",
  ".badge.running{color:#e8c05c;border-color:#574722}",
  ".badge.failed,.badge.aborted{color:#e87171;border-color:#5a2626}",
  "ul{margin:0;padding-left:20px}",
  "li{margin:4px 0}",
  "a{color:var(--accent);text-decoration:none}",
  "a:hover{text-decoration:underline}",
  ".size{color:var(--muted);font-size:12px}",
  ".warn{color:#e8c05c;font-size:13px;margin:8px 0 0}",
  ".note{color:var(--muted);font-size:12px;margin:20px 0 0;border-top:1px solid var(--line);padding-top:12px}",
  "@media(max-width:520px){body{padding:16px 10px 48px}}",
].join("");

/**
 * The index: one server-rendered list of every published page, grouped by run.
 *
 * No JS, no SSE, and no rendering at request time — an am page is produced when the
 * agent calls `report_page`, and this page only reads journals. So a host with no
 * visitors costs nothing, and a stale host never shows a half-built report.
 */
export function renderIndex(runs: RunSummary[], home: string, banner: string | null): string {
  const groups = new Map<string, RunSummary[]>();
  for (const r of runs) {
    const list = groups.get(r.group);
    if (list) list.push(r);
    else groups.set(r.group, [r]);
  }

  const body: string[] = [];
  if (!runs.length) {
    body.push("<section><h2>还没有汇报</h2><p class='meta'>agent 调用 <code>report_page</code> 后，页面会出现在这里。</p></section>");
  }
  for (const [group, list] of groups) {
    body.push(`<div class='group'>${esc(group)}</div>`);
    for (const r of list) {
      const pages = r.pages.map((p) => {
        const href = `/r/${encodeURIComponent(r.runId)}/${p.seq}-${encodeURIComponent(p.slug)}`;
        return `<li><a href='${href}'>${esc(p.title)}</a> <span class='size'>${bytes(p.bytes)} · ${clock(p.ts)}</span></li>`;
      });
      body.push(
        `<section><h2>${esc(r.title)}<span class='badge${STATUS_LABEL[r.status] ? " " + r.status : ""}'>${STATUS_LABEL[r.status] ?? esc(r.status)}</span></h2>` +
          `<p class='meta'>${esc(r.agent ?? "agent 未署名")} · ${r.recordCount} 条记录 · 开始 ${clock(r.startedAt)}</p>` +
          (pages.length ? `<ul>${pages.join("")}</ul>` : "<p class='meta'>尚无已渲染的页面</p>") +
          (r.pending.length
            ? `<p class='warn'>有 ${r.pending.length} 份草稿没有渲染成功：${r.pending.map((p) => esc(p.title)).join("、")}</p>`
            : "") +
          (r.failureSummary ? `<p class='warn'>${esc(r.failureSummary)}</p>` : "") +
          `</section>`,
      );
    }
  }

  return [
    "<!doctype html>",
    "<html lang='zh'><head><meta charset='utf-8'>",
    "<meta name='viewport' content='width=device-width,initial-scale=1'>",
    "<title>汇报 · report-mcp</title>",
    `<style>${INDEX_CSS}</style></head><body><main>`,
    "<h1>汇报</h1>",
    `<p class='sub'>${runs.length} 个 run · ${runs.reduce((n, r) => n + r.pageCount, 0)} 页 · ${esc(home)}</p>`,
    ...(banner ? [`<p class='warn'>${esc(banner)}</p>`] : []),
    ...body,
    "<p class='note'>每份汇报是一个自包含的单文件 HTML，可离线保存。页面写一次不改：同一 URL 永远是同一份内容。</p>",
    "</main></body></html>",
    "\n",
  ].join("");
}

export const LAN_WARNING =
  "这个宿主绑在了 0.0.0.0：同一网段的任何设备都能打开这些汇报，没有鉴权也没有 HTTPS。";

export interface HostOptions {
  /** Bind address; a wildcard is what makes the reports reachable off this machine. */
  host: string;
  port: number;
  version: string;
}

/** Runs on the index page. Not client-settable: this host has no knobs. */
const INDEX_LIMIT = 60;

export interface Host {
  url: string;
  urls: string[];
  port: number;
  close(): Promise<void>;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function isLoopback(req: http.IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr.startsWith("127.") || addr.startsWith("::ffff:127.");
}

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  // Written once, named by seq: a corrected draft is a new page, so this one never changes.
  "Cache-Control": "public, max-age=31536000, immutable",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  // A report page is the most readable thing this tool produces. It must not be
  // framable or fetchable by another origin: that is how a LAN link leaks contents.
  "X-Frame-Options": "DENY",
  "Cross-Origin-Resource-Policy": "same-origin",
} as const;

export async function startHost(store: Store, opts: HostOptions): Promise<Host> {
  const wildcard = opts.host === "0.0.0.0" || opts.host === "::";
  const selfHost = wildcard ? "127.0.0.1" : opts.host;

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      if (!res.headersSent) json(res, 500, { error: err instanceof Error ? err.message : String(err) });
      else res.end();
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "GET" && req.method !== "HEAD") {
      json(res, 405, { error: "this host is read-only" });
      return;
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const p = url.pathname;

    if (p === "/api/health") {
      json(res, 200, { ok: true, home: store.home, pid: process.pid, urls, version: opts.version });
      return;
    }

    // Journal dumps are for debugging this machine, not for the LAN.
    if (p === "/api/runs" || p.startsWith("/api/runs/")) {
      if (!isLoopback(req)) {
        json(res, 404, { error: "not found" });
        return;
      }
      const runId = p === "/api/runs" ? "" : decodeURIComponent(p.slice("/api/runs/".length));
      if (!runId) {
        json(res, 200, { runs: await store.listRuns(INDEX_LIMIT) });
        return;
      }
      if (!RUN_ID_RE.test(runId)) {
        json(res, 400, { error: "invalid run id" });
        return;
      }
      const run = await store.readRun(runId);
      if (!run) {
        json(res, 404, { error: "no such run" });
        return;
      }
      json(res, 200, run);
      return;
    }

    if (p === "/" || p === "/index.html") {
      const runs = await store.listRuns(INDEX_LIMIT);
      const html = renderIndex(runs, store.home, wildcard ? LAN_WARNING : null);
      const buf = Buffer.from(html, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": buf.length,
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(buf);
      return;
    }

    if (p.startsWith("/r/")) {
      const ref = parsePageRoute(p);
      const abs = ref ? store.resolvePage(ref) : null;
      if (!abs) {
        notFound(res);
        return;
      }
      // Realpath, because a symlink placed inside pages/ would otherwise walk out of it.
      const real = await fsp.realpath(abs).catch(() => null);
      const pagesRoot = await fsp.realpath(store.pagesDir).catch(() => store.pagesDir);
      if (!real || !real.startsWith(pagesRoot + path.sep)) {
        notFound(res);
        return;
      }
      const stat = await fsp.stat(real).catch(() => null);
      if (!stat?.isFile()) {
        notFound(res);
        return;
      }
      const raw = await fsp.readFile(real);
      // A report page is one file with every image inlined as base64; uncompressed it
      // is multiple megabytes, which is exactly what a phone on Wi-Fi should not fetch.
      const gzip = /\bgzip\b/.test(req.headers["accept-encoding"] ?? "");
      const out = gzip ? zlib.gzipSync(raw, { level: 6 }) : raw;
      res.writeHead(200, {
        ...PAGE_HEADERS,
        "Content-Length": out.length,
        ...(gzip ? { "Content-Encoding": "gzip", Vary: "Accept-Encoding" } : {}),
      });
      res.end(out);
      return;
    }

    notFound(res);
  }

  function notFound(res: http.ServerResponse): void {
    const body = "<!doctype html><meta charset='utf-8'><title>404</title><p style='font:15px system-ui;padding:24px'>没有这个页面。汇报的链接形如 <code>/r/&lt;run id&gt;/&lt;seq&gt;-&lt;slug&gt;</code>，从索引页找。</p>";
    const buf = Buffer.from(body, "utf8");
    res.writeHead(404, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": buf.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(buf);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;
  // A wildcard bind answers on more than one address, and the LAN ones are the point
  // of that config: advertise them, best first, loopback last.
  const discovered = wildcard
    ? [...lanAddresses().map((a) => `http://${a}:${port}`), `http://${selfHost}:${port}`]
    : [`http://${selfHost}:${port}`];
  // Inside a container the discovered addresses are the bridge network's, which a phone
  // cannot open; the override is how the operator says "the reachable address is this".
  const override = process.env.REPORT_MCP_PUBLIC_URL?.trim().replace(/\/+$/, "");
  const urls = override ? [override, ...discovered.filter((u) => u !== override)] : discovered;

  store.writeHostState(urls[0], urls, opts.version);
  process.on("exit", () => store.clearHostState());

  return {
    url: urls[0],
    urls,
    port,
    close() {
      return new Promise<void>((resolve) => {
        store.clearHostState();
        server.close(() => resolve());
      });
    },
  };
}
