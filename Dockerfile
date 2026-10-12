# report-mcp in a container: the persistent host (`report-mcp serve`).
#
# What this image is for, and what it is deliberately not:
#
#   1. dist/ is COMMITTED to the repo, so the build stage exists only to produce a
#      clean, self-contained runtime layer — the install contract (a global git
#      install has no devDependencies, therefore no `tsc`) does not depend on it.
#   2. Rendering happens in here, not in the agent's container. The MCP server binds
#      no port and spawns nothing: it writes drafts and pages under REPORT_MCP_HOME.
#      Point an MCP client at this image *sharing the same volume* and it picks up
#      the host's address from host.json — see docker-compose.yml.

# ---------- build ----------
FROM node:24-alpine AS build
WORKDIR /app

# Install with devDependencies: this is the only stage that needs tsc.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Production dependency tree, pruned to what dist/ actually imports.
# `npm ci --omit=dev` in a fresh stage is the honest way to get it: the runtime
# stage below copies the result rather than pruning in place.
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
COPY --from=build /app/package.json ./package.json

# The renderer is one vendored file (MIT, upstream-generated, sha-pinned). Without
# it there is no pipeline. Straight from the context: nothing in the build stage
# compiles it, and the runtime image should not contain more than it needs.
COPY vendor ./vendor

# Rendered pages live in /data, which is the report home. Keep the image read-only
# in spirit: the host writes nothing outside /data except its own host.json there.
USER node

EXPOSE 7788
VOLUME ["/data"]

# The host's own health endpoint: no MCP handshake, no stdio, safe to probe.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.REPORT_MCP_PORT||7788)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The hosting side, which is the only thing worth keeping resident in a container.
# The MCP server is started by the agent's host, over stdio, against the same volume.
ENTRYPOINT ["node", "dist/index.js", "serve"]
