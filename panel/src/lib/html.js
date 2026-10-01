/**
 * Text helpers shared by the panel components.
 *
 * There is deliberately no `esc` here any more: React escapes text children and
 * sets attributes via setAttribute, so the component tree never needs manual
 * escaping. The one place that builds an HTML string — `renderMarkdown` in
 * lib/markdown.js — hands its output to DOMPurify instead of escaping by hand.
 */

/** Strings pass through; anything else is pretty-printed, with a String() fallback. */
export const pretty = (v) => {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
};

export const fmtDur = (ms) => {
  if (ms == null || !isFinite(ms)) return "–";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

export const clock = (iso) => {
  try {
    return new Date(iso).toLocaleTimeString([], { hour12: false });
  } catch {
    return "";
  }
};

export const ago = (iso) => {
  const d = Date.now() - Date.parse(iso);
  if (!isFinite(d)) return "";
  if (d < 60000) return `${Math.max(0, Math.round(d / 1000))}s 前`;
  if (d < 3600000) return `${Math.round(d / 60000)}m 前`;
  if (d < 86400000) return `${Math.round(d / 3600000)}h 前`;
  return new Date(iso).toLocaleDateString();
};
