#!/usr/bin/env node
/**
 * Test orchestrator.
 *
 *   npm test    build, then run every suite
 *
 * Each suite owns its temp home and its own port; nothing is shared between them,
 * so a red points at one process and not at somebody else's leftover state. There is
 * no seeded fixture and no long-lived panel to boot first: the pipeline under test is
 * a child process per render and a host that reads journals, so the suites start both
 * themselves.
 *
 *   vendor.mjs        the vendored renderer is the file the manifest pins
 *   am-smoke.mjs      the CLI contract src/render.ts assumes, against am directly
 *   render-error.mjs  a bad draft: am's error text survives, the journal keeps the draft
 *   milestone.mjs     the whole path: tool → journal → renderer → serve → fetched page
 *   host.mjs          routing and the security edges of `serve`
 *   serve.mjs         `serve` as a process: host.json, bind-or-die, address ordering
 *   tunnel.mjs        `--tunnel`: the quick-tunnel address, its failures, its shutdown
 *   manage.mjs        `start`/`stop`/`status`: idempotence, a recycled pid, a held port
 *   e2e.mjs           two MCP processes on one run id, plus a writer killed mid-run
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, "..", "dist", "index.js");

const SUITES = ["vendor.mjs", "am-smoke.mjs", "render-error.mjs", "milestone.mjs", "host.mjs", "serve.mjs", "tunnel.mjs", "manage.mjs", "e2e.mjs"];

function run(file) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(here, file)], { stdio: "inherit" });
    p.on("exit", (code) => resolve(code ?? 1));
    p.on("error", () => resolve(1));
  });
}

if (!fs.existsSync(SERVER)) {
  console.error("dist/index.js not found — run `npm run build` first.");
  process.exit(1);
}

const failed = [];
for (const s of SUITES) {
  console.log(`\n=== ${s} ===`);
  if (await run(s)) failed.push(s);
}

// Suites clean up after themselves; this is the belt, for a run that threw mid-file.
for (const d of fs.readdirSync(here)) {
  if (d.startsWith(".tmp-")) fs.rmSync(path.join(here, d), { recursive: true, force: true });
}

console.log(failed.length ? `\nFAILED: ${failed.join(", ")}` : "\nall suites passed");
process.exit(failed.length ? 1 : 0);
