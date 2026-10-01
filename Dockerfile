# report-mcp in a container.
#
# Two things make this image different from a normal Node app:
#
#   1. dist/ and public/panel.js are COMMITTED to the repo, so the build stages
#      here exist only to produce a clean, self-contained runtime layer — the
#      install contract (a global git install has no tsc, no esbuild, no React)
#      does not depend on them.
#   2. The MCP client does not run node. It runs `docker run ... report-mcp`,
#      speaking MCP over stdio into the container. The panel is served by the
#      same process, so REPORT_MCP_HOME has to be a bind mount or the reports
#      vanish with the container.

# ---------- build ----------
FROM node:24-alpine AS build
WORKDIR /app

# Install with devDependencies: this is the only stage that needs tsc + esbuild.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY panel ./panel
COPY public ./public
COPY scripts ./scripts

# tsc → dist/, esbuild → public/panel.js, fixtures → public/demo-data.js
RUN npm run build

# Production dependency tree, pruned to what dist/ actually imports.
# `npm ci --omit=dev` in a fresh stage is the honest way to get it: the
# runtime stage below copies the result rather than pruning in place.
RUN npm ci --omit=dev --ignore-scripts

# ---------- runtime ----------
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    REPORT_MCP_HOME=/data \
    REPORT_MCP_HOST=0.0.0.0 \
    REPORT_MCP_PORT=7788

# Only the server's own dependency tree — no devDependencies, no sources.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json

# Run unprivileged. The report home is a volume, so ownership is the operator's
# problem to solve (see docker-compose.yml for the matching user).
USER node

EXPOSE 7788
VOLUME ["/data"]

# The panel's own health endpoint: no MCP handshake, no stdio, safe to probe.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.REPORT_MCP_PORT||7788)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# stdio is the MCP transport, so this process is normally driven by an MCP client
# rather than run by hand. `docker run` with no stdin still starts the panel and
# prints its addresses to stderr.
ENTRYPOINT ["node", "dist/index.js"]
