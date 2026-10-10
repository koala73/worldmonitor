# Hosted Verification Desk: open its URL on any computer and log in.
# Build from the repository root (the desk imports WorldMonitor's own modules):
#   docker build -f demos/verification-desk/Dockerfile -t verification-desk .
# On Railway, set RAILWAY_DOCKERFILE_PATH=demos/verification-desk/Dockerfile.
# Keys and DESK_PASSWORD come from the host's environment, never the image.
FROM node:24-slim

WORKDIR /app
# Only what the desk imports: WorldMonitor's grading modules and the desk itself.
COPY package.json ./
COPY shared ./shared
COPY server/_shared ./server/_shared
COPY scripts ./scripts
COPY src/locales/en.json ./src/locales/en.json
COPY demos/verification-desk ./demos/verification-desk

WORKDIR /app/demos/verification-desk
RUN rm -rf node_modules data public/vendor public/deck.html \
  && npm ci --no-audit --no-fund

ENV NODE_ENV=production \
    DESK_HOST=0.0.0.0
EXPOSE 4317
CMD ["node", "--import", "tsx", "server.mjs"]
