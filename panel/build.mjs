#!/usr/bin/env node
/**
 * Build the panel front end: `panel/src/**` → `public/panel.js`.
 *
 * Why a bundler at all, in a project whose selling point used to be "no build"?
 * Because the panel is now React, and React has to be compiled (JSX) and bundled
 * before a browser can run it. What this script deliberately does *not* do is
 * add a framework, a dev server, or a config file:
 *
 *   - no `vite.config`, no plugins, no PostCSS, no CSS pipeline
 *   - the stylesheet stays hand-written inside `public/index.html` (see below)
 *   - the output is a single IIFE with no runtime chunk splitting
 *
 * Output is **committed** to `public/panel.js`, for the same reason `dist/` is
 * committed: a global git install gets no devDependencies, so there is no
 * esbuild and no React to build with at install time. `npm run build:panel`
 * regenerates it, and CI fails if it drifts from `panel/src` — the same gate
 * `dist/` already has.
 *
 * CSS is intentionally NOT imported from the JSX. It lives in the hand-written
 * `<style>` block in `public/index.html`, which keeps (a) the verified
 * narrow-viewport rules reviewable in one place next to the markup they target,
 * and (b) styles applied before the bundle parses, so there is no unstyled flash.
 */
import { build, context } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const entry = path.join(root, "panel", "src", "main.jsx");
const out = path.join(root, "public", "panel.js");

if (!fs.existsSync(entry)) {
  console.error(`missing panel entry: ${entry}`);
  process.exit(1);
}

const watch = process.argv.includes("--watch");

/** Options shared by the one-shot and the watch build. */
const common = {
  entryPoints: [entry],
  outfile: out,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  jsx: "automatic",
  minify: true,
  sourcemap: true,
  // Fail the build on a warning rather than shipping a subtly broken bundle.
  logLevel: "warning",
  legalComments: "none",
  define: { "process.env.NODE_ENV": '"production"' },
};

if (watch) {
  const ctx = await context(common);
  await ctx.watch();
  console.log("watching panel/src → " + path.relative(root, out));
} else {
  const result = await build({ ...common, metafile: true });
  const bytes = fs.statSync(out).size;
  const gz = gzipSync(fs.readFileSync(out)).length;
  const inputs = Object.keys(result.metafile.inputs).length;
  console.log(
    `wrote ${path.relative(root, out)}  ${inputs} module(s), ` +
      `${(bytes / 1024).toFixed(1)} kB (gzip ${(gz / 1024).toFixed(1)} kB)`,
  );
}
