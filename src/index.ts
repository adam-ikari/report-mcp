#!/usr/bin/env node
/**
 * report-mcp entry point.
 *
 * Runs two things in one process:
 *   1. an MCP server over stdio, exposing the report_* tools to the agent;
 *   2. a localhost HTTP panel that streams those reports to a human.
 *
 * stdout is reserved for MCP JSON-RPC — every diagnostic goes to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { Store } from "./store.js";
import { startPanel } from "./panel.js";
import { createServer } from "./server.js";
import { mirrorFromEnv } from "./remote.js";

const VERSION = "0.3.1";

async function main(): Promise<void> {
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    process.stdout.write(`report-mcp ${VERSION}\n`);
    return;
  }
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(
      [
        `report-mcp ${VERSION} — one-way agent → human reporting over MCP (stdio).`,
        "",
        "Environment:",
        "  REPORT_MCP_HOME    storage root        (default ~/.report-mcp)",
        "  REPORT_MCP_PORT    panel port          (default 7788; one shared panel,",
        "                     later agents attach to it; 0 = private ephemeral port)",
        "  REPORT_MCP_HOST    panel bind address  (default 127.0.0.1; 0.0.0.0 = also",
        "                     reachable from the LAN — the startup banner prints",
        "                     every address). No auth: set REPORT_MCP_FILE_ROOTS",
        "                     to keep /api/file inside your own directories.",
        "  REPORT_MCP_RUN_ID  share one run across several MCP servers",
        "",
        "Remote mirror (optional; both are required, never inferred):",
        "  REPORT_MCP_REMOTE        base URL of a report-mcp Worker",
        "  REPORT_MCP_REMOTE_TOKEN  bearer token for that Worker",
        "  REPORT_MCP_REMOTE_FILES  1 to also upload inline-renderable artifacts",
        "                           (off by default: it discloses file contents)",
        "",
        "Tools: report_start, report_progress, report_status, report_log,",
        "       report_result, report_end, report_panel",
        "",
      ].join("\n"),
    );
    return;
  }

  const store = new Store();
  const panel = await startPanel(store);
  const mirror = mirrorFromEnv(process.env, process.cwd());
  const server = createServer(store, panel.getUrl, mirror);
  const transport = new StdioServerTransport();

  let closing = false;
  const shutdown = async (code: number): Promise<void> => {
    if (closing) return;
    closing = true;
    // Flush the mirror before anything else: the process is about to exit, and
    // an unflushed batch is a run missing its last few records on the mirror.
    if (mirror) {
      try {
        await mirror.close();
        const { pushed, dropped, failed, lastError } = mirror.stats;
        if (pushed) console.error(`[report-mcp] mirror  pushed ${pushed} record(s) to ${process.env.REPORT_MCP_REMOTE}`);
        if (dropped) console.error(`[report-mcp] mirror  dropped ${dropped} record(s): queue overflow`);
        if (failed) console.error(`[report-mcp] mirror  ${failed} record(s) failed: ${lastError}`);
      } catch {
        /* ignore */
      }
    }
    try {
      await server.close();
    } catch {
      /* ignore */
    }
    try {
      await panel.close();
    } catch {
      /* ignore */
    }
    process.exit(code);
  };

  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
  process.on("exit", () => store.clearPanelState());
  process.on("uncaughtException", (err) => {
    console.error(`[report-mcp] uncaught: ${err?.stack ?? err}`);
  });
  process.on("unhandledRejection", (err) => {
    console.error(`[report-mcp] unhandled rejection: ${err instanceof Error ? err.stack : err}`);
  });
  transport.onclose = () => void shutdown(0);

  console.error(
    `[report-mcp] panel    ${panel.getUrl()}/#/run/${encodeURIComponent(store.runId)}  ${
      panel.isAttached() ? "(attached · shared host)" : "(host)"
    }`,
  );
  // A wildcard bind means the panel answers on more than one address; the extra
  // ones are the point of that config, so name them instead of making the human
  // go hunting for the machine's IP.
  for (const extra of panel.getUrls().slice(1)) {
    console.error(`[report-mcp] lan      ${extra}/#/run/${encodeURIComponent(store.runId)}`);
  }
  console.error(`[report-mcp] storage  ${store.runsDir}`);
  console.error(`[report-mcp] run id   ${store.runId}`);
  if (mirror) console.error(`[report-mcp] mirror   ${process.env.REPORT_MCP_REMOTE}`);

  await server.connect(transport);
}

main().catch((err) => {
  console.error(`[report-mcp] failed to start: ${err instanceof Error ? err.stack : err}`);
  process.exit(1);
});
