/**
 * Shared plumbing for the test suites.
 *
 * Two things are worth sharing rather than copying a third time:
 *
 *   connectMcp()          a minimal MCP client over stdio — JSON-RPC framing,
 *                         notification collection (used to assert stdout purity)
 *                         and parsing of the server's stderr boot lines.
 *   createEventSourceShim() the SSE-over-fetch reader. jsdom ships no
 *                         EventSource, and the framing logic (event:/data:
 *                         blocks split on blank lines) is subtle enough that
 *                         two copies would drift.
 *
 * Suites keep their own `check`/`results` locals: they differ in what they
 * print and how they exit, and a shared reporter buys nothing.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER = path.join(here, "..", "dist", "index.js");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll `cond` until it is truthy (or the timeout).
 *
 * E2E assertions wait for a *state* rather than a fixed delay: 700ms was
 * enough for local fs.watch but the same code on a loaded CI box needs more,
 * and a fixed sleep that is too short turns into a flaky red.
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

/** Node has no fetch in the jsdom window; bridge it to the absolute origin. */
export const createFetcher = (origin) => (u, o) => fetch(new URL(String(u), origin), o);

/**
 * Minimal EventSource over fetch streaming.
 *
 * Live log hooks are optional: suites that want a transcript pass them, the
 * others stay quiet so the suite output only carries assertions.
 */
export function createEventSourceShim(fetchFn, { onEvent, onError, onClose, onListenerError } = {}) {
  return class EventSourceShim {
    constructor(url) {
      this.listeners = new Map();
      this.onerror = null;
      this.readyState = 0;
      this.ac = new AbortController();
      fetchFn(url, { signal: this.ac.signal })
        .then((res) => {
          this.readyState = 1;
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let acc = "";
          const pump = () =>
            reader.read().then(({ value, done }) => {
              if (done) return;
              acc += dec.decode(value, { stream: true });
              let i;
              while ((i = acc.indexOf("\n\n")) >= 0) {
                const block = acc.slice(0, i);
                acc = acc.slice(i + 2);
                const em = /^event: (.+)$/m.exec(block);
                const dm = /^data: (.+)$/m.exec(block);
                if (!em || !dm) continue;
                onEvent?.(em[1], dm[1]);
                for (const fn of this.listeners.get(em[1]) ?? []) {
                  try {
                    fn({ data: dm[1] });
                  } catch (e) {
                    onListenerError?.(e);
                  }
                }
              }
              return pump();
            });
          return pump();
        })
        .catch((e) => {
          onError?.(e);
          if (this.onerror) this.onerror(e);
        });
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    removeEventListener(type, fn) {
      const list = this.listeners.get(type);
      if (list) this.listeners.set(type, list.filter((f) => f !== fn));
    }
    close() {
      onClose?.();
      this.ac.abort();
      this.readyState = 2;
    }
  };
}

/**
 * Spawn a server process and speak MCP to it over stdio.
 *
 * Resolves only once the server has announced its panel URL on stderr, so the
 * caller gets a usable client or a throw with the boot log attached.
 */
export async function connectMcp(env, { serverPath = SERVER, timeout = 15000 } = {}) {
  const proc = spawn("node", [serverPath], { env, stdio: ["pipe", "pipe", "pipe"] });

  let stdoutBuf = "";
  let stderrBuf = "";
  let exitedWith = null;
  let nextId = 1;
  const pending = new Map();
  const notifications = [];
  const meta = { panelUrl: null, runId: null, storage: null };

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
    if (!meta.panelUrl && (m = /\[report-mcp\] panel\s+(\S+)/.exec(stderrBuf))) {
      meta.panelUrl = m[1].replace(/\/#.*$/, "");
    }
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

  // The boot lines arrive as separate stderr writes in the order
  // panel → storage → run id; resolving on the first alone races callers
  // that assert on runId immediately after connect.
  const up = await waitFor(() => Boolean(meta.panelUrl && meta.runId && meta.storage), { timeout, interval: 50 });
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
      }, 10000);
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

  /** Convenience: tools/call in one step. */
  async function call(name, args = {}) {
    return text(await rpc("tools/call", { name, arguments: args }));
  }

  return {
    proc,
    rpc,
    notify,
    text,
    call,
    notifications,
    get panelUrl() {
      return meta.panelUrl;
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
