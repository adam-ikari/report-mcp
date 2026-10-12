import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { summarize } from "./summarize.js";
export { summarize };
/** Where runs and pages live. Override with REPORT_MCP_HOME. */
export function reportHome() {
    return process.env.REPORT_MCP_HOME?.trim() || path.join(os.homedir(), ".report-mcp");
}
export function newRunId() {
    const t = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    return `run_${t}_${crypto.randomBytes(3).toString("hex")}`;
}
function newId() {
    return crypto.randomUUID();
}
const VALID_KINDS = new Set(["start", "milestone", "published", "end"]);
/** How long one append waits for the run's lock before writing unlocked. */
const LOCK_WAIT_MS = 2000;
/** A lock older than this belongs to a writer that died mid-append. */
const LOCK_STALE_MS = 2000;
/** Count newline-terminated records; tolerates a trailing partial line. */
function countLines(text) {
    let n = 0;
    for (let i = 0; i < text.length; i++)
        if (text.charCodeAt(i) === 10)
            n++;
    return n;
}
export function parseRecords(text) {
    const out = [];
    for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (!line)
            continue;
        try {
            const rec = JSON.parse(line);
            if (rec && typeof rec === "object" && typeof rec.kind === "string" && VALID_KINDS.has(rec.kind))
                out.push(rec);
        }
        catch {
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
 * across servers) a lock directory around the append keeps the re-sync and the
 * write in one critical section, so the two processes cannot pick the same seq.
 */
export class RunWriter {
    runId;
    filePath;
    lockPath;
    seq = 0;
    expectedSize = 0;
    startedAt;
    constructor(runsDir, runId) {
        this.runId = runId;
        this.filePath = path.join(runsDir, `${runId}.jsonl`);
        this.lockPath = `${this.filePath}.lock`;
    }
    async init() {
        await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
        let text = "";
        try {
            text = await fsp.readFile(this.filePath, "utf8");
        }
        catch {
            /* new file */
        }
        this.seq = countLines(text);
        this.expectedSize = Buffer.byteLength(text);
        this.startedAt = parseRecords(text)[0]?.ts;
    }
    /**
     * Append one record.
     *
     * The body is accepted untyped and the record kind is validated at runtime:
     * callers pass heterogeneous bodies through a single dispatch helper, so the
     * discriminated-union type would collapse to `never` anyway.
     */
    async append(kind, body) {
        if (!VALID_KINDS.has(kind))
            throw new Error(`unknown record kind: ${String(kind)}`);
        const held = await this.acquire();
        try {
            return await this.appendLocked(kind, body);
        }
        finally {
            if (held)
                await this.release();
        }
    }
    /**
     * Cross-process lock around "measure the tail, choose seq, append".
     *
     * The size check alone is a check-then-act race: two processes can both see the same
     * size and both pick seq N+1, which puts a duplicate into the one structure whose
     * whole job is to be a sequence. `mkdir` is atomic on every filesystem we care about,
     * so it is the lock. Losing it is not a reason to fail a report — after the wait
     * budget we append unlocked, which is the old behaviour, rather than erroring.
     */
    async acquire() {
        await fsp.mkdir(path.dirname(this.lockPath), { recursive: true }).catch(() => { });
        const deadline = Date.now() + LOCK_WAIT_MS;
        for (;;) {
            try {
                await fsp.mkdir(this.lockPath);
                return true;
            }
            catch (err) {
                const e = err;
                if (e.code !== "EEXIST")
                    return false;
                const st = await fsp.stat(this.lockPath).catch(() => null);
                // A writer killed mid-append leaves the lock behind; its own mtime says when.
                if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
                    await fsp.rm(this.lockPath, { recursive: true, force: true }).catch(() => { });
                    continue;
                }
                if (Date.now() > deadline)
                    return false;
                await new Promise((r) => setTimeout(r, 2 + Math.floor(Math.random() * 6)));
            }
        }
    }
    async release() {
        await fsp.rm(this.lockPath, { recursive: true, force: true }).catch(() => { });
    }
    async appendLocked(kind, body) {
        let size = 0;
        try {
            size = (await fsp.stat(this.filePath)).size;
        }
        catch {
            size = 0;
        }
        // Someone else appended since our last write: re-sync so seq stays unique.
        if (size !== this.expectedSize) {
            const text = await fsp.readFile(this.filePath, "utf8").catch(() => "");
            this.seq = countLines(text);
            this.expectedSize = Buffer.byteLength(text);
            if (!this.startedAt)
                this.startedAt = parseRecords(text)[0]?.ts;
        }
        const ts = new Date().toISOString();
        if (!this.startedAt)
            this.startedAt = ts;
        const rec = {
            ...body,
            id: newId(),
            runId: this.runId,
            seq: this.seq + 1,
            ts,
            kind,
        };
        const line = `${JSON.stringify(rec)}\n`;
        await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
        await fsp.appendFile(this.filePath, line, "utf8");
        this.seq = rec.seq;
        this.expectedSize = size + Buffer.byteLength(line);
        return rec;
    }
    /** Duration of the run so far, in ms. */
    elapsedMs() {
        return this.startedAt ? Date.now() - Date.parse(this.startedAt) : undefined;
    }
}
export class Store {
    home;
    runsDir;
    pagesDir;
    hostPath;
    runId;
    constructor(runId) {
        this.home = reportHome();
        this.runsDir = path.join(this.home, "runs");
        this.pagesDir = path.join(this.home, "pages");
        this.hostPath = path.join(this.home, "host.json");
        this.runId = runId?.trim() || process.env.REPORT_MCP_RUN_ID?.trim() || newRunId();
        fs.mkdirSync(this.runsDir, { recursive: true });
    }
    filePath(runId) {
        return path.join(this.runsDir, `${runId}.jsonl`);
    }
    /**
     * Where a rendered page goes.
     *
     * The seq is part of the name, so a corrected draft is a *new* page and the old
     * link keeps working — which is what lets the host serve these with `immutable`.
     */
    pagePath(runId, seq, slug) {
        return path.join(this.pagesDir, runId, `${seq}-${slug}.html`);
    }
    /** Home-relative form, for the journal. Absolute paths in records do not survive a moved home. */
    pageRef(runId, seq, slug) {
        return path.posix.join("pages", runId, `${seq}-${slug}.html`);
    }
    /** Resolve a journal `path` back to disk. Returns null for anything outside pages/. */
    resolvePage(ref) {
        if (!ref.startsWith("pages/") || ref.includes(".."))
            return null;
        const abs = path.join(this.home, ref);
        return abs.startsWith(this.pagesDir + path.sep) ? abs : null;
    }
    writer;
    async writerFor(runId = this.runId) {
        if (runId === this.runId && this.writer)
            return this.writer;
        const w = new RunWriter(this.runsDir, runId);
        await w.init();
        if (runId === this.runId)
            this.writer = w;
        return w;
    }
    async readRecords(runId) {
        const text = await fsp.readFile(this.filePath(runId), "utf8").catch(() => "");
        return parseRecords(text);
    }
    async readRun(runId) {
        const records = await this.readRecords(runId);
        if (!records.length)
            return null;
        return { summary: summarize(runId, records), records };
    }
    /**
     * Runs ordered by last activity (not by file mtime), so restoring or copying a run
     * file does not reorder the index. mtime only picks which files are worth reading.
     */
    async listRuns(limit = 100) {
        let names = [];
        try {
            names = await fsp.readdir(this.runsDir);
        }
        catch {
            return [];
        }
        const files = [];
        for (const name of names) {
            if (!name.endsWith(".jsonl"))
                continue;
            try {
                const st = await fsp.stat(path.join(this.runsDir, name));
                files.push({ name, mtimeMs: st.mtimeMs });
            }
            catch {
                /* raced with a delete */
            }
        }
        files.sort((a, b) => b.mtimeMs - a.mtimeMs);
        const out = [];
        for (const f of files.slice(0, limit * 2)) {
            const runId = f.name.slice(0, -".jsonl".length);
            const records = await this.readRecords(runId);
            if (records.length)
                out.push(summarize(runId, records));
        }
        out.sort((a, b) => Date.parse(b.updatedAt ?? b.startedAt ?? "0") - Date.parse(a.updatedAt ?? a.startedAt ?? "0"));
        return out.slice(0, limit);
    }
    /**
     * Announce this host. The MCP process reads it to decide whether a published page
     * has a link worth returning — no HTTP probe, no port scanning, no lying URL.
     */
    writeHostState(url, urls, version) {
        try {
            fs.mkdirSync(this.home, { recursive: true });
            fs.writeFileSync(this.hostPath, JSON.stringify({ url, urls, pid: process.pid, home: this.home, startedAt: new Date().toISOString(), version }, null, 2), "utf8");
        }
        catch {
            /* best effort */
        }
    }
    clearHostState() {
        try {
            const cur = JSON.parse(fs.readFileSync(this.hostPath, "utf8"));
            if (cur.pid === process.pid)
                fs.unlinkSync(this.hostPath);
        }
        catch {
            /* best effort */
        }
    }
    /**
     * The live host, if one is running.
     *
     * `host.json` outlives a crash, so the pid is checked: a stale file must not make
     * the tool return a link that 404s.
     */
    readHostState() {
        try {
            const raw = JSON.parse(fs.readFileSync(this.hostPath, "utf8"));
            if (!raw?.url || !raw?.pid)
                return null;
            if (raw.home && raw.home !== this.home)
                return null;
            process.kill(raw.pid, 0);
            return raw;
        }
        catch {
            return null;
        }
    }
}
//# sourceMappingURL=store.js.map