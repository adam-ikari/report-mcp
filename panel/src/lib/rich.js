/**
 * Rich result rendering: sandboxed agent HTML, and the /api/file URL scheme.
 *
 * Both functions below are security boundaries, not formatting helpers.
 */

/**
 * Wildcard sources never cover `style=` attributes — 'unsafe-inline' must be
 * spelled out or every inline-styled agent HTML renders unstyled. Script risk
 * stays contained by the sandbox attribute (opaque origin), not by this list.
 */
export const FRAME_CSP =
  '<meta http-equiv="Content-Security-Policy" content="default-src *; script-src * \'unsafe-inline\'; style-src * \'unsafe-inline\'; img-src * data:;">';

/** Inject the CSP unless the document already carries one. */
export function withCsp(html) {
  const s = String(html);
  if (/<meta\s+http-equiv=["']?content-security-policy/i.test(s)) return s;
  if (/<head[^>]*>/i.test(s)) return s.replace(/<head[^>]*>/i, (m) => m + FRAME_CSP);
  if (/<html[^>]*>/i.test(s)) return s.replace(/<html[^>]*>/i, (m) => m + "<head>" + FRAME_CSP + "</head>");
  return FRAME_CSP + s;
}

/**
 * Props for a sandboxed frame holding agent-supplied HTML.
 *
 * `sandbox="allow-scripts"` and deliberately **not** `allow-same-origin`: the
 * frame gets an opaque origin, so scripts inside it cannot read the panel DOM or
 * call the panel's /api endpoints even though it is same-origin on the wire.
 * Do not "fix" this by adding allow-same-origin.
 */
export function iframeProps(src) {
  return { className: "arthtml", sandbox: "allow-scripts", srcdoc: withCsp(src) };
}

/**
 * URL for an artifact rendered inline, or null when it must stay a plain link.
 *
 * The /api/file path is a (run, seq, i) triple, never a filesystem path from
 * the query string — the server resolves it back out of the stored result
 * record, so it can only ever disclose a file the agent already reported.
 */
export function inlineAsset(record, artifact, index, { runId, live }) {
  if (artifact.url || !artifact.path) return null;
  const t = String(artifact.type || "").toLowerCase();
  let href = null;
  if (live) {
    href = `/api/file?run=${encodeURIComponent(runId)}&seq=${record.seq}&i=${index}`;
  } else if (/^assets\/[\w./-]+$/.test(artifact.path)) {
    href = artifact.path; // demo assets deployed next to the hosted panel
  }
  if (!href) return null;
  if (t === "image") return { kind: "image", href };
  if (t === "markdown" || t === "text") return { kind: "md", href };
  if (t === "html") return { kind: "html", href };
  return null;
}
