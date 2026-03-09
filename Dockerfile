## syntax=docker/dockerfile:1.7

# Multi-stage build for the World Monitor web app.
# Stage 1: Build the frontend (full variant) with Vite.
FROM node:22-alpine AS builder

WORKDIR /app

ENV NODE_ENV=production

# Install dependencies (including dev deps needed for the build).
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build the full variant.
COPY . .

# Build arguments allow overriding defaults at build time.
ARG VITE_VARIANT=full
ARG VITE_WS_API_URL=https://api.worldmonitor.app

ENV VITE_VARIANT=${VITE_VARIANT}
ENV VITE_WS_API_URL=${VITE_WS_API_URL}

RUN npm run build:full


# Stage 2: Serve the built assets from a minimal Node image.
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Use a small static file server for the built assets.
RUN npm install -g serve@14

COPY --from=builder /app/dist ./dist

# Default Vite preview port; can be overridden at runtime.
ENV PORT=4173
EXPOSE 4173

CMD ["sh", "-c", "serve -s dist -l ${PORT}"]

