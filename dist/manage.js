import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LAN_WARNING } from "./host.js";
import { registeredHosts, removeHost } from "./registry.js";
import { TUNNEL_TIMEOUT_MS, isTunnelUrl } from "./tunnel.js";
/**
 * `start` / `stop` / `status`: a human or an agent turning the one HTTP host for
 * this home on and off without owning a terminal for it.
 *
 * There is no daemon here. `start` spawns `report-mcp serve` detached, with its
 * diagnostics in a log file, and then trusts what `serve` publishes: `host.json`,
 * written after the listen succeeds and cleared on exit. That file is the whole
 * supervision protocol — `stop` reads the pid out of it and sends SIGTERM, which
 * is the signal `serve` already shuts down on.
 *
 * `start` also reads the per-account registry (`src/registry.ts`), because one host
 * per *home* would still let a second home quietly take a second port.
 */
const SELF = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");
function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * A pid is only ours if its command line says so. Without this, a stale
 * `host.json` whose pid got recycled by an unrelated process would get SIGTERM
 * from a tool that has no business killing it.
 *
 * On platforms without procfs the check degrades to liveness only, and `stop --all`
 * — the one command that reaches pids this home never owned — is where that exposure
 * widens. Asking each candidate's own `/api/health` would close it; v0.4 does not.
 */
function isServe(pid) {
    let raw;
    try {
        raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    }
    catch {
        return true; // No procfs (macOS): fall back to the liveness check alone.
    }
    const argv = raw.split("\0").filter(Boolean);
    return argv.some((a) => a.endsWith("report-mcp") || a.endsWith("dist/index.js")) && argv.includes("serve");
}
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
async function settled(budgetMs, probe) {
    const until = Date.now() + budgetMs;
    for (;;) {
        const hit = await probe();
        if (hit)
            return hit;
        if (Date.now() >= until)
            return null;
        await settle(50);
    }
}
/** A running host for this home, or null. `host.json` is the only source of truth. */
function liveHost(store) {
    const h = store.readHostState();
    if (!h || !alive(h.pid))
        return null;
    return { pid: h.pid, url: h.url };
}
/**
 * Live hosts serving some *other* home under this account. Entries whose pid is gone,
 * or is now some unrelated process, are deleted here rather than left to accumulate.
 */
function otherHosts(store) {
    const out = [];
    for (const h of registeredHosts()) {
        if (!alive(h.pid) || !isServe(h.pid)) {
            removeHost(h);
            continue;
        }
        if (h.home === store.home)
            continue;
        out.push(h);
    }
    return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
export async function startHostProcess(store, opts) {
    const log = path.join(store.home, "serve.log");
    // Idempotent: an agent that starts the host on every session must not fail
    // because a session already did it.
    let restarted = false;
    const live = liveHost(store);
    if (live) {
        // Asking for a tunnel when the live host has none changes what the host *is*,
        // not just how it was started: replace it. A live tunnel is the same start, so
        // it stays idempotent. A host that already has one is never restarted by `start`.
        if (!opts.tunnel || isTunnelUrl(live.url))
            return status(store);
        await stopHostProcess(store);
        restarted = true;
    }
    // One instance per account, unless a port was named. A second host nobody asked
    // for means two indexes, two sets of links, and no way to tell which one a page
    // was published against.
    const others = otherHosts(store);
    if (others.length && !opts.explicitPort) {
        const who = others.map((h) => `${h.url}（home ${h.home}，pid ${h.pid}）`).join("、");
        throw Object.assign(new Error(`这个账户下已经有宿主在跑：${who}。start 只起一个实例——先停掉它（report-mcp stop --all），确实要第二个就显式给 --port`), { conflict: others });
    }
    const child = spawn(process.execPath, [SELF, "serve", "--host", opts.host, "--port", String(opts.port), ...(opts.tunnel ? ["--tunnel"] : [])], {
        detached: true,
        stdio: ["ignore", fs.openSync(log, "a"), fs.openSync(log, "a")],
        env: process.env,
        cwd: process.cwd(),
    });
    child.unref();
    // `serve` publishes host.json only after the listen succeeds, and clears it on
    // exit — so that file appearing is the readiness signal, and the child exiting
    // without one is bind-or-die.
    let problem = null;
    const settledChild = new Promise((resolve) => {
        child.once("error", (err) => {
            problem = err;
            resolve();
        });
        child.once("exit", (code, signal) => {
            problem = new Error(`serve 一起来就退了（code ${String(code)}${signal ? ` / ${signal}` : ""}）`);
            resolve();
        });
    });
    // A tunnel has to reach Cloudflare before host.json exists, so readiness waits longer
    // when one was asked for — the host is not up until its public address is.
    const budget = opts.tunnel ? TUNNEL_TIMEOUT_MS + 5000 : 4000;
    const up = await Promise.race([settled(budget, () => liveHost(store)), settledChild.then(() => null)]);
    if (!up) {
        await Promise.race([settledChild, settle(200)]);
        await settle(200); // the child's own last lines reach the log just after it exits
        if (!problem) {
            // Alive but silent: no host.json means no `stop`, so this is ours to clean up.
            try {
                child.kill("SIGTERM");
            }
            catch {
                /* already gone */
            }
        }
        throw Object.assign(problem ?? new Error(`${Math.round(budget / 1000)}s 内没写出 host.json（已终止 pid ${String(child.pid)}）`), {
            logTail: tail(log),
        });
    }
    const out = await status(store);
    return restarted ? { ...out, restarted: true } : out;
}
function tail(file, bytes = 1200) {
    let text = "";
    try {
        text = fs.readFileSync(file, "utf8");
    }
    catch {
        return "";
    }
    return text.slice(-bytes).trim();
}
export async function stopHostProcess(store, all = false) {
    const h = store.readHostState();
    if (h && alive(h.pid) && !isServe(h.pid)) {
        throw Object.assign(new Error(`pid ${h.pid} 在跑，但它不是这个 home 的 report-mcp serve —— 不动它`), { stale: true });
    }
    // `--all` is the way out of the refusal in `start`: the other host belongs to a
    // different home, so this command has to reach it by pid, not by `host.json`.
    const also = all ? otherHosts(store) : [];
    const target = h && alive(h.pid) ? { pid: h.pid } : null;
    if (!target && !also.length)
        return { stopped: false };
    if (target)
        process.kill(target.pid, "SIGTERM");
    for (const other of also)
        process.kill(other.pid, "SIGTERM");
    const lingering = [target?.pid, ...also.map((o) => o.pid)].filter((p) => typeof p === "number");
    const gone = await settled(5000, async () => (lingering.some((pid) => alive(pid)) ? null : true));
    if (!gone)
        throw new Error(`pid ${lingering.join(", ")} 收到 SIGTERM 后 5s 内没退出`);
    return { stopped: true, pid: target?.pid, also: also.map((o) => o.pid) };
}
export async function status(store) {
    const h = store.readHostState();
    const running = !!h && alive(h.pid);
    const others = otherHosts(store).map((o) => ({ url: o.url, home: o.home, pid: o.pid }));
    const out = { running, home: store.home, log: path.join(store.home, "serve.log"), ...(others.length ? { others } : {}) };
    if (!h || !running)
        return out;
    const runs = await store.listRuns(60);
    return {
        ...out,
        pid: h.pid,
        url: h.url,
        urls: h.urls,
        version: h.version,
        startedAt: h.startedAt,
        runs: runs.length,
        pages: runs.reduce((n, r) => n + r.pageCount, 0),
    };
}
export const ANSI = {
    off: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    green: "\x1b[32m",
    red: "\x1b[31m",
    yellow: "\x1b[33m",
};
export const NO_COLOR = { off: "", bold: "", dim: "", green: "", red: "", yellow: "" };
/** Human-readable, one line per fact; `--json` is there for agents. */
export function describe(s, opts, a = ANSI) {
    const others = (s.others ?? []).map((o) => `    另有宿主 ${o.url} ${a.dim}(home ${o.home} · pid ${o.pid})${a.off}`);
    if (!s.running) {
        const bind = opts.host === "127.0.0.1" ? "" : ` --host ${opts.host} --port ${opts.port}`;
        return [
            `${a.red}✗${a.off} 宿主未运行`,
            `${a.dim}home${a.off}    ${s.home}`,
            ...(others.length ? [...others, `   ${a.dim}start 会拒绝再起一个（同端口只一个实例），除非显式 --port${a.off}`] : []),
            `   起一个：${a.bold}report-mcp start${a.off}${bind}`,
        ].join("\n");
    }
    // Off-loopback URLs, not the flags someone just typed: this is the host that
    // is actually running, and `--host 0.0.0.0` is how it got readable by the floor.
    // A tunnel address is off-loopback too, but it is not a wildcard bind: excluding it
    // here keeps the LAN warning about the LAN.
    const wild = (s.urls ?? []).some((u) => !isTunnelUrl(u) && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(u));
    return [
        `${a.green}✓${a.off} 宿主在跑 ${a.bold}${s.url}/${a.off} ${a.dim}(pid ${s.pid} · v${s.version} · 自 ${s.startedAt})${a.off}`,
        ...(s.urls ?? []).slice(1).map((u) => `    备选  ${u}/`),
        `${a.dim}home${a.off}    ${s.home}`,
        `${a.dim}内容${a.off}    ${s.runs} 次汇报 · ${s.pages} 页`,
        `${a.dim}日志${a.off}    ${s.log}`,
        ...(s.url && isTunnelUrl(s.url) ? [`${a.yellow}注意${a.off}    隧道地址公网可达：拿到链接的人都能读，无鉴权。`] : []),
        ...others,
        ...(wild ? [`${a.yellow}注意${a.off}    ${LAN_WARNING}`] : []),
    ].join("\n");
}
//# sourceMappingURL=manage.js.map