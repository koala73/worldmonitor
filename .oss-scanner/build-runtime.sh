#!/bin/sh
# Rebuild /opt/worldmonitor-runtime from /src.
#
# docker/build-handlers.mjs writes self-contained bundles over the tracked
# api/*.js files, so it runs on this copy and /src keeps the real source.
# A bundle inlines the helpers it imports, so after patching anything in /src
# rerun this script: it recreates the copy from source instead of rebundling
# old bundles.
set -eu

RUNTIME=/opt/worldmonitor-runtime

# Leave the copy before deleting it; node cannot start in a removed directory.
cd /

rm -rf "$RUNTIME"
mkdir -p "$RUNTIME"
tar -C /src --exclude=./.git --exclude='*/node_modules' --exclude=./node_modules \
    --exclude=./tests --exclude=./e2e --exclude=./docs --exclude=./dist \
    --exclude=./blog-site --exclude=./demos --exclude=./src-tauri/target -cf - . \
  | tar -C "$RUNTIME" -xf -
ln -s /src/node_modules "$RUNTIME/node_modules"
node "$RUNTIME/docker/build-handlers.mjs"
