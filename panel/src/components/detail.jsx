import { useEffect, useState } from "react";

import { Button, Empty as AntEmpty, Progress, Skeleton, Tooltip } from "antd";

import { clock, fmtDur, pretty } from "../lib/html.js";
import { renderMarkdown } from "../lib/markdown.js";
import { iframeProps, inlineAsset } from "../lib/rich.js";

/** `<details>` block for an opaque payload. `pretty` output is escaped by React. */
function Details({ label, value }) {
  if (value == null || value === "") return null;
  return (
    <details>
      <summary>{label}</summary>
      <pre>{pretty(value)}</pre>
    </details>
  );
}

function Head({ summary }) {
  const s = summary;
  const bits = [];
  if (s.agent) bits.push(<span key="agent">agent <b>{s.agent}</b></span>);
  if (s.startedAt) bits.push(<span key="started">开始 <b>{clock(s.startedAt)}</b></span>);
  bits.push(<span key="dur">耗时 <b>{fmtDur(s.durationMs)}</b></span>);
  bits.push(<span key="rec">记录 <b>{s.recordCount}</b></span>);
  const errs = (s.logCounts && s.logCounts.error + s.logCounts.warn) || 0;
  if (errs) bits.push(<span key="errs">warn/error <b>{errs}</b></span>);
  if (s.resultCount) bits.push(<span key="res">结果 <b>{s.resultCount}</b></span>);
  if (s.tags && s.tags.length) bits.push(<span key="tags">tags <b>{s.tags.join(", ")}</b></span>);
  if (s.failureSummary)
    bits.push(
      <span key="fsum" style={{ color: "#ff8368" }}>
        失败原因 <b>{s.failureSummary}</b>
      </span>,
    );
  if (s.lastError)
    bits.push(
      <span key="lerr" style={{ color: "#ff8368" }}>
        最后错误 <b>{s.lastError}</b>
      </span>,
    );

  const p = s.progress;
  let percent = 0;
  let label = "";
  let indet = false;
  let title = "";
  if (p && p.percent != null) {
    percent = p.percent;
    label = `${Math.round(p.percent)}%`;
  } else if (p) {
    indet = true;
    label = p.phase || "…";
  }
  if (p && p.phase) {
    const step = p.step != null ? (p.totalSteps ? ` ${p.step}/${p.totalSteps}` : ` #${p.step}`) : "";
    title = p.phase + step + (p.message ? " — " + p.message : "");
  }

  return (
    <div className="head">
      <div className="row">
        <h2 id="rTitle">{s.title || "Untitled run"}</h2>
        <Tooltip title={`status: ${s.status}`}>
          <span className={`chip ${s.status}`} id="rStatus">
            {s.status}
          </span>
        </Tooltip>
      </div>
      <div className="meta" id="rMeta">
        {bits}
      </div>
      <div className="progress-wrap">
        {/* The bar's own markup and id stay: #rProgress > i.style.width is what
            the suites assert, so antd's Progress is used for the indeterminate
            case only and the deterministic bar keeps the hand-written element. */}
        {indet ? (
          <Progress percent={100} status="active" showInfo={false} className="ant-progress-unknown" />
        ) : (
          <div className="progress" id="rProgress" title={title}>
            <i style={{ width: `${percent}%` }} />
          </div>
        )}
        <div className="progress-label" id="rProgressLabel">
          {label}
        </div>
      </div>
    </div>
  );
}

const FILTERS = [
  ["all", "全部"],
  ["progress", "进度"],
  ["log", "日志"],
  ["result", "结果"],
  ["status", "状态"],
];

function Toolbar({ filter, onFilter, follow, onFollow, copyLabel, onCopy }) {
  return (
    <div className="toolbar">
      <div className="seg" id="filters">
        {FILTERS.map(([f, label]) => (
          <button key={f} type="button" className={`btn${filter === f ? " on" : ""}`} data-f={f} onClick={() => onFilter(f)}>
            {label}
          </button>
        ))}
      </div>
      <span className="spacer" />
      <Button size="small" className={`btn${follow ? " on" : ""}`} id="followBtn" onClick={onFollow}>
        自动滚动
      </Button>
      <Button size="small" className="btn" id="copyBtn" onClick={onCopy}>
        {copyLabel}
      </Button>
    </div>
  );
}

/** Markdown file artifact: fetched through /api/file, then typeset. */
function MdFile({ src }) {
  const [state, setState] = useState({ status: "loading" });
  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    fetch(src)
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((text) => live && setState({ status: "ready", html: renderMarkdown(text) }))
      .catch((e) => live && setState({ status: "error", message: String(e.message || e) }));
    return () => {
      live = false;
    };
  }, [src]);

  if (state.status === "error") {
    return (
      <span className="muted">
        {`（加载失败${state.message.startsWith("HTTP ") ? "：" + state.message : ""}）`}
      </span>
    );
  }
  if (state.status !== "ready") return <Skeleton active title={false} paragraph={{ rows: 2 }} style={{ marginTop: 8 }} />;
  return <div className="md-body" dangerouslySetInnerHTML={{ __html: state.html }} />;
}

/** HTML file artifact: fetched, then rendered in a sandboxed opaque-origin frame. */
function HtmlFile({ src }) {
  const [text, setText] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setText(null);
    setFailed(false);
    fetch(src)
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(String(res.status)))))
      .then((t) => live && setText(t))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [src]);
  if (failed) return <span className="muted">（加载失败）</span>;
  if (text == null) return <span className="muted">加载中…</span>;
  return <iframe {...iframeProps(text)} />;
}

function ResultCard({ record, runId, live }) {
  const r = record;
  const metrics = (r.metrics || []).map((m, i) => (
    <div className="metric" key={i}>
      <div className="k">{m.hint ? `${m.name} · ${m.hint}` : m.name}</div>
      <div className="v">
        {String(m.value)}
        {m.unit ? <span className="u">{m.unit}</span> : null}
      </div>
    </div>
  ));

  const arts = (r.artifacts || []).map((a, i) => {
    const target = a.url || a.path || "";
    const name = a.url ? (
      <a className="nm" href={a.url} target="_blank" rel="noreferrer">
        {a.name}
      </a>
    ) : (
      <span className="nm">{a.name}</span>
    );
    const inline = inlineAsset(r, a, i, { runId, live });
    const block = !inline ? null : inline.kind === "image" ? (
      <img className="artimg" loading="lazy" src={inline.href} alt={a.name} />
    ) : inline.kind === "md" ? (
      <MdFile src={inline.href} />
    ) : (
      <HtmlFile src={inline.href} />
    );
    const pth =
      a.url && a.path ? (
        <>
          <br />
          <span className="pth">{a.path}</span>
        </>
      ) : a.path && !a.url ? (
        <span className="pth">{a.path}</span>
      ) : null;
    const ty = a.type && !inline ? <span className="muted">{a.type}</span> : null;
    return (
      <li key={i}>
        {name}
        {a.description ? <span className="muted">{` — ${a.description}`}</span> : null}
        {ty ? (
          <>
            {" "}
            {ty}
          </>
        ) : null}
        {pth}
        {block ? <div style={{ flex: "1 0 100%" }}>{block}</div> : null}
      </li>
    );
  });

  const links = (r.links || []).map((l, i) => (
    <a key={i} href={l.url} target="_blank" rel="noreferrer">
      {l.label}
    </a>
  ));

  return (
    <div className="result-card">
      <span className="kind result">result</span>
      <h4 style={{ display: "inline" }}>{r.title}</h4>
      {r.summary ? <div className="sum">{r.summary}</div> : null}
      {r.markdown ? <div className="md-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(r.markdown) }} /> : null}
      {r.html ? <iframe {...iframeProps(r.html)} /> : null}
      {metrics.length ? <div className="metrics">{metrics}</div> : null}
      {arts.length ? <ul className="art">{arts}</ul> : null}
      {links.length ? <div className="links">{links}</div> : null}
      <Details label="data" value={r.data} />
    </div>
  );
}

function Entry({ record, runId, live }) {
  const r = record;
  const when = (
    <div className="when">
      {r.ts ? clock(r.ts) : ""}
      <br />
      <span className="muted" style={{ fontSize: "10px" }}>
        {`#${r.seq}`}
      </span>
    </div>
  );

  let body;
  if (r.kind === "start") {
    body = (
      <>
        <span className="kind start">start</span>
        <span className="msg">
          <b>{r.title}</b>
        </span>
        {r.agent || r.task ? (
          <div className="sub">{[r.agent, r.task].filter(Boolean).join(" · ")}</div>
        ) : null}
        <Details label="metadata" value={r.metadata} />
      </>
    );
  } else if (r.kind === "progress") {
    const pct = r.percent != null ? `${r.percent}%` : "…";
    const step =
      r.step != null ? (
        <span className="muted">{` step ${r.step}${r.totalSteps ? `/${r.totalSteps}` : ""}`}</span>
      ) : null;
    body = (
      <>
        <span className="kind progress">progress</span>
        <span className="msg">
          <b>{r.phase}</b> <span className="muted">{pct}</span>
          {step}
        </span>
        {r.message ? <div className="sub">{r.message}</div> : null}
        {r.percent != null ? (
          <div className="mini-progress">
            <i style={{ width: `${r.percent}%` }} />
          </div>
        ) : null}
        <Details label="detail" value={r.detail} />
      </>
    );
  } else if (r.kind === "status") {
    body = (
      <>
        <span className="kind status">status</span>
        <span className={`chip ${r.status}`}>{r.status}</span>
        {r.message ? <div className="sub">{r.message}</div> : null}
        <Details label="detail" value={r.detail} />
      </>
    );
  } else if (r.kind === "log") {
    body = (
      <>
        <span className="kind log">log</span>
        <span className={`lv ${r.level}`}>{r.level}</span>
        <span className="msg">{r.message}</span>
        <Details label="detail" value={r.detail} />
      </>
    );
  } else if (r.kind === "result") {
    body = <ResultCard record={r} runId={runId} live={live} />;
  } else if (r.kind === "end") {
    body = (
      <>
        <span className="kind end">end</span>
        <span className={`chip ${r.status}`}>{r.status}</span>
        {r.durationMs != null ? <span className="muted">{`耗时 ${fmtDur(r.durationMs)}`}</span> : null}
        {r.summary ? <div className="sub">{r.summary}</div> : null}
      </>
    );
  } else {
    body = (
      <>
        <span className="kind log">{r.kind}</span>
        <span className="msg">{pretty(r)}</span>
      </>
    );
  }

  return (
    <div className="entry">
      {when}
      <div className="body">{body}</div>
    </div>
  );
}

function matchesFilter(r, filter) {
  if (filter === "all") return true;
  if (filter === "log") return r.kind === "log";
  if (filter === "progress") return r.kind === "progress";
  if (filter === "result") return r.kind === "result";
  if (filter === "status") return r.kind === "status" || r.kind === "start" || r.kind === "end";
  return true;
}

function Timeline({ records, filter, runId, live, timelineRef }) {
  const rows = records.filter((r) => matchesFilter(r, filter));
  if (!rows.length) {
    return (
      <AntEmpty
        image={null}
        description={
          <span className="muted">
            {`还没有记录${filter !== "all" ? `（当前筛选：${filter}）` : ""}。agent 调用 report_* 工具后会实时出现。`}
          </span>
        }
        style={{ margin: "24px 0" }}
      />
    );
  }
  return rows.map((r) => <Entry key={r.id} record={r} runId={runId} live={live} />);
}

/** Shown for a few frames on a cold open so the timeline does not just pop in. */
export function TimelineSkeleton() {
  return <Skeleton active paragraph={{ rows: 5 }} style={{ padding: "24px 0" }} />;
}

export function Detail({
  summary,
  records,
  runId,
  live,
  hidden,
  filter,
  onFilter,
  follow,
  onFollow,
  copyLabel,
  onCopy,
  timelineRef,
  onTimelineScroll,
}) {
  return (
    <div id="detail" className={hidden ? "hidden" : ""}>
      <Head summary={summary} />
      <Toolbar
        filter={filter}
        onFilter={onFilter}
        follow={follow}
        onFollow={onFollow}
        copyLabel={copyLabel}
        onCopy={onCopy}
      />
      <div className="timeline" id="timeline" ref={timelineRef} onScroll={onTimelineScroll}>
        <Timeline records={records} filter={filter} runId={runId} live={live} />
      </div>
    </div>
  );
}
