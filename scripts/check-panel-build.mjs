#!/usr/bin/env node
/**
 * Fail loudly at install time if the committed panel bundle is missing.
 *
 * `public/panel.js` is committed (same reason `dist/` is: a global git install
 * has no esbuild and no React, so nothing could build it), and `prepare` must not
 * try to build it — it cannot. What it *can* do is catch the one failure that
 * would otherwise be discovered by the user opening a blank panel: the bundle
 * was never committed, or was deleted.
 *
 * Regenerating demo-data.js here is not a contradiction: that file is NOT
 * committed, because its timestamps are relative to Date.now() and would go
 * stale in a checkout.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = path.join(root, "public", "panel.js");

if (!fs.existsSync(bundle) || fs.statSync(bundle).size < 1000) {
  console.error(
    `\n[report-mcp] public/panel.js is missing or truncated.\n` +
      `It is committed on purpose — a git install has no esbuild or React to build it.\n` +
      `Run \`npm ci && npm run build:panel\` and commit the result.\n`,
  );
  process.exit(1);
}
