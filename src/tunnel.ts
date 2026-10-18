import { spawn, type ChildProcess } from "node:child_process";

/**
 * A Cloudflare Quick Tunnel, on demand.
 *
 * `cloudflared tunnel --url <target>` prints a random
 * `https://<words>.trycloudflare.com` and proxies it to the local host: no account,
 * no DNS record, no certificate to install. That is the right shape for "this report
 * has to be reachable from a phone that is not on this Wi-Fi".
 *
 * The address is unguessable, not private. Anyone the URL reaches can read the pages,
 * and cloudflared connects to the origin from 127.0.0.1 — so every tunneled request
 * *looks* local to the host. `host.ts` treats forwarding headers as the tell, which is
 * why `/api/*` does not follow a tunnel out. `serve` warns on the terminal; this module
 * only owns the process.
 */

/** The one line cloudflared prints for a quick tunnel; nothing else in its log matches. */
const QUICK_TUNNEL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;

/** How long to wait for the address. `start`'s readiness budget outlasts this. */
export const TUNNEL_TIMEOUT_MS = 30_000;

export interface Tunnel {
  url: string;
  close(): void;
}

/** True for a quick-tunnel address, so `status` can label it and warn about exposure. */
export function isTunnelUrl(url: string): boolean {
  return QUICK_TUNNEL_RE.test(url);
}

/** Overridable so a test (or a non-PATH install) can name the binary without a shim. */
function binary(): string {
  return process.env.REPORT_MCP_CLOUDFLARED?.trim() || "cloudflared";
}

function kill(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
}

export async function startQuickTunnel(target: string, timeoutMs = TUNNEL_TIMEOUT_MS): Promise<Tunnel> {
  const bin = binary();
  const child = spawn(bin, ["tunnel", "--url", target, "--no-autoupdate"], {
    // stdin ignored: cloudflared reads nothing, and a shared terminal would fight it.
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  let url: string | null = null;
  let failure: Error | null = null;

  const scan = (chunk: Buffer): void => {
    output += chunk.toString("utf8");
    if (!url) url = QUICK_TUNNEL_RE.exec(output)?.[0] ?? null;
  };
  child.stdout?.on("data", scan);
  child.stderr?.on("data", scan);

  // A failure before the address arrives is as good as no address: record it and let
  // the same poll below fall through to the error paths.
  child.once("error", (err) => {
    failure = err;
  });
  child.once("exit", (code, signal) => {
    failure = new Error(`cloudflared 退出（code ${String(code)}${signal ? ` / ${signal}` : ""}）`);
  });

  const deadline = Date.now() + timeoutMs;
  while (!url && !failure && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }

  if (!url) {
    kill(child);
    const tail = output.trim().split("\n").filter(Boolean).slice(-6).join("\n");
    const e = failure as NodeJS.ErrnoException | null;
    if (e?.code === "ENOENT") {
      throw withTail(new Error(`找不到 ${bin} —— 装好 cloudflared，或用 REPORT_MCP_CLOUDFLARED 指向它`), tail);
    }
    throw withTail(e ?? new Error(`cloudflared ${Math.round(timeoutMs / 1000)}s 内没给出隧道地址`), tail);
  }

  // The address is in hand. Keep cloudflared's log flowing into ours so a later
  // disconnect lands in serve.log instead of failing silently.
  child.stdout?.off("data", scan);
  child.stderr?.off("data", scan);
  forward(child.stdout, "[report-mcp] tunnel  ");
  forward(child.stderr, "[report-mcp] tunnel  ");

  return { url, close: () => kill(child) };
}

/** A failure with the last lines cloudflared managed to print, for `serve` to relay. */
function withTail(err: Error, tail: string): Error & { tunnelTail?: string } {
  return Object.assign(err, { tunnelTail: tail });
}

/** Relay a child stream to our stderr, one prefixed line at a time. */
function forward(stream: NodeJS.ReadableStream | null, prefix: string): void {
  if (!stream) return;
  let buf = "";
  stream.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) process.stderr.write(`${prefix}${line}\n`);
    }
  });
}
