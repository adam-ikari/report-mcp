#!/usr/bin/env node
/**
 * Suite: `serve --tunnel` — the Cloudflare Quick Tunnel path.
 *
 * A real quick tunnel needs the public internet and a cloudflared that reaches it, so
 * every test here points REPORT_MCP_CLOUDFLARED at a fake binary that prints the one
 * line the parser keys on (or the failure a real one would print). What is asserted is
 * the contract around it: the tunnel address becomes the advertised url, host.json and
 * /api/health agree, the local origin still serves, /api/* does not follow the tunnel
 * out, and each way the tunnel can fail says why and leaves no half-host behind.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { SERVER, connectMcp, freePort, makeReport, startServe, waitFor } from "./harness.mjs";
import { sheetDraft } from "./drafts.mjs";

const TMP = path.join(process.cwd(), "test", ".tmp-tunnel");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const HOME = path.join(TMP, "home");

const TUNNEL_URL = "https://fake-words-1234.trycloudflare.com";
const { check, finish } = makeReport();
const procs = [];
let goodPidFile = null;

/** A stand-in for cloudflared. `body` runs after `#!/bin/sh`, with the test's env. */
function fakeCloudflared(body) {
  const file = path.join(TMP, `cloudflared-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, "utf8");
  fs.chmodSync(file, 0o755);
  return file;
}

function spawnServe(port, args = [], env = {}) {
  const proc = spawn("node", [SERVER, "serve", "--port", String(port), ...args], {
    env: { ...process.env, REPORT_MCP_HOME: HOME, XDG_STATE_HOME: path.join(HOME, ".state"), AM_NO_UPDATE_CHECK: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  procs.push(proc);
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d.toString()));
  proc.stdout.on("data", () => {});
  return {
    proc,
    get stderr() {
      return stderr;
    },
    exited: new Promise((r) => proc.once("exit", (code, signal) => r({ code, signal }))),
  };
}

const hostPath = path.join(HOME, "host.json");
const readHost = () => {
  try {
    return JSON.parse(fs.readFileSync(hostPath, "utf8"));
  } catch {
    return null;
  }
};

try {
  // --- the happy path: cloudflared prints an address and keeps running ---
  goodPidFile = path.join(TMP, "cloudflared.pid");
  const good = fakeCloudflared(`echo "|  ${TUNNEL_URL}  |"; echo $$ > "${goodPidFile}"; exec sleep 30`);
  const port = await freePort();
  const s = spawnServe(port, ["--tunnel"], { REPORT_MCP_CLOUDFLARED: good });

  const up = await waitFor(() => readHost()?.url === TUNNEL_URL, { timeout: 8000 });
  check("the tunnel address becomes the advertised url", up, s.stderr.slice(0, 200));

  const st = readHost();
  check(
    "host.json lists the tunnel first and the local origin after it",
    st?.urls?.[0] === TUNNEL_URL && st.urls.includes(`http://127.0.0.1:${port}`),
    JSON.stringify(st?.urls),
  );

  const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  check("/api/health agrees with host.json", health.urls[0] === TUNNEL_URL, JSON.stringify(health.urls));
  check("the local origin still serves the index", (await fetch(`http://127.0.0.1:${port}/`)).ok);
  check("serve warns that the tunnel address is public", /公网可达/.test(s.stderr), s.stderr.replace(/\s+/g, " ").slice(0, 160));
  check("and does not also claim a LAN bind, since it still listens on loopback", !/绑的是 0\.0\.0\.0/.test(s.stderr), s.stderr.replace(/\s+/g, " ").slice(0, 160));

  // The journal dump is loopback-only, and a tunneled request arrives from 127.0.0.1.
  // When a tunnel is on, the route is off outright.
  check("a tunneled host does not expose /api/runs, even to a loopback caller", (await fetch(`http://127.0.0.1:${port}/api/runs`)).status === 404);

  // An agent in this home builds its links from host.json — so it hands back the tunnel.
  const c = await connectMcp({ ...process.env, REPORT_MCP_HOME: HOME });
  await c.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "tunnel", version: "0" } });
  c.notify("notifications/initialized", {});
  const start = await c.call("report_start", { title: "Through the tunnel" });
  const page = await c.call("report_page", { title: "Page", slug: "one", draft: sheetDraft("Page") });
  check("the agent hands back a tunnel link", page.url === `${TUNNEL_URL}/r/${start.runId}/2-one`, String(page.url));
  c.close();

  // --- a clean stop takes the tunnel process with it ---
  const cfPid = Number(fs.readFileSync(goodPidFile, "utf8").trim());
  await s.proc.kill("SIGTERM");
  await waitFor(() => !fs.existsSync(hostPath), { timeout: 4000 });
  check("a clean stop removes host.json", !fs.existsSync(hostPath));
  const cfGone = await waitFor(() => {
    try {
      process.kill(cfPid, 0);
      return false;
    } catch {
      return true;
    }
  }, { timeout: 4000, interval: 50 });
  check("and stops the cloudflared process it started", cfGone, `cloudflared pid ${cfPid}`);

  // --- without --tunnel nothing changes ---
  const plain = await startServe({ home: HOME, port: await freePort() });
  try {
    check("a host without --tunnel advertises the local origin", !plain.health.urls.some((u) => u.includes("trycloudflare")), JSON.stringify(plain.health.urls));
    check("and does not warn about a tunnel", !/公网可达/.test(plain.stderr));
    check("its journal dump is readable from loopback again", (await fetch(`${plain.origin}/api/runs`)).ok);
    // Forwarding headers are the tell that a request came through a proxy, not the loop.
    check("a loopback request carrying a proxy header is not treated as local", (await fetch(`${plain.origin}/api/runs`, { headers: { "cf-connecting-ip": "203.0.113.7" } })).status === 404);
  } finally {
    await plain.stop("SIGTERM");
  }

  // --- the tunnel can fail, and then there is no host pretending otherwise ---
  const missing = spawnServe(await freePort(), ["--tunnel"], { REPORT_MCP_CLOUDFLARED: path.join(TMP, "does-not-exist") });
  const em = await missing.exited;
  check("a missing cloudflared fails with an install hint", em.code === 3 && /找不到/.test(missing.stderr), `code=${em.code} ${missing.stderr.replace(/\s+/g, " ").slice(0, 160)}`);
  check("and leaves no host.json behind", !fs.existsSync(hostPath));

  const dead = fakeCloudflared('echo "ERR failed to request quick Tunnel"; exit 1');
  const broken = spawnServe(await freePort(), ["--tunnel"], { REPORT_MCP_CLOUDFLARED: dead });
  const eb = await broken.exited;
  check("a cloudflared that dies without an address names the exit", eb.code === 3 && /cloudflared 退出/.test(broken.stderr), `code=${eb.code} ${broken.stderr.replace(/\s+/g, " ").slice(0, 160)}`);
  check("and also leaves no host.json behind", !fs.existsSync(hostPath));

  // --- `start --tunnel` runs the same path in the background ---
  const startPort = await freePort();
  const env = { ...process.env, REPORT_MCP_HOME: HOME, XDG_STATE_HOME: path.join(HOME, ".state"), AM_NO_UPDATE_CHECK: "1", REPORT_MCP_CLOUDFLARED: good };
  const plainStart = spawnSync(process.execPath, [SERVER, "start", "--port", String(startPort)], { env, encoding: "utf8" });
  const plainPid = readHost()?.pid;
  check(
    "start without --tunnel leaves the local address",
    plainStart.status === 0 && !!plainPid && !String(readHost()?.url).includes("trycloudflare"),
    (plainStart.stdout + plainStart.stderr).replace(/\s+/g, " ").slice(0, 160),
  );

  // Adding a tunnel changes what the host *is*, so `start` replaces the live one
  // instead of keeping the tunnel-less host the flag was asking to change.
  const started = spawnSync(process.execPath, [SERVER, "start", "--port", String(startPort), "--tunnel"], { env, encoding: "utf8" });
  check("start --tunnel exits 0 and advertises the tunnel", started.status === 0 && started.stdout.includes(TUNNEL_URL), (started.stdout + started.stderr).replace(/\s+/g, " ").slice(0, 200));
  check("start --tunnel on loopback does not claim a 0.0.0.0 bind", !/绑在了 0\.0\.0\.0/.test(started.stdout + started.stderr), (started.stdout + started.stderr).replace(/\s+/g, " ").slice(0, 200));
  check(
    "start --tunnel restarts the live host that had no tunnel",
    readHost()?.url === TUNNEL_URL && readHost()?.pid !== plainPid && /已重启/.test(started.stdout),
    `pid ${plainPid} -> ${readHost()?.pid}, ${(started.stdout + started.stderr).replace(/\s+/g, " ").slice(0, 200)}`,
  );

  // Already tunneled is the same start, so it stays idempotent: no second restart.
  const tunnelPid = readHost()?.pid;
  const again = spawnSync(process.execPath, [SERVER, "start", "--port", String(startPort), "--tunnel"], { env, encoding: "utf8" });
  check(
    "start --tunnel on an already-tunneled host is a no-op",
    again.status === 0 && readHost()?.pid === tunnelPid && !/已重启/.test(again.stdout),
    `pid ${tunnelPid} -> ${readHost()?.pid}, ${(again.stdout + again.stderr).replace(/\s+/g, " ").slice(0, 160)}`,
  );

  const stopped = spawnSync(process.execPath, [SERVER, "stop"], { env, encoding: "utf8" });
  check("stop cleans it up", stopped.status === 0 && !fs.existsSync(hostPath), (stopped.stdout + stopped.stderr).replace(/\s+/g, " ").slice(0, 160));
} catch (err) {
  check("no exception", false, String(err && err.stack ? err.stack : err));
} finally {
  for (const p of procs) {
    try {
      p.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  if (goodPidFile && fs.existsSync(goodPidFile)) {
    try {
      process.kill(Number(fs.readFileSync(goodPidFile, "utf8").trim()), "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  fs.rmSync(TMP, { recursive: true, force: true });
}

finish();
