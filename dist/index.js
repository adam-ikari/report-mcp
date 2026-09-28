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
const VERSION = "0.1.1";
async function main() {
    if (process.argv.includes("--version") || process.argv.includes("-v")) {
        process.stdout.write(`report-mcp ${VERSION}\n`);
        return;
    }
    if (process.argv.includes("--help") || process.argv.includes("-h")) {
        process.stdout.write([
            `report-mcp ${VERSION} — one-way agent → human reporting over MCP (stdio).`,
            "",
            "Environment:",
            "  REPORT_MCP_HOME    storage root        (default ~/.report-mcp)",
            "  REPORT_MCP_PORT    panel port          (default 0 = ephemeral)",
            "  REPORT_MCP_HOST    panel bind address  (default 127.0.0.1)",
            "  REPORT_MCP_RUN_ID  share one run across several MCP servers",
            "",
            "Tools: report_start, report_progress, report_status, report_log,",
            "       report_result, report_end, report_panel",
            "",
        ].join("\n"));
        return;
    }
    const store = new Store();
    const panel = await startPanel(store);
    const server = createServer(store, panel.url);
    const transport = new StdioServerTransport();
    let closing = false;
    const shutdown = async (code) => {
        if (closing)
            return;
        closing = true;
        try {
            await server.close();
        }
        catch {
            /* ignore */
        }
        try {
            await panel.close();
        }
        catch {
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
    console.error(`[report-mcp] panel    ${panel.url}/#/run/${encodeURIComponent(store.runId)}`);
    console.error(`[report-mcp] storage  ${store.runsDir}`);
    console.error(`[report-mcp] run id   ${store.runId}`);
    await server.connect(transport);
}
main().catch((err) => {
    console.error(`[report-mcp] failed to start: ${err instanceof Error ? err.stack : err}`);
    process.exit(1);
});
//# sourceMappingURL=index.js.map