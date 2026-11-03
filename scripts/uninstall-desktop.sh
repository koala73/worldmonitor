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
LEGACY_SECRET_KEYS="OPENROUTER_API_KEY EXA_API_KEYS BRAVE_API_KEYS SERPAPI_API_KEYS FRED_API_KEY EIA_API_KEY CLOUDFLARE_API_TOKEN ACLED_ACCESS_TOKEN URLHAUS_AUTH_KEY OTX_API_KEY ABUSEIPDB_API_KEY WINGBITS_API_KEY WS_RELAY_URL VITE_OPENSKY_RELAY_URL OPENSKY_CLIENT_ID OPENSKY_CLIENT_SECRET AISSTREAM_API_KEY VITE_WS_RELAY_URL FINNHUB_API_KEY ALPHA_VANTAGE_API_KEY NASA_FIRMS_API_KEY UCDP_ACCESS_TOKEN OLLAMA_API_URL OLLAMA_MODEL WORLDMONITOR_API_KEY WTO_API_KEY AVIATIONSTACK_API ICAO_API_KEY"

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

add_discovered_path() {
  if [[ "$1" == *[[:cntrl:]]* ]]; then
    echo "Warning: Skipping discovered path containing control characters; remove it manually." >&2
    return
  fi
  add_path_if_exists "$1"
}

collect_macos_paths() {
  add_path_if_exists "${WM_UNINSTALL_SYSTEM_APPLICATIONS_DIR:-/Applications}/${PRODUCT}.app"
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
  local pattern_space pattern_dash dir entry line executable basename matched
  local config_home="${XDG_CONFIG_HOME:-${HOME}/.config}"
  local data_home="${XDG_DATA_HOME:-${HOME}/.local/share}"
  local cache_home="${XDG_CACHE_HOME:-${HOME}/.cache}"
  pattern_space="${PRODUCT}*.AppImage"
  pattern_dash="${PRODUCT// /-}*.AppImage"
  for dir in "${HOME}/Applications" "${HOME}/Downloads" "${HOME}/.local/bin" "${HOME}/bin" "${HOME}/Desktop" "${HOME}/AppImages"; do
    [ -d "$dir" ] || continue
    while IFS= read -r -d '' appimage; do
      add_discovered_path "$appimage"
    done < <(find "$dir" -maxdepth 1 \( -iname "$pattern_space" -o -iname "$pattern_dash" \) -print0 2>/dev/null)
  done

  # Launcher entries created by AppImage integration tools: only those whose
  # Exec line runs this product, never an unrelated entry that mentions it.
  if [ -d "${data_home}/applications" ]; then
    while IFS= read -r -d '' entry; do
      matched=0
      while IFS= read -r line; do
        [[ "$line" == Exec=* ]] || continue
        executable="${line#Exec=}"
        executable="${executable#"${executable%%[![:space:]]*}"}"
        if [[ "$executable" == \"* ]]; then
          executable="${executable#\"}"
          [[ "$executable" == *\"* ]] || continue
          executable="${executable%%\"*}"
        else
          executable="${executable%%[[:space:]]*}"
        fi
        basename="${executable##*/}"
        case "$basename" in
          "$BINARY"|"$PRODUCT"*.AppImage|"${PRODUCT// /-}"*.AppImage) matched=1; break ;;
        esac
      done < "$entry"
      if [ "$matched" -eq 1 ]; then add_discovered_path "$entry"; fi
    done < <(find "${data_home}/applications" -maxdepth 1 -name '*.desktop' -print0 2>/dev/null)
  fi

  if [ "$KEEP_DATA" -eq 0 ]; then
    add_path_if_exists "${config_home}/${IDENTIFIER}"
    add_path_if_exists "${data_home}/${IDENTIFIER}"
    add_path_if_exists "${cache_home}/${IDENTIFIER}"
  fi
}

PROCESS_ROOTS=()
PROCESS_IDS=()
PROCESS_EXES=()

process_executable() {
  if [ "$OS" = "Darwin" ]; then
    ps -o comm= -p "$1" 2>/dev/null
  else
    readlink "/proc/$1/exe" 2>/dev/null
  fi
}

is_app_executable() {
  local root
  for root in ${PROCESS_ROOTS[@]+"${PROCESS_ROOTS[@]}"}; do
    if [ "$OS" = "Darwin" ]; then
      case "$1" in
        "$root/Contents/MacOS/$BINARY"|"$root/Contents/Resources/sidecar/node") return 0 ;;
      esac
    else
      case "$1" in
        "$root/"*)
          case "${1##*/}" in node|"$BINARY") return 0 ;; esac ;;
      esac
    fi
  done
  return 1
}

collect_processes() {
  [ "${WM_UNINSTALL_SKIP_PROCESS_STOP:-0}" != "1" ] || return 0
  local path mountroot pid executable
  for path in ${REMOVE_PATHS[@]+"${REMOVE_PATHS[@]}"}; do
    if [ "$OS" = "Darwin" ]; then
      case "$path" in *.app) PROCESS_ROOTS+=("$path") ;; esac
    else
      case "$path" in
        *.AppImage)
          mountroot="$(findmnt -rn -S "$path" -o TARGET 2>/dev/null)" || mountroot=""
          if [ -n "$mountroot" ] && [[ "$mountroot" != *$'\n'* ]]; then
            PROCESS_ROOTS+=("$mountroot")
          else
            echo "Cannot resolve the mount for ${path}; quit its app and sidecar manually before continuing." >&2
          fi ;;
      esac
    fi
  done
  [ "${#PROCESS_ROOTS[@]}" -gt 0 ] || return 0
  for pid in $(pgrep -f "$BINARY|sidecar/node" 2>/dev/null || true); do
    executable="$(process_executable "$pid")" || continue
    if is_app_executable "$executable"; then
      PROCESS_IDS+=("$pid")
      PROCESS_EXES+=("$executable")
    fi
  done
}

stop_processes() {
  local index executable
  for ((index=0; index<${#PROCESS_IDS[@]}; index++)); do
    # Re-check after confirmation: a process may exit and its PID be reused.
    executable="$(process_executable "${PROCESS_IDS[$index]}")" || continue
    if [ "$executable" = "${PROCESS_EXES[$index]}" ] && is_app_executable "$executable"; then
      kill "${PROCESS_IDS[$index]}" 2>/dev/null || true
    fi
  done
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
if [ "$KEEP_SECRETS" -eq 0 ]; then
  if [ "$OS" = "Linux" ]; then
    if ! command -v secret-tool >/dev/null 2>&1; then
      echo "secret-tool not found; remove the '${KEYRING_SERVICE}' entries with your keyring manager." >&2
    fi
    echo "Reboot after uninstall to clear any API keys saved in the Linux kernel session keyring fallback." >&2
  fi
  if keychain_entries_exist; then
    REMOVE_SECRETS=1
  fi
fi

if [ "${#REMOVE_PATHS[@]}" -eq 0 ] && [ "$REMOVE_SECRETS" -eq 0 ]; then
  echo "Nothing to uninstall: no ${PRODUCT} desktop installation found."
  exit 0
fi

collect_processes

echo "The following will be removed:"
# ${arr[@]+...} guards empty-array expansion under `set -u` on bash 3.2 (macOS default)
for p in ${REMOVE_PATHS[@]+"${REMOVE_PATHS[@]}"}; do
  echo "  ${p}"
done
if [ "$REMOVE_SECRETS" -eq 1 ]; then
  echo "  OS keychain entries (service: ${KEYRING_SERVICE})"
fi

for ((index=0; index<${#PROCESS_IDS[@]}; index++)); do
  echo "  Stop process ${PROCESS_IDS[$index]} (${PROCESS_EXES[$index]})"
done

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
