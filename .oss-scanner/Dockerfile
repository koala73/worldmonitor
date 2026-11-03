# =============================================================================
# World Monitor — build image for Anthropic's OSS Scanner
# =============================================================================
# The scanner builds this with the repository root as the context, then scans
# the result with no Internet access. Everything a reproducer needs (npm trees,
# compiled API handlers, the built frontend, Rust crates) is fetched and built
# here. .oss-scanner/Dockerfile.dockerignore replaces the root .dockerignore
# for this build so tests/, e2e/ and docs stay in /src.
#
# Local check:  docker build -f .oss-scanner/Dockerfile -t wm-oss-scanner .
# Layout:       see .oss-scanner/threat_model.md ("How to exercise it").
# =============================================================================

# Base images are pinned to multi-arch index digests, as
# tests/ci-workflow-coverage.test.mts requires.
# rust:1-bookworm (Rust 1.99.1) supplies the toolchain, so no installer script
# is fetched and run unverified.
FROM rust:1-bookworm@sha256:e12566d5abc17a0da741628782cdb504b68b8961f5bfcf677936bf3e8b32de29 AS rust

# node:24-bookworm
FROM node:24-bookworm@sha256:7b559cf7f77d837192392499a850abb1a3d1f49fbc2bd0692d54b212c9e38f6d

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_OPTIONS=--max-old-space-size=8192 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    CARGO_HOME=/usr/local/cargo \
    RUSTUP_HOME=/usr/local/rustup \
    PATH=/usr/local/cargo/bin:$PATH

# Tauri's Linux build dependencies (same set as .github/workflows/build-desktop.yml)
# so `cargo check` can compile the desktop shell in src-tauri/.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git python3 build-essential pkg-config \
      libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev libssl-dev \
      libsoup-3.0-dev libjavascriptcoregtk-4.1-dev libdbus-1-dev \
    && rm -rf /var/lib/apt/lists/*

COPY --from=rust /usr/local/cargo /usr/local/cargo
COPY --from=rust /usr/local/rustup /usr/local/rustup
RUN rustc --version && cargo --version

COPY . /src
WORKDIR /src

# Root workspace: web app, Vercel edge handlers (api/), server/, convex/, tests.
# postinstall regenerates the untracked inventory modules.
RUN npm ci

# Separate lockfiles for services that ship from this repo:
#   scripts/              Railway relay + seeders
#   consumer-prices-core/ consumer-prices API service
#   pro-test/             /pro marketing pages (needed by build:pro)
RUN npm ci --prefix scripts \
    && npm ci --prefix consumer-prices-core \
    && npm ci --prefix pro-test

# Typecheck and build the frontend into dist/, as the root Dockerfile does.
RUN npm run build:pro && npx tsc && npx vite build

# The local API server (src-tauri/sidecar/local-api-server.mjs) loads esbuild
# bundles of the handlers. The script bundles them in a copy at
# /opt/worldmonitor-runtime so /src keeps the real source.
RUN sh .oss-scanner/build-runtime.sh

# Desktop shell. Fetch every crate so the offline scan can read and rebuild
# them; a failing check warns instead of aborting the image.
RUN mkdir -p src-tauri/sidecar/node \
    && cargo fetch --locked --manifest-path src-tauri/Cargo.toml \
    && (cargo check --locked --manifest-path src-tauri/Cargo.toml \
        || echo "WARNING: cargo check failed")

# Cheap smoke tests so a broken image is visible in the build log. Failures
# warn instead of aborting the build.
RUN npm run test:sidecar || echo "WARNING: test:sidecar reported failures"
