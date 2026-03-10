# syntax=docker/dockerfile:1.7

# Multi-stage build for the World Monitor web app (frontend only).

# Stage 1: Build the frontend with TypeScript + Vite.
FROM node:20-alpine AS builder

WORKDIR /app

# Install all dependencies (including devDependencies for tsc, vite, etc.).
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# Copy source and build.
COPY . .

# Build-time configuration. Pass via --build-arg. Other VITE_* vars (e.g. VITE_PMTILES_URL)
# can be added here or via --build-arg for custom builds; see .env.example for the full list.
ARG VITE_VARIANT=full
ARG VITE_WS_API_URL=https://api.worldmonitor.app

ENV VITE_VARIANT=${VITE_VARIANT}
ENV VITE_WS_API_URL=${VITE_WS_API_URL}

# tsc + vite build (see package.json "build" script)
RUN npm run build


# Stage 2: Serve the built assets from nginx.
FROM nginx:alpine AS runtime

WORKDIR /usr/share/nginx/html

ENV API_UPSTREAM=https://api.worldmonitor.app

# Copy built assets, nginx template (API_UPSTREAM substituted at startup), and entrypoint.
COPY --from=builder /app/dist/ ./
COPY docker/nginx.conf.template /etc/nginx/nginx.conf.template
COPY docker/nginx-security-headers.conf /etc/nginx/security_headers.conf
COPY docker/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 80

CMD ["/docker-entrypoint.sh"]


