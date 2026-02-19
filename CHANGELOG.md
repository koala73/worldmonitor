# Changelog

All notable changes to World Monitor are documented here.

## [2.4.0] - 2026-02-19

### Added

- **Live Webcams Panel**: 2x2 grid of live YouTube webcam feeds from global hotspots with region filters (Middle East, Europe, Asia-Pacific, Americas), grid/single view toggle, idle detection, and full i18n support (#111)
- **Linux download**: added `.AppImage` option to download banner

### Changed

- **Mobile detection**: use viewport width only for mobile detection; touch-capable notebooks (e.g. ROG Flow X13) now get desktop layout (#113)
- **Webcam feeds**: curated Tel Aviv, Mecca, LA, Miami; replaced dead Tokyo feed; diverse ALL grid with Jerusalem, Tehran, Kyiv, Washington

### Fixed

- **Le Monde RSS**: English feed URL updated (`/en/rss/full.xml` → `/en/rss/une.xml`) to fix 404
- **Workbox precache**: added `html` to `globPatterns` so `navigateFallback` works for offline PWA
- **Panel ordering**: one-time migration ensures Live Webcams follows Live News for existing users
- **Mobile popups**: improved sheet/touch/controls layout (#109)
- **Intelligence alerts**: disabled on mobile to reduce noise (#110)
- **RSS proxy**: added 8 missing domains to allowlist
- **HTML tags**: repaired malformed tags in panel template literals
- **ML worker**: wrapped `unloadModel()` in try/catch to prevent unhandled timeout rejections
- **YouTube player**: optional chaining on `playVideo?.()` / `pauseVideo?.()` for initialization race
- **Panel drag**: guarded `.closest()` on non-Element event targets
- **Beta mode**: resolved race condition and timeout failures
- **Sentry noise**: added filters for Firefox `too much recursion`, maplibre `_layers`/`id`/`type` null crashes

## [2.3.9] - 2026-02-18

### Added

- **Full internationalization (14 locales)**: English, French, German, Spanish, Italian, Polish, Portuguese, Dutch, Swedish, Russian, Arabic, Chinese Simplified, Japanese — each with 1100+ translated keys
- **RTL support**: Arabic locale with `dir="rtl"`, dedicated RTL CSS overrides, regional language code normalization (e.g. `ar-SA` correctly triggers RTL)
- **Language switcher**: in-app locale picker with flag icons, persists to localStorage
- **i18n infrastructure**: i18next with browser language detection and English fallback
- **Community discussion widget**: floating pill linking to GitHub Discussions with delayed appearance and permanent dismiss
- **Linux AppImage**: added `ubuntu-22.04` to CI build matrix with webkit2gtk/appindicator dependencies
- **NHK World and Nikkei Asia**: added RSS feeds for Japan news coverage
- **Intelligence Findings badge toggle**: option to disable the findings badge in the UI

### Changed

- **Zero hardcoded English**: all UI text routed through `t()` — panels, modals, tooltips, popups, map legends, alert templates, signal descriptions
- **Trending proper-noun detection**: improved mid-sentence capitalization heuristic with all-caps fallback when ML classifier is unavailable
- **Stopword suppression**: added missing English stopwords to trending keyword filter

### Fixed

- **Dead UTC clock**: removed `#timeDisplay` element that permanently displayed `--:--:-- UTC`
- **Community widget duplicates**: added DOM idempotency guard preventing duplicate widgets on repeated news refresh cycles
- **Settings help text**: suppressed raw i18n key paths rendering when translation is missing
- **Intelligence Findings badge**: fixed toggle state and listener lifecycle
- **Context menu styles**: restored intel-findings context menu styles
- **CSS theme variables**: defined missing `--panel-bg` and `--panel-border` variables

## [2.3.8] - 2026-02-17

### Added

- **Finance variant**: Added a dedicated market-first variant (`finance.worldmonitor.app`) with finance/trading-focused feeds, panels, and map defaults
- **Finance desktop profile**: Added finance-specific desktop config and build profile for Tauri packaging

### Changed

- **Variant feed loading**: `loadNews` now enumerates categories dynamically and stages category fetches with bounded concurrency across variants
- **Feed resilience**: Replaced direct MarketWatch RSS usage in finance/full/tech paths with Google News-backed fallback queries
- **Classification pressure controls**: Tightened AI classification budgets for tech/full and tuned per-feed caps to reduce startup burst pressure
- **Timeline behavior**: Wired timeline filtering consistently across map and news panels
- **AI summarization defaults**: Switched OpenRouter summarization to auto-routed free-tier model selection

### Fixed

- **Finance panel parity**: Kept data-rich panels while adding news panels for finance instead of removing core data surfaces
- **Desktop finance map parity**: Finance variant now runs first-class Deck.GL map/layer behavior on desktop runtime
- **Polymarket fallback**: Added one-time direct connectivity probe and memoized fallback to prevent repeated `ERR_CONNECTION_RESET` storms
- **FRED fallback behavior**: Missing `FRED_API_KEY` now returns graceful empty payloads instead of repeated hard 500s
- **Preview CSP tooling**: Allowed `https://vercel.live` script in CSP so Vercel preview feedback injection is not blocked
- **Trending quality**: Suppressed noisy generic finance terms in keyword spike detection
- **Mobile UX**: Hidden desktop download prompt on mobile devices

## [2.3.7] - 2026-02-16

### Added

- **Full light mode theme**: Complete light/dark theme system with CSS custom properties, ThemeManager module, FOUC prevention, and `getCSSColor()` utility for theme-aware inline styles
- **Theme-aware maps and charts**: Deck.GL basemap, overlay layers, and CountryTimeline charts respond to theme changes in real time
- **Dark/light mode header toggle**: Sun/moon icon in the header bar for quick theme switching, replacing the duplicate UTC clock
- **Desktop update checker**: Architecture-aware download links for macOS (ARM/Intel) and Windows
- **Node.js bundled in Tauri installer**: Sidecar no longer requires system Node.js
- **Markdown linting**: Added markdownlint config and CI workflow

### Changed

- **Panels modal**: Reverted from "Settings" back to "Panels" — removed redundant Appearance section now that header has theme toggle
- **Default panels**: Enabled UCDP Conflict Events, UNHCR Displacement, Climate Anomalies, and Population Exposure panels by default

### Fixed

- **CORS for Tauri desktop**: Fixed CORS issues for desktop app requests
- **Markets panel**: Keep Yahoo-backed data visible when Finnhub API key is skipped
- **Windows UNC paths**: Preserve extended-length path prefix when sanitizing sidecar script path
- **Light mode readability**: Darkened neon semantic colors and overlay backgrounds for light mode contrast

## [2.3.6] - 2026-02-16

### Fixed

- **Windows console window**: Hide the `node.exe` console window that appeared alongside the desktop app on Windows

## [2.3.5] - 2026-02-16

### Changed

- **Panel error messages**: Differentiated error messages per panel so users see context-specific guidance instead of generic failures
- **Desktop config auto-hide**: Desktop configuration panel automatically hides on web deployments where it is not relevant

## [2.3.4] - 2026-02-16

### Fixed

- **Windows sidecar crash**: Strip `\\?\` UNC extended-length prefix from paths before passing to Node.js — Tauri `resource_dir()` on Windows returns UNC-prefixed paths that cause `EISDIR: lstat 'C:'` in Node.js module resolution
- **Windows sidecar CWD**: Set explicit `current_dir` on the Node.js Command to prevent bare drive-letter working directory issues from NSIS shortcut launcher
- **Sidecar package scope**: Add `package.json` with `"type": "module"` to sidecar directory, preventing Node.js from walking up the entire directory tree during ESM scope resolution

## [2.3.3] - 2026-02-16

### Fixed

- **Keychain persistence**: Enable `apple-native` (macOS) and `windows-native` (Windows) features for the `keyring` crate — v3 ships with no default platform backends, so API keys were stored in-memory only and lost on restart
- **Settings key verification**: Soft-pass network errors during API key verification so transient sidecar failures don't block saving
- **Resilient keychain reads**: Use `Promise.allSettled` in `loadDesktopSecrets` so a single key failure doesn't discard all loaded secrets
- **Settings window capabilities**: Add `"settings"` to Tauri capabilities window list for core plugin permissions
- **Input preservation**: Capture unsaved input values before DOM re-render in settings panel

## [2.3.0] - 2026-02-15

### Security

- **CORS hardening**: Tighten Vercel preview deployment regex to block origin spoofing (`worldmonitorEVIL.vercel.app`)
- **Sidecar auth bypass**: Move `/api/local-env-update` behind `LOCAL_API_TOKEN` auth check
- **Env key allowlist**: Restrict sidecar env mutations to 18 known secret keys (matching `SUPPORTED_SECRET_KEYS`)
- **postMessage validation**: Add `origin` and `source` checks on incoming messages in LiveNewsPanel
- **postMessage targetOrigin**: Replace wildcard `'*'` with specific embed origin
- **CORS enforcement**: Add `isDisallowedOrigin()` check to 25+ API endpoints that were missing it
- **Custom CORS migration**: Migrate `gdelt-geo` and `eia` from custom CORS to shared `_cors.js` module
- **New CORS coverage**: Add CORS headers + origin check to `firms-fires`, `stock-index`, `youtube/live`
- **YouTube embed origins**: Tighten `ALLOWED_ORIGINS` regex in `youtube/embed.js`
- **CSP hardening**: Remove `'unsafe-inline'` from `script-src` in both `index.html` and `tauri.conf.json`
- **iframe sandbox**: Add `sandbox="allow-scripts allow-same-origin allow-presentation"` to YouTube embed iframe
- **Meta tag validation**: Validate URL query params with regex allowlist in `parseStoryParams()`

### Fixed

- **Service worker stale assets**: Add `skipWaiting`, `clientsClaim`, and `cleanupOutdatedCaches` to workbox config — fixes `NS_ERROR_CORRUPTED_CONTENT` / MIME type errors when users have a cached SW serving old HTML after redeployment

## [2.2.6] - 2026-02-14

### Fixed

- Filter trending noise and fix sidecar auth
- Restore tech variant panels
- Remove Market Radar and Economic Data panels from tech variant

### Docs

- Add developer X/Twitter link to Support section
- Add cyber threat API keys to `.env.example`

## [2.2.5] - 2026-02-13

### Security

- Migrate all Vercel edge functions to CORS allowlist
- Restrict Railway relay CORS to allowed origins only

### Fixed

- Hide desktop config panel on web
- Route World Bank & Polymarket via Railway relay

## [2.2.3] - 2026-02-12

### Added

- Cyber threat intelligence map layer (Feodo Tracker, URLhaus, C2IntelFeeds, OTX, AbuseIPDB)
- Trending keyword spike detection with end-to-end flow
- Download desktop app slide-in banner for web visitors
- Country briefs in Cmd+K search

### Changed

- Redesign 4 panels with table layouts and scoped styles
- Redesign population exposure panel and reorder UCDP columns
- Dramatically increase cyber threat map density

### Fixed

- Resolve z-index conflict between pinned map and panels grid
- Cap geo enrichment at 12s timeout, prevent duplicate download banners
- Replace ipwho.is/ipapi.co with ipinfo.io/freeipapi.com for geo enrichment
- Harden trending spike processing and optimize hot paths
- Improve cyber threat tooltip/popup UX and dot visibility

## [2.2.2] - 2026-02-10

### Added

- Full-page Country Brief Page replacing modal overlay
- Download redirect API for platform-specific installers

### Fixed

- Normalize country name from GeoJSON to canonical TIER1 name
- Tighten headline relevance, add Top News section, compact markets
- Hide desktop config panel on web, fix irrelevant prediction markets
- Tone down climate anomalies heatmap to stop obscuring other layers
- macOS: hide window on close instead of quitting

### Performance

- Reduce idle CPU from pulse animation loop
- Harden regression guardrails in CI, cache, and map clustering

## [2.2.1] - 2026-02-08

### Fixed

- Consolidate variant naming and fix PWA tile caching
- Windows settings window: async command, no menu bar, no white flash
- Constrain layers menu height in DeckGLMap
- Allow Cloudflare Insights script in CSP
- macOS build failures when Apple signing secrets are missing

## [2.2.0] - 2026-02-07

Initial v2.2 release with multi-variant support (World + Tech), desktop app (Tauri), and comprehensive geopolitical intelligence features.
