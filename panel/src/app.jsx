import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { Empty, MobileBar, Scrim } from "./components/chrome.jsx";
import { Detail, TimelineSkeleton } from "./components/detail.jsx";
import { Sidebar } from "./components/sidebar.jsx";
import { PanelTheme } from "./components/theme.jsx";
import { DS } from "./lib/datasource.js";
import { derive } from "./lib/derive.js";
import { addPanel, loadPanels, removePanel } from "./lib/mypanels.js";

const HASH_RUN = /#\/run\/([^/]+)/;
const POLL_MS = 15000;
/** Sidebar reload debounce. A burst of progress records would otherwise trigger
 *  one full /api/runs refetch per record (see docs: 侧栏比头部晚 600ms). */
const SIDEBAR_DEBOUNCE_MS = 600;

const runIdFromHash = () => {
  const m = HASH_RUN.exec(location.hash);
  return m ? decodeURIComponent(m[1]) : null;
};

/**
 * execCommand("copy") via an off-screen textarea. Deprecated, and still the only
 * copy path on a plain-http page — which is exactly what a LAN panel served
 * from http://192.168.x.x:7788 is, so navigator.clipboard is simply absent and
 * the copy button would otherwise always report failure on a phone.
 */
function legacyCopy(text) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function App() {
  // `mode` is null until DS.detect() resolves. Nothing renders before that: the
  // static demo's bundle has to load first, and rendering "no runs" in the
  // meantime would flash an empty sidebar on every page view.
  const [mode, setMode] = useState(null);
  const [runs, setRuns] = useState([]);
  // records + summary live in one object so they can never disagree: the header
  // is computed from the records the timeline is showing.
  const [view, setView] = useState({ runId: null, records: [], summary: null });
  const [filter, setFilter] = useState("all");
  const [follow, setFollow] = useState(true);
  const [drawer, setDrawer] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState([]);
  const [copyLabel, setCopyLabel] = useState("复制链接");
  const [panels, setPanels] = useState([]);
  const [panelError, setPanelError] = useState(null);
  const [homePath, setHomePath] = useState(null);

  const timelineRef = useRef(null);
  const panelInputRef = useRef(null);
  // Mirrors view.runId synchronously. Every async callback (SSE, fetch, timer)
  // needs to know which run it was started for; reading it from state would let
  // a late response from the previously open run overwrite the current one.
  const runIdRef = useRef(null);
  // Whether the timeline is scrolled to the bottom, sampled on scroll rather
  // than at render time: by the time an effect runs, the new rows are already
  // in the DOM and the old scrollHeight is gone.
  const atBottomRef = useRef(true);
  const sidebarTimer = useRef(null);
  const esRef = useRef(null);

  const live = mode === "live";

  const openRun = useCallback((id, push) => {
    runIdRef.current = id;
    if (push) location.hash = `#/run/${encodeURIComponent(id)}`;
    setDrawer(false); // picking a run from the drawer should reveal it
    setView({ runId: id, records: [], summary: derive(id, []) });
  }, []);

  const loadRun = useCallback(async (id) => {
    let data = null;
    if (DS.kind === "static") {
      data = DS.getRun(id);
    } else {
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(id)}`);
        if (res.ok) data = await res.json();
      } catch {
        data = null;
      }
    }
    if (runIdRef.current !== id) return; // a newer run was opened meanwhile
    if (!data) {
      setView({ runId: id, records: [], summary: null });
      return;
    }
    setView({ runId: id, records: data.records || [], summary: data.summary });
  }, []);

  /** Refresh the sidebar. Returns the list so callers can act on it. */
  const loadRuns = useCallback(async () => {
    let next;
    if (DS.kind === "static") {
      next = DS.listRuns();
    } else {
      try {
        const res = await fetch("/api/runs");
        next = await res.json();
      } catch {
        next = [];
      }
    }
    setRuns(next);
    return next;
  }, []);

  /** Debounced sidebar refresh; the detail pane refreshes immediately. */
  const reloadRuns = useCallback(() => {
    clearTimeout(sidebarTimer.current);
    sidebarTimer.current = setTimeout(loadRuns, SIDEBAR_DEBOUNCE_MS);
  }, [loadRuns]);

  // --- boot: detect the data source, then open a deep link or the first run ---
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await DS.detect();
      if (cancelled) return;
      if (DS.kind === "static") {
        setPanels(loadPanels());
        setHomePath("演示数据 · 静态站点（无后端）");
      } else {
        fetch("/api/health")
          .then((r) => r.json())
          .then((d) => d.home && !cancelled && setHomePath(d.home))
          .catch(() => {});
      }
      setMode(DS.kind);

      const deep = runIdFromHash();
      if (deep) {
        // A deep link names the run to show, but the sidebar still has to be
        // populated — there is no "cold open" here to trigger it.
        openRun(deep);
        loadRun(deep);
        loadRuns();
      } else {
        const first = await loadRuns();
        // Auto-select the newest run only on a cold open, never on a background
        // refresh — otherwise a poll would yank the reader off what they are on.
        if (first.length && !runIdRef.current) {
          openRun(first[0].runId, false);
          loadRun(first[0].runId);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [openRun, loadRun, loadRuns]);

  // --- the drawer is an overlay, so it has to be dismissible ---
  // Dismissal paths: the hamburger, the scrim, and Escape. Deliberately no
  // history entry per open — that would make the browser's own back-swipe (how
  // iOS users dismiss a drawer) a two-swipe trap.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") setDrawer(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // --- deep links: the back button and a pasted #/run/... ---
  useEffect(() => {
    const onHash = () => {
      const id = runIdFromHash();
      if (id && id !== runIdRef.current) {
        openRun(id);
        loadRun(id);
      }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [openRun, loadRun]);

  const pickRun = useCallback(
    (id) => {
      openRun(id, true);
      loadRun(id);
      loadRuns();
    },
    [openRun, loadRun, loadRuns],
  );

  // --- live stream ---
  useEffect(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    if (!live || !view.runId || !window.EventSource) return;
    const id = view.runId;
    const es = new EventSource(`/api/stream?run=${encodeURIComponent(id)}`);
    esRef.current = es;
    es.addEventListener("record", (e) => {
      if (runIdRef.current !== id) return;
      let rec;
      try {
        rec = JSON.parse(e.data);
      } catch {
        return;
      }
      setView((v) => {
        if (v.runId !== id) return v;
        if (v.records.some((x) => x.id === rec.id)) return v;
        const records = [...v.records, rec].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
        return { runId: id, records, summary: derive(id, records) };
      });
    });
    es.addEventListener("runs", () => {
      if (runIdRef.current === id) loadRun(id);
      reloadRuns();
    });
    es.onerror = () => {
      /* EventSource retries on its own */
    };
    return () => {
      es.close();
      if (esRef.current === es) esRef.current = null;
    };
  }, [live, view.runId, loadRun, reloadRuns]);

  // --- safety net: full resync even if fs.watch or the SSE socket was lost ---
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => {
      loadRuns();
      if (runIdRef.current) loadRun(runIdRef.current);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [live, loadRuns, loadRun]);

  // --- auto-scroll: stick to the bottom only if the reader already was ---
  const records = view.records;
  const filterKey = filter;
  useLayoutEffect(() => {
    const box = timelineRef.current;
    if (!box) return;
    if (follow && atBottomRef.current) box.scrollTop = box.scrollHeight;
  }, [records, filterKey, follow]);

  const onTimelineScroll = useCallback((e) => {
    const b = e.currentTarget;
    atBottomRef.current = b.scrollHeight - b.scrollTop - b.clientHeight < 60;
  }, []);

  const onFollow = useCallback(() => {
    setFollow((f) => {
      const next = !f;
      if (next) {
        const b = timelineRef.current;
        if (b) {
          b.scrollTop = b.scrollHeight;
          atBottomRef.current = true;
        }
      }
      return next;
    });
  }, []);

  const onCopy = useCallback(async () => {
    let done = false;
    try {
      await navigator.clipboard.writeText(location.href);
      done = true;
    } catch {
      done = legacyCopy(location.href);
    }
    setCopyLabel(done ? "已复制" : "复制失败");
    setTimeout(() => setCopyLabel("复制链接"), 1500);
  }, []);

  const onAddPanel = useCallback(() => {
    const raw = panelInputRef.current ? panelInputRef.current.value : "";
    const next = addPanel(raw);
    if (!next) {
      setPanelError("请输入 http(s) 地址");
      return;
    }
    setPanelError(null);
    setPanels(next);
    if (panelInputRef.current) panelInputRef.current.value = "";
  }, []);

  const onRemovePanel = useCallback((origin) => setPanels(removePanel(origin)), []);

  const onToggleGroup = useCallback((key) => {
    setCollapsedGroups((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }, []);

  const hasRun = !!view.runId;
  const summary = view.summary || derive(view.runId, records);

  return (
    <PanelTheme>
      <div id="app" className={drawer ? "nav-open" : ""}>
        <Scrim onClick={() => setDrawer(false)} />
      <Sidebar
        staticMode={mode === "static"}
        runs={runs}
        booting={mode === null}
        runId={view.runId}
        onPick={pickRun}
        collapsed={collapsedGroups}
        onToggleGroup={onToggleGroup}
        panels={panels}
        panelError={panelError}
        inputRef={panelInputRef}
        onAdd={onAddPanel}
        onRemove={onRemovePanel}
      />
      <main>
        <MobileBar
          open={drawer}
          onToggle={() => setDrawer((d) => !d)}
          title={hasRun ? summary.title || "Untitled run" : "Agent Report"}
          status={hasRun ? summary.status : null}
        />
        {/*
          Both panes stay mounted and are toggled with `hidden`, exactly as the
          pre-React markup did. Conditional rendering would also throw away the
          timeline's scroll position on every run switch.
        */}
        <Empty homePath={homePath} hidden={hasRun} />
        <Detail
          summary={summary}
          records={records}
          runId={view.runId}
          live={live}
          hidden={!hasRun}
          filter={filter}
          onFilter={setFilter}
          follow={follow}
          onFollow={onFollow}
          copyLabel={copyLabel}
          onCopy={onCopy}
          timelineRef={timelineRef}
          onTimelineScroll={onTimelineScroll}
        />
      </main>
      </div>
    </PanelTheme>
  );
}
