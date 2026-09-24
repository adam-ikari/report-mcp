import fs from "node:fs";
import path from "node:path";
import { buildRuns } from "./fixtures.mjs";

const HOME = process.env.REPORT_MCP_HOME || "/tmp/opencode/report-home";
fs.rmSync(HOME, { recursive: true, force: true });
const RUNS = path.join(HOME, "runs");
fs.mkdirSync(RUNS, { recursive: true });

const runs = buildRuns();
for (const { runId, records } of runs) {
  fs.writeFileSync(path.join(RUNS, `${runId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

console.log(`seeded ${runs.length} runs into ${RUNS}`);
for (const r of runs) console.log("  ", r.runId);
