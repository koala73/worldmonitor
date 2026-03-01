# ─── World Monitor: OSINT-Ready Docker Build ─────────────────────
# Multi-stage build: installs deps, builds frontend, serves with
# nginx (static) + local-api-server.mjs (API edge functions).

# Stage 1: Install dependencies & build
FROM node:20-alpine AS builder
WORKDIR /app

# Disable telemetry for OPSEC
ENV NEXT_TELEMETRY_DISABLED=1

# Install ALL deps including devDependencies (tsc, vite needed for build)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source
COPY . .

# Build the Vite frontend
RUN npm run build

# Stage 2: Production runner with nginx + Node.js
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Install nginx and supervisor for process management
RUN apk add --no-cache nginx supervisor

# Copy built assets + api handlers + server
COPY --from=builder /app/dist /app/dist
COPY --from=builder /app/api /app/api
COPY --from=builder /app/server /app/server
COPY --from=builder /app/src/generated /app/src/generated
COPY --from=builder /app/src-tauri/sidecar/local-api-server.mjs /app/local-api-server.mjs
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/verbose-mode.json /app/verbose-mode.json

# Copy configs
COPY nginx.conf /etc/nginx/http.d/default.conf
COPY supervisord.conf /etc/supervisord.conf

# Create supervisor log directory
RUN mkdir -p /var/log/supervisor

# Single port: nginx serves static files + proxies /api/* to local-api-server
EXPOSE 3737

CMD ["supervisord", "-c", "/etc/supervisord.conf"]
