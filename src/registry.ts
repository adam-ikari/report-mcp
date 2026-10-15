import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The machine-level host registry: one small file per running host, kept outside the
 * report home on purpose. `host.json` answers "who serves *this* home"; this answers
 * "is any host running on this box at all", which is the question `start` has to ask
 * before it makes a second one.
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
  } catch {
    /* the host is serving; the announcement is optional */
  }
}

export function unregisterHost(pid: number, port: number): void {
  try {
    fs.unlinkSync(fileFor(pid, port));
  } catch {
    /* never had one */
  }
}

/** Every entry on disk. A file that does not parse is deleted on the way past. */
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
      if (Number.isInteger(raw?.pid) && Number.isInteger(raw?.port) && typeof raw?.url === "string" && typeof raw?.home === "string") {
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
