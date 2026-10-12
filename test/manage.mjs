#!/usr/bin/env node
/**
 * Suite: `report-mcp start` / `stop` / `status` — the CLI that owns the host's
 * lifecycle, for a human without a free terminal and an agent that can shell out.
 *
 * These commands add no state: they read and write the same `host.json` the MCP
 * side already reads, and the process they stop is the process `serve` would have
 * been. So the tests are about the seams — idempotence, a recycled pid, a stale
 * record, a port someone else holds.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { SERVER, connectMcp, freePort, makeReport, waitFor } from "./harness.mjs";
import { sheetDraft } from "./drafts.mjs";

const TMP = path.join(process.cwd(), "test", ".tmp-manage");
fs.rmSync(TMP, { recursive: true, force: true });
const HOME = path.join(TMP, "home");
fs.mkdirSync(HOME, { recursive: true });

const { check, finish } = makeReport();

const cli = (cmd, args = [], env = {}) =>
  spawnSync(process.execPath, [SERVER, cmd, ...args], {
    encoding: "utf8",
    env: { ...process.env, REPORT_MCP_HOME: HOME, ...env },
  });

const hostFile = path.join(HOME, "host.json");
const readHost = () => {
  try {
    return JSON.parse(fs.readFileSync(hostFile, "utf8"));
  } catch {
    return null;
  }
};
const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

let port = 0;
let client = null;
let stranger = null;

try {
  port = await freePort();

  // --- status answers the question an agent asks, in its own currency ---
  const off = cli("status", ["--json"]);
  check("status exits 1 with no host", off.status === 1, `status=${off.status}`);
  check("and says so in JSON", JSON.parse(off.stdout).running === false, off.stdout.trim());
  check("status names the home it looked in", JSON.parse(off.stdout).home === HOME);
  check("status without --json tells you the command to run", cli("status").stdout.includes("report-mcp start"));

  // --- start: one host, and a second call does not make two ---
  const up = cli("start", ["--port", String(port)]);
  check("start succeeds", up.status === 0, `status=${up.status} · ${up.stderr.slice(0, 200)}`);
  const first = readHost();
  check("start wrote host.json with a live pid", !!first?.pid && isAlive(first.pid), JSON.stringify(first));
  check("start reports what it started", up.stdout.includes(`127.0.0.1:${port}`), up.stdout.trim());
  check("the background host logs to the home, not to the caller", fs.readFileSync(path.join(HOME, "serve.log"), "utf8").includes("serve"));

  const again = cli("start", ["--port", String(port)]);
  check("start is idempotent", again.status === 0 && readHost()?.pid === first.pid, `pid ${first.pid} → ${readHost()?.pid}`);

  const on = cli("status", ["--json"]);
  check("status exits 0 with a host", on.status === 0, `status=${on.status}`);
  check("status finds the running host", JSON.parse(on.stdout).running === true);

  // --- the point of the whole thing: the agent's link is live ---
  client = await connectMcp({ REPORT_MCP_HOME: HOME });
  await client.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "manage", version: "0" } });
  client.notify("notifications/initialized", {});
  await client.call("report_start", { title: "CLI 启停", tags: ["infra"] });
  const page = await client.call("report_page", { title: "First report", slug: "first", draft: sheetDraft("First report") });
  const res = await fetch(page.url);
  check("a page published while the CLI holds the host is reachable", res.ok && (await res.text()).includes("First report"), page.url);
  check("status counts the pages", String(JSON.parse(cli("status", ["--json"]).stdout).pages) === "1", cli("status", ["--json"]).stdout.replace(/\s+/g, " "));

  // --- stop ---
  const down = cli("stop");
  check("stop succeeds", down.status === 0, `status=${down.status} · ${down.stderr.slice(0, 160)}`);
  check("stop took the pid down", await waitFor(() => !isAlive(first.pid)));
  check("and cleared host.json", readHost() === null);
  const reachable = await fetch(`http://127.0.0.1:${port}/`).then(
    () => true,
    () => false,
  );
  check("a stopped host stops serving", !reachable);
  check("stop is idempotent", cli("stop").status === 0);

  // --- a pid that got recycled by someone else's process ---
  stranger = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  fs.writeFileSync(
    hostFile,
    JSON.stringify({ url: "http://127.0.0.1:9", urls: ["http://127.0.0.1:9"], pid: stranger.pid, home: HOME, startedAt: "x", version: "0.0.0" }),
  );
  const refuse = cli("stop");
  check("stop refuses to signal a process that is not its own", refuse.status !== 0 && isAlive(stranger.pid), `status=${refuse.status}`);
  check("and explains what it found", (refuse.stderr + refuse.stdout).includes(String(stranger.pid)), (refuse.stderr || refuse.stdout).trim());

  // --- a stale record must not wedge start ---
  stranger.kill("SIGKILL");
  fs.rmSync(hostFile, { force: true });
  const restart = cli("start", ["--port", String(port)]);
  check("start takes over after the record is cleaned up", restart.status === 0 && isAlive(readHost()?.pid), restart.stderr.slice(0, 200));
  cli("stop");

  // --- bind-or-die reaches the caller, with the reason ---
  const squatter = net.createServer();
  await new Promise((r) => squatter.listen(port, "127.0.0.1", r));
  const blocked = cli("start", ["--port", String(port)]);
  check("start fails when the port is held by someone else", blocked.status === 3, `status=${blocked.status}`);
  check("and shows the host's own complaint", (blocked.stderr + blocked.stdout).includes("已被占用"), blocked.stderr.trim().slice(0, 160));
  check("start on failure leaves no host record", readHost() === null);
  squatter.close();
} catch (err) {
  check("no exception", false, String(err && err.stack ? err.stack : err));
} finally {
  if (client) client.close();
  if (stranger && isAlive(stranger.pid)) stranger.kill("SIGKILL");
  cli("stop");
  fs.rmSync(TMP, { recursive: true, force: true });
}

finish();
