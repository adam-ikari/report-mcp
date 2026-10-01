import { Tag, Tooltip } from "antd";

import { ago } from "../lib/html.js";

/** Label for the "no tag, no agent" bucket rather than a bare empty header. */
export const UNGROUPED = "未分组";

/**
 * Which bucket a run belongs to.
 *
 * One run lands in exactly one group: its first tag, else its agent, else
 * "未分组". Duplicating a run into every one of its tags would make the sidebar
 * lie about how many runs there are and make "mark the one I care about" a
 * scavenger hunt — the remaining tags ride along on the item as chips instead.
 *
 * Tags first because `report_start` documents them as the grouping label; agent
 * is the fallback since it is the other field that identifies a producer.
 */
export function groupKey(run) {
  if (run.tags && run.tags.length) return run.tags[0];
  if (run.agent) return run.agent;
  return UNGROUPED;
}

const activity = (run) => Date.parse(run.updatedAt ?? run.startedAt ?? "0") || 0;

/**
 * Bucket runs by group, both levels ordered by last activity.
 *
 * Groups sort by their most recently active member, so the project you are
 * working on is the first thing in the list rather than wherever its name
 * happens to sort alphabetically.
 */
export function groupRuns(runs) {
  const buckets = new Map();
  for (const run of runs) {
    const key = groupKey(run);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(run);
  }
  return [...buckets.entries()]
    .map(([key, items]) => {
      items.sort((a, b) => activity(b) - activity(a));
      return { key, items, latest: activity(items[0]) };
    })
    .sort((a, b) => b.latest - a.latest || a.key.localeCompare(b.key));
}

function RunItem({ run, active, onPick }) {
  const pct = run.progress && run.progress.percent != null ? run.progress.percent : null;
  const bar =
    pct != null ? (
      <div className="bar">
        <i style={{ width: `${pct}%` }} />
      </div>
    ) : run.progress ? (
      <div className="bar">
        {/* Unknown progress: a short stub, not a bar that claims to know. */}
        <i style={{ width: "18%", opacity: 0.5 }} />
      </div>
    ) : null;
  const err = run.lastError || run.failureSummary ? <span className="chip error" style={{ textTransform: "none" }}>err</span> : null;
  // The first tag is the group header, so only the rest need showing here.
  const extraTags = (run.tags || []).slice(1);

  return (
    <button
      type="button"
      className={`run-item${active ? " active" : ""}`}
      data-run={run.runId}
      onClick={onPick}
    >
      <div className="t">{run.title}</div>
      <div className="m">
        <span className={`chip ${run.status}`}>{run.status}</span>
        <span>{run.updatedAt ? ago(run.updatedAt) : ""}</span>
        {err}
        {extraTags.map((t) => (
          <Tooltip key={t} title={`tag: ${t}`}>
            <Tag className="tagchip" bordered={false}>
              {t}
            </Tag>
          </Tooltip>
        ))}
        {run.agent ? (
          <Tooltip title={`agent: ${run.agent}`}>
            {/* Neutral, not status-coloured: the status chip two elements to the
                left already carries that, and a third colour-coded pill on every
                row turns the sidebar into confetti. */}
            <Tag className="tagchip" bordered={false}>
              {run.agent}
            </Tag>
          </Tooltip>
        ) : null}
      </div>
      {bar}
    </button>
  );
}

/**
 * The run list, bucketed by project (first tag → agent → 未分组).
 *
 * `booting` renders nothing rather than the "no runs" message: before the data
 * source is known we do not yet know whether there are runs, and flashing
 * "暂无运行记录" for the second or two the demo bundle takes to load reads as
 * "your agents reported nothing" rather than "still starting up".
 */
export function RunList({ runs, runId, onPick, booting, collapsed, onToggleGroup }) {
  if (booting) return null;
  if (!runs.length) {
    return <div className="muted" style={{ padding: "12px", fontSize: "12px" }}>暂无运行记录</div>;
  }
  return groupRuns(runs).map((group) => {
    // The group holding the run on screen is never collapsible away: hiding the
    // thing you are reading is a worse failure than showing an extra header.
    const forced = group.items.some((r) => r.runId === runId);
    const isCollapsed = !forced && collapsed.includes(group.key);
    return (
      <div className="rgroup" key={group.key} data-group={group.key}>
        <button
          type="button"
          className="rgroup-head"
          aria-expanded={String(!isCollapsed)}
          onClick={() => onToggleGroup(group.key)}
        >
          <span className="caret" aria-hidden="true" />
          <span className="gname">{group.key}</span>
          <span className="gcount">{group.items.length}</span>
        </button>
        {isCollapsed ? null : (
          <div className="rgroup-body">
            {group.items.map((r) => (
              <RunItem key={r.runId} run={r} active={r.runId === runId} onPick={() => onPick(r.runId)} />
            ))}
          </div>
        )}
      </div>
    );
  });
}

export function Brand({ staticMode, runCount }) {
  return (
    <div className="brand">
      <span className="dot" />
      <h1>Agent Report</h1>
      <span className={`chip demo${staticMode ? "" : " hidden"}`} id="modeChip" title="静态演示站点，数据为示例">
        DEMO
      </span>
      <span className="spacer" style={{ flex: 1 }} />
      <span className="muted" id="runCount" style={{ fontSize: "11px" }}>
        {runCount ? `${runCount} runs` : ""}
      </span>
    </div>
  );
}

/**
 * Static sites double as an address book for your own live panels. The input is
 * intentionally **uncontrolled**: the Add button reads `input.value` at click
 * time, so nothing has to be threaded through state and a bookmark URL pasted
 * and submitted in one gesture cannot be dropped by a re-render.
 */
export function MyPanels({ panels, error, inputRef, onAdd, onRemove }) {
  return (
    <div id="myPanels">
      <div className="lbl">我的面板</div>
      <div className="mp-add">
        <input id="mpUrl" ref={inputRef} placeholder="http://127.0.0.1:7788" spellcheck="false" />
        <button className="btn" id="mpAdd" onClick={onAdd}>
          添加
        </button>
      </div>
      <div id="mpList">
        {error ? <div className="mp-err">{error}</div> : null}
        {panels.map((u, i) => (
          <a key={u} className="mp-item" href={u} target="_blank" rel="noreferrer noopener">
            <span style={{ flex: 1 }}>{u}</span>
            <button
              type="button"
              className="mp-del"
              data-i={i}
              title="移除"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onRemove(u);
              }}
            >
              ×
            </button>
          </a>
        ))}
      </div>
    </div>
  );
}

export function Sidebar({
  staticMode,
  runs,
  runId,
  onPick,
  panels,
  panelError,
  inputRef,
  onAdd,
  onRemove,
  booting,
  collapsed,
  onToggleGroup,
}) {
  return (
    <aside id="sidebar">
      <Brand staticMode={staticMode} runCount={booting ? 0 : runs.length} />
      {staticMode ? (
        <MyPanels
          panels={panels}
          error={panelError}
          inputRef={inputRef}
          onAdd={onAdd}
          onRemove={onRemove}
        />
      ) : (
        // Kept in the tree (rather than unmounted) so the id stays findable and
        // the hidden state is the same one the pre-React markup used.
        <div id="myPanels" className="hidden" />
      )}
      <div className="run-list" id="runList">
        <RunList
          runs={runs}
          runId={runId}
          onPick={onPick}
          booting={booting}
          collapsed={collapsed}
          onToggleGroup={onToggleGroup}
        />
      </div>
    </aside>
  );
}
