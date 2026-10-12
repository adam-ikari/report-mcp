/**
 * Draft fixtures.
 *
 * They are written as arrays of lines because every draft is full of triple backticks:
 * a template literal here would end at the first fence. The component syntax comes from
 * `am help <component>`, so a red on a render points at the renderer, not at a fixture
 * somebody typed from memory.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.join(here, "fixtures");

/** A sheet page: table, flow diagram, kv metadata, one callout. */
export function sheetDraft(title = "Cache selection") {
  return [
    "---",
    `title: ${title}`,
    "subtitle: decided at the milestone boundary",
    "template: sheet",
    "cols: 2",
    "---",
    "Intro text that says what this page decides.",
    "",
    "## The options {meta=\"measured, not guessed\"}",
    "| option | keeps data on restart | ops cost |",
    "|---|---|---|",
    "| Redis | ok yes | warn needs a volume |",
    "| Memcached | no evicted | ok none |",
    "",
    "```flow LR",
    "(Client) -> Gateway: HTTPS",
    "Gateway -> Cache: lookup",
    "Cache -> Service: miss",
    "Service -> [(Database)]",
    "group Backend: Cache, Service",
    "```",
    "",
    "## The decision",
    "```kv cols=1",
    "* Chosen: Redis",
    "Reason: the restart window is the outage we already had",
    "```",
    "",
    "```callout ok Decided",
    "Redis, with a volume and a 90 day key expiry.",
    "```",
    "",
  ].join("\n");
}

/** A doc page carrying an image that the renderer must embed as base64. */
export function imageDraft(imagePath = path.join(FIXTURES_DIR, "chart.png")) {
  return [
    "---",
    "title: Measured latency",
    "template: doc",
    "---",
    "## What the chart shows",
    `![p99 latency after the change](${imagePath})`,
    "",
    "The p99 line drops at the second marker, where the cache starts to answer.",
    "",
  ].join("\n");
}

/** A closing page for `report_end`. */
export function closingDraft(title = "Wrap-up") {
  return [
    "---",
    `title: ${title}`,
    "template: doc",
    "---",
    "## Done",
    "- The cache is in place.",
    "- The volume is provisioned.",
    "",
    "```ask",
    "Do we keep the fallback path?",
    "* Yes | one more release",
    "- No | simpler",
    "```",
    "",
  ].join("\n");
}

/**
 * A flow fence with an edge that has no target. am names the line and the component,
 * prints a correct example, and writes no page — which is the whole failure contract.
 */
export const BAD_FLOW = ["## A Broken", "```flow", "A -> : no target", "```", ""].join("\n");
