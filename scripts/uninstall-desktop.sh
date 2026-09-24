#!/usr/bin/env bash
set -euo pipefail

# Uninstalls the World Monitor desktop app (macOS / Linux).
#
# Removes, per variant found on this machine:
#   - the app bundle (macOS) or AppImage + desktop entries (Linux)
#   - app data, caches, WebView storage, and logs (unless --keep-data)
#   - OS keychain secrets vault (unless --keep-secrets)
#
# Windows users: use scripts/uninstall-desktop.ps1 instead (the NSIS/MSI
# uninstaller from "Add or Remove Programs" also works, but leaves app data).

usage() {
  cat <<'EOF'
Usage: bash scripts/uninstall-desktop.sh [options]

Options:
  --variant <world|tech|finance|all>  Which desktop variant to uninstall (default: all)
  --keep-data      Keep app data, caches, and logs
  --keep-secrets   Keep API keys stored in the OS keychain
  --dry-run        Show what would be removed without removing anything
  --yes            Skip the confirmation prompt
  -h, --help       Show this help

The keychain secrets vault (service "world-monitor") is shared by all
variants; it is only offered for removal when uninstalling with
--variant all (the default).
EOF
}

VARIANT="all"
KEEP_DATA=0
KEEP_SECRETS=0
DRY_RUN=0
ASSUME_YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --variant)
      VARIANT="${2:-}"
      shift 2
      ;;
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

case "$VARIANT" in
  world|tech|finance|all) ;;
  *)
    echo "Invalid --variant: ${VARIANT} (expected world, tech, finance, or all)" >&2
    exit 1
    ;;
esac

OS="$(uname -s)"
if [ "$OS" != "Darwin" ] && [ "$OS" != "Linux" ]; then
  echo "Unsupported OS: ${OS}. On Windows, run scripts/uninstall-desktop.ps1." >&2
  exit 1
fi

# variant -> product name / binary name / bundle identifier
# (mirrors src-tauri/tauri*.conf.json)
variant_product() {
  case "$1" in
    world) echo "World Monitor" ;;
    tech) echo "Tech Monitor" ;;
    finance) echo "Finance Monitor" ;;
  esac
}

variant_binary() {
  case "$1" in
    world) echo "world-monitor" ;;
    tech) echo "tech-monitor" ;;
    finance) echo "finance-monitor" ;;
  esac
}

variant_identifier() {
  case "$1" in
    world) echo "app.worldmonitor.desktop" ;;
    tech) echo "app.worldmonitor.tech.desktop" ;;
    finance) echo "app.worldmonitor.finance.desktop" ;;
  esac
}

KEYRING_SERVICE="world-monitor"
KEYRING_VAULT_ACCOUNT="secrets-vault"
# Legacy per-key entries from before the consolidated vault
# (see SUPPORTED_SECRET_KEYS in src-tauri/src/main.rs).
LEGACY_SECRET_KEYS="GROQ_API_KEY OPENROUTER_API_KEY FRED_API_KEY EIA_API_KEY FINNHUB_API_KEY CLOUDFLARE_API_TOKEN ACLED_ACCESS_TOKEN URLHAUS_AUTH_KEY OTX_API_KEY ABUSEIPDB_API_KEY NASA_FIRMS_API_KEY WINGBITS_API_KEY WS_RELAY_URL VITE_WS_RELAY_URL VITE_OPENSKY_RELAY_URL OPENSKY_CLIENT_ID OPENSKY_CLIENT_SECRET AISSTREAM_API_KEY OLLAMA_API_URL OLLAMA_MODEL WORLDMONITOR_API_KEY WTO_API_KEY AVIATIONSTACK_API ICAO_API_KEY UCDP_ACCESS_TOKEN"

if [ "$VARIANT" = "all" ]; then
  VARIANTS="world tech finance"
else
  VARIANTS="$VARIANT"
fi

REMOVE_PATHS=()

add_path_if_exists() {
  if [ -e "$1" ]; then
    REMOVE_PATHS+=("$1")
  fi
}

collect_macos_paths() {
  local product="$1" identifier="$2"
  add_path_if_exists "/Applications/${product}.app"
  add_path_if_exists "${HOME}/Applications/${product}.app"
  if [ "$KEEP_DATA" -eq 0 ]; then
    add_path_if_exists "${HOME}/Library/Application Support/${identifier}"
    add_path_if_exists "${HOME}/Library/Caches/${identifier}"
    add_path_if_exists "${HOME}/Library/WebKit/${identifier}"
    add_path_if_exists "${HOME}/Library/HTTPStorages/${identifier}"
    add_path_if_exists "${HOME}/Library/Logs/${identifier}"
    add_path_if_exists "${HOME}/Library/Preferences/${identifier}.plist"
    add_path_if_exists "${HOME}/Library/Saved Application State/${identifier}.savedState"
  fi
}

collect_linux_paths() {
  local product="$1" binary="$2" identifier="$3"

  # AppImages in the usual download/install locations. Tauri names the
  # bundle after the product name ("World Monitor_2.10.0_amd64.AppImage");
  # match both space- and dash-separated forms.
  local pattern_space pattern_dash dir
  pattern_space="${product}*.AppImage"
  pattern_dash="${product// /-}*.AppImage"
  for dir in "${HOME}/Applications" "${HOME}/Downloads" "${HOME}/.local/bin" "${HOME}/bin" "${HOME}/Desktop" "${HOME}/AppImages"; do
    [ -d "$dir" ] || continue
    while IFS= read -r appimage; do
      add_path_if_exists "$appimage"
    done < <(find "$dir" -maxdepth 1 \( -iname "$pattern_space" -o -iname "$pattern_dash" \) 2>/dev/null)
  done

  # Desktop entries and icons created by AppImage integration tools.
  if [ -d "${HOME}/.local/share/applications" ]; then
    while IFS= read -r entry; do
      if grep -qiE "(${binary}|${product})" "$entry" 2>/dev/null; then
        add_path_if_exists "$entry"
      fi
    done < <(find "${HOME}/.local/share/applications" -maxdepth 1 -name '*.desktop' 2>/dev/null)
  fi

  if [ "$KEEP_DATA" -eq 0 ]; then
    add_path_if_exists "${HOME}/.config/${identifier}"
    add_path_if_exists "${HOME}/.local/share/${identifier}"
    add_path_if_exists "${HOME}/.cache/${identifier}"
  fi
}

stop_processes() {
  local binary="$1" product="$2"
  local pid ppid pcomm mount_prefix
  # Best-effort: stop this variant's bundled sidecar Node runtime, then the
  # main binary (matches the NSIS pre-uninstall hook behavior on Windows).
  # The sidecar kill is variant-scoped so uninstalling one variant never takes
  # down another variant's running local API server.
  #
  # 1. Live sidecars: the sidecar is spawned by the variant binary, so match
  #    sidecar Node processes whose PARENT command is this variant's binary.
  for pid in $(pgrep -f "sidecar/node" 2>/dev/null || true); do
    ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
    [ -n "$ppid" ] || continue
    pcomm="$(ps -o comm= -p "$ppid" 2>/dev/null || true)"
    case "$pcomm" in
      *"$binary"*) kill "$pid" 2>/dev/null || true ;;
    esac
  done
  # 2. Orphaned sidecars (parent already exited, reparented to init): match by
  #    a variant-scoped executable path instead.
  if [ "$OS" = "Darwin" ]; then
    # Layout-agnostic under the bundle's Resources dir (Tauri places bundled
    # resources at Contents/Resources/sidecar/...).
    pkill -f "${product}\.app/Contents/Resources/.*sidecar" 2>/dev/null || true
  else
    # AppImages run from a FUSE mount named after the AppImage file
    # (/tmp/.mount_<name-prefix>XXXXXX). The first characters of the product
    # name distinguish the variants (World/Tech/Finance).
    mount_prefix="$(printf '%s' "${product%% *}" | cut -c1-4)"
    pkill -f "\.mount_${mount_prefix}.*sidecar/node" 2>/dev/null || true
  fi
  pkill -x "$binary" 2>/dev/null || true
}

remove_keychain_secrets() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] would remove keychain secrets (service: ${KEYRING_SERVICE})"
    return
  fi
  if [ "$OS" = "Darwin" ]; then
    security delete-generic-password -s "$KEYRING_SERVICE" -a "$KEYRING_VAULT_ACCOUNT" >/dev/null 2>&1 || true
    for key in $LEGACY_SECRET_KEYS; do
      security delete-generic-password -s "$KEYRING_SERVICE" -a "$key" >/dev/null 2>&1 || true
    done
    echo "Removed keychain secrets (service: ${KEYRING_SERVICE})."
  else
    if command -v secret-tool >/dev/null 2>&1; then
      secret-tool clear service "$KEYRING_SERVICE" username "$KEYRING_VAULT_ACCOUNT" 2>/dev/null || true
      for key in $LEGACY_SECRET_KEYS; do
        secret-tool clear service "$KEYRING_SERVICE" username "$key" 2>/dev/null || true
      done
      echo "Removed keyring secrets (service: ${KEYRING_SERVICE})."
    else
      echo "secret-tool not found — skipping keyring cleanup. Remove entries for service '${KEYRING_SERVICE}' with your keyring manager (e.g. GNOME Seahorse)."
    fi
  fi
}

for v in $VARIANTS; do
  product="$(variant_product "$v")"
  binary="$(variant_binary "$v")"
  identifier="$(variant_identifier "$v")"
  if [ "$OS" = "Darwin" ]; then
    collect_macos_paths "$product" "$identifier"
  else
    collect_linux_paths "$product" "$binary" "$identifier"
  fi
done

keychain_secrets_exist() {
  if [ "$OS" = "Darwin" ]; then
    security find-generic-password -s "$KEYRING_SERVICE" >/dev/null 2>&1
  else
    command -v secret-tool >/dev/null 2>&1 &&
      [ -n "$(secret-tool lookup service "$KEYRING_SERVICE" username "$KEYRING_VAULT_ACCOUNT" 2>/dev/null)" ]
  fi
}

REMOVE_SECRETS=0
if [ "$KEEP_SECRETS" -eq 0 ] && [ "$VARIANT" = "all" ] && keychain_secrets_exist; then
  REMOVE_SECRETS=1
fi

if [ "${#REMOVE_PATHS[@]}" -eq 0 ] && [ "$REMOVE_SECRETS" -eq 0 ]; then
  echo "Nothing to uninstall — no World Monitor desktop installation found."
  exit 0
fi

echo "The following will be removed:"
# ${arr[@]+...} guards empty-array expansion under `set -u` on bash 3.2 (macOS default)
for p in ${REMOVE_PATHS[@]+"${REMOVE_PATHS[@]}"}; do
  echo "  ${p}"
done
if [ "$REMOVE_SECRETS" -eq 1 ]; then
  echo "  OS keychain secrets (service: ${KEYRING_SERVICE})"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "Dry run — nothing was removed."
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

for v in $VARIANTS; do
  stop_processes "$(variant_binary "$v")" "$(variant_product "$v")"
done

for p in ${REMOVE_PATHS[@]+"${REMOVE_PATHS[@]}"}; do
  rm -rf "$p"
  echo "Removed ${p}"
done

if [ "$REMOVE_SECRETS" -eq 1 ]; then
  remove_keychain_secrets
fi

echo "Done. World Monitor desktop has been uninstalled."
