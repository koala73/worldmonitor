FROM node:24-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS base
WORKDIR /app

# Patch the base image's pre-installed OS packages before adding our own.
# `node:20-slim` ships system libraries (e.g. libgnutls30) that `apt-get install`
# never touches because they're already present, so they stay pinned to whatever
# the base tag shipped. An explicit `apt-get upgrade` pulls Debian's security
# point-releases (libgnutls30 -> 3.7.9-2+deb12u7), which clears the critical
# GnuTLS CVEs Snyk reports against this image.
#
# Every network step tolerates a hard mirror outage so a transient Railway build
# failure can't block deploys (2026-04-17: noble-security CDN hash-sum mismatch
# blocked all Railway builds). `apt-get update` is retried so the refresh is
# reliable before the security upgrade; the upgrade then carries the same `|| true`
# tolerance that `update` already had and `install` keeps via `--fix-missing`, so
# this step has no less download resilience than the original. The post-deploy
# Snyk scan is the backstop that flags a libgnutls30 left un-upgraded by an outage.
RUN (for i in 1 2 3; do apt-get update && break || sleep 5; done) \
    && (apt-get upgrade -y --no-install-recommends || true) \
    && apt-get install -y --fix-missing \
    chromium \
    fonts-liberation \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libgdk-pixbuf2.0-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libxrender1 \
    --no-install-recommends && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install all dependencies (including devDeps for tsc)
COPY package.json package-lock.json ./
RUN npm ci

# Build
COPY tsconfig.json ./
COPY src ./src
COPY configs ./configs
COPY migrations ./migrations
RUN npm run build

# Prune dev dependencies after build
RUN npm prune --omit=dev

# Runtime
ENV NODE_ENV=production
EXPOSE 3400
CMD ["node", "dist/api/server.js"]
