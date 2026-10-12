import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The renderer.
 *
 * We do not draw anything. A draft goes in, one self-contained HTML page comes out,
 * and every layout decision belongs to the draft's frontmatter — the same contract
 * the `answer-me-with-html` CLI offers an agent directly. All this module adds is
 * the parts a server needs: an isolated AM_HOME, a timeout, bounded output capture,
 * and a failure message the agent can act on.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

/** `dist/render.js` and the vendor dir are siblings in the installed package. */
export const AM_BUNDLE = path.join(here, "..", "vendor", "am", "am.mjs");

/** Drafts bigger than this are refused before spawning: am's own limits are much tighter. */
export const MAX_DRAFT_BYTES = 64 * 1024;

const OUTPUT_CAP = 64 * 1024;
const RENDER_TIMEOUT_MS = 10_000;
const SYNTAX_TIMEOUT_MS = 5_000;

let manifestCache: { version: string } | null | undefined;

export function amVersion(): string {
  if (manifestCache === undefined) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(here, "..", "vendor", "am", "manifest.json"), "utf8"));
      manifestCache = { version: String(raw.version ?? "unknown") };
    } catch {
      manifestCache = null;
    }
  }
  return manifestCache?.version ?? "unknown";
}

/** am.mjs calls `Array.prototype.toSorted`, which needs V8 11 / Node 20. */
export function nodeSupportsAm(): boolean {
  return Number(process.versions.node.split(".")[0]) >= 20;
}

export function amInstalled(): boolean {
  return fs.existsSync(AM_BUNDLE);
}

/**
 * A page's URL segment from its title.
 *
 * Non-ASCII titles slugify to nothing useful (and the report language is usually
 * Chinese), so an agent-supplied `slug` always wins and the fallback is plain
 * `page`: the seq is part of the filename anyway, so uniqueness never depends on
 * the title surviving transliteration.
 */
export function slugify(title: string): string {
  const ascii = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return ascii || "page";
}

export interface RenderRequest {
  draft: string;
  /** Absolute path to write. Its parent is created. */
  outPath: string;
  /** REPORT_MCP_HOME: holds the isolated AM_HOME. */
  home: string;
  /**
   * Where relative paths in the draft resolve. Defaults to this process's cwd — the
   * agent's project — because `src=path` and relative image paths name *its* files.
   */
  cwd?: string;
}

export type RenderFailure = "no-node" | "no-bundle" | "draft-too-large" | "draft" | "timeout" | "spawn" | "no-output";

export type RenderOutcome =
  | { ok: true; bytes: number; sha256: string; report: string }
  | { ok: false; failure: RenderFailure; message: string };

/** am's own stdout, minus the leading `✓ <path>` line: template · theme · panels · STE. */
function reportLine(stdout: string): string {
  return stdout
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" · ")
    .slice(0, 200);
}

/** Accumulate a child stream, but never let a runaway renderer grow the heap. */
function bounded(s: string, chunk: Buffer): string {
  return s.length >= OUTPUT_CAP ? s : s + chunk.toString("utf8");
}

export async function renderDraft({ draft, outPath, home, cwd }: RenderRequest): Promise<RenderOutcome> {
  if (!nodeSupportsAm()) {
    return {
      ok: false,
      failure: "no-node",
      message: `Node 20+ is required to render a page (this is ${process.versions.node}). The draft is saved in the journal; upgrade and call again.`,
    };
  }
  if (!amInstalled()) {
    return {
      ok: false,
      failure: "no-bundle",
      message: `the vendored renderer is missing at ${AM_BUNDLE}. Reinstall report-mcp, or run \`node scripts/update-am.mjs --from <url> <version>\`.`,
    };
  }
  const size = Buffer.byteLength(draft);
  if (size > MAX_DRAFT_BYTES) {
    return {
      ok: false,
      failure: "draft-too-large",
      message: `draft is ${size} bytes, over the ${MAX_DRAFT_BYTES} byte limit. Split it into more than one page.`,
    };
  }

  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.mkdir(path.join(home, "am"), { recursive: true, mode: 0o700 });


  return await new Promise<RenderOutcome>((resolve) => {
    const child = spawn(process.execPath, [AM_BUNDLE, "render", "-", "--no-open", "-o", outPath], {
      cwd: cwd ?? process.cwd(),
      env: {
        ...process.env,
        // am's pages, config and theme scratch space belong to the storage root, so two
        // REPORT_MCP_HOMEs on one machine cannot see each other's pages.
        AM_HOME: path.join(home, "am"),
        AM_NO_OPEN: "1",
        // am would otherwise contact GitHub for a new release once a week. Never from a
        // server process, and never on the path a tool call is waiting on.
        AM_NO_UPDATE_CHECK: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let out = "";
    let err = "";
    let timedOut = false;
    child.stdout.on("data", (c: Buffer) => (out = bounded(out, c)));
    child.stderr.on("data", (c: Buffer) => (err = bounded(err, c)));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, RENDER_TIMEOUT_MS);

    // A draft this large cannot be rejected by am's argument parser, but the pipe can
    // still close under us; a write error is not a failure, the exit code is.
    child.stdin.on("error", () => {});
    child.stdin.end(draft, "utf8");

    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, failure: "spawn", message: `could not start the renderer: ${e.message}` });
    });

    child.on("exit", async (code) => {
      clearTimeout(timer);
      const text = `${out}${err}`.trim();
      if (timedOut) {
        resolve({
          ok: false,
          failure: "timeout",
          message: `the renderer was killed after ${RENDER_TIMEOUT_MS}ms.\n${text}`.trim(),
        });
        return;
      }
      if (code !== 0) {
        // Verbatim, including `✗ L12 [flow] …`, the "Correct example:" block and the
        // `am help <component>` pointer. That output is the agent's fix instruction;
        // paraphrasing it loses the line number.
        resolve({ ok: false, failure: "draft", message: text || `renderer exited with code ${code}` });
        return;
      }
      let st;
      try {
        st = await fsp.stat(outPath);
      } catch {
        resolve({
          ok: false,
          failure: "no-output",
          message: `the renderer reported success but wrote no page at ${outPath}.\n${text}`.trim(),
        });
        return;
      }
      const buf = await fsp.readFile(outPath);
      resolve({
        ok: true,
        bytes: st.size,
        sha256: createHash("sha256").update(buf).digest("hex"),
        report: reportLine(out),
      });
    });
  });
}

/**
 * `am list` / `am help <component>` — the draft syntax, straight from the bundle we
 * render with. Exposed as a tool so the agent reads the same text the renderer obeys,
 * instead of a second spec that can drift.
 */
export async function amSyntax(topic?: string): Promise<{ ok: boolean; text: string }> {
  if (!amInstalled()) return { ok: false, text: `the vendored renderer is missing at ${AM_BUNDLE}` };
  const args = topic ? [AM_BUNDLE, "help", topic] : [AM_BUNDLE, "list"];
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, AM_NO_UPDATE_CHECK: "1", AM_NO_OPEN: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), SYNTAX_TIMEOUT_MS);
    child.stdout.on("data", (c: Buffer) => (out = bounded(out, c)));
    child.stderr.on("data", (c: Buffer) => (out = bounded(out, c)));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, text: `could not start the renderer: ${e.message}` });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 || out.trim().length > 0, text: out.trim().slice(0, OUTPUT_CAP) });
    });
  });
}
