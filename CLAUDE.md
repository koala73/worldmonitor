# World Monitor — Claude Code Context

## Project Overview
- **App name**: World Monitor (do NOT call this "Crystal Ball" — that is a separate project)
- **Bundle ID**: `com.bradleybond.crystalball` (internal only, not the app's name)
- **Fork of**: `koala73/worldmonitor` by Elie Habib (AGPL-3.0)
- **Stack**: Tauri 2 + TypeScript + Vite + DeckGL + Node.js sidecar (port 46123)

## Commands
```bash
npm run desktop:build:full   # full production build
npm run typecheck:all        # type-check both tsconfig.json + tsconfig.api.json (must stay at zero errors)
npm run dev                  # vite dev server (web only, no Tauri)
```
Install built app: copy `src-tauri/target/release/bundle/dmg/*.dmg` to /Applications.

## CANONICAL REPO — SINGLE SOURCE OF TRUTH (MANDATE)
There is exactly ONE place to develop this app:
```
~/Library/Mobile Documents/com~apple~CloudDocs/World Monitor MacOS project/worldmonitor
```
- **Never** build, commit, or make changes in any other clone (e.g. `~/Documents/GitHub/worldmonitor-macos/`)
- **Never** install to `/Applications` from any other build directory
- Always install from: `src-tauri/target/release/bundle/macos/World Monitor.app` in this directory
- The Dock and Spotlight should point to `~/Applications/World Monitor.app` only

If a second clone is found, DELETE it. Do not merge from it without explicit user instruction.

## Git Remotes
- `upstream` — Elie's repo, **fetch only** (push URL = `no_push`)
- `macos` — `bradleybond512/worldmonitor-macos` — **always push here**
- `crystal-ball` — alternate, do not use unless asked

Always commit with: `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`

## Architecture
```
src/                        # TypeScript frontend (Vite)
  app/
    panel-layout.ts         # panel instantiation + sidebar layout
    data-loader.ts          # data fetching, task scheduling
    refresh-scheduler.ts    # scheduleRefresh() — ghost multiplier + hidden×10 + jitter
    event-handlers.ts       # UI events, keyboard shortcuts
  components/
    Panel.ts                # base Panel class (getContentElement() is public)
    RadiationDecayPanel.ts  # offline; disabled by default
    ResourceInventoryPanel.ts # offline; disabled by default
  config/
    panels.ts               # FULL_PANELS, PANEL_CATEGORY_MAP, FULL_MAP_LAYERS
  services/
    mode-manager.ts         # AppMode: peace/finance/war/disaster/ghost
    runtime-config.ts       # API key definitions, feature toggles
    settings-constants.ts   # HUMAN_LABELS, SIGNUP_URLS, SETTINGS_CATEGORIES
    analytics.ts            # PostHog (suppressed in Ghost Mode)
    cyber-extra.ts          # ThreatFox, OpenPhish, Spamhaus, CISA KEV
    ema-forecast.ts         # rolling 24-session EMA threat forecast
  styles/
    main.css
    macos-native.css        # sidebar, mode themes, Ghost Mode crimson/violet
src-tauri/
  sidecar/local-api-server.mjs  # Node.js API proxy, port 46123
  capabilities/default.json     # Tauri capability allowlist
  src/main.rs                   # 25 SUPPORTED_SECRET_KEYS (include THREATFOX_API_KEY)
```

## App Modes (`src/services/mode-manager.ts`)
| Mode | Trigger |
|------|---------|
| Peace | default |
| Finance | S&P500 ≥2.5% OR BTC ≥5% OR Oil ≥4% OR Gold ≥2% |
| War | ≥2 war signals > confidence 0.6 (normalized by conflict baselines) |
| Disaster | GDACS Red OR 3+ Orange OR M≥6.5 quake |
| Ghost | Manual only — ⌘⇧G / sidebar / File menu |

Ghost Mode: polling ×5, analytics suppressed, notifications suppressed, dark crimson sidebar, 👻 title.

## Tauri 2 / WKWebView Gotchas
- **Window drag**: CSS `-webkit-app-region: drag` does NOT work — use JS `mousedown` → `tryInvokeTauri('plugin:window|start_dragging')`. Requires `core:window:allow-start-dragging` in `capabilities/default.json` (not in `core:default`).
- **Local iframes**: Always `http://127.0.0.1:{port}`, never `localhost` — CSP only allows `127.0.0.1`, WKWebView treats them as distinct origins. Use `getApiBaseUrl()` from `runtime.ts`.
- **YouTube sidecar**: `origin` in playerVars must match actual page URL (`http://127.0.0.1:{port}`).
- **Devtools**: Use `--features devtools` flag during dev (NOT in default features — removed from production builds). e.g. `cargo tauri dev --features devtools` → Safari > Develop > World Monitor.

## Legacy Internal Identifiers (do not change)
- `localStorage` keys stay `worldmonitor-*` (changing breaks existing user data)
- IndexedDB stays `worldmonitor_db`
- `KEYRING_SERVICE = "world-monitor"` (changing breaks keychain entries)
- `worldmonitor.app` domain refs kept (upstream cloud services)

## Settings / API Keys
- API keys entered via gear icon → API Keys tab (not in `FULL_PANELS`)
- `radiation-decay` and `resource-inventory` default `enabled: false`, priority 3
- `cyberThreats: true` in `FULL_MAP_LAYERS`, `VITE_ENABLE_CYBER_LAYER=true` in `.env.local`
- `SUPPORTED_SECRET_KEYS` in `main.rs` = 25 keys (THREATFOX_API_KEY is #25)

## Known Issues
- **Sector Heatmap**: Yahoo Finance blocked → needs Finnhub API key
- **Fires panel**: Needs `NASA_FIRMS_API_KEY`
- **Stablecoins**: "The string did not match the expected pattern" — WKWebView URL handling
