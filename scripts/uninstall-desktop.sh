#!/usr/bin/env bash
set -euo pipefail

# Uninstalls the World Monitor desktop app on macOS and Linux.
#
# One binary ships for every variant (variants are switched in-app), so there
# is one product, one bundle identifier and one keychain service to clean up:
#   - the app bundle (macOS) or the AppImage and its launcher entry (Linux)
#   - app data, caches, WebView storage and logs (unless --keep-data)
#   - the OS keychain entries, service "world-monitor" (unless --keep-secrets)
#
# The script lists everything it found and asks before removing anything.
# Run it from a repository checkout; the manual steps are in
# docs/desktop-app.mdx under "Uninstall". Windows: scripts/uninstall-desktop.ps1.
#
# WM_UNINSTALL_SKIP_PROCESS_STOP=1 skips stopping the running app, for
# automation and tests that only exercise the path cleanup.

usage() {
  cat <<'USAGE'
Usage: bash scripts/uninstall-desktop.sh [options]

Options:
  --keep-data      Keep app data, caches, WebView storage and logs
  --keep-secrets   Keep API keys and sign-in state stored in the OS keychain
  --dry-run        Show what would be removed without removing anything
  --yes            Skip the confirmation prompt
  -h, --help       Show this help
USAGE
}

# Mirrors src-tauri/tauri.conf.json and src-tauri/src/main.rs; the test in
# tests/desktop-uninstall-scripts.test.mjs fails when they drift.
PRODUCT="World Monitor"
BINARY="world-monitor"
IDENTIFIER="app.worldmonitor.desktop"
KEYRING_SERVICE="world-monitor"
# Keychain accounts: the consolidated vault, the sign-in client state, and the
# per-key entries an install from before the vault may still hold.
KEYRING_ACCOUNTS="secrets-vault clerk-client"
LEGACY_SECRET_KEYS="OPENROUTER_API_KEY EXA_API_KEYS BRAVE_API_KEYS SERPAPI_API_KEYS FRED_API_KEY EIA_API_KEY CLOUDFLARE_API_TOKEN ACLED_ACCESS_TOKEN URLHAUS_AUTH_KEY OTX_API_KEY ABUSEIPDB_API_KEY WINGBITS_API_KEY WS_RELAY_URL VITE_OPENSKY_RELAY_URL OPENSKY_CLIENT_ID OPENSKY_CLIENT_SECRET AISSTREAM_API_KEY VITE_WS_RELAY_URL FINNHUB_API_KEY ALPHA_VANTAGE_API_KEY NASA_FIRMS_API_KEY UCDP_ACCESS_TOKEN OLLAMA_API_URL OLLAMA_MODEL WORLDMONITOR_API_KEY WTO_API_KEY AVIATIONSTACK_API ICAO_API_KEY WM_DESKTOP_SHARED_SECRET"

KEEP_DATA=0
KEEP_SECRETS=0
DRY_RUN=0
ASSUME_YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --keep-data) KEEP_DATA=1; shift ;;
    --keep-secrets) KEEP_SECRETS=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

OS="$(uname -s)"
if [ "$OS" != "Darwin" ] && [ "$OS" != "Linux" ]; then
  echo "Unsupported OS: ${OS}. On Windows, run scripts/uninstall-desktop.ps1." >&2
  exit 1
fi

REMOVE_PATHS=()

add_path_if_exists() {
  if [ -e "$1" ]; then
    REMOVE_PATHS+=("$1")
  fi
}

collect_macos_paths() {
  add_path_if_exists "/Applications/${PRODUCT}.app"
  add_path_if_exists "${HOME}/Applications/${PRODUCT}.app"
  if [ "$KEEP_DATA" -eq 0 ]; then
    add_path_if_exists "${HOME}/Library/Application Support/${IDENTIFIER}"
    add_path_if_exists "${HOME}/Library/Caches/${IDENTIFIER}"
    add_path_if_exists "${HOME}/Library/WebKit/${IDENTIFIER}"
    add_path_if_exists "${HOME}/Library/HTTPStorages/${IDENTIFIER}"
    add_path_if_exists "${HOME}/Library/Logs/${IDENTIFIER}"
    add_path_if_exists "${HOME}/Library/Preferences/${IDENTIFIER}.plist"
    add_path_if_exists "${HOME}/Library/Saved Application State/${IDENTIFIER}.savedState"
  fi
}

collect_linux_paths() {
  # Tauri names the AppImage after the product ("World Monitor_2.11.2_amd64.AppImage");
  # launcher integrations sometimes rename it with dashes.
  local pattern_space pattern_dash dir
  pattern_space="${PRODUCT}*.AppImage"
  pattern_dash="${PRODUCT// /-}*.AppImage"
  for dir in "${HOME}/Applications" "${HOME}/Downloads" "${HOME}/.local/bin" "${HOME}/bin" "${HOME}/Desktop" "${HOME}/AppImages"; do
    [ -d "$dir" ] || continue
    while IFS= read -r appimage; do
      add_path_if_exists "$appimage"
    done < <(find "$dir" -maxdepth 1 \( -iname "$pattern_space" -o -iname "$pattern_dash" \) 2>/dev/null)
  done

  # Launcher entries created by AppImage integration tools: only those whose
  # Exec line runs this product, never an unrelated entry that mentions it.
  if [ -d "${HOME}/.local/share/applications" ]; then
    while IFS= read -r entry; do
      if grep -qiE "^Exec=.*(${BINARY}|${PRODUCT// /[ _-]})" "$entry" 2>/dev/null; then
        add_path_if_exists "$entry"
      fi
    done < <(find "${HOME}/.local/share/applications" -maxdepth 1 -name '*.desktop' 2>/dev/null)
  fi

  if [ "$KEEP_DATA" -eq 0 ]; then
    add_path_if_exists "${HOME}/.config/${IDENTIFIER}"
    add_path_if_exists "${HOME}/.local/share/${IDENTIFIER}"
    add_path_if_exists "${HOME}/.cache/${IDENTIFIER}"
  fi
}

stop_processes() {
  if [ "${WM_UNINSTALL_SKIP_PROCESS_STOP:-0}" = "1" ]; then
    return
  fi
  local pid ppid pcomm
  # The app spawns its sidecar Node runtime from the bundle. Stop sidecars
  # whose parent is the app binary, then the orphans that still run from the
  # bundle path (parent already gone), then the app itself. Every match is
  # scoped to this product so no other Node process on the machine is touched.
  for pid in $(pgrep -f "sidecar/node" 2>/dev/null || true); do
    ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
    [ -n "$ppid" ] || continue
    pcomm="$(ps -o comm= -p "$ppid" 2>/dev/null || true)"
    case "$pcomm" in
      *"$BINARY"*) kill "$pid" 2>/dev/null || true ;;
    esac
  done
  if [ "$OS" = "Darwin" ]; then
    pkill -f "${PRODUCT}\.app/Contents/Resources/sidecar/node" 2>/dev/null || true
  else
    # AppImages run from a FUSE mount named after the file: /tmp/.mount_World…
    pkill -f "\.mount_${PRODUCT%% *}.*sidecar/node" 2>/dev/null || true
  fi
  pkill -x "$BINARY" 2>/dev/null || true
}

keychain_entries_exist() {
  if [ "$OS" = "Darwin" ]; then
    security find-generic-password -s "$KEYRING_SERVICE" >/dev/null 2>&1
  else
    command -v secret-tool >/dev/null 2>&1 \
      && [ -n "$(secret-tool search service "$KEYRING_SERVICE" 2>/dev/null)" ]
  fi
}

remove_keychain_entries() {
  local account
  if [ "$OS" = "Darwin" ]; then
    for account in $KEYRING_ACCOUNTS $LEGACY_SECRET_KEYS; do
      security delete-generic-password -s "$KEYRING_SERVICE" -a "$account" >/dev/null 2>&1 || true
    done
    echo "Removed keychain entries (service: ${KEYRING_SERVICE})."
  elif command -v secret-tool >/dev/null 2>&1; then
    for account in $KEYRING_ACCOUNTS $LEGACY_SECRET_KEYS; do
      secret-tool clear service "$KEYRING_SERVICE" username "$account" 2>/dev/null || true
    done
    echo "Removed keyring entries (service: ${KEYRING_SERVICE})."
  else
    echo "secret-tool not found; remove the '${KEYRING_SERVICE}' entries with your keyring manager (for example GNOME Seahorse)."
  fi
}

if [ "$OS" = "Darwin" ]; then
  collect_macos_paths
else
  collect_linux_paths
fi

REMOVE_SECRETS=0
if [ "$KEEP_SECRETS" -eq 0 ] && keychain_entries_exist; then
  REMOVE_SECRETS=1
fi

if [ "${#REMOVE_PATHS[@]}" -eq 0 ] && [ "$REMOVE_SECRETS" -eq 0 ]; then
  echo "Nothing to uninstall: no ${PRODUCT} desktop installation found."
  exit 0
fi

echo "The following will be removed:"
# ${arr[@]+...} guards empty-array expansion under `set -u` on bash 3.2 (macOS default)
for p in ${REMOVE_PATHS[@]+"${REMOVE_PATHS[@]}"}; do
  echo "  ${p}"
done
if [ "$REMOVE_SECRETS" -eq 1 ]; then
  echo "  OS keychain entries (service: ${KEYRING_SERVICE})"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "Dry run: nothing was removed."
  exit 0
fi

if [ "$ASSUME_YES" -eq 0 ]; then
  printf "Proceed? [y/N] "
  read -r answer
  case "$answer" in
    y|Y|yes|YES) ;;
    *)
      echo "Aborted."
      exit 1
      ;;
  esac
fi

stop_processes

for p in ${REMOVE_PATHS[@]+"${REMOVE_PATHS[@]}"}; do
  rm -rf "$p"
  echo "Removed ${p}"
done

if [ "$REMOVE_SECRETS" -eq 1 ]; then
  remove_keychain_entries
fi

echo "Done. ${PRODUCT} desktop has been uninstalled."
