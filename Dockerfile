# World Monitor — self-hosted Docker image
# Serves the built SPA + local API (45+ handlers). Optional API keys via env.
# See README "Self-hosting with Docker" and .env.example.

FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .
ENV VITE_VARIANT=full
RUN npm run build:full

# Runner stage: same Node, no devDependencies
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY api ./api
COPY src-tauri/sidecar ./src-tauri/sidecar
COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
ENV LOCAL_API_MODE=standalone
ENV LOCAL_API_PORT=3000
ENV LOCAL_API_CLOUD_FALLBACK=true

EXPOSE 3000

CMD ["node", "src-tauri/sidecar/local-api-server.mjs"]
