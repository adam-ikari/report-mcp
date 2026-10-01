#!/usr/bin/env node
/**
 * Suite: LAN exposure (REPORT_MCP_HOST=0.0.0.0).
 *
 * The panel is read-only and unauthenticated by design, so it binds 127.0.0.1
 * unless asked not to. This suite covers the opt-in path and, just as
 * importantly, the guarantee that stays true when it is *not* taken:
 *
 *   a. 0.0.0.0 binds, the boot banner names the extra addresses, and the panel
 *      actually answers on one of them
 *   b. /api/health publishes those addresses so an attaching process adopts
 *      them instead of handing out a loopback link a phone cannot open
 *   c. a second, loopback-configured process attaches and republishes the
 *      host's LAN URL — one run, one panel, links that work from a phone
 *   d. the default bind still advertises exactly one address, loopback
 *   e. a panel claiming addresses on a *different* port is not trusted for them
 *
 * Own home and OS-assigned ports (override with TEST_LAN_PORT) so it can never
 * collide with the orchestrator panel or a live production session on 7788.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { connectMcp, freePort } from "./harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.join(here, ".tmp-lan");
const HOME2 = path.join(here, ".tmp-lan2");

/** What this machine would consider its LAN address — the same rule the panel uses. */
const LOCAL_LAN = Object.values(os.networkInterfaces())
  .flat()
  .filter((n) => n && !n.internal && n.family === "IPv4" && !n.address.startsWith("169.254."))
  .map((n) => n.address);

const PORT = Number(process.env.TEST_LAN_PORT || (await freePort()));
const NARROW_PORT = process.env.TEST_LAN_PORT ? PORT + 1 : await freePort();
const SQUAT_PORT = process.env.TEST_LAN_PORT ? PORT + 2 : await freePort();

let passed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) passed++;
  else failures.push(name);
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra != null ? "  " + extra : ""}`);
}

const envFor = (home, port, extra = {}) => ({
  ...process.env,
  REPORT_MCP_HOME: home,
  REPORT_MCP_PORT: String(port),
  ...extra,
});
const readState = (home) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, "panel.json"), "utf8"));
  } catch {
    return null;
  }
};

for (const h of [HOME, HOME2]) fs.rmSync(h, { recursive: true, force: true });

const procs = [];
try {
  /* ---- a. wildcard bind ---- */
  console.log("--- 0.0.0.0: the panel answers where the banner says it does ---");
  const A = await connectMcp(envFor(HOME, PORT, { REPORT_MCP_HOST: "0.0.0.0" }));
  procs.push(A);
  check("A bound the shared port", new URL(A.panelUrl).port === String(PORT), A.panelUrl);

  const all = [A.panelUrl, ...A.lanUrls];
  check("every address shares the bound port",
    all.every((u) => new URL(u).port === String(PORT)), all.join(" "));
  check("loopback is always offered", all.includes(`http://127.0.0.1:${PORT}`), all.join(" "));
  check("at least one non-loopback address is advertised",
    all.some((u) => !/^http:\/\/127\.0\.0\.1:/.test(u)), all.join(" "));

  if (LOCAL_LAN.length) {
    const reachable = [];
    for (const u of all) {
      if (/^http:\/\/127\.0\.0\.1:/.test(u)) continue;
      const ok = await fetch(`${u}/api/health`, { signal: AbortSignal.timeout(2000) })
        .then((r) => r.ok)
        .catch(() => false);
      reachable.push(`${u}=${ok}`);
      if (ok) break;
    }
    check("a LAN address really serves the panel", reachable.some((r) => r.endsWith("=true")), reachable.join(" "));
  } else {
    console.log("SKIP  no non-internal IPv4 on this machine — LAN reachability not checkable here");
  }

  const st = readState(HOME);
  check("panel.json records every address",
    st?.url === A.panelUrl && JSON.stringify(st?.urls) === JSON.stringify(all), JSON.stringify(st));

  /* ---- b. health publishes the addresses ---- */
  console.log("\n--- /api/health tells attachers how to reach the host ---");
  const health = await (await fetch(`${A.panelUrl}/api/health`)).json();
  check("health advertises the same list", JSON.stringify(health.urls) === JSON.stringify(all),
    JSON.stringify(health.urls));
  check("health still answers ok + home", health.ok === true && health.home === HOME);

  /* ---- c. a loopback-configured attacher adopts the LAN URL ---- */
  console.log("\n--- a narrow-configured agent attaches and republishes the LAN link ---");
  const B = await connectMcp(envFor(HOME, PORT)); // no REPORT_MCP_HOST: 127.0.0.1
  procs.push(B);
  check("B attached to the host", B.stderr.includes("(attached"), B.panelUrl);
  check("B hands out the host's LAN URL, not its own loopback guess",
    B.panelUrl === A.panelUrl, `${A.panelUrl} vs ${B.panelUrl}`);
  const bStart = await B.call("report_start", { title: "written by the narrow-configured agent" });
  check("tool reply carries a phone-openable viewUrl",
    bStart.viewUrl === `${A.panelUrl}/#/run/${encodeURIComponent(B.runId)}`, bStart.viewUrl);
  check("attach did not rewrite panel.json", readState(HOME)?.pid === A.proc.pid);

  /* ---- d. the default bind stays loopback-only ---- */
  console.log("\n--- default bind: one address, loopback, no LAN lines ---");
  const C = await connectMcp(envFor(HOME2, NARROW_PORT));
  procs.push(C);
  check("C advertises only its loopback URL",
    C.lanUrls.length === 0 && C.panelUrl === `http://127.0.0.1:${NARROW_PORT}`, C.panelUrl);
  check("C printed no lan line", !C.stderr.includes("[report-mcp] lan"), C.panelUrl);
  const cHealth = await (await fetch(`${C.panelUrl}/api/health`)).json();
  check("C's health lists exactly one address",
    cHealth.urls?.length === 1 && cHealth.urls[0] === C.panelUrl, JSON.stringify(cHealth.urls));

  /* ---- e. the address list is filtered before it is republished ---- */
  console.log("\n--- the address list is filtered before it is republished ---");
  // A same-home-looking panel on its own port, advertising a mix of entries.
  // The contract: same-port http(s) entries are adopted — that is precisely how
  // a real wide-bound host publishes a LAN alias, and whoever holds our port
  // while claiming our storage path is already the host we serve from.
  // Everything else (another port, another scheme, junk) is dropped rather than
  // echoed into a link a human is about to open.
  const squatter = http.createServer((req, res) => {
    const body = JSON.stringify({
      ok: true,
      home: HOME,
      runId: "run_squatter",
      urls: [
        `http://10.0.0.9:${SQUAT_PORT}`,           // same port + scheme → adopted
        `http://10.0.0.8:${SQUAT_PORT + 100}`,     // different port → dropped
        "https://elsewhere.example.com:443",       // wrong scheme → dropped
        "not-a-url",
        42,
      ],
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
  });
  await new Promise((r) => squatter.listen(SQUAT_PORT, "127.0.0.1", r));
  const D = await connectMcp(envFor(HOME, SQUAT_PORT, { REPORT_MCP_HOST: "127.0.0.1" }));
  procs.push(D);
  check("D attaches to the same-home panel", D.panelUrl === `http://10.0.0.9:${SQUAT_PORT}`, D.panelUrl);
  check("a same-port alias is adopted", D.panelUrl === `http://10.0.0.9:${SQUAT_PORT}`, D.panelUrl);
  check("off-port address is not republished", !D.stderr.includes("10.0.0.8"), D.panelUrl);
  check("off-scheme and malformed entries are not republished",
    !D.stderr.includes("elsewhere.example.com") && !D.stderr.includes("not-a-url"), D.panelUrl);
  squatter.close();
} catch (err) {
  check("suite completed without throwing", false, err instanceof Error ? err.stack : String(err));
} finally {
  for (const c of procs) c.close();
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(HOME2, { recursive: true, force: true });
}

const failed = failures.length;
console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
