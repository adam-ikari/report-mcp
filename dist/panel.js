import http from "node:http";
import path from "node:path";
import fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { parseRecords, summarize } from "./store.js";
const HTML_PATH = fileURLToPath(new URL("../public/index.html", import.meta.url));
/** Every session aims here first; binding it is how one process wins the host election. */
const DEFAULT_PORT = 7788;
function sseHeaders() {
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
function send(res, event, data) {
    if (res.writableEnded || res.destroyed)
        return false;
    try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        return true;
    }
    catch {
        return false;
    }
}
function json(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
    });
    res.end(text);
}
/** Extension → Content-Type for inline artifact rendering. SVG is deliberately absent. */
const FILE_TYPES = {
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
async function serveArtifactFile(store, url, res) {
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
    const records = await store.readRecords(runId);
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
    let real;
    try {
        real = await fsp.realpath(path.resolve(artifact.path));
    }
    catch {
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
async function flushTail(store, client) {
    if (!client.runId)
        return;
    // A few iterations is enough to drain a burst without starving the event loop.
    for (let i = 0; i < 20; i++) {
        const t = await store.readTail(client.runId, client.offset).catch(() => null);
        if (!t)
            return;
        if (!t.chunk) {
            client.offset = t.next;
            return;
        }
        client.offset = t.next;
        for (const rec of parseRecords(t.chunk)) {
            if (!send(client.res, "record", rec))
                return;
        }
    }
}
/** Is `url` a live report-mcp panel serving our storage home? */
async function probePanel(url, expectHome) {
    try {
        const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
        if (!res.ok)
            return false;
        const data = (await res.json());
        // Same-home check: a panel on our port serving a *different* REPORT_MCP_HOME
        // must not swallow our agents' links — those runs would be invisible there.
        return data.ok === true && data.home === expectHome;
    }
    catch {
        return false;
    }
}
export async function startPanel(store) {
    const clients = new Set();
    const preferred = Number(process.env.REPORT_MCP_PORT ?? DEFAULT_PORT);
    const host = process.env.REPORT_MCP_HOST?.trim() || "127.0.0.1";
    const hostUrl = (p) => `http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${p}`;
    let html = "";
    try {
        html = await fsp.readFile(HTML_PATH, "utf8");
    }
    catch {
        html = "<!doctype html><title>report-mcp</title><p>public/index.html missing — rebuild the package.</p>";
    }
    const server = http.createServer((req, res) => {
        void handle(req, res).catch((err) => {
            if (!res.headersSent)
                json(res, 500, { error: String(err && err.message ? err.message : err) });
            else
                res.end();
        });
    });
    async function handle(req, res) {
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
            const client = { res, runId, offset: st ? st.next : 0, alive: true };
            // Seed with everything already on disk so the browser need not refetch.
            if (runId && st?.chunk) {
                for (const rec of parseRecords(st.chunk)) {
                    if (!send(res, "record", rec))
                        return;
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
            if (unwatch)
                void flushTail(store, client);
            req.on("close", () => {
                unwatch?.();
                clients.delete(client);
                try {
                    res.end();
                }
                catch {
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
            if (c.runId)
                void flushTail(store, c);
            send(c.res, "runs", { runIds: "*" });
        }
    });
    // Fallback sweep: covers filesystems where fs.watch is unreliable, and
    // re-announces the run list so a client that missed an event self-heals.
    const sweep = setInterval(() => {
        for (const c of clients) {
            if (!c.alive)
                continue;
            if (c.runId)
                void flushTail(store, c);
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
            }
            catch {
                c.alive = false;
            }
        }
    }, 20000);
    ping.unref?.();
    let url = "";
    let port = 0;
    let attached = false;
    let takeover;
    let takingOver = false;
    function bind(p) {
        return new Promise((resolve, reject) => {
            const onError = (err) => {
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
    }
    /** Win the election: grab the shared port and publish ourselves as the host. */
    async function promote() {
        try {
            port = await bind(preferred);
        }
        catch (err) {
            if (err.code === "EADDRINUSE")
                return false;
            throw err;
        }
        url = hostUrl(port);
        if (attached)
            console.error(`[report-mcp] promoted to panel host: ${url}`);
        attached = false;
        if (takeover)
            clearInterval(takeover);
        takeover = undefined;
        store.writePanelState(url);
        return true;
    }
    if (!(await promote())) {
        // The shared port is taken. Attach if it is a same-home report-mcp panel;
        // otherwise treat it as a foreign squatter and run a private panel instead.
        if (await probePanel(hostUrl(preferred), store.home)) {
            url = hostUrl(preferred);
            attached = true;
            // Watch the host: when its agent session ends, whoever binds the port
            // next becomes the new host — within ~5s of the old one letting go.
            takeover = setInterval(() => {
                if (takingOver)
                    return;
                takingOver = true;
                void (async () => {
                    try {
                        if (await probePanel(url, store.home))
                            return; // host still alive
                        for (let i = 0; i < 5; i++) {
                            if (await promote())
                                return;
                            // Lost the race; if the winner is a same-home panel, keep it attached.
                            if (await probePanel(hostUrl(preferred), store.home))
                                return;
                            await sleep(200);
                        }
                        // Next tick retries.
                    }
                    catch (err) {
                        console.error(`[report-mcp] takeover failed: ${err instanceof Error ? err.message : err}`);
                    }
                    finally {
                        takingOver = false;
                    }
                })();
            }, 5000);
            takeover.unref?.();
        }
        else {
            port = await bind(0);
            url = hostUrl(port);
            store.writePanelState(url);
        }
    }
    return {
        getUrl: () => url,
        port,
        isAttached: () => attached,
        async close() {
            clearInterval(sweep);
            clearInterval(ping);
            if (takeover)
                clearInterval(takeover);
            unsubscribe();
            store.clearPanelState(); // pid-guarded: never clears another host's state
            for (const c of clients) {
                try {
                    c.res.end();
                }
                catch {
                    /* ignore */
                }
            }
            clients.clear();
            store.close();
            if (server.listening) {
                await new Promise((resolve) => server.close(() => resolve()));
            }
        },
    };
}
/** Convenience for tests / CLI use. */
export { summarize };
//# sourceMappingURL=panel.js.map