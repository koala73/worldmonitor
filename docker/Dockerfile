# syntax=docker/dockerfile:1.7

# Multi-stage build for the World Monitor web app (frontend only).

# Stage 1: Build the frontend with TypeScript + Vite.
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS builder

WORKDIR /app

# Copy source and build.
COPY . .

# Install all dependencies (including devDependencies for tsc, vite, etc.).
# --ignore-scripts matches the sidecar image's proven install: it skips
# node-gyp postinstalls (bufferutil/utf-8-validate have no prebuilt binary for
# every buildx platform and the image carries no compiler toolchain) — those
# are optional ws accelerators the frontend build never loads.
RUN npm ci --include=dev --ignore-scripts

# Build-time configuration. Pass via --build-arg. Other VITE_* vars (e.g. VITE_PMTILES_URL)
# can be added here or via --build-arg for custom builds; see .env.example for the full list.
ARG VITE_VARIANT=full
ARG VITE_WS_API_URL=https://api.worldmonitor.app

ENV VITE_VARIANT=${VITE_VARIANT}
ENV VITE_WS_API_URL=${VITE_WS_API_URL}

# Build the crawlable static corpus, then tsc + vite build directly like the
# sidecar image's builder. `npm run build` would chain build:blog
# (blog-site has its own lockfile, not installed here) and the prebuild
# openapi/agent-skills generators.
RUN npm run build:crawlable-corpus && npm run build:content-corpus && npx tsc && npx vite build


# Stage 2: Serve the built assets from nginx.
FROM nginx:alpine@sha256:54f2a904c251d5a34adf545a72d32515a15e08418dae0266e23be2e18c66fefa AS runtime

WORKDIR /usr/share/nginx/html

ENV API_UPSTREAM=https://api.worldmonitor.app

# Copy built assets, nginx template (API_UPSTREAM substituted at startup), and entrypoint.
COPY --from=builder /app/dist/ ./
COPY docker/nginx.conf.template /etc/nginx/nginx.conf.template
COPY docker/nginx-security-headers.conf /etc/nginx/security_headers.conf
COPY docker/nginx-embed-security-headers.conf /etc/nginx/embed_security_headers.conf
COPY docker/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 80

CMD ["/docker-entrypoint.sh"]

