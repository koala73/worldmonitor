# ============================================================
# World Monitor — Docker Build
# https://github.com/koala73/worldmonitor
#
# Architecture:
#   Stage 1 (builder) — installs deps and builds the Vite frontend
#   Stage 2 (runner)  — serves the static build with nginx,
#                       plus a Node.js sidecar that mirrors the
#                       60+ Vercel Edge Functions locally
# ============================================================

# ── Stage 1: Build ──────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package*.json ./
RUN npm ci --ignore-scripts

# Copy source
COPY . .

# Build-time environment variables.
# Override these at build time with --build-arg:
#   docker build --build-arg VITE_VARIANT=world .
#
# VITE_VARIANT options: world | tech | finance | happy
ARG VITE_VARIANT=world
ARG VITE_MAPTILER_KEY=""
ARG VITE_MAPBOX_TOKEN=""
ARG VITE_POSTHOG_KEY=""

ENV VITE_VARIANT=${VITE_VARIANT}
ENV VITE_MAPTILER_KEY=${VITE_MAPTILER_KEY}
ENV VITE_MAPBOX_TOKEN=${VITE_MAPBOX_TOKEN}
ENV VITE_POSTHOG_KEY=${VITE_POSTHOG_KEY}

# Compile the sebuf RPC handlers (api/[domain]/v1/[rpc].ts → .js)
# Required so the local API sidecar can dynamically load them at runtime
RUN npm run build:sidecar-sebuf

# Build the Vite SPA
RUN npm run build

# ── Stage 2: Runtime ─────────────────────────────────────────
# Pin to amd64 so the image runs on x86_64 cluster nodes regardless of
# the build host platform (avoids QEMU emulation for the npm build stage).
FROM --platform=linux/amd64 node:20-alpine AS runner

WORKDIR /app

# Install nginx to serve the static frontend
RUN apk add --no-cache nginx

# Copy the built frontend
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy the API handlers and their dependencies
COPY --from=builder /app/api ./api
COPY --from=builder /app/server ./server
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Copy the local API sidecar (repurposed from Tauri desktop sidecar)
COPY --from=builder /app/src-tauri/sidecar/local-api-server.mjs ./sidecar/local-api-server.mjs

# Copy nginx config
COPY docker/nginx.conf /etc/nginx/http.d/default.conf

# Copy the entrypoint script
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Runtime secrets — pass these via `docker run -e` or a .env file.
# The dashboard works without most keys; missing panels simply won't appear.
# See .env.example in the repo for full descriptions and registration links.
ENV NODE_ENV=production
# Port the Node.js API sidecar listens on (must match nginx proxy_pass upstream)
ENV LOCAL_API_PORT=3001

# Runtime API keys (all optional — dashboard degrades gracefully)
# See .env.example for full descriptions and registration links.
ENV GROQ_API_KEY=""
ENV OPENROUTER_API_KEY=""
ENV UPSTASH_REDIS_REST_URL=""
ENV UPSTASH_REDIS_REST_TOKEN=""
ENV FINNHUB_API_KEY=""
ENV EIA_API_KEY=""
ENV FRED_API_KEY=""
ENV WINGBITS_API_KEY=""
ENV ACLED_ACCESS_TOKEN=""
ENV CLOUDFLARE_API_TOKEN=""
ENV NASA_FIRMS_API_KEY=""
ENV AISSTREAM_API_KEY=""
ENV OPENSKY_CLIENT_ID=""
ENV OPENSKY_CLIENT_SECRET=""
ENV WS_RELAY_URL=""
ENV RELAY_SHARED_SECRET=""

# Expose ports:
#   80          — nginx (frontend + /api proxy)
#   3001        — Node.js API sidecar (internal; proxied by nginx)
EXPOSE 80 3001

ENTRYPOINT ["/entrypoint.sh"]
