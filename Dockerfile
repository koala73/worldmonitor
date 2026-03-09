## syntax=docker/dockerfile:1.7

# Multi-stage build for the World Monitor web app (frontend only).

# Stage 1: Build the frontend with TypeScript + Vite.
FROM node:20-alpine AS builder

WORKDIR /app

ENV NODE_ENV=production

# Install dependencies (including dev deps needed for the build).
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build.
COPY . .

# Build-time configuration
ARG VITE_VARIANT=full
ARG VITE_WS_API_URL=https://api.worldmonitor.app

ENV VITE_VARIANT=${VITE_VARIANT}
ENV VITE_WS_API_URL=${VITE_WS_API_URL}

# tsc + vite build (see package.json "build" script)
RUN npm run build


# Stage 2: Serve the built assets from nginx.
FROM nginx:alpine AS runtime

WORKDIR /usr/share/nginx/html

# Allow API_UPSTREAM to be read from the environment.
ENV API_UPSTREAM=https://api.worldmonitor.app

# Copy built assets and nginx configuration.
COPY --from=builder /app/dist/ ./
COPY nginx.conf /etc/nginx/nginx.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]


