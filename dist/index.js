#!/usr/bin/env node
/**
 * report-mcp entry point. Two modes, one binary.
 *
 *   report-mcp          an MCP server over stdio. Writes drafts and rendered pages to
 *                       disk and returns links; it binds no port and spawns no daemon,
 *                       so it can die with the agent's session without taking the
 *                       reports down with it.
 *   report-mcp serve    the hosting side: a read-only HTTP server over that same
 *                       directory, run by a human (or by Docker) and left running.
 *   report-mcp start    same thing, in the background: spawn `serve` detached, its
 *                       diagnostics to $HOME/serve.log. `stop` and `status` finish
 *                       the pair, so nobody has to own a terminal to read reports.
 *                       One instance per account: a live host registered by another
 *                       home makes this refuse, unless a port was named.
 *
 * stdout is reserved for MCP JSON-RPC in the first mode — every diagnostic goes to
 * stderr, in both.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Store } from "./store.js";
import { startHost } from "./host.js";
import { createServer } from "./server.js";
import { nodeSupportsAm } from "./render.js";
import { ANSI, NO_COLOR, describe, startHostProcess, status, stopHostProcess } from "./manage.js";
const VERSION = "0.4.0";
const DEFAULT_PORT = 7788;
const USAGE = [
    `report-mcp ${VERSION} — 里程碑汇报：agent 交草稿，页面落盘，宿主给链接。`,
    "",
    "用法：",
    "  report-mcp                MCP server（stdio）。不监听端口，随会话生灭。",
    "  report-mcp serve          常驻只读宿主，索引页 + /r/ 页面。前台跑，Ctrl-C 停。",
    "  report-mcp start          把同一个宿主放到后台（日志写 $HOME/serve.log）。一个账户只一个",
    "                            实例：别的 home 已有活宿主就拒绝（退出码 4），除非显式 --port。",
    "                            加 --tunnel 同时开一条 Cloudflare Quick Tunnel（需 cloudflared），",
    "                            隧道地址写进 host.json；serve 同样认，已在跑且无隧道时会先重启。",
    "  report-mcp stop           停掉后台宿主。没在跑也算成功（幂等，agent 可以放心调）。",
    "                            --all 连别的 home 的宿主一起停。",
    "  report-mcp status         宿主在不在跑、地址、home、页数。--json 给 agent 读。",
    "  report-mcp --version      打印版本后退出。",
    "",
    "环境变量：",
    "  REPORT_MCP_HOME            存储根目录（默认 ~/.report-mcp）",
    "  REPORT_MCP_PORT            serve/start 监听端口（默认 7788）",
    "  REPORT_MCP_HOST            serve/start 绑定地址（默认 127.0.0.1；0.0.0.0 = 同网段都能读，",
    "                             无鉴权无 TLS —— 那些页面是完整的汇报文档）",
    "  REPORT_MCP_PUBLIC_URL      对外宣传的地址（容器内端口映射时地址自动发现不可用，用这个）",
    "  REPORT_MCP_TUNNEL          非空即等于 --tunnel（1 / true / yes）",
    "  REPORT_MCP_CLOUDFLARED     cloudflared 可执行文件路径（默认从 PATH 找）",
    "  REPORT_MCP_RUN_ID          多个 MCP 进程共用一个 run",
    "  XDG_STATE_HOME             宿主登记表目录（默认 ~/.local/state）；容器里每个 home 各起一个",
    "                             宿主时指到各自的可写目录，否则 start 会看见别人的实例",
    "",
    "工具：report_start, report_page, report_end, report_syntax",
    "",
].join("\n");
function flag(args, name) {
    const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (i < 0)
        return undefined;
    const arg = args[i];
    return arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[i + 1];
}
/** `--tunnel` on the command line, or REPORT_MCP_TUNNEL in the environment. */
function tunnelRequested(args) {
    if (args.includes("--tunnel"))
        return true;
    const v = process.env.REPORT_MCP_TUNNEL?.trim().toLowerCase();
    return v === "1" || v === "true" || v === "yes";
}
/** Where to bind and which home, resolved the same way for `serve` and `start`. */
function bind(args) {
    const store = new Store();
    const host = flag(args, "host") ?? process.env.REPORT_MCP_HOST?.trim() ?? "127.0.0.1";
    const portFlag = flag(args, "port");
    const envPort = process.env.REPORT_MCP_PORT?.trim();
    const port = Number(portFlag ?? envPort ?? DEFAULT_PORT);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        console.error(`[report-mcp] invalid port: ${String(port)}`);
        process.exit(2);
    }
    // A named port is a request for *this* port, so a host already sitting on another
    // one is not the caller's problem — `start` only refuses when nobody said.
    const explicitPort = portFlag !== undefined || Boolean(envPort);
    return { store, host, port, explicitPort };
}
async function serve(args) {
    const { store, host, port } = bind(args);
    const tunnel = tunnelRequested(args);
    let server;
    try {
        server = await startHost(store, { host, port, version: VERSION, tunnel });
    }
    catch (err) {
        // One HTTP host per home: nothing here takes over, queues, or picks a random port.
        // A second `serve` is a mistake, so say which host is already there and stop.
        const e = err;
        if (e?.code === "EADDRINUSE") {
            const other = store.readHostState();
            console.error(`[report-mcp] serve   端口 ${port} 已被占用，本进程退出。`);
            if (other) {
                console.error(`[report-mcp]           这个 home 已经有宿主在跑：${other.url}（pid ${other.pid}，版本 ${other.version}）`);
                console.error("[report-mcp]           不需要第二个。要看内容直接开那个地址。");
            }
            else {
                console.error(`[report-mcp]           ${store.hostPath} 里没有活的宿主记录 —— 占用端口的不是本 home 的 report-mcp。`);
                console.error(`[report-mcp]           换端口：report-mcp serve --port <n>，或把对方的 URL 写进 REPORT_MCP_PUBLIC_URL。`);
            }
            console.error(`[report-mcp]           home ${store.home}`);
            process.exit(3);
        }
        if (e?.tunnelTail !== undefined) {
            // They asked for a public URL and there is none; a local-only host would be a
            // quiet bait-and-switch, so say why and leave the pages on disk.
            console.error(`[report-mcp] 起隧道失败：${e.message}`);
            if (e.tunnelTail)
                for (const line of e.tunnelTail.split("\n"))
                    console.error(`[report-mcp]          ${line}`);
            console.error("[report-mcp]          去掉 --tunnel 可以只跑本地宿主；页面照常在磁盘上。");
            process.exit(3);
        }
        throw err;
    }
    const index = server.url;
    console.error(`[report-mcp] serve    ${index}/`);
    for (const extra of server.urls.slice(1))
        console.error(`[report-mcp]          ${extra}/`);
    console.error(`[report-mcp] home     ${store.home}`);
    if (host === "0.0.0.0" || host === "::") {
        console.error("[report-mcp] 注意      绑的是 0.0.0.0：同网段任何设备都能读这些汇报，没有鉴权也没有 TLS。");
    }
    if (server.tunnel) {
        console.error("[report-mcp] 注意      隧道地址公网可达：拿到链接的人都能读，无鉴权。");
    }
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
        process.exit(code);
    };
    process.on("SIGINT", () => void shutdown(0));
    process.on("SIGTERM", () => void shutdown(0));
}
/**
 * `start` / `stop` / `status`. These talk to the same `host.json` the MCP side
 * reads, so there is exactly one notion of "is a host serving this home" — and
 * the LAN warning cannot hide in a log file: whoever asked for 0.0.0.0 sees it.
 */
async function manage(cmd, args) {
    const { store, host, port, explicitPort } = bind(args);
    const opts = { host, port, version: VERSION, explicitPort, tunnel: tunnelRequested(args) };
    const palette = process.stdout.isTTY && !args.includes("--json") ? ANSI : NO_COLOR;
    if (cmd === "start") {
        let s;
        try {
            s = await startHostProcess(store, opts);
        }
        catch (err) {
            // A host that died on the way up left its reason in serve.log, not on this
            // terminal; without the tail, "起不来" is the only thing a human has to go on.
            const e = err;
            if (e.conflict) {
                // Exit 4, not 3: nothing failed to start — the machine already has the one
                // instance this command promises.
                console.error(`${palette.yellow}·${palette.off} 没有起新的宿主：${e.message}`);
                console.error(`${palette.dim}home${palette.off}    ${store.home}`);
                process.exit(4);
            }
            console.error(`${palette.red}✗ 起不来${palette.off}：${e.message}`);
            if (e.logTail)
                console.error(`${palette.dim}serve.log${palette.off}  ${e.logTail.split("\n").slice(-4).join("\n")}`);
            console.error(`${palette.dim}home${palette.off}    ${store.home}`);
            process.exit(3);
        }
        process.stdout.write(`${describe(s, opts, palette)}\n`);
        if (s.restarted) {
            process.stdout.write(`${palette.dim}·${palette.off} 已在跑的宿主没有隧道，已重启并加上\n`);
        }
        return;
    }
    if (cmd === "stop") {
        let r;
        try {
            r = await stopHostProcess(store, args.includes("--all"));
        }
        catch (err) {
            // Including "this pid is not mine". Killing a recycled pid would be the one
            // way this tool damages something it has no claim on, so it refuses out loud.
            console.error(`${palette.red}✗ 没停${palette.off}：${err.message}`);
            console.error(`${palette.dim}记录${palette.off}    ${store.hostPath}`);
            process.exit(3);
        }
        if (args.includes("--json"))
            process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
        else if (r.stopped) {
            const mine = r.pid ? `pid ${r.pid}` : "本 home 没有宿主";
            const also = r.also?.length ? `，另有 ${r.also.length} 个别的 home 的宿主（pid ${r.also.join(", ")}）` : "";
            process.stdout.write(`${palette.green}✓${palette.off} 已停止（${mine}）${also}，页面还在磁盘上\n`);
        }
        else
            process.stdout.write(`${palette.dim}·${palette.off} 本来就没在跑\n`);
        return;
    }
    const s = await status(store);
    if (args.includes("--json"))
        process.stdout.write(`${JSON.stringify(s, null, 2)}\n`);
    else
        process.stdout.write(`${describe(s, opts, palette)}\n`);
    // status is a question: exit 0 running, 1 not. Same shape as `systemctl is-active`.
    process.exit(s.running ? 0 : 1);
}
async function mcp() {
    if (!nodeSupportsAm()) {
        // The renderer is one file that needs Node 20+; without it every report_page
        // call fails, so say so once at startup instead of on every tool reply.
        console.error(`[report-mcp] 需要 Node >= 20 才能渲染页面（当前 ${process.version}）。工具可用，report_page 会失败。`);
    }
    const store = new Store();
    const server = createServer(store);
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
        process.exit(code);
    };
    process.on("SIGINT", () => void shutdown(0));
    process.on("SIGTERM", () => void shutdown(0));
    process.on("uncaughtException", (err) => {
        // Log and leave. An uncaught exception means the process state is unknown;
        // continuing to serve MCP over stdio from it would report plausible-looking
        // results off a broken foundation, which is worse than a visible failure.
        console.error(`[report-mcp] uncaught: ${err?.stack ?? err}`);
        void shutdown(1);
    });
    transport.onclose = () => void shutdown(0);
    const host = store.readHostState();
    console.error(`[report-mcp] storage  ${store.home}`);
    console.error(`[report-mcp] run id   ${store.runId}`);
    if (host) {
        console.error(`[report-mcp] host     ${host.url}  (pid ${host.pid} · ${host.urls.length} address(es))`);
    }
    else {
        console.error("[report-mcp] host     未运行 —— 页面照写，链接要等 `report-mcp start`（或 serve）起来才有");
    }
    await server.connect(transport);
}
async function main() {
    const args = process.argv.slice(2);
    if (args.includes("--version") || args.includes("-v")) {
        process.stdout.write(`report-mcp ${VERSION}\n`);
        return;
    }
    if (args.includes("--help") || args.includes("-h")) {
        process.stdout.write(`${USAGE}\n`);
        return;
    }
    if (args[0] === "serve") {
        await serve(args);
        return;
    }
    if (args[0] === "start" || args[0] === "stop" || args[0] === "status") {
        await manage(args[0], args.slice(1));
        return;
    }
    await mcp();
}
main().catch((err) => {
    console.error(`[report-mcp] failed to start: ${err instanceof Error ? err.stack : err}`);
    process.exit(1);
});
//# sourceMappingURL=index.js.map