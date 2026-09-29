#!/usr/bin/env node
/**
 * Suite: one shared panel across processes.
 *
 * Covers the election (first bind wins), attach (second agent reuses the
 * host's URL and writes into the shared store), takeover (host session dies,
 * attached agent promotes within ~5s), the foreign-squatter fallback, and
 * cross-home isolation (a same-port panel with a different REPORT_MCP_HOME
 * must not be trusted).
 *
 * Uses its own home dirs and OS-assigned free ports (override with
 * TEST_SINGLE_PORT) so it can never collide with the orchestrator panel or a
 * live production session on 7788.
 */
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { connectMcp, waitFor } from "./harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const HOME1 = path.join(here, ".tmp-single");
const HOME2 = path.join(here, ".tmp-single2");

/** Ask the OS for a port nobody holds, then get out of its way fast. */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

const PORT = Number(process.env.TEST_SINGLE_PORT || (await freePort()));
const SQUAT_PORT = process.env.TEST_SINGLE_PORT ? PORT + 3 : await freePort();

let passed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) {
    passed++;
  } else {
    failures.push(name);
  }
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra != null ? "  " + extra : ""}`);
}

const envFor = (home, port) => ({
  ...process.env,
  REPORT_MCP_HOME: home,
  REPORT_MCP_PORT: String(port),
});
const readState = (home) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, "panel.json"), "utf8"));
  } catch {
    return null;
  }
};
const portOf = (url) => new URL(url).port;

fs.rmSync(HOME1, { recursive: true, force: true });
fs.rmSync(HOME2, { recursive: true, force: true });

// A leftover live panel on our port (e.g. an orphan from a failed run) would
// turn every scenario into an attach. Fail loudly instead of testing that.
try {
  const stale = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(500) });
  if (stale.ok) {
    console.error(`port ${PORT} already serves a panel — orphan process still alive?`);
    process.exit(1);
  }
} catch {
  /* free, as expected */
}

const procs = [];
try {
  /* ---- a. host + attach ---- */
  console.log("--- election: first process hosts, second attaches ---");
  const A = await connectMcp(envFor(HOME1, PORT));
  procs.push(A);
  check("A hosts the shared port", portOf(A.panelUrl) === String(PORT), A.panelUrl);
  check("A boot line says host", A.stderr.includes("(host)"));
  const stA = readState(HOME1);
  check("panel.json records A as host", stA?.pid === A.proc.pid && stA?.url === A.panelUrl,
    JSON.stringify(stA));

  const B = await connectMcp(envFor(HOME1, PORT));
  procs.push(B);
  check("B attaches to A's URL", B.panelUrl === A.panelUrl, B.panelUrl);
  check("B boot line says attached", B.stderr.includes("(attached"));
  check("attach does not rewrite panel.json", readState(HOME1)?.pid === A.proc.pid);

  const start = await B.call("report_start", { title: "written by the attached agent" });
  check("attached tool reply carries the shared panelUrl", start.panelUrl === A.panelUrl, start.panelUrl);
  check("viewUrl deep-links into the shared panel",
    start.viewUrl === `${A.panelUrl}/#/run/${encodeURIComponent(B.runId)}`, start.viewUrl);

  /* ---- b. shared store is live through the host ---- */
  console.log("\n--- shared store: host panel serves the attacher's records ---");
  await B.call("report_progress", { phase: "append", percent: 50 });
  const ok = await waitFor(async () => {
    try {
      const res = await fetch(`${A.panelUrl}/api/runs/${encodeURIComponent(B.runId)}`);
      if (!res.ok) return false;
      const data = await res.json();
      return data.records.length === 2;
    } catch {
      return false;
    }
  }, { timeout: 6000, interval: 100 });
  check("host serves both records written by the attached process", ok);

  /* ---- c. takeover after the host dies ---- */
  console.log("\n--- takeover: kill host, attached agent promotes ---");
  A.proc.kill("SIGTERM");
  const promoted = await waitFor(() => readState(HOME1)?.pid === B.proc.pid, { timeout: 20000, interval: 250 });
  check("B is elected after A exits", promoted, "panel.json pid=" + readState(HOME1)?.pid + " want=" + B.proc.pid);
  const alive = await waitFor(async () => {
    try {
      return (await fetch(`${B.panelUrl}/api/health`)).ok;
    } catch {
      return false;
    }
  }, { timeout: 5000 });
  check("promoted panel answers on the same URL", alive, B.panelUrl);
  const stillThere = await fetch(`${B.panelUrl}/api/runs/${encodeURIComponent(B.runId)}`).then((r) => r.json());
  check("history survives the takeover", stillThere?.records?.length === 2,
    "got " + stillThere?.records?.length);

  const C = await connectMcp(envFor(HOME1, PORT));
  procs.push(C);
  check("a third agent attaches to the new host", C.panelUrl === B.panelUrl && C.stderr.includes("(attached"),
    C.panelUrl);

  /* ---- d. foreign squatter → private fallback ---- */
  console.log("\n--- foreign port holder: fall back to a private panel ---");
  const squatter = http.createServer((_req, res) => res.end("not a report-mcp panel"));
  await new Promise((r) => squatter.listen(SQUAT_PORT, "127.0.0.1", r));
  const D = await connectMcp(envFor(HOME1, SQUAT_PORT));
  procs.push(D);
  check("D refuses to attach to a foreign holder", D.stderr.includes("(host)"));
  check("D falls back to an ephemeral port", portOf(D.panelUrl) !== String(SQUAT_PORT) && portOf(D.panelUrl) !== "0",
    D.panelUrl);
  const dHealth = await fetch(`${D.panelUrl}/api/health`).then((r) => r.json()).catch(() => null);
  check("D's private panel works", dHealth?.ok === true && dHealth.home === HOME1, JSON.stringify(dHealth));
  squatter.close();

  /* ---- e. cross-home isolation ---- */
  console.log("\n--- same port, different home: do not share ---");
  const E = await connectMcp(envFor(HOME2, PORT));
  procs.push(E);
  check("E does not attach to a different-home host", E.panelUrl !== B.panelUrl, E.panelUrl);
  check("E hosts a private panel instead", E.stderr.includes("(host)") && portOf(E.panelUrl) !== String(PORT),
    E.panelUrl);
  const eState = readState(HOME2);
  check("E's home records E as its host", eState?.pid === E.proc.pid);
} catch (err) {
  check("suite completed without throwing", false, err instanceof Error ? err.stack : String(err));
} finally {
  for (const c of procs) c.close();
  fs.rmSync(HOME1, { recursive: true, force: true });
  fs.rmSync(HOME2, { recursive: true, force: true });
}

const failed = failures.length;
console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
