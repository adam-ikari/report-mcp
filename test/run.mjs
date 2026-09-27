#!/usr/bin/env node
/**
 * Test orchestrator.
 *
 *   npm test          build + seed fixtures + start a panel + run all suites
 *
 * Suites, in order (render must run before live mutates a fixture run):
 *   e2e.mjs    tool call → process boundary → panel DOM, incl. two writers
 *              sharing one run and a SIGKILL/restart. Own home and ports.
 *   smoke.mjs  MCP stdio handshake, every tool, HTTP API, SSE delivery, stdout purity
 *   render.mjs panel rendering in jsdom: sidebar, header, timeline, filters, switching
 *   live.mjs   append records to the JSONL out-of-band and assert the DOM updates live
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, "..", "dist", "index.js");
const HOME = path.join(here, ".tmp-home");
const SMOKE_HOME = path.join(here, ".tmp-smoke");
const E2E_HOME = path.join(here, ".tmp-e2e");
const PORT = Number(process.env.TEST_PANEL_PORT || 7788);
const ORIGIN = `http://127.0.0.1:${PORT}`;

function run(cmd, args, env) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: "inherit", env });
    p.on("exit", (code) => resolve(code ?? 1));
    p.on("error", () => resolve(1));
  });
}

if (!fs.existsSync(SERVER)) {
  console.error("dist/index.js not found — run `npm run build` first.");
  process.exit(1);
}

fs.rmSync(HOME, { recursive: true, force: true });
fs.rmSync(SMOKE_HOME, { recursive: true, force: true });
fs.rmSync(E2E_HOME, { recursive: true, force: true });

const env = {
  ...process.env,
  REPORT_MCP_HOME: HOME,
  REPORT_MCP_PORT: String(PORT),
  SMOKE_HOME,
  TEST_PANEL_URL: ORIGIN,
};

console.log("seeding fixture runs...");
let code = await run("node", [path.join(here, "seed.mjs")], env);
if (code) process.exit(code);

// stdin is kept open on purpose: closing it makes the MCP transport shut the
// server down, which is exactly what we do not want for the life of the suite.
const server = spawn("node", [SERVER], { env, stdio: ["pipe", "ignore", "inherit"] });

let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try {
    up = (await fetch(`${ORIGIN}/api/health`)).ok;
  } catch {
    await sleep(200);
  }
}
if (!up) {
  console.error(`panel did not come up on ${ORIGIN}`);
  server.kill("SIGKILL");
  process.exit(1);
}
console.log(`panel ready: ${ORIGIN}`);

const suites = ["e2e.mjs", "render.mjs", "live.mjs", "smoke.mjs", "static.mjs"];
const failed = [];
for (const s of suites) {
  console.log(`\n=== ${s} ===`);
  const c = await run("node", [path.join(here, s)], env);
  if (c) failed.push(s);
}

server.kill("SIGKILL");
fs.rmSync(HOME, { recursive: true, force: true });
fs.rmSync(SMOKE_HOME, { recursive: true, force: true });
fs.rmSync(E2E_HOME, { recursive: true, force: true });

console.log(failed.length ? `\nFAILED: ${failed.join(", ")}` : "\nall suites passed");
process.exit(failed.length ? 1 : 0);
