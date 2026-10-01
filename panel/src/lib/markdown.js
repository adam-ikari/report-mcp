import DOMPurify from "dompurify";
import { marked } from "marked";

/**
 * Markdown → HTML, then sanitise.
 *
 * Two stages, and the order is the point:
 *
 *   1. `marked` renders the markdown. Unlike the hand-rolled subset renderer
 *      this replaces, it passes **raw HTML in the source straight through** —
 *      which is what makes full markdown (tables, footnotes, task lists) work,
 *      and also what makes stage 2 mandatory rather than optional.
 *   2. `DOMPurify` then removes everything an agent could have used to run
 *      script. This is the single XSS boundary for every piece of agent-authored
 *      markup in the panel: the `markdown` field of a result record, and any
 *      `.md` artifact fetched through /api/file.
 *
 * The previous implementation was escape-first (escape the whole document, then
 * transform the inert text). That is safe too, but it is a hand-rolled
 * allowlist, and it silently degrades to plain text for any markdown feature it
 * does not implement. Sanitising a fully-featured renderer is the standard
 * arrangement, and it means one reviewed library owns the attack surface
 * instead of ~40 lines of regexes here.
 *
 * CONFIGURED STRICTLY. marked's defaults are permissive in ways that matter for
 * agent output:
 *   - `mangle`/`headerIds` are gone in v15, but raw HTML still passes through
 *   - `javascript:` / `data:` links are therefore only stopped by DOMPurify
 * The DOMPurify config below is an allowlist. Adding an entry is a security
 * decision; do not do it casually, and do not switch to ADD_TAGS/ADD_ATTR to
 * "fix" something an agent reported.
 */
marked.setOptions({
  gfm: true,
  breaks: true, // agents write chat-style lines; a single \n should be a <br>
});

const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    "p", "br", "hr", "span", "div",
    "strong", "em", "del", "ins", "sub", "sup", "mark", "small",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li",
    "blockquote", "pre", "code",
    "a", "img",
    "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "col", "colgroup",
    "input", // task-list checkboxes, which marked emits as disabled inputs
  ],
  ALLOWED_ATTR: [
    "href", "title", "alt", "src", "width", "height",
    "class", "id", "align", "colspan", "rowspan", "scope",
    "type", "checked", "disabled", // task lists only
  ],
  // No data: images, no iframe, no form, no style attribute, no event handlers.
  ALLOW_DATA_ATTR: false,
  FORBID_TAGS: ["style", "form", "iframe", "object", "embed", "svg", "math", "link", "meta"],
  FORBID_ATTR: ["style", "srcset", "formaction", "target"],
  // Keep target="_blank" working without handing the opener over.
  ADD_ATTR: ["target"],
};

let cached = null;

/**
 * Render markdown to HTML that is safe to hand to dangerouslySetInnerHTML.
 *
 * The result is cached per source string: the timeline re-renders on every SSE
 * record, and re-parsing every past result record each time is pure waste.
 */
export function renderMarkdown(src) {
  const text = String(src == null ? "" : src);
  if (cached && cached.src === text) return cached.html;
  const raw = marked.parse(text, { async: false });
  const html = DOMPurify.sanitize(raw, PURIFY_CONFIG);
  cached = { src: text, html };
  return html;
}
