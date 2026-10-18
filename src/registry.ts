import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The host registry for this user account: one small file per running host, kept
 * outside the report home on purpose. `host.json` answers "who serves *this* home";
 * this answers "do I already have a host running", which is the question `start` has
 * to ask before it makes a second one.
 *
 * Scope is the account, not the kernel: the state directory lives under `$HOME`, and
 * a host owned by another user is neither visible here nor stoppable from here.
 *
 * Entries are best effort, like every other announcement here: a read-only state
 * directory costs at worst a duplicate host, never a crash in the serving path.
 */

export interface HostRegistration {
  pid: number;
  port: number;
  host: string;
  url: string;
  home: string;
  startedAt: string;
  version: string;
}

/** `$XDG_STATE_HOME/report-mcp/hosts`, the fallback the spec itself documents. */
export function registryDir(): string {
  const xdg = process.env.XDG_STATE_HOME?.trim();
  const root = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".local", "state");
  return path.join(root, "report-mcp", "hosts");
}

function fileFor(pid: number, port: number): string {
  return path.join(registryDir(), `${pid}-${port}.json`);
}

export function registerHost(entry: HostRegistration): void {
  try {
    fs.mkdirSync(registryDir(), { recursive: true });
    fs.writeFileSync(fileFor(entry.pid, entry.port), JSON.stringify(entry, null, 2), "utf8");
  } catch (err) {
    // Serving is not the problem here; `start`'s single-instance gate is. Say so on
    // stderr instead of dropping it — otherwise the gate silently stops existing.
    console.error(`[report-mcp] registry 写入失败（${String(err)}）：start 看不见这个宿主，可能再起一个`);
  }
}

export function unregisterHost(pid: number, port: number): void {
  try {
    fs.unlinkSync(fileFor(pid, port));
  } catch {
    /* never had one */
  }
}

/** Every entry on disk. A file that does not parse, or lies about its shape, is deleted on the way past. */
export function registeredHosts(): HostRegistration[] {
  let names: string[];
  try {
    names = fs.readdirSync(registryDir());
  } catch {
    return [];
  }
  const out: HostRegistration[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(registryDir(), name);
    let entry: HostRegistration | null = null;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as HostRegistration;
      // Check every field callers dereference, `startedAt` included: the sort in
      // manage.ts would throw on a half-written entry otherwise.
      if (
        Number.isInteger(raw?.pid) &&
        Number.isInteger(raw?.port) &&
        typeof raw?.host === "string" &&
        typeof raw?.url === "string" &&
        typeof raw?.home === "string" &&
        typeof raw?.startedAt === "string" &&
        typeof raw?.version === "string"
      ) {
        entry = raw;
      }
    } catch {
      /* torn write, or a hand-edited file */
    }
    if (!entry) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* already gone */
      }
      continue;
    }
    out.push(entry);
  }
  return out;
}

export function removeHost(entry: HostRegistration): void {
  unregisterHost(entry.pid, entry.port);
}
