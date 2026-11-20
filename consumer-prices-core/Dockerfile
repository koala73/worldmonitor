FROM node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS base
WORKDIR /app

# Upgrade packages the base image already ships. A later apt-get install does not
# refresh those, so libgnutls30 stays on the tag's version until this upgrade.
# || true keeps a mirror outage from failing the build (2026-04-17 noble-security
# hash-sum mismatch). The post-deploy Snyk scan flags a libgnutls30 this step
# did not move.
RUN (for i in 1 2 3; do apt-get update && break || sleep 5; done) \
    && (apt-get upgrade -y --no-install-recommends || true) \
    && rm -rf /var/lib/apt/lists/*

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
