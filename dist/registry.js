import fs from "node:fs";
import os from "node:os";
import path from "node:path";
/** `$XDG_STATE_HOME/report-mcp/hosts`, the fallback the spec itself documents. */
export function registryDir() {
    const xdg = process.env.XDG_STATE_HOME?.trim();
    const root = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".local", "state");
    return path.join(root, "report-mcp", "hosts");
}
function fileFor(pid, port) {
    return path.join(registryDir(), `${pid}-${port}.json`);
}
export function registerHost(entry) {
    try {
        fs.mkdirSync(registryDir(), { recursive: true });
        fs.writeFileSync(fileFor(entry.pid, entry.port), JSON.stringify(entry, null, 2), "utf8");
    }
    catch {
        /* the host is serving; the announcement is optional */
    }
}
export function unregisterHost(pid, port) {
    try {
        fs.unlinkSync(fileFor(pid, port));
    }
    catch {
        /* never had one */
    }
}
/** Every entry on disk. A file that does not parse is deleted on the way past. */
export function registeredHosts() {
    let names;
    try {
        names = fs.readdirSync(registryDir());
    }
    catch {
        return [];
    }
    const out = [];
    for (const name of names) {
        if (!name.endsWith(".json"))
            continue;
        const file = path.join(registryDir(), name);
        let entry = null;
        try {
            const raw = JSON.parse(fs.readFileSync(file, "utf8"));
            if (Number.isInteger(raw?.pid) && Number.isInteger(raw?.port) && typeof raw?.url === "string" && typeof raw?.home === "string") {
                entry = raw;
            }
        }
        catch {
            /* torn write, or a hand-edited file */
        }
        if (!entry) {
            try {
                fs.unlinkSync(file);
            }
            catch {
                /* already gone */
            }
            continue;
        }
        out.push(entry);
    }
    return out;
}
export function removeHost(entry) {
    unregisterHost(entry.pid, entry.port);
}
//# sourceMappingURL=registry.js.map