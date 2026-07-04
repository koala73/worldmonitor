# =============================================================================
# World Monitor — Docker Image
# =============================================================================
# Multi-stage build:
#   builder       — installs deps, compiles TS handlers, builds Vite frontend
#   runtime-deps  — installs only packages needed by unbundled raw JS handlers
#   final         — nginx (static) + node (API) under supervisord
# =============================================================================

# ── Stage 1: Builder ─────────────────────────────────────────────────────────
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS builder

WORKDIR /app

# Install root dependencies (layer-cached until package.json changes)
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Copy full source
COPY . .

# Compile TypeScript API handlers → self-contained ESM bundles
# Output is api/**/*.js alongside the source .ts files
RUN node docker/build-handlers.mjs

# Build Vite frontend (outputs to dist/)
# Skip blog build — blog-site has its own deps not installed here
RUN npx tsc && npx vite build

# ── Stage 2: Runtime dependencies ───────────────────────────────────────────
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS runtime-deps

WORKDIR /app

# Keep the runtime dependency set deliberately smaller than the app's full
# production graph. The raw api/*.js handlers are not bundled by
# docker/build-handlers.mjs, so they still need these package imports at
# runtime, but the frontend/server-only production deps do not belong in the
# final image.
COPY docker/runtime-package.json ./package.json
COPY docker/runtime-package-lock.json ./package-lock.json
RUN npm ci --omit=dev --omit=optional --ignore-scripts

# ── Stage 3: Runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS final

# nginx + supervisord
RUN apk add --no-cache nginx supervisor gettext && \
    mkdir -p /tmp/nginx-client-body /tmp/nginx-proxy /tmp/nginx-fastcgi \
             /tmp/nginx-uwsgi /tmp/nginx-scgi /var/log/supervisor && \
    addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# API server
COPY --from=builder /app/src-tauri/sidecar/local-api-server.mjs ./local-api-server.mjs
COPY --from=builder /app/src-tauri/sidecar/package.json ./package.json

# Minimal runtime node_modules — required by raw .js handlers that aren't
# bundled by build-handlers.mjs. Without this the Node sidecar dispatches
# those routes, fails to resolve package imports like @upstash/ratelimit,
# and returns 502 "missing dependency".
COPY --from=runtime-deps /app/node_modules ./node_modules

# API handler modules (JS originals + compiled TS bundles)
COPY --from=builder /app/api ./api

# Static data files used by handlers at runtime
COPY --from=builder /app/data ./data

# Built frontend static files
COPY --from=builder /app/dist /usr/share/nginx/html

# Nginx + supervisord configs
COPY docker/nginx.conf /etc/nginx/nginx.conf.template
COPY docker/supervisord.conf /etc/supervisor/conf.d/worldmonitor.conf
COPY docker/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Ensure writable dirs for non-root
RUN chown -R appuser:appgroup /app /tmp/nginx-client-body /tmp/nginx-proxy \
    /tmp/nginx-fastcgi /tmp/nginx-uwsgi /tmp/nginx-scgi /var/log/supervisor \
    /var/lib/nginx /var/log/nginx

USER appuser

EXPOSE 8080

# Healthcheck via nginx
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:8080/api/health || exit 1

CMD ["/app/entrypoint.sh"]
