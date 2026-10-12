import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Store } from "./store.js";
import { LAN_WARNING } from "./host.js";

/**
 * `start` / `stop` / `status`: a human or an agent turning the one HTTP host for
 * this home on and off without owning a terminal for it.
 *
 * There is no daemon here. `start` spawns `report-mcp serve` detached, with its
 * diagnostics in a log file, and then trusts what `serve` publishes: `host.json`,
 * written after the listen succeeds and cleared on exit. That file is the whole
 * supervision protocol — `stop` reads the pid out of it and sends SIGTERM, which
 * is the signal `serve` already shuts down on.
 */

const SELF = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");

export interface ManageOptions {
  host: string;
  port: number;
  version: string;
}

export interface Status {
  running: boolean;
  pid?: number;
  url?: string;
  urls?: string[];
  home?: string;
  version?: string;
  startedAt?: string;
  log?: string;
  runs?: number;
  pages?: number;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A pid is only ours if its command line says so. Without this, a stale
 * `host.json` whose pid got recycled by an unrelated process would get SIGTERM
 * from a tool that has no business killing it.
 */
function isServe(pid: number): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return true; // No procfs (macOS): fall back to the liveness check alone.
  }
  const argv = raw.split("\0").filter(Boolean);
  return argv.some((a) => a.endsWith("report-mcp") || a.endsWith("dist/index.js")) && argv.includes("serve");
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function settled<T>(budgetMs: number, probe: () => Promise<T | null> | (T | null)): Promise<T | null> {
  const until = Date.now() + budgetMs;
  for (;;) {
    const hit = await probe();
    if (hit) return hit;
    if (Date.now() >= until) return null;
    await settle(50);
  }
}

/** A running host for this home, or null. `host.json` is the only source of truth. */
function liveHost(store: Store): { pid: number; url: string } | null {
  const h = store.readHostState();
  if (!h || !alive(h.pid)) return null;
  return { pid: h.pid, url: h.url };
}

export async function startHostProcess(store: Store, opts: ManageOptions): Promise<Status> {
  const log = path.join(store.home, "serve.log");

  // Idempotent: an agent that starts the host on every session must not fail
  // because a session already did it.
  if (liveHost(store)) return status(store);

  const child = spawn(process.execPath, [SELF, "serve", "--host", opts.host, "--port", String(opts.port)], {
    detached: true,
    stdio: ["ignore", fs.openSync(log, "a"), fs.openSync(log, "a")],
    env: process.env,
    cwd: process.cwd(),
  });
  child.unref();

  // `serve` publishes host.json only after the listen succeeds, and clears it on
  // exit — so that file appearing is the readiness signal, and the child exiting
  // without one is bind-or-die.
  let problem: Error | null = null;
  const settledChild = new Promise<void>((resolve) => {
    child.once("error", (err) => {
      problem = err;
      resolve();
    });
    child.once("exit", (code, signal) => {
      problem = new Error(`serve 一起来就退了（code ${String(code)}${signal ? ` / ${signal}` : ""}）`);
      resolve();
    });
  });

  const up = await Promise.race([settled(4000, () => liveHost(store)), settledChild.then(() => null)]);
  if (!up) {
    await Promise.race([settledChild, settle(200)]);
    await settle(200); // the child's own last lines reach the log just after it exits
    if (!problem) {
      // Alive but silent: no host.json means no `stop`, so this is ours to clean up.
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
    throw Object.assign(problem ?? new Error(`4s 内没写出 host.json（已终止 pid ${String(child.pid)}）`), {
      logTail: tail(log),
    });
  }
  return status(store);
}

function tail(file: string, bytes = 1200): string {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
  return text.slice(-bytes).trim();
}

export async function stopHostProcess(store: Store): Promise<{ stopped: boolean; pid?: number }> {
  const h = store.readHostState();
  if (!h || !alive(h.pid)) return { stopped: false };
  if (!isServe(h.pid)) {
    throw Object.assign(new Error(`pid ${h.pid} 在跑，但它不是这个 home 的 report-mcp serve —— 不动它`), { stale: true });
  }
  process.kill(h.pid, "SIGTERM");
  const gone = await settled(5000, async () => (alive(h.pid) ? null : true));
  if (!gone) throw new Error(`pid ${h.pid} 收到 SIGTERM 后 5s 内没退出`);
  return { stopped: true, pid: h.pid };
}

export async function status(store: Store): Promise<Status> {
  const h = store.readHostState();
  const running = !!h && alive(h.pid);
  const out: Status = { running, home: store.home, log: path.join(store.home, "serve.log") };
  if (!h || !running) return out;
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

export type Palette = typeof ANSI;

export const NO_COLOR: Palette = { off: "", bold: "", dim: "", green: "", red: "", yellow: "" };

/** Human-readable, one line per fact; `--json` is there for agents. */
export function describe(s: Status, opts: ManageOptions, a: Palette = ANSI): string {
  if (!s.running) {
    const bind = opts.host === "127.0.0.1" ? "" : ` --host ${opts.host} --port ${opts.port}`;
    return [
      `${a.red}✗${a.off} 宿主未运行`,
      `${a.dim}home${a.off}    ${s.home}`,
      `   起一个：${a.bold}report-mcp start${a.off}${bind}`,
    ].join("\n");
  }
  // Off-loopback URLs, not the flags someone just typed: this is the host that
  // is actually running, and `--host 0.0.0.0` is how it got readable by the floor.
  const wild = (s.urls ?? []).some((u) => !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(u));
  return [
    `${a.green}✓${a.off} 宿主在跑 ${a.bold}${s.url}/${a.off} ${a.dim}(pid ${s.pid} · v${s.version} · 自 ${s.startedAt})${a.off}`,
    ...(s.urls ?? []).slice(1).map((u) => `    备选  ${u}/`),
    `${a.dim}home${a.off}    ${s.home}`,
    `${a.dim}内容${a.off}    ${s.runs} 次汇报 · ${s.pages} 页`,
    `${a.dim}日志${a.off}    ${s.log}`,
    ...(wild ? [`${a.yellow}注意${a.off}    ${LAN_WARNING}`] : []),
  ].join("\n");
}
