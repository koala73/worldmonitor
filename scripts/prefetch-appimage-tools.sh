#!/usr/bin/env bash
# Fill the Tauri bundler's AppImage tool directory before `tauri build`.
#
# usage: prefetch-appimage-tools.sh <x86_64|aarch64>
#
# The bundler downloads these tools once per runner, with no retry, and fails
# the whole build on any error (prepare_tools in
# crates/tauri-bundler/src/bundle/linux/appimage/linuxdeploy.rs, tauri-cli
# v2.10.1). It skips every file that already exists, so fetching them here with
# retries, into the directory CI also caches, keeps a GitHub download outage
# from failing the build. A tool this script cannot fetch is left for the
# bundler to download itself, so prefetching is never worse than not
# prefetching: an outage past the retry budget, or an old asset removed after a
# CLI upgrade renamed it, does not fail the build here. Keep the file names and
# URLs in step with that function when @tauri-apps/cli is upgraded, or the
# drifted tool goes back to being downloaded without retry.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <x86_64|aarch64>" >&2
  exit 2
fi

ARCH=$1
case "$ARCH" in
  x86_64|aarch64) ;;
  *)
    echo "::error::Unsupported AppImage tool architecture: $ARCH" >&2
    exit 2
    ;;
esac

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# dirs::cache_dir() on Linux: $XDG_CACHE_HOME, else ~/.cache.
TOOLS_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/tauri"
mkdir -p "$TOOLS_DIR"

fetch() {
  local name=$1 url=$2
  if [ -s "$TOOLS_DIR/$name" ]; then
    echo "cached: $name"
  else
    if ! bash "$SCRIPT_DIR/fetch-with-retry.sh" "$url" "$TOOLS_DIR/$name"; then
      # The bundler only checks that the file exists: an empty one left by an
      # interrupted write would be bundled instead of downloaded.
      rm -f "$TOOLS_DIR/$name"
      echo "::warning::$name not prefetched; the bundler will download it itself" >&2
      return 0
    fi
    echo "fetched: $name"
  fi
  chmod +x "$TOOLS_DIR/$name"
}

fetch "AppRun-$ARCH" \
  "https://github.com/tauri-apps/binary-releases/releases/download/apprun-old/AppRun-$ARCH"
fetch "linuxdeploy-$ARCH.AppImage" \
  "https://github.com/tauri-apps/binary-releases/releases/download/linuxdeploy/linuxdeploy-$ARCH.AppImage"
fetch "linuxdeploy-plugin-gtk.sh" \
  "https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gtk/master/linuxdeploy-plugin-gtk.sh"
fetch "linuxdeploy-plugin-gstreamer.sh" \
  "https://raw.githubusercontent.com/tauri-apps/linuxdeploy-plugin-gstreamer/master/linuxdeploy-plugin-gstreamer.sh"
# Optional in the bundler: without it linuxdeploy uses its built-in version.
fetch "linuxdeploy-plugin-appimage.AppImage" \
  "https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/continuous/linuxdeploy-plugin-appimage-$ARCH.AppImage"
