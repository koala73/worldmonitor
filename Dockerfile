# Multi-stage build for World Monitor (Vite SPA)
FROM public.ecr.aws/docker/library/node:20-alpine AS builder

RUN apk add --no-cache libc6-compat
WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm install --platform=linux --arch=x64 --force

# Copy source and build
COPY . .

# Build the full variant by default
ARG VITE_VARIANT=full
ENV VITE_VARIANT=$VITE_VARIANT

RUN npm run build

# Production — serve static files with nginx + API proxy
FROM nginx:1.27-alpine AS runner

# Remove default nginx config
RUN rm /etc/nginx/conf.d/default.conf

# Use nginx templates directory for envsubst support.
# The official nginx Docker image automatically runs envsubst on
# /etc/nginx/templates/*.template files at startup, writing results
# to /etc/nginx/conf.d/. This lets us inject API_UPSTREAM at runtime.
COPY nginx.conf /etc/nginx/templates/worldmonitor.conf.template
COPY --from=builder /app/dist /usr/share/nginx/html

# Default API upstream — K8s sidecar (same pod, localhost)
# Override with API_UPSTREAM=worldmonitor-api:8787 for docker-compose
ENV API_UPSTREAM=127.0.0.1:8787

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
