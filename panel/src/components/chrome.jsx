const CONFIG_SNIPPET = `{
  "mcpServers": {
    "report": {
      "command": "node",
      "args": ["/absolute/path/report_mcp/dist/index.js"]
    }
  }
}`;

/**
 * The narrow-viewport bar: hamburger, which run is on screen, its status.
 *
 * The run list is an overlay below 860px, so this is the only persistent chrome
 * above the timeline — it has to carry the run identity on its own.
 */
export function MobileBar({ open, onToggle, title, status }) {
  return (
    <div className="mobar" id="mobar">
      <button
        type="button"
        className="iconbtn"
        id="navBtn"
        aria-label="打开 run 列表"
        aria-expanded={String(open)}
        aria-controls="sidebar"
        onClick={onToggle}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M3 6h18M3 12h18M3 18h18" />
        </svg>
      </button>
      <span className="mo-title" id="moTitle">
        {title}
      </span>
      {/* Always in the tree, hidden when there is no run: the pre-React markup
          kept it mounted and toggled the class. */}
      <span className={`chip ${status || "running"}${status ? "" : " hidden"}`} id="moStatus">
        {status || ""}
      </span>
    </div>
  );
}

export function Scrim({ onClick }) {
  return <div className="scrim" id="scrim" onClick={onClick} />;
}

export function Empty({ homePath, hidden }) {
  return (
    <div className={`empty${hidden ? " hidden" : ""}`} id="empty">
      <h3>还没有汇报</h3>
      <p>
        把 MCP server 挂到 agent 上之后，agent 调用 <code>report_progress</code> / <code>report_result</code> 等工具，记录会实时出现在这里。
      </p>
      <pre className="mono">{CONFIG_SNIPPET}</pre>
      <p className="muted">
        存储位置：<code id="homePath">{homePath || "–"}</code>
      </p>
    </div>
  );
}
