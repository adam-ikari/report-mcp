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
 *
 * stdout is reserved for MCP JSON-RPC in the first mode — every diagnostic goes to
 * stderr, in both.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { Store } from "./store.js";
import { startHost } from "./host.js";
import { createServer } from "./server.js";
import { nodeSupportsAm } from "./render.js";

const VERSION = "0.4.0";
const DEFAULT_PORT = 7788;

const USAGE = [
  `report-mcp ${VERSION} — 里程碑汇报：agent 交草稿，页面落盘，宿主给链接。`,
  "",
  "用法：",
  "  report-mcp                MCP server（stdio）。不监听端口，随会话生灭。",
  "  report-mcp serve          常驻只读宿主，索引页 + /r/ 页面。人手动起、或者 Docker 起。",
  "  report-mcp --version      打印版本后退出。",
  "",
  "环境变量：",
  "  REPORT_MCP_HOME            存储根目录（默认 ~/.report-mcp）",
  "  REPORT_MCP_PORT            serve 监听端口（默认 7788）",
  "  REPORT_MCP_HOST            serve 绑定地址（默认 127.0.0.1；0.0.0.0 = 同网段都能读，",
  "                             无鉴权无 TLS —— 那些页面是完整的汇报文档）",
  "  REPORT_MCP_PUBLIC_URL      对外宣传的地址（容器内端口映射时地址自动发现不可用，用这个）",
  "  REPORT_MCP_RUN_ID          多个 MCP 进程共用一个 run",
  "",
  "工具：report_start, report_page, report_end, report_syntax",
  "",
].join("\n");

function flag(args: string[], name: string): string | undefined {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  const arg = args[i];
  return arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[i + 1];
}

async function serve(args: string[]): Promise<void> {
  const store = new Store();
  const host = flag(args, "host") ?? process.env.REPORT_MCP_HOST?.trim() ?? "127.0.0.1";
  const port = Number(flag(args, "port") ?? process.env.REPORT_MCP_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`[report-mcp] serve  invalid port: ${String(port)}`);
    process.exit(2);
  }

  let server;
  try {
    server = await startHost(store, { host, port, version: VERSION });
  } catch (err) {
    // One HTTP host per home: nothing here takes over, queues, or picks a random port.
    // A second `serve` is a mistake, so say which host is already there and stop.
    const e = err as NodeJS.ErrnoException;
    if (e?.code === "EADDRINUSE") {
      const other = store.readHostState();
      console.error(`[report-mcp] serve   端口 ${port} 已被占用，本进程退出。`);
      if (other) {
        console.error(
          `[report-mcp]           这个 home 已经有宿主在跑：${other.url}（pid ${other.pid}，版本 ${other.version}）`,
        );
        console.error("[report-mcp]           不需要第二个。要看内容直接开那个地址。");
      } else {
        console.error(`[report-mcp]           ${store.hostPath} 里没有活的宿主记录 —— 占用端口的不是本 home 的 report-mcp。`);
        console.error(`[report-mcp]           换端口：report-mcp serve --port <n>，或把对方的 URL 写进 REPORT_MCP_PUBLIC_URL。`);
      }
      console.error(`[report-mcp]           home ${store.home}`);
      process.exit(3);
    }
    throw err;
  }

  const index = server.url;
  console.error(`[report-mcp] serve    ${index}/`);
  for (const extra of server.urls.slice(1)) console.error(`[report-mcp]          ${extra}/`);
  console.error(`[report-mcp] home     ${store.home}`);
  if (host === "0.0.0.0" || host === "::") {
    console.error("[report-mcp] 注意      绑的是 0.0.0.0：同网段任何设备都能读这些汇报，没有鉴权也没有 TLS。");
  }

  let closing = false;
  const shutdown = async (code: number): Promise<void> => {
    if (closing) return;
    closing = true;
    try {
      await server.close();
    } catch {
      /* ignore */
    }
    process.exit(code);
  };
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
}

async function mcp(): Promise<void> {
  if (!nodeSupportsAm()) {
    // The renderer is one file that needs Node 20+; without it every report_page
    // call fails, so say so once at startup instead of on every tool reply.
    console.error(
      `[report-mcp] 需要 Node >= 20 才能渲染页面（当前 ${process.version}）。工具可用，report_page 会失败。`,
    );
  }

  const store = new Store();
  const server = createServer(store);
  const transport = new StdioServerTransport();

  let closing = false;
  const shutdown = async (code: number): Promise<void> => {
    if (closing) return;
    closing = true;
    try {
      await server.close();
    } catch {
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
  } else {
    console.error("[report-mcp] host     未运行 —— 页面照写，链接要等 `report-mcp serve` 起来才有");
  }

  await server.connect(transport);
}

async function main(): Promise<void> {
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
  await mcp();
}

main().catch((err) => {
  console.error(`[report-mcp] failed to start: ${err instanceof Error ? err.stack : err}`);
  process.exit(1);
});
