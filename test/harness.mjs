/**
 * Shared plumbing for the test suites.
 *
 * Three things are worth sharing rather than copying a sixth time:
 *
 *   connectMcp()   a minimal MCP client over stdio — JSON-RPC framing, notification
 *                  collection (used to assert stdout purity) and parsing of the
 *                  server's stderr boot lines.
 *   startServe()   spawns `report-mcp serve` on a free port and waits for its health
 *                  endpoint, so suites never sleep a guess.
 *   makeReport()   the PASS/FAIL line printer and the exit code, identical everywhere.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER = path.join(here, "..", "dist", "index.js");
export const REPO = path.join(here, "..");
export const FIXTURES_DIR = path.join(here, "fixtures");

/**
 * The journal as the tests see it: raw JSONL, no import of the code under test.
 *
 * Suites read the file rather than `summarize()` on purpose — a fixture asserted
 * against the same function that builds it proves nothing about the file format.
 */
export function parseJournalSafe(file) {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      out.push({ kind: "UNPARSEABLE", line });
    }
  }
  return out;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Ask the OS for a port nobody holds, then get out of its way fast.
 *
 * Suites that need their own listener use this instead of a hardcoded port: 7788 is
 * the production default, and a real `serve` on this machine may legitimately hold it
 * while tests run.
 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

/**
 * Poll `cond` until it is truthy (or the timeout).
 *
 * Assertions wait for a *state* rather than a fixed delay: a loaded CI box needs more
 * than 700ms for a child process to render a page, and a sleep that is too short
 * turns into a flaky red.
 */
export async function waitFor(cond, { timeout = 4000, interval = 40 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let value;
    try {
      value = await cond();
    } catch {
      value = false;
    }
    if (value) return true;
    if (Date.now() >= deadline) return false;
    await sleep(interval);
  }
}

export function makeReport() {
  const results = [];
  return {
    check(name, cond, extra) {
      results.push({ name, ok: !!cond, extra });
      console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
    },
    finish() {
      const failed = results.filter((r) => !r.ok);
      console.log(`\n${results.length - failed.length}/${results.length} passed`);
      process.exit(failed.length ? 1 : 0);
    },
  };
}

/**
 * Spawn a `report-mcp` process and speak MCP to it over stdio.
 *
 * Resolves only once the server has announced its storage root and run id on stderr,
 * so the caller gets a usable client or a throw with the boot log attached.
 */
export async function connectMcp(env, { args = [], serverPath = SERVER, timeout = 15000 } = {}) {
  const proc = spawn("node", [serverPath, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });

  let stdoutBuf = "";
  let stderrBuf = "";
  let exitedWith = null;
  let nextId = 1;
  const pending = new Map();
  const notifications = [];
  const meta = { hostUrl: null, runId: null, storage: null };

  proc.stdout.on("data", (d) => {
    stdoutBuf += d.toString();
    let i;
    while ((i = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, i).trim();
      stdoutBuf = stdoutBuf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        console.log("NON-JSON stdout:", line);
        notifications.push("NON-JSON stdout: " + line);
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        notifications.push(msg.method);
      }
    }
  });

  proc.stderr.on("data", (d) => {
    stderrBuf += d.toString();
    let m;
    // The host line carries a trailing " (pid N)" or the "未运行" explanation; the URL
    // is the first whitespace-delimited token either way.
    if (!meta.hostUrl && (m = /\[report-mcp\] host\s+(http:\/\/\S+)/.exec(stderrBuf))) meta.hostUrl = m[1];
    if (!meta.runId && (m = /\[report-mcp\] run id\s+(\S+)/.exec(stderrBuf))) meta.runId = m[1];
    if (!meta.storage && (m = /\[report-mcp\] storage\s+(\S+)/.exec(stderrBuf))) meta.storage = m[1];
  });

  const failAll = (why) => {
    for (const { reject } of pending.values()) reject(new Error(why));
    pending.clear();
  };
  proc.on("exit", (code) => {
    exitedWith = code;
    failAll(`server exited with code ${code}`);
  });
  proc.on("error", (e) => {
    exitedWith = -1;
    failAll(`could not spawn server: ${e.message}`);
  });

  // storage and run id arrive as separate stderr writes; resolving on the first alone
  // races callers that assert on runId immediately after connect.
  const up = await waitFor(() => Boolean(meta.runId && meta.storage), { timeout, interval: 50 });
  if (!up) {
    proc.kill("SIGKILL");
    throw new Error(`server never announced boot lines (exit=${exitedWith})\n${stderrBuf}`);
  }

  function rpc(method, params) {
    const id = nextId++;
    const promise = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error("timeout: " + method));
        }
      }, 20000);
    });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return promise;
  }

  function notify(method, params) {
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  /** Unwrap a tool result, throwing on isError so callers fail loudly. */
  function text(res) {
    if (res.isError) throw new Error("tool error: " + res.content.map((c) => c.text).join(""));
    return JSON.parse(res.content[0].text);
  }

  /** Call a tool and return its payload — or the raw result when it failed. */
  async function call(name, args = {}) {
    const res = await rpc("tools/call", { name, arguments: args });
    return res.isError ? res : text(res);
  }

  /** The joined tool text, for asserting on a renderer's own error output. */
  function errorText(res) {
    return res.content.map((c) => c.text).join("");
  }

  return {
    proc,
    rpc,
    notify,
    text,
    call,
    errorText,
    notifications,
    get hostUrl() {
      return meta.hostUrl;
    },
    get runId() {
      return meta.runId;
    },
    get storage() {
      return meta.storage;
    },
    get stderr() {
      return stderrBuf;
    },
    close() {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    },
  };
}

/**
 * `report-mcp serve` on its own port and home, ready to fetch from.
 *
 * Returns the process plus the health payload. `stop()` kills it; a suite that wants
 * the exit code uses `exited`, which resolves with {code, signal, stderr}.
 */
export async function startServe({ home, port, host = "127.0.0.1", env = {}, args = [] }, { timeout = 8000 } = {}) {
  const proc = spawn("node", [SERVER, "serve", "--host", host, "--port", String(port), ...args], {
    // The host registry is per-account; a suite that registers its throwaway host in
    // the real ~/.local/state would make a later `start` under this user refuse.
    env: { ...process.env, REPORT_MCP_HOME: home, XDG_STATE_HOME: path.join(home, ".state"), AM_NO_UPDATE_CHECK: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderrBuf = "";
  let stdoutBuf = "";
  proc.stderr.on("data", (d) => (stderrBuf += d.toString()));
  proc.stdout.on("data", (d) => (stdoutBuf += d.toString()));
  const exited = new Promise((resolve) => {
    proc.once("exit", (code, signal) => resolve({ code, signal, stderr: stderrBuf, stdout: stdoutBuf }));
  });
  proc.on("error", () => {});

  const origin = `http://${host}:${port}`;
  let health = null;
  const up = await waitFor(
    async () => {
      const r = await fetch(`${origin}/api/health`).catch(() => null);
      if (!r?.ok) return false;
      health = await r.json();
      return true;
    },
    { timeout, interval: 60 },
  );
  if (!up) {
    proc.kill("SIGKILL");
    throw new Error(`serve did not come up on ${origin}\n${stderrBuf}`);
  }
  return {
    proc,
    origin,
    port,
    host,
    health,
    get stderr() {
      return stderrBuf;
    },
    exited,
    stop: (signal = "SIGKILL") => {
      if (proc.exitCode === null && !proc.killed) proc.kill(signal);
      return exited;
    },
  };
}
