# syntax=docker/dockerfile:1.7

# ────────────────────────────────────────────────────────────────────────────────
# World Monitor — Full-Stack Self-Hosted Docker Image
#
# Builds the Vite frontend and runs it alongside the local-api-server.mjs
# backend (the same sidecar used by the Tauri desktop app). Nginx serves
# static assets and proxies /api/ to the Node process on port 46123.
# ────────────────────────────────────────────────────────────────────────────────

# ── Stage 1: Build the frontend ──────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies (including devDependencies for tsc, vite, etc.)
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# Copy source and build
COPY . .

# Build-time configuration — override via --build-arg
ARG VITE_VARIANT=full
ARG VITE_WS_API_URL=http://127.0.0.1:46123

ENV VITE_VARIANT=${VITE_VARIANT}
ENV VITE_WS_API_URL=${VITE_WS_API_URL}

# tsc + vite build (see package.json "build" script)
RUN npm run build


# ── Stage 2: Runtime — nginx + node + supervisord ────────────────────────────
FROM node:22-alpine AS runtime

# Install nginx and supervisord
RUN apk add --no-cache nginx supervisor curl

WORKDIR /app

# Copy built frontend assets
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy API handlers and the local-api-server sidecar
COPY --from=builder /app/api /app/api
COPY --from=builder /app/src-tauri/sidecar/local-api-server.mjs /app/local-api-server.mjs

# Copy data files needed by API handlers at runtime
COPY --from=builder /app/data /app/data

# Install production-only dependencies for API handlers
COPY --from=builder /app/package.json /app/package-lock.json /app/
RUN npm ci --omit=dev --ignore-scripts 2>/dev/null || true

# Copy nginx config (routes /api/ to local node backend)
COPY nginx.conf /etc/nginx/nginx.conf
COPY docker/nginx-security-headers.conf /etc/nginx/security_headers.conf

# Copy supervisord config
COPY supervisord.conf /etc/supervisord.conf

# Copy entrypoint (Docker secrets → env bridge)
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Create nginx pid directory
RUN mkdir -p /run/nginx

# ── Metadata ─────────────────────────────────────────────────────────────────
LABEL org.opencontainers.image.title="World Monitor"
LABEL org.opencontainers.image.description="Real-time global intelligence dashboard — self-hosted"
LABEL org.opencontainers.image.url="https://github.com/koala73/worldmonitor"
LABEL org.opencontainers.image.source="https://github.com/koala73/worldmonitor"

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:80/ > /dev/null || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]
