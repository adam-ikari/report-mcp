#!/usr/bin/env node
/**
 * Stage the panel demo into the docs site's public directory.
 *
 * The panel lives in `public/` because the MCP server serves it from there at
 * runtime. The docs site needs the same files under `docs/public/panel/` so
 * VitePress copies them to `<site>/panel/` — one source of truth, two deploy
 * targets.
 *
 * The demo bundle is regenerated first so its relative timestamps ("3 分钟前")
 * are fresh at build time, exactly as they are in the Pages-only pipeline.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const src = path.join(root, "public");
const dest = path.join(root, "docs", "public", "panel");

const gen = spawnSync(process.execPath, [path.join(here, "build-demo.mjs")], { stdio: "inherit" });
if (gen.status !== 0) process.exit(gen.status ?? 1);

if (!fs.existsSync(path.join(src, "index.html"))) {
  console.error(`missing panel entry: ${path.join(src, "index.html")}`);
  process.exit(1);
}

// Rebuild the destination from scratch: a file deleted upstream must not
// survive as a stale copy in the published site.
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });

const files = fs.readdirSync(dest).sort();
console.log(`staged ${files.length} file(s) → ${path.relative(root, dest)}/${files.length ? " " + files.join(" ") : ""}`);
