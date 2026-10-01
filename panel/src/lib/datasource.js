import { derive } from "./derive.js";

/**
 * Data source.
 *
 * `live`   — a report-mcp backend answered /api/runs: full REST + SSE.
 * `static` — no backend (GitHub Pages, or the backend died): fall back to the
 *            bundled demo-data.js and render entirely from memory.
 *
 * Static mode makes no /api request, opens no EventSource and runs no polling —
 * all three are load-bearing enough to have assertions. Keeping the source a
 * module singleton (rather than React state) is what makes that checkable: the
 * mode is decided once, before the first render, and never flips.
 */
export const DS = {
  kind: "live",
  demo: null,

  async detect() {
    try {
      const res = await fetch("/api/runs", { cache: "no-store" });
      const ct = res.headers.get("content-type") || "";
      if (res.ok && ct.includes("json")) {
        this.kind = "live";
        return;
      }
    } catch {
      /* no backend */
    }
    this.kind = "static";
    await this.loadDemo();
  },

  loadDemo() {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.demo = window.__REPORT_DEMO__ || null;
        resolve();
      };
      const s = document.createElement("script");
      s.src = "demo-data.js";
      s.onload = finish;
      s.onerror = finish;
      document.head.appendChild(s);
      // Never let a stalled script tag block the whole panel from booting.
      // demo-data.js is same-origin on a static host, so 2s is generous.
      const timer = setTimeout(finish, 2000);
    });
  },

  entries() {
    return (this.demo && this.demo.runs) || [];
  },

  listRuns() {
    return this.entries()
      .map((e) => derive(e.runId, e.records))
      .sort((a, b) => Date.parse(b.updatedAt ?? b.startedAt ?? "0") - Date.parse(a.updatedAt ?? a.startedAt ?? "0"));
  },

  getRun(id) {
    const e = this.entries().find((x) => x.runId === id);
    return e ? { summary: derive(id, e.records), records: e.records } : null;
  },
};
