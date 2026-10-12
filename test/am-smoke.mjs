#!/usr/bin/env node
/**
 * Suite: the CLI contract src/render.ts depends on.
 *
 * This spawns `am.mjs` directly, on purpose. It is the proof that the flags, the
 * stdin draft, the `-o` destination and the *shape of a failure* are what the
 * renderer assumes — written before src/render.ts exists, so a red here points at
 * upstream, not at our own wrapping.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const AM = path.join(here, "..", "vendor", "am", "am.mjs");
const TMP = path.join(here, ".tmp-am");
const AM_HOME = path.join(TMP, "amhome");
const OUT = path.join(TMP, "page.html");
const BAD = path.join(TMP, "bad.html");

let passed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) passed++;
  else failures.push(name);
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra != null ? "  " + extra : ""}`);
}

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const env = { ...process.env, AM_HOME, AM_NO_OPEN: "1", AM_NO_UPDATE_CHECK: "1" };
const render = (draft, out) =>
  spawnSync(process.execPath, [AM, "render", "-", "--no-open", "-o", out], {
    input: draft,
    env,
    encoding: "utf8",
    timeout: 20000,
    cwd: TMP,
  });

// Built from lines rather than a template literal: the draft is full of triple backticks,
// and escaping them inside a template string is how this file used to break.
const DRAFT = [
  "---",
  "title: Smoke · three-way handshake",
  "subtitle: one page, no CDN",
  "---",
  "## A The handshake",
  "Two sides agree on sequence numbers before data moves.",
  "",
  "| step | sends | state |",
  "|---|---|---|",
  "| 1 | SYN | SYN-SENT |",
  "| 2 | SYN-ACK | SYN-RCVD |",
  "",
  "```flow LR",
  "(CLOSED) -> LISTEN: passive open",
  "LISTEN -> SYN_RCVD: get SYN",
  "```",
  "",
].join("\n");

const t0 = Date.now();
const good = render(DRAFT, OUT);
const ms = Date.now() - t0;

check("render exits 0", good.status === 0, good.stderr?.slice(0, 200));
check("render prints the page path", (good.stdout || "").includes(OUT), String(good.stdout || "").split("\n")[0]);
check("render reports the STE check", /STE/.test(good.stdout || ""));
check("a page renders well under a second", ms < 5000, `${ms}ms`);

const html = fs.readFileSync(OUT, "utf8");
check("page is one self-contained file", html.length > 50_000, `${html.length} bytes`);
check("page starts with <!doctype html>", /^<!doctype html>/i.test(html.trimStart()));
check("page carries panel markup", (html.match(/class="am-panel/g) || []).length >= 2);
check("page embeds its own draft (#am-source)", html.includes('id="am-source"'));
check("page has no external script", !/<script[^>]+src=/i.test(html));
check("page has no stylesheet link", !/<link[^>]+stylesheet/i.test(html));
check("page has no root-relative asset", !/\ssrc="\//.test(html));
check("page rendered the table", html.includes("SYN-RCVD"));

// A bad draft is the agent's most likely failure, and the whole recovery design rests on
// am naming the line and the component: src/render.ts forwards this text verbatim.
const bad = render("## A Bad\n```flow\nA -> : broken\n```\n", BAD);
const badOut = `${bad.stdout || ""}${bad.stderr || ""}`;
check("bad draft exits non-zero", bad.status === 1, `status ${bad.status}`);
check("bad draft names the line and component", /L\d+ \[flow\]/.test(badOut), badOut.split("\n")[0]);
check("bad draft shows a correct example", /Correct example:/.test(badOut));
check("bad draft points at am help", /am help flow/.test(badOut));
check("bad draft writes no page", !fs.existsSync(BAD));

// AM_HOME isolation: `-o` writes where we ask and am keeps no pages of its own in our tree.
check("AM_HOME is created private", fs.existsSync(AM_HOME) && (fs.statSync(AM_HOME).mode & 0o077) === 0);
check("am wrote no pages/ of its own", !fs.existsSync(path.join(AM_HOME, "pages")));
const state = fs.existsSync(path.join(AM_HOME, "state.json")) ? fs.readFileSync(path.join(AM_HOME, "state.json"), "utf8") : "{}";
check("update check stayed off", !/[Uu]pdate/.test(state), state.trim().slice(0, 60));

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
