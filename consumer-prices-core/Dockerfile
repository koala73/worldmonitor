FROM node:20-slim AS base
WORKDIR /app

# Install Playwright dependencies
RUN apt-get update && apt-get install -y \
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
