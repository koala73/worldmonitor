# =============================================================================
# World Monitor — Docker Image
# =============================================================================
# Multi-stage build:
#   builder  — installs deps, compiles TS handlers, builds Vite frontend
#   final    — nginx (static) + node (API) under supervisord
# =============================================================================

# ── Stage 1: Builder ─────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Install root dependencies (layer-cached until package.json changes)
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Install blog-site dependencies (separate workspace)
COPY blog-site/package.json blog-site/package-lock.json ./blog-site/
RUN cd blog-site && npm ci --ignore-scripts

# Copy full source
COPY . .

# Compile TypeScript API handlers → self-contained ESM bundles
# Output is api/**/*.js alongside the source .ts files
RUN node docker/build-handlers.mjs

# Build Vite frontend (outputs to dist/)
RUN npm run build

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM node:20-alpine AS final

# nginx + supervisord
RUN apk add --no-cache nginx supervisor && \
    mkdir -p /tmp/nginx-client-body /tmp/nginx-proxy /tmp/nginx-fastcgi \
             /tmp/nginx-uwsgi /tmp/nginx-scgi /var/log/supervisor

WORKDIR /app

# API server
COPY --from=builder /app/src-tauri/sidecar/local-api-server.mjs ./local-api-server.mjs
COPY --from=builder /app/src-tauri/sidecar/package.json ./package.json

# API handler modules (JS originals + compiled TS bundles)
COPY --from=builder /app/api ./api

# Static data files used by handlers at runtime
COPY --from=builder /app/data ./data

# Built frontend static files
COPY --from=builder /app/dist /usr/share/nginx/html

# Nginx + supervisord configs
COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY docker/supervisord.conf /etc/supervisor/conf.d/worldmonitor.conf

EXPOSE 8080

# Healthcheck via nginx
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:8080/api/health || exit 1

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/worldmonitor.conf"]
