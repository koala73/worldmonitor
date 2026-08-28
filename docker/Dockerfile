# syntax=docker/dockerfile:1.7

# Multi-stage build for the World Monitor web app (frontend only).

# Stage 1: Build the frontend with TypeScript + Vite.
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS builder
ARG BUILDKIT_SBOM_SCAN_STAGE=true

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

# Generated inventory assets are intentionally untracked. Recreate them in the
# clean release image before Vite copies public/ into dist/.
RUN node scripts/generate-inventory-facts.mjs

# public/pro/ is a build product, not committed bytes (#6898), and
# docker/nginx.conf.template routes `location ^~ /pro` + `/pro/assets/` — so
# unlike /blog (deliberately skipped here) the image must build pro-test or it
# serves a 404 behind a live route. build:pro installs pro-test's own lockfile.
RUN npm run build:pro

# Build the crawlable static corpus, then tsc + vite build directly like the
# sidecar image's builder. `npm run build` would chain build:blog
# (blog-site has its own lockfile, not installed here) and the prebuild
# openapi/agent-skills generators.
RUN npm run build:crawlable-corpus && npm run build:sitemap && npx tsc && npx vite build
RUN test -s dist/product-facts.json
# Assert the /pro pages survived the public/ -> dist/ copy. build:pro succeeding
# proves public/pro/ exists; it does NOT prove Vite copied it, and nginx routes
# `location ^~ /pro` regardless (#6898). Without this an outDir/publicDir change
# ships a green image that 404s behind a live route.
RUN test -s dist/pro/index.html && test -s dist/pro/welcome.html


# Stage 2: Serve the built assets from nginx.
FROM nginx:alpine@sha256:db35bfc6b2951e7f8a72db5db120288c127ffaeeb4a6d4b95a26fead017d5913 AS runtime

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
