import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { pageIndexUrl, pageUrl } from "./host.js";
import { amSyntax, amVersion, MAX_DRAFT_BYTES, renderDraft, slugify } from "./render.js";
const END_STATUSES = ["done", "failed", "aborted"];
function ok(payload) {
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...payload }) }] };
}
/**
 * The failure text is what the agent acts on. For a bad draft that means the
 * renderer's own report — line number, component, correct example — passed through
 * untouched, so nothing here paraphrases it.
 */
function fail(error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }) }],
        isError: true,
    };
}
const DRAFT_HELP = [
    "Draft format (the answer-me-with-html draft). The renderer does the layout, colours and SVG, so write content, not markup:",
    "  frontmatter   title, subtitle, template: sheet|doc, theme: auto|blueprint|shadcn|paper, cols, style, mode, source",
    "  every `## ` heading is one panel; panel attributes: {span=2 meta=\"small note\"} — write span only where a panel must stand out",
    "  component fences: flow, sequence, er, tree, timeline, limits, annot, kv, callout, ask; `html` / `svg` fences embed as-is",
    "  any other fence is a code block: ```ts src=path lines=18-30 hl=22 quotes real code; a ```diff fence draws a patch",
    "  tables are GFM; in a cell, ok / no / warn render as a check, a cross, a bang",
    "  images: ![caption](/absolute/path.png) — the file is embedded, so the page stays one self-contained file (<= 5 MB)",
    "  a relative src= or image path resolves against the MCP server's working directory, i.e. the project you are working in",
    "  a page keeps its own draft and has Reply/Remark buttons: the reader's comments come back as one Markdown message for them to paste to you.",
    'Full syntax for one component: report_syntax with component="flow" (or format|code|image|ask|theme); component="style" repeats the prose rules below.',
].join("\n");
/**
 * The prose standard for every page this tool publishes, in the author's own voice
 * rules. It is in the tool description rather than only the docs because the agent
 * writes the draft from the description: a rule it has to go fetch is a rule it skips.
 * `report_syntax {component:"style"}` returns this same constant — one copy, no drift.
 */
const STYLE_RULES = [
    "",
    "Prose rules (中文正文按这套写，仓库作者本人的 voice 规范):",
    "  1 首句就是事实：机制、变更、坏在哪。不做铺垫、不设问、不写「你是否还在为…发愁」。",
    "  2 用「——」追一句修正或后果：先断言，破折号后面是让它成立的那件事。",
    "  3 点名具体的东西：文件路径、命令、HTTP 状态码、字节数、commit sha。能套在任何项目上的句子等于没说。",
    "  4 错误用陈述句承认（「此前遗漏」「实测 18.2.11 是误读」）。修正是信息，不是道歉。",
    "  5 取舍写成因果，不写成口号。",
    "  6 术语留在英文（fail-closed、deny、Streamable HTTP），只翻译它周围的句子。",
    "  7 短句，一句一条因果链。",
    "  不要：凑三件套（首先/其次/最后、「三个关键价值」）、隔一条就加粗、not-X-but-Y 反差句、结尾复述段意、",
    "  每个分句一个破折号、销售词（强大、无缝、革命性、极致、彻底）、「我们」（写「仓库」「宿主」或省主语）、",
    "  感叹号（一个都不要）、diagram 节点标签以外的 emoji。",
    "  自检：跟仓库自己的 CHANGELOG 对读，比它更「精致」就是写错了。读者已知的从句全删。",
].join("\n");
export function createServer(store) {
    const server = new McpServer({ name: "report-mcp", version: "0.4.0" });
    /**
     * A page always gets written; a link only exists while a host is running. So the
     * reply never claims a URL that would 404 — it returns the path plus the reason
     * there is no link, and starting `report-mcp serve` makes every past page reachable
     * at the same URL.
     */
    function published(ref) {
        const url = pageUrl(store, ref);
        return url ? { url, indexUrl: pageIndexUrl(store) } : { url: null, indexUrl: null, hint: HOST_HINT };
    }
    /** Journal first, render second: a draft that fails to render is still on disk. */
    async function publish(title, draft, slug) {
        const w = await store.writerFor();
        const name = slug || slugify(title);
        const milestone = await w.append("milestone", { title, draft, slug: name });
        const seq = milestone.seq;
        const ref = store.pageRef(store.runId, seq, name);
        const res = await renderDraft({ draft, outPath: store.pagePath(store.runId, seq, name), home: store.home });
        if (!res.ok)
            return { ok: false, seq, failure: res.failure, error: res.message, ref };
        const pub = await w.append("published", {
            for: seq,
            title,
            slug: name,
            path: ref,
            bytes: res.bytes,
            sha256: res.sha256,
            am: amVersion(),
            render: res.report || undefined,
        });
        return { ok: true, seq, pubSeq: pub.seq, ref, slug: name, bytes: res.bytes, sha256: res.sha256, report: res.report };
    }
    server.registerTool("report_start", {
        title: "Start a report",
        description: "Open a reporting run and give it a human-readable title. Call once at the start of a task. The " +
            "title and the first tag group the run on the index page. Optional: pages can be published without " +
            "it, and the run then shows up as untitled.",
        inputSchema: {
            title: z.string().min(1).max(120).describe("Short human-facing title of this report."),
            agent: z.string().optional().describe('Name/role of the reporting agent, e.g. "research-agent".'),
            task: z.string().optional().describe("The task statement this report answers."),
            tags: z.array(z.string()).optional().describe("Labels; the first one groups the run in the index."),
            metadata: z.record(z.string(), z.any()).optional().describe("Any extra structured context."),
        },
    }, async ({ title, agent, task, tags, metadata }) => {
        try {
            const w = await store.writerFor();
            const body = { title };
            if (agent)
                body.agent = agent;
            if (task)
                body.task = task;
            if (tags)
                body.tags = tags;
            if (metadata)
                body.metadata = metadata;
            const rec = await w.append("start", body);
            const indexUrl = pageIndexUrl(store);
            return ok({
                runId: store.runId,
                seq: rec.seq,
                indexUrl,
                pagesDir: store.pagesDir,
                ...(indexUrl ? {} : { hint: HOST_HINT }),
            });
        }
        catch (err) {
            return fail(err);
        }
    });
    server.registerTool("report_page", {
        title: "Publish a report page",
        description: "Publish one milestone as a single readable HTML page. Call it when something worth reading is " +
            "finished — a conclusion, a comparison, a plan, a deliverable — not for log lines.\n\n" +
            DRAFT_HELP +
            STYLE_RULES +
            "\n\nThis call blocks on one render and can fail: a draft error comes back as the renderer's own " +
            "report with the line number, so fix the draft and call again. The draft is journalled either way.",
        inputSchema: {
            title: z.string().min(1).max(120).describe("What this page reports."),
            draft: z
                .string()
                .min(1)
                .describe(`Markdown draft with optional frontmatter and component fences (max ${MAX_DRAFT_BYTES} bytes).`),
            slug: z
                .string()
                .regex(/^[a-z0-9][a-z0-9-]{0,47}$/i)
                .optional()
                .describe("URL segment for the page. Defaults to a slug of the title; set it for non-Latin titles."),
        },
    }, async ({ title, draft, slug }) => {
        try {
            const res = await publish(title, draft, slug);
            if (!res.ok) {
                return {
                    content: [
                        {
                            type: "text",
                            text: [
                                `nothing published — the draft is journalled at seq ${res.seq} in ${store.filePath(store.runId)}`,
                                `failure: ${res.failure}`,
                                "",
                                res.error,
                            ].join("\n"),
                        },
                    ],
                    isError: true,
                };
            }
            return ok({
                runId: store.runId,
                seq: res.seq,
                title,
                page: res.ref,
                bytes: res.bytes,
                sha256: res.sha256,
                render: res.report || undefined,
                am: amVersion(),
                ...published(res.ref),
            });
        }
        catch (err) {
            return fail(err);
        }
    });
    server.registerTool("report_end", {
        title: "End the report",
        description: "Close the run; `status` is the verdict shown on the index page. Pass a draft and it is published " +
            "as the closing page — do write one, it is the page the human reads first, and without it the run " +
            "ends as a list of links with no conclusion. Same draft format and same prose rules as report_page.",
        inputSchema: {
            status: z.enum(END_STATUSES).optional().describe('Terminal status, default "done".'),
            summary: z.string().max(4000).optional().describe("One-paragraph wrap-up."),
            draft: z.string().max(MAX_DRAFT_BYTES).optional().describe("Closing page draft, rendered like report_page."),
        },
    }, async ({ status, summary, draft }) => {
        try {
            const w = await store.writerFor();
            let page = null;
            let renderError = null;
            if (draft?.trim()) {
                const run = await store.readRun(store.runId);
                // A fixed slug: the title is the run's, which is usually not ASCII, and the
                // closing page should have a URL a human can type from memory.
                const res = await publish(`${run?.summary.title ?? "汇报"} · 收尾`, draft, "close");
                if (res.ok)
                    page = res;
                else
                    renderError = `closing page failed to render (${res.failure}):\n${res.error}`;
            }
            // The run closes even when its closing page did not render: an agent that
            // cannot write a valid summary draft must still be able to end the report.
            const body = { status: status ?? "done" };
            if (summary)
                body.summary = summary;
            const elapsed = w.elapsedMs();
            if (elapsed !== undefined)
                body.durationMs = elapsed;
            const rec = await w.append("end", body);
            if (renderError)
                return fail(new Error(`the run is closed at seq ${rec.seq}, but ${renderError}`));
            return ok({
                runId: store.runId,
                seq: rec.seq,
                status: body.status,
                durationMs: body.durationMs ?? null,
                pageCount: (await store.readRun(store.runId))?.summary.pageCount ?? 0,
                page: page?.ref,
                ...(page
                    ? {
                        bytes: page.bytes,
                        sha256: page.sha256,
                        render: page.report || undefined,
                        am: amVersion(),
                        ...published(page.ref),
                    }
                    : { indexUrl: pageIndexUrl(store) }),
            });
        }
        catch (err) {
            return fail(err);
        }
    });
    server.registerTool("report_syntax", {
        title: "Look up draft syntax",
        description: "Return the renderer's own syntax reference: the component list with no argument, or full syntax " +
            "for one topic (flow, sequence, er, tree, timeline, limits, annot, kv, callout, ask, code, image, " +
            "format, theme). `style` is the one topic that is ours rather than the renderer's: the prose rules " +
            "every page is written to. Read this before inventing a fence — a wrong component costs a failed render.",
        inputSchema: {
            component: z.string().min(1).max(24).optional().describe("One syntax topic. Omit for the component list."),
        },
    }, async ({ component }) => {
        if (component?.toLowerCase() === "style") {
            return { content: [{ type: "text", text: STYLE_RULES.trim() + "\n" }] };
        }
        const res = await amSyntax(component);
        return {
            content: [{ type: "text", text: res.text || "(no output)" }],
            ...(res.ok ? {} : { isError: true }),
        };
    });
    return server;
}
const HOST_HINT = "no report-mcp host is running — the page is on disk; run `report-mcp start` (it returns; `serve` would hold the terminal) and every page in this journal becomes reachable at a stable URL";
//# sourceMappingURL=server.js.map