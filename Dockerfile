# =============================================================
# World Monitor — Full-Stack K8s Image
# nginx (static SPA) + Node.js sidecar (60+ API handlers)
# =============================================================

# ── Stage 1: Build ───────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .

# Compile the sebuf RPC gateway → self-contained ESM bundle
# so the sidecar can load all 17 typed service handlers
RUN node scripts/build-sidecar-sebuf.mjs

# Build the static frontend (SPA)
ENV VITE_VARIANT=full
RUN npx tsc || true
RUN npx vite build


# ── Stage 2: Runtime ─────────────────────────────────────────
FROM node:22-alpine

RUN apk add --no-cache nginx

WORKDIR /app

# ── Static frontend ──
COPY --from=builder /app/dist /usr/share/nginx/html

# ── API layer (sidecar) ──
# Legacy Vercel edge functions (rss-proxy, eia, youtube, etc.)
COPY --from=builder /app/api ./api
# Sebuf server handlers + router + CORS + error-mapper
COPY --from=builder /app/server ./server
# Generated TypeScript server stubs (sebuf protoc output)
COPY --from=builder /app/src/generated ./src/generated
# Desktop sidecar entry → runs all 60+ handlers as a Node.js HTTP server
COPY --from=builder /app/src-tauri/sidecar/local-api-server.mjs ./sidecar/local-api-server.mjs
# Node modules for handler dependencies
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# AIS relay (live vessel tracking via AISStream WebSocket)
COPY --from=builder /app/scripts/ais-relay.cjs ./scripts/ais-relay.cjs

# ── nginx config ──
COPY nginx.conf /etc/nginx/http.d/worldmonitor.conf
RUN rm -f /etc/nginx/http.d/default.conf

# ── Entrypoint ──
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8080

CMD ["/entrypoint.sh"]
