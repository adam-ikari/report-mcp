#!/usr/bin/env node
/**
 * Suite: `report-mcp serve` as a process, and the handshake it has with the agents.
 *
 * The old panel had a port election, an attach mode and a 5 second takeover window.
 * This host has none of that: one HTTP host per home, bind-or-die, and a `host.json`
 * that tells the agent process whether a link is real. Every rule here used to be
 * tested by the panel's arbitration — the coverage moved, it did not disappear.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { SERVER, connectMcp, freePort, makeReport, startServe, waitFor } from "./harness.mjs";
import { lanAddresses, parsePageRoute } from "../dist/host.js";
import { sheetDraft } from "./drafts.mjs";

const TMP = path.join(process.cwd(), "test", ".tmp-serve");
fs.rmSync(TMP, { recursive: true, force: true });
const HOME = path.join(TMP, "home");
const HOME2 = path.join(TMP, "home2");

const { check, finish } = makeReport();
const procs = [];
const spawnServe = (home, port, env = {}) => {
  const p = spawn("node", [SERVER, "serve", "--port", String(port)], {
    env: { ...process.env, REPORT_MCP_HOME: home, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  procs.push(p);
  let stderr = "";
  p.stderr.on("data", (d) => (stderr += d.toString()));
  p.stdout.on("data", () => {});
  return { p, get stderr() { return stderr; }, exited: new Promise((r) => p.once("exit", (code, sig) => r({ code, sig }))) };
};

try {
  // --- the CLI itself ---
  const v = spawnSync(process.execPath, [SERVER, "--version"], { encoding: "utf8" });
  check("--version prints the package version", v.status === 0 && /^report-mcp 0\.4\.0/.test(v.stdout), v.stdout.trim());
  const help = spawnSync(process.execPath, [SERVER, "--help"], { encoding: "utf8" });
  check("--help documents both modes", help.status === 0 && help.stdout.includes("serve") && help.stdout.includes("report_page"));
  check("--help names the env vars that change behaviour", help.stdout.includes("REPORT_MCP_HOME") && help.stdout.includes("REPORT_MCP_PUBLIC_URL"));

  // --- host.json: written on listen, removed on a clean exit ---
  const port = await freePort();
  const host = await startServe({ home: HOME, port });
  const statePath = path.join(HOME, "host.json");
  const st = JSON.parse(fs.readFileSync(statePath, "utf8"));
  check("host.json records the live host", st.pid === host.proc.pid && st.url === host.origin && st.home === HOME && st.version === "0.4.0", JSON.stringify(st).slice(0, 120));
  check("host.json carries every advertised address", Array.isArray(st.urls) && st.urls[0] === host.origin);

  // The per-account registry is what makes `start` refuse a second host in a second
  // home. It is written by the same code path as host.json, so it is checked here.
  const regDir = path.join(HOME, ".state", "report-mcp", "hosts");
  const regFile = () => path.join(regDir, `${host.proc.pid}-${port}.json`);
  check("a listening host registers itself beyond its own home", fs.existsSync(regFile()), JSON.stringify(fs.existsSync(regDir) ? fs.readdirSync(regDir) : "(no registry)"));

  // An agent in the same home must build a link from that file, not from a guess.
  const c = await connectMcp({ ...process.env, REPORT_MCP_HOME: HOME });
  await c.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "serve", version: "0" } });
  c.notify("notifications/initialized", {});
  const start = await c.call("report_start", { title: "Hosted" });
  check("the agent announces the host it found", c.hostUrl === host.origin, String(c.hostUrl));
  const page = await c.call("report_page", { title: "Page", slug: "one", draft: sheetDraft("Page") });
  check("a live host means a live link", page.url === `${host.origin}/r/${start.runId}/2-one`, String(page.url));
  check("and the link resolves", (await fetch(page.url)).ok, page.url);
  c.close();

  // --- a stale host.json must not produce a lying link ---
  const dead = path.join(TMP, "dead");
  fs.mkdirSync(path.join(dead, "runs"), { recursive: true });
  fs.writeFileSync(
    path.join(dead, "host.json"),
    JSON.stringify({ url: "http://127.0.0.1:1", urls: ["http://127.0.0.1:1"], pid: 999999, home: dead, startedAt: new Date().toISOString(), version: "0.4.0" }),
  );
  const c2 = await connectMcp({ ...process.env, REPORT_MCP_HOME: dead });
  await c2.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "serve", version: "0" } });
  c2.notify("notifications/initialized", {});
  const orphan = await c2.call("report_page", { title: "Orphan", slug: "two", draft: sheetDraft("Orphan") });
  check("a dead pid in host.json means url:null", orphan.ok === true && orphan.url === null && /report-mcp start/.test(orphan.hint || ""), JSON.stringify(orphan).slice(0, 140));
  check("the page is still written", fs.existsSync(path.join(dead, orphan.page)), orphan.page);
  c2.close();

  // --- bind-or-die ---
  const second = spawnServe(HOME, port);
  const gone = await second.exited;
  check("a second host on the same port exits", gone.code === 3, `code=${gone.code}`);
  check("and says which host already holds it", /已经有宿主在跑/.test(second.stderr) && second.stderr.includes(host.origin), second.stderr.split("\n")[1]);
  check("a refused host does not rewrite host.json", JSON.parse(fs.readFileSync(statePath, "utf8")).pid === host.proc.pid);

  // A different home on the same port: no host.json of its own, so the message must
  // say "not this home's report-mcp" rather than naming a host it cannot see.
  fs.mkdirSync(path.join(HOME2, "runs"), { recursive: true });
  const other = spawnServe(HOME2, port);
  const gone2 = await other.exited;
  check("another home cannot steal the port", gone2.code === 3, `code=${gone2.code}`);
  check("and is told the occupant is not its own", /不是本 home 的 report-mcp/.test(other.stderr), other.stderr.split("\n").slice(0, 3).join(" | ").slice(0, 200));

  // An unrelated listener: same verdict, no claim about report-mcp at all.
  const squatter = net.createServer();
  await new Promise((r) => squatter.listen(0, "127.0.0.1", r));
  const squatted = squatter.address().port;
  const third = spawnServe(HOME2, squatted);
  const gone3 = await third.exited;
  check("a foreign listener on the port is refused too", gone3.code === 3 && /已被占用/.test(third.stderr), `code=${gone3.code}`);
  squatter.close();

  // --- SIGKILL leaves the file, and the pid check is what saves it ---
  await host.stop("SIGKILL");
  check("a killed host leaves host.json behind", fs.existsSync(statePath));
  check("and a killed host leaves its registry entry behind too", fs.existsSync(regFile()));
  const c3 = await connectMcp({ ...process.env, REPORT_MCP_HOME: HOME });
  await c3.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "serve", version: "0" } });
  c3.notify("notifications/initialized", {});
  const after = await c3.call("report_page", { title: "After", slug: "three", draft: sheetDraft("After") });
  check("and nothing links until it is started again", after.ok === true && after.url === null);
  c3.close();

  const back = await startServe({ home: HOME, port: await freePort() });
  check("the same page is reachable after a restart", (await fetch(`${back.origin}/r/${start.runId}/2-one`)).ok);
  await back.stop("SIGTERM");
  check("a SIGTERM'd host clears host.json on the way out", !fs.existsSync(statePath));
  check("and clears its registry entry", !fs.existsSync(path.join(regDir, `${back.proc.pid}-${back.port}.json`)));

  // --- the address an operator says is reachable wins ---
  const pubPort = await freePort();
  const pub = await startServe({ home: HOME, port: pubPort, env: { REPORT_MCP_PUBLIC_URL: "https://reports.example/" } });
  check("REPORT_MCP_PUBLIC_URL is advertised first", pub.health.urls[0] === "https://reports.example", JSON.stringify(pub.health.urls));
  check("and it is what the agent links to", JSON.parse(fs.readFileSync(path.join(HOME, "host.json"), "utf8")).url === "https://reports.example");
  await pub.stop("SIGTERM");

  // --- the address list itself ---
  const lan = lanAddresses();
  check("only IPv4 is advertised — a phone on the Wi-Fi has an IPv4 address", lan.every((a) => /^\d{1,3}(\.\d{1,3}){3}$/.test(a)), JSON.stringify(lan));
  check("no link-local address is ever advertised", lan.every((a) => !a.startsWith("169.254.")), JSON.stringify(lan));
  const priv = (a) => a.startsWith("192.168.") || a.startsWith("10.") || /^172\.(1[6-9]|2\d|3[01])\./.test(a);
  const firstNonPriv = lan.findIndex((a) => !priv(a));
  check("private addresses sort ahead of the rest", firstNonPriv < 0 || lan.slice(0, firstNonPriv).every(priv), JSON.stringify(lan));

  // --- the route parser is the same one the host uses ---
  check("parsePageRoute accepts the shape we generate", parsePageRoute("/r/run_2026_abc/7-slug") === "pages/run_2026_abc/7-slug.html", String(parsePageRoute("/r/run_2026_abc/7-slug")));
  check("parsePageRoute accepts a percent-encoded non-Latin slug", parsePageRoute(`/r/run_2026_abc/7-${encodeURIComponent("缓存")}`) === "pages/run_2026_abc/7-缓存.html");
  check(
    "parsePageRoute rejects every traversal and malformed shape",
    ["/r/../etc/1-passwd", "/r/run_ok/..%2f..%2fetc", "/r/run_ok/x-slug", "/r/run_ok/0-slug", "/r/run_ok/1-a%2fb", "/r/1-slug", "/r/run_ok/1-a%2Fb"].every((p) => parsePageRoute(p) === null),
  );
} catch (err) {
  check("no exception", false, String(err && err.stack ? err.stack : err));
} finally {
  for (const { p } of procs) {
    try {
      p.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  await waitFor(() => procs.every((x) => x.p.exitCode !== null), { timeout: 2000 });
  fs.rmSync(TMP, { recursive: true, force: true });
}

finish();
