# Vendored `am.mjs`

`am.mjs` is the renderer from [Answer me with HTML](https://github.com/QingYunA/answer-me-with-html)
(MIT, `LICENSE`). It turns a short Markdown draft into a single self-contained HTML page: layout,
SVG diagrams and themes are computed by the CLI, not written by the model.

**It is a generated artifact. Do not edit it.** Upstream builds it with `scripts/build.mjs`, and its
own header says so. Upgrading means replacing the whole file:

```bash
node scripts/update-am.mjs --from https://raw.githubusercontent.com/QingYunA/answer-me-with-html/main/skills/answer-me-with-html/scripts/am.mjs 0.5.1
```

That rewrites `am.mjs`, records the new version and sha256 in `manifest.json`, and prints the size
delta. `scripts/check-vendor.mjs` (wired into `prepare` and CI) fails if the file and the manifest
disagree, so a hand edit or a half-finished update cannot ship.

Why vendor instead of requiring the skill: report-mcp is installed from git into an agent's MCP
config, where nothing can prompt to install a second tool, and a rendered report is the whole
product — the tool call must not fail because the user never installed the skill.

We shell out to it (`node am.mjs render - --no-open -o <path>`, draft on stdin) rather than
importing it: it is a CLI bundle, not a library, and its pages are the unit of work.

Two of its behaviours are suppressed by env vars on every spawn — see `src/render.ts`:
`AM_NO_UPDATE_CHECK` (it otherwise phones home to GitHub for a new version once a week) and
`AM_NO_OPEN` (it otherwise launches a browser). `AM_HOME` points at `$REPORT_MCP_HOME/am` so its
pages, config and theme scratch space stay inside our storage root, which is mode `0700`.

Node 20 or newer is required by `am.mjs` (`Array.prototype.toSorted`); that is why `engines.node`
is `>=20` in this package.
