#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <AppImage path> <x86_64|aarch64>" >&2
  exit 2
fi

APPIMAGE=$(realpath "$1")
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TOOL_ARCH=$2
APPIMAGETOOL_VERSION=1.9.1
APPIMAGETOOL_SHA256_X86_64=ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0
APPIMAGETOOL_SHA256_AARCH64=f0837e7448a0c1e4e650a93bb3e85802546e60654ef287576f46c71c126a9158

case "$TOOL_ARCH" in
  x86_64)
    EXPECTED_SHA=$APPIMAGETOOL_SHA256_X86_64
    ASSET_ARCH=amd64
    ;;
  aarch64)
    EXPECTED_SHA=$APPIMAGETOOL_SHA256_AARCH64
    ASSET_ARCH=aarch64
    ;;
  *)
    echo "::error::Unsupported appimagetool architecture: $TOOL_ARCH"
    exit 2
    ;;
esac

if [ ! -f "$APPIMAGE" ]; then
  echo "::error::AppImage not found: $APPIMAGE"
  exit 1
fi

WORK_DIR=$(mktemp -d "${RUNNER_TEMP:-/tmp}/worldmonitor-appimage-repack.XXXXXX")
cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

chmod +x "$APPIMAGE"
cd "$WORK_DIR"

echo "Stripping bundled GPU/Wayland libraries from: $APPIMAGE"
"$APPIMAGE" --appimage-extract

GPU_LIBS=(
  'libEGL.so*'
  'libEGL_mesa.so*'
  'libGLX.so*'
  'libGLX_mesa.so*'
  'libGLdispatch.so*'
  'libGLESv2.so*'
  'libGL.so*'
  'libOpenGL.so*'
  'libglapi.so*'
  'libgbm.so*'
  'libwayland-client.so*'
  'libwayland-server.so*'
  'libwayland-cursor.so*'
  'libwayland-egl.so*'
)

REMOVED=0
for pattern in "${GPU_LIBS[@]}"; do
  while IFS= read -r -d '' file; do
    rm -f "$file"
    echo "  Removed: ${file#squashfs-root/}"
    ((REMOVED++)) || true
  done < <(find squashfs-root -name "$pattern" -print0)
done
while IFS= read -r -d '' file; do
  rm -f "$file"
  echo "  Removed DRI: ${file#squashfs-root/}"
  ((REMOVED++)) || true
done < <(find squashfs-root -path '*/dri/*_dri.so' -print0)

echo "Stripped $REMOVED GPU/Wayland library files"
if [ "$REMOVED" -eq 0 ]; then
  echo "::error::No GPU libraries found to strip — build may have changed"
  exit 1
fi

TOOL_URL="https://github.com/AppImage/appimagetool/releases/download/${APPIMAGETOOL_VERSION}/appimagetool-${TOOL_ARCH}.AppImage"
TOOL_PATH="$WORK_DIR/appimagetool"
bash "$SCRIPT_DIR/fetch-with-retry.sh" "$TOOL_URL" "$TOOL_PATH"
ACTUAL_SHA=$(sha256sum "$TOOL_PATH" | awk '{print $1}')
if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
  echo "::error::appimagetool SHA256 mismatch! Expected: $EXPECTED_SHA Got: $ACTUAL_SHA"
  exit 1
fi
echo "appimagetool SHA256 verified: $ACTUAL_SHA"
chmod +x "$TOOL_PATH"

# Update information (#5757) lets AppImageUpdate, AppImageLauncher and similar
# tools find the newest release and fetch only the changed blocks. It points at
# the .zsync asset of the latest release. appimagetool writes that file to the
# current directory as "<output basename>.zsync", not next to the output.
#
# GitHub stores "World Monitor_…" as "World.Monitor_…", and the .zsync file
# records the AppImage's file name as its download URL. Build under the stored
# name, so that URL resolves to the asset next to the .zsync file.
REPO=${GITHUB_REPOSITORY:-koala73/worldmonitor}
ASSET_NAME=$(basename "$APPIMAGE" | tr ' ' '.')
UPDATE_INFO="gh-releases-zsync|${REPO%%/*}|${REPO#*/}|latest|World.Monitor_*_${ASSET_ARCH}.AppImage.zsync"
ARCH=$TOOL_ARCH "$TOOL_PATH" --appimage-extract-and-run -u "$UPDATE_INFO" squashfs-root "$ASSET_NAME"
if [ ! -s "$ASSET_NAME.zsync" ]; then
  echo "::error::appimagetool did not write $ASSET_NAME.zsync"
  exit 1
fi
mv -f "$ASSET_NAME" "$APPIMAGE"
ZSYNC="$(dirname "$APPIMAGE")/$ASSET_NAME.zsync"
mv -f "$ASSET_NAME.zsync" "$ZSYNC"
echo "Embedded update information: $UPDATE_INFO"
echo "Wrote $ZSYNC"

rm -rf squashfs-root
"$APPIMAGE" --appimage-extract
BANNED=""
for pattern in "${GPU_LIBS[@]}"; do
  found=$(find squashfs-root -name "$pattern" -print)
  if [ -n "$found" ]; then
    BANNED+="$found"$'\n'
  fi
done
found=$(find squashfs-root -path '*/dri/*_dri.so' -print)
if [ -n "$found" ]; then
  BANNED+="$found"$'\n'
fi
if [ -n "$BANNED" ]; then
  echo "::error::Banned GPU libraries remain after repack:"
  echo "$BANNED"
  exit 1
fi

EMBEDDED=$("$APPIMAGE" --appimage-updateinformation)
if [ "$EMBEDDED" != "$UPDATE_INFO" ]; then
  echo "::error::Embedded update information is '$EMBEDDED', expected '$UPDATE_INFO'"
  exit 1
fi
ZSYNC_URL=$(sed -n 's/^URL: //p' "$ZSYNC" | head -1)
if [ "$ZSYNC_URL" != "$ASSET_NAME" ]; then
  echo "::error::$ZSYNC points at '$ZSYNC_URL', expected the release asset '$ASSET_NAME'"
  exit 1
fi

echo "Post-repack verification passed — no banned GPU libraries"
