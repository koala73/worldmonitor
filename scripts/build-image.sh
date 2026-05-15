#!/usr/bin/env bash
# Build and push the hlidskjalf-monitor server image to the SNO internal registry.
#
# Builds one image and tags it with both `:latest` and `:<git-sha>`:
#   <registry>/hlidskjalf-monitor/hlidskjalf-mon  (server)   Dockerfile.bun-server
#
# The Telegram relay was dropped (2026-05-14 Hermes-architecture refactor).
#
# REGISTRY behavior:
#   - For push, this script uses the external Route URL of the SNO internal
#     registry by default: default-route-openshift-image-registry.apps.sno.greysson.com
#   - Pods pull from the in-cluster Service URL
#     (image-registry.openshift-image-registry.svc:5000/hlidskjalf-monitor/...)
#     which the OCP manifests already reference.
#   - Override REGISTRY env var to push elsewhere if needed.
#
# Authentication: log in to the registry with your oc token first, e.g.:
#   oc registry login --skip-check
#   (or) docker login -u $(oc whoami) -p $(oc whoami -t) \
#     default-route-openshift-image-registry.apps.sno.greysson.com
#
# Detects podman (preferred) or docker. Idempotent — re-running is safe.
#
# Usage:
#   scripts/build-image.sh             # build + push the server image
#   scripts/build-image.sh --no-push   # build only; don't push to registry
#   scripts/build-image.sh --help

set -euo pipefail

REGISTRY="${REGISTRY:-default-route-openshift-image-registry.apps.sno.greysson.com}"
NAMESPACE="${NAMESPACE:-hlidskjalf-monitor}"
SERVER_IMAGE="hlidskjalf-mon"
SERVER_DOCKERFILE="Dockerfile.bun-server"
# Target SNO is amd64; the local Mac (Apple Silicon, arm64) needs to
# cross-build. podman uses qemu-user-static under the hood for this.
PLATFORM="${PLATFORM:-linux/amd64}"

PUSH=1
for arg in "$@"; do
  case "$arg" in
    --no-push) PUSH=0 ;;
    -h|--help)
      sed -n '2,15p' "$0"
      exit 0
      ;;
    *)
      echo "unknown arg: $arg" >&2
      exit 2
      ;;
  esac
done

# Resolve repo root (this script lives in scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Pick container runtime
if command -v podman >/dev/null 2>&1; then
  RUNTIME="podman"
elif command -v docker >/dev/null 2>&1; then
  RUNTIME="docker"
else
  echo "error: neither podman nor docker found on PATH" >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "error: git not found on PATH" >&2
  exit 1
fi

SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo "[build-image] runtime=$RUNTIME sha=$SHA push=$PUSH"

build_and_tag() {
  local image="$1"
  local dockerfile="$2"

  if [[ ! -f "$dockerfile" ]]; then
    echo "[build-image] skip $image — $dockerfile missing"
    return
  fi

  local latest_ref="$REGISTRY/$NAMESPACE/$image:latest"
  local sha_ref="$REGISTRY/$NAMESPACE/$image:$SHA"

  echo "[build-image] building $image ($dockerfile) -> :latest, :$SHA (platform=$PLATFORM)"
  "$RUNTIME" build --platform "$PLATFORM" -f "$dockerfile" -t "$latest_ref" -t "$sha_ref" .

  if [[ "$PUSH" -eq 1 ]]; then
    echo "[build-image] pushing $latest_ref"
    "$RUNTIME" push "$latest_ref"
    echo "[build-image] pushing $sha_ref"
    "$RUNTIME" push "$sha_ref"
  else
    echo "[build-image] --no-push: skipping registry push for $image"
  fi
}

build_and_tag "$SERVER_IMAGE" "$SERVER_DOCKERFILE"

echo "[build-image] done"
