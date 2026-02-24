#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEST_DIR="${ROOT_DIR}/src-tauri/sidecar/node"
NODE_VERSION="${NODE_VERSION:-22.14.0}"

usage() {
  cat <<'EOF'
Usage: bash scripts/download-node.sh [--target <triple>]

Supported targets:
  - x86_64-pc-windows-msvc
  - x86_64-apple-darwin
  - aarch64-apple-darwin
  - x86_64-unknown-linux-gnu

Environment:
  NODE_VERSION   Node.js version to bundle (default: 22.14.0)
  NODE_TARGET    Optional target triple (same as --target)
  RUNNER_OS      Optional GitHub Actions OS hint
  RUNNER_ARCH    Optional GitHub Actions arch hint
EOF
}

TARGET=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --target" >&2
        exit 1
      fi
      TARGET="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "${TARGET}" ]]; then
  TARGET="${NODE_TARGET:-}"
fi

if [[ -z "${TARGET}" ]]; then
  if [[ -n "${RUNNER_OS:-}" ]]; then
    case "${RUNNER_OS}" in
      Windows)
        TARGET="x86_64-pc-windows-msvc"
        ;;
      macOS)
        case "${RUNNER_ARCH:-}" in
          ARM64|arm64)
            TARGET="aarch64-apple-darwin"
            ;;
          X64|x64)
            TARGET="x86_64-apple-darwin"
            ;;
          *)
            echo "Unsupported RUNNER_ARCH for macOS: ${RUNNER_ARCH:-unknown}" >&2
            exit 1
            ;;
        esac
        ;;
      Linux)
        TARGET="x86_64-unknown-linux-gnu"
        ;;
      *)
        echo "Unsupported RUNNER_OS: ${RUNNER_OS}" >&2
        exit 1
        ;;
    esac
  else
    case "$(uname -s)" in
      Darwin)
        case "$(uname -m)" in
          arm64|aarch64)
            TARGET="aarch64-apple-darwin"
            ;;
          x86_64)
            TARGET="x86_64-apple-darwin"
            ;;
          *)
            echo "Unsupported macOS arch: $(uname -m)" >&2
            exit 1
            ;;
        esac
        ;;
      Linux)
        TARGET="x86_64-unknown-linux-gnu"
        ;;
      MINGW*|MSYS*|CYGWIN*|Windows_NT)
        TARGET="x86_64-pc-windows-msvc"
        ;;
      *)
        echo "Unsupported host OS for auto-detection: $(uname -s)" >&2
        echo "Pass --target explicitly." >&2
        exit 1
        ;;
    esac
  fi
fi

case "${TARGET}" in
  x86_64-pc-windows-msvc)
    DIST_NAME="node-v${NODE_VERSION}-win-x64"
    ARCHIVE_NAME="${DIST_NAME}.zip"
    NODE_RELATIVE_PATH="node.exe"
    OUTPUT_NAME="node.exe"
    ;;
  x86_64-apple-darwin)
    DIST_NAME="node-v${NODE_VERSION}-darwin-x64"
    ARCHIVE_NAME="${DIST_NAME}.tar.gz"
    NODE_RELATIVE_PATH="bin/node"
    OUTPUT_NAME="node"
    ;;
  aarch64-apple-darwin)
    DIST_NAME="node-v${NODE_VERSION}-darwin-arm64"
    ARCHIVE_NAME="${DIST_NAME}.tar.gz"
    NODE_RELATIVE_PATH="bin/node"
    OUTPUT_NAME="node"
    ;;
  x86_64-unknown-linux-gnu)
    DIST_NAME="node-v${NODE_VERSION}-linux-x64"
    ARCHIVE_NAME="${DIST_NAME}.tar.gz"
    NODE_RELATIVE_PATH="bin/node"
    OUTPUT_NAME="node"
    ;;
  *)
    echo "Unsupported target: ${TARGET}" >&2
    exit 1
    ;;
esac

BASE_URL="https://nodejs.org/dist/v${NODE_VERSION}"
ARCHIVE_URL="${BASE_URL}/${ARCHIVE_NAME}"
SHASUMS_URL="${BASE_URL}/SHASUMS256.txt"

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

echo "[download-node] Downloading ${ARCHIVE_NAME}"
curl -fsSL "${ARCHIVE_URL}" -o "${TMP_DIR}/${ARCHIVE_NAME}"
curl -fsSL "${SHASUMS_URL}" -o "${TMP_DIR}/SHASUMS256.txt"

EXPECTED_SHA="$(awk -v file="${ARCHIVE_NAME}" '$2 == file { print $1 }' "${TMP_DIR}/SHASUMS256.txt")"
if [[ -z "${EXPECTED_SHA}" ]]; then
  echo "Failed to find checksum for ${ARCHIVE_NAME} in SHASUMS256.txt" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_SHA="$(sha256sum "${TMP_DIR}/${ARCHIVE_NAME}" | awk '{ print $1 }')"
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL_SHA="$(shasum -a 256 "${TMP_DIR}/${ARCHIVE_NAME}" | awk '{ print $1 }')"
else
  echo "Neither sha256sum nor shasum is available for checksum verification." >&2
  exit 1
fi

if [[ "${EXPECTED_SHA}" != "${ACTUAL_SHA}" ]]; then
  echo "Checksum mismatch for ${ARCHIVE_NAME}" >&2
  echo "Expected: ${EXPECTED_SHA}" >&2
  echo "Actual:   ${ACTUAL_SHA}" >&2
  exit 1
fi

mkdir -p "${TMP_DIR}/extract"
if [[ "${ARCHIVE_NAME}" == *.zip ]]; then
  if command -v unzip >/dev/null 2>&1; then
    unzip -q "${TMP_DIR}/${ARCHIVE_NAME}" -d "${TMP_DIR}/extract"
  else
    tar -xf "${TMP_DIR}/${ARCHIVE_NAME}" -C "${TMP_DIR}/extract"
  fi
else
  tar -xzf "${TMP_DIR}/${ARCHIVE_NAME}" -C "${TMP_DIR}/extract"
fi

SOURCE_NODE="${TMP_DIR}/extract/${DIST_NAME}/${NODE_RELATIVE_PATH}"
SOURCE_LICENSE="${TMP_DIR}/extract/${DIST_NAME}/LICENSE"

if [[ ! -f "${SOURCE_NODE}" ]]; then
  echo "Node binary not found after extraction: ${SOURCE_NODE}" >&2
  exit 1
fi

mkdir -p "${DEST_DIR}"
cp "${SOURCE_NODE}" "${DEST_DIR}/${OUTPUT_NAME}"
if [[ -f "${SOURCE_LICENSE}" ]]; then
  cp "${SOURCE_LICENSE}" "${DEST_DIR}/LICENSE"
fi
if [[ "${OUTPUT_NAME}" != "node.exe" ]]; then
  chmod +x "${DEST_DIR}/${OUTPUT_NAME}"
fi

echo "[download-node] Bundled Node.js v${NODE_VERSION} for ${TARGET} at ${DEST_DIR}/${OUTPUT_NAME}"
