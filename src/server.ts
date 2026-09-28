import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Store } from "./store.js";
import type { Panel } from "./panel.js";

const RUN_STATUSES = ["running", "waiting", "blocked", "error", "done", "failed", "aborted"] as const;
const END_STATUSES = ["done", "failed", "aborted"] as const;
const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

const artifactSchema = z.object({
  name: z.string().min(1).describe("Human-readable name of the artifact."),
  path: z.string().optional().describe("Filesystem path (absolute or relative to the agent's cwd)."),
  url: z.string().optional().describe("Remote or local URL."),
  type: z.string().optional().describe('Free-form type, e.g. "markdown", "csv", "image".'),
  description: z.string().optional(),
  size: z.number().optional().describe("Size in bytes."),
});

const metricSchema = z.object({
  name: z.string().min(1),
  value: z.union([z.number(), z.string()]),
  unit: z.string().optional(),
  hint: z.string().optional().describe('Qualifier, e.g. "p95" or "target > 200".'),
});

const linkSchema = z.object({
  label: z.string().min(1),
  url: z.string().min(1),
});

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(payload: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...payload }) }] };
}

function fail(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }) }],
    isError: true,
  };
}

export function createServer(store: Store, panelUrl: string): McpServer {
  const server = new McpServer({ name: "report-mcp", version: "0.1.1" });

  const viewUrl = (runId: string) => `${panelUrl}/#/run/${encodeURIComponent(runId)}`;

  /** Every tool is fire-and-forget: it returns as soon as the record is on disk. */
  async function record(
    kind: "start" | "progress" | "status" | "log" | "result" | "end",
    body: Record<string, unknown>,
  ): Promise<ToolResult> {
    try {
      const w = await store.writerFor();
      const rec = await w.append(kind, body);
      return ok({
        runId: store.runId,
        seq: rec.seq,
        kind: rec.kind,
        panelUrl,
        viewUrl: viewUrl(store.runId),
      });
    } catch (err) {
      return fail(err);
    }
  }

  server.registerTool(
    "report_start",
    {
      title: "Start a report",
      description:
        "Announce the beginning of a task and set the run's title. Optional: call once at the start; " +
        "calling again overwrites the displayed title. All other report_* tools work without it " +
        "(a default title is used).",
      inputSchema: {
        title: z.string().min(1).describe("Short human-facing title for this run."),
        agent: z.string().optional().describe('Name/role of the reporting agent, e.g. "research-agent".'),
        task: z.string().optional().describe("The full task statement or goal."),
        tags: z.array(z.string()).optional().describe("Labels for grouping runs in the panel."),
        metadata: z.record(z.string(), z.any()).optional().describe("Any extra structured context."),
      },
    },
    async ({ title, agent, task, tags, metadata }) => {
      const body: Record<string, unknown> = { title };
      if (agent) body.agent = agent;
      if (task) body.task = task;
      if (tags) body.tags = tags;
      if (metadata) body.metadata = metadata;
      return record("start", body);
    },
  );

  server.registerTool(
    "report_progress",
    {
      title: "Report progress",
      description:
        "Push a progress update (one-way, non-blocking). Use it at each phase boundary or when the " +
        "percentage moves materially. `percent` is 0-100; omit it for an indeterminate phase. " +
        "The latest progress record drives the panel's progress bar and run list.",
      inputSchema: {
        phase: z.string().min(1).describe('Current phase, e.g. "searching literature".'),
        percent: z.number().min(0).max(100).optional().describe("Completion 0-100. Omit if unknown."),
        step: z.number().int().min(0).optional().describe("Current step index (1-based when totalSteps is set)."),
        totalSteps: z.number().int().min(1).optional(),
        message: z.string().optional().describe("One-line human-facing status."),
        detail: z.any().optional().describe("Extra structured context (string or JSON)."),
      },
    },
    async ({ phase, percent, step, totalSteps, message, detail }) => {
      const body: Record<string, unknown> = { phase };
      if (percent !== undefined) body.percent = percent;
      if (step !== undefined) body.step = step;
      if (totalSteps !== undefined) body.totalSteps = totalSteps;
      if (message) body.message = message;
      if (detail !== undefined) body.detail = detail;
      return record("progress", body);
    },
  );

  server.registerTool(
    "report_status",
    {
      title: "Report status",
      description:
        "Push a run-level status change (one-way, non-blocking). Use `waiting`/`blocked` to signal that " +
        "the agent needs a human, `error` when something went wrong but the run continues, and " +
        "`done`/`failed`/`aborted` only together with report_end.",
      inputSchema: {
        status: z.enum(RUN_STATUSES).describe("New run status."),
        message: z.string().optional().describe("Why, in one line."),
        detail: z.any().optional().describe("Extra structured context."),
      },
    },
    async ({ status, message, detail }) => {
      const body: Record<string, unknown> = { status };
      if (message) body.message = message;
      if (detail !== undefined) body.detail = detail;
      return record("status", body);
    },
  );

  server.registerTool(
    "report_log",
    {
      title: "Report a log line",
      description:
        "Append a log line to the run timeline (one-way, non-blocking). Use for intermediate events that " +
        "are not progress updates. Errors logged here surface in the run list as `lastError`.",
      inputSchema: {
        level: z.enum(LOG_LEVELS).optional().describe('Severity, default "info".'),
        message: z.string().min(1).describe("Log line."),
        detail: z.any().optional().describe("Stack trace, payload, or other structured context."),
      },
    },
    async ({ level, message, detail }) => {
      const body: Record<string, unknown> = { level: level ?? "info", message };
      if (detail !== undefined) body.detail = detail;
      return record("log", body);
    },
  );

  server.registerTool(
    "report_result",
    {
      title: "Report a result",
      description:
        "Deliver a structured result to the human (one-way, non-blocking). Call once per meaningful " +
        "deliverable: a finished analysis, a generated file, a decision. Results render as highlighted " +
        "cards in the panel. This does not end the run — call report_end afterwards.",
      inputSchema: {
        title: z.string().min(1).describe("What was delivered."),
        summary: z.string().optional().describe("2-5 sentence human-facing summary of the outcome."),
        status: z.enum(RUN_STATUSES).optional().describe('Status implied by this result, default "done".'),
        artifacts: z.array(artifactSchema).optional().describe("Files or resources produced."),
        metrics: z.array(metricSchema).optional().describe("Key numbers worth surfacing."),
        links: z.array(linkSchema).optional().describe("Related URLs."),
        data: z.any().optional().describe("Arbitrary structured payload for machine consumption."),
      },
    },
    async ({ title, summary, status, artifacts, metrics, links, data }) => {
      const body: Record<string, unknown> = { title };
      if (summary) body.summary = summary;
      if (status) body.status = status;
      if (artifacts) body.artifacts = artifacts;
      if (metrics) body.metrics = metrics;
      if (links) body.links = links;
      if (data !== undefined) body.data = data;
      return record("result", body);
    },
  );

  server.registerTool(
    "report_end",
    {
      title: "End the report",
      description:
        "Declare the run finished. Sets the terminal status shown everywhere in the panel and computes " +
        "the run duration. Call exactly once, after the final report_result (if any).",
      inputSchema: {
        status: z.enum(END_STATUSES).optional().describe('Terminal status, default "done".'),
        summary: z.string().optional().describe("Final one-paragraph wrap-up for the human."),
      },
    },
    async ({ status, summary }) => {
      try {
        const w = await store.writerFor();
        const body: Record<string, unknown> = { status: status ?? "done" };
        if (summary) body.summary = summary;
        const elapsed = w.elapsedMs();
        if (elapsed !== undefined) body.durationMs = elapsed;
        const rec = await w.append("end", body);
        return ok({
          runId: store.runId,
          seq: rec.seq,
          kind: rec.kind,
          durationMs: body.durationMs ?? null,
          panelUrl,
          viewUrl: viewUrl(store.runId),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "report_panel",
    {
      title: "Get the panel URL",
      description:
        "Return the local web panel URL and current run id. Use this when the human asks where to look, " +
        "or to re-emit the link after it slipped out of context.",
      inputSchema: {},
    },
    async () => {
      try {
        const data = await store.readRun(store.runId);
        return ok({
          runId: store.runId,
          panelUrl,
          viewUrl: viewUrl(store.runId),
          status: data?.summary.status ?? "running",
          recordCount: data?.records.length ?? 0,
          storage: store.runsDir,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}
