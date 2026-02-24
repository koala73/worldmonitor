# Changelog

All notable changes to World Monitor are documented here.

## [2.5.6] - 2026-02-23

### Added

- **Greek (Ελληνικά) locale** — full translation of all 1,397 i18n keys (#256)
- **Nigeria RSS feeds** — 5 new sources: Premium Times, Vanguard, Channels TV, Daily Trust, ThisDay Live
- **Greek locale feeds** — Naftemporiki, in.gr, iefimerida.gr for Greek-language news coverage
- **Brasil Paralelo source** — Brazilian news with RSS feed and source tier (#260)

### Performance

- **AIS relay optimization** — backpressure queue with configurable watermarks, spatial indexing for chokepoint detection (O(chokepoints) vs O(chokepoints × vessels)), pre-serialized + pre-gzipped snapshot cache eliminating per-request JSON.stringify + gzip CPU (#266)

### Fixed

- **Vietnam flag country code** — corrected flag emoji in language selector (#245)
- **Sentry noise filters** — added patterns for SW FetchEvent, PostHog ingest; enabled SW POST method for PostHog analytics (#246)
- **Service Worker same-origin routing** — restricted SW route patterns to same-origin only, preventing cross-origin fetch interception (#247, #251)
- **Social preview bot allowlisting** — whitelisted Twitterbot, facebookexternalhit, and other crawlers on OG image assets (#251)
- **Windows CORS for Tauri** — allow `http://` origin from `tauri.localhost` for Windows desktop builds (#262)
- **Linux AppImage GLib crash** — fix GLib symbol mismatch on newer distros by bundling compatible libraries (#263)

---

## [2.5.2] - 2026-02-21

### Fixed

- **QuotaExceededError handling** — detect storage quota exhaustion and stop further writes to localStorage/IndexedDB instead of silently failing; shared `markStorageQuotaExceeded()` flag across persistent-cache and utility storage
- **deck.gl null.getProjection crash** — wrap `setProps()` calls in try/catch to survive map mid-teardown races in debounced/RAF callbacks
- **MapLibre "Style is not done loading"** — guard `setFilter()` in mousemove/mouseout handlers during theme switches
- **YouTube invalid video ID** — validate video ID format (`/^[\w-]{10,12}$/`) before passing to IFrame Player constructor
- **Vercel build skip on empty SHA** — guard `ignoreCommand` against unset `VERCEL_GIT_PREVIOUS_SHA` (first deploy, force deploy) which caused `git diff` to fail and cancel builds
- **Sentry noise filters** — added 7 patterns: iOS readonly property, SW FetchEvent, toLowerCase/trim/indexOf injections, QuotaExceededError

---

## [2.5.1] - 2026-02-20

### Performance

- **Batch FRED API requests** — frontend now sends a single request with comma-separated series IDs instead of 7 parallel edge function invocations, eliminating Vercel 25s timeouts
- **Parallel UCDP page fetches** — replaced sequential loop with Promise.all for up to 12 pages, cutting fetch time from ~96s worst-case to ~8s
- **Bot protection middleware** — blocks known social-media crawlers from hitting API routes, reducing unnecessary edge function invocations
- **Extended API cache TTLs** — country-intel 12h→24h, GDELT 2h→4h, nuclear 12h→24h; Vercel ignoreCommand skips non-code deploys

### Fixed

- **Partial UCDP cache poisoning** — failed page fetches no longer silently produce incomplete results cached for 6h; partial results get 10-min TTL in both Redis and memory, with `partial: true` flag propagated to CDN cache headers
- **FRED upstream error masking** — single-series failures now return 502 instead of empty 200; batch mode surfaces per-series errors and returns 502 when all fail
- **Sentry `Load failed` filter** — widened regex from `^TypeError: Load failed$` to `^TypeError: Load failed( \(.*\))?$` to catch host-suffixed variants (e.g., gamma-api.polymarket.com)
- **Tooltip XSS hardening** — replaced `rawHtml()` with `safeHtml()` allowlist sanitizer for panel info tooltips
- **UCDP country endpoint** — added missing HTTP method guards (OPTIONS/GET)
- **Middleware exact path matching** — social preview bot allowlist uses `Set.has()` instead of `startsWith()` prefix matching

### Changed

- FRED batch API supports up to 15 comma-separated series IDs with deduplication
- Missing FRED API key returns 200 with `X-Data-Status: skipped-no-api-key` header instead of silent empty response
- LAYER_TO_SOURCE config extracted from duplicate inline mappings into shared constant

---

## [2.5.0] - 2026-02-20

### Highlights

**Local LLM Support (Ollama / LM Studio)** — Run AI summarization entirely on your own hardware with zero cloud dependency. The desktop app auto-discovers models from any OpenAI-compatible local inference server (Ollama, LM Studio, llama.cpp, vLLM) and populates a selection dropdown. A 4-tier fallback chain ensures summaries always generate: Local LLM → Groq → OpenRouter → browser-side T5. Combined with the Tauri desktop app, this enables fully air-gapped intelligence analysis where no data leaves your machine.

### Added

- **Ollama / LM Studio integration** — local AI summarization via OpenAI-compatible `/v1/chat/completions` endpoint with automatic model discovery, embedding model filtering, and fallback to manual text input
- **4-tier summarization fallback chain** — Ollama (local) → Groq (cloud) → OpenRouter (cloud) → Transformers.js T5 (browser), each with 5-second timeout before silently advancing to the next
- **Shared summarization handler factory** — all three API tiers use identical logic for headline deduplication (Jaccard >0.6), variant-aware prompting, language-aware output, and Redis caching (`summary:v3:{mode}:{variant}:{lang}:{hash}`)
- **Settings window with 3 tabs** — dedicated **LLMs** tab (Ollama endpoint/model, Groq, OpenRouter), **API Keys** tab (12+ data source credentials), and **Debug & Logs** tab (traffic log, verbose mode, log file access). Each tab runs an independent verification pipeline
- **Consolidated keychain vault** — all desktop secrets stored as a single JSON blob in one OS keychain entry (`secrets-vault`), reducing macOS Keychain authorization prompts from 20+ to exactly 1 on app startup. One-time auto-migration from individual entries with cleanup
- **Cross-window secret synchronization** — saving credentials in the Settings window immediately syncs to the main dashboard via `localStorage` broadcast, with no app restart needed
- **API key verification pipeline** — each credential is validated against its provider's actual API endpoint. Network errors (timeouts, DNS failures) soft-pass to prevent transient failures from blocking key storage; only explicit 401/403 marks a key invalid
- **Plaintext URL inputs** — endpoint URLs (Ollama API, relay URLs, model names) display as readable text instead of masked password dots in Settings
- **5 new defense/intel RSS feeds** — Military Times, Task & Purpose, USNI News, Oryx OSINT, UK Ministry of Defence
- **Koeberg nuclear power plant** — added to the nuclear facilities map layer (the only commercial reactor in Africa, Cape Town, South Africa)
- **Privacy & Offline Architecture** documentation — README now details the three privacy levels: full cloud, desktop with cloud APIs, and air-gapped local with Ollama
- **AI Summarization Chain** documentation — README includes provider fallback flow diagram and detailed explanation of headline deduplication, variant-aware prompting, and cross-user cache deduplication

### Changed

- AI fallback chain now starts with Ollama (local) before cloud providers
- Feature toggles increased from 14 to 15 (added AI/Ollama)
- Desktop architecture uses consolidated vault instead of per-key keychain entries
- README expanded with ~85 lines of new content covering local LLM support, privacy architecture, summarization chain internals, and desktop readiness framework

### Fixed

- URL and model fields in Settings display as plaintext instead of masked password dots
- OpenAI-compatible endpoint flow hardened for Ollama/LM Studio response format differences (thinking tokens, missing `choices` array edge cases)
- Sentry null guard for `getProjection()` crash with 6 additional noise filters
- PathLayer cache cleared on layer toggle-off to prevent stale WebGL buffer rendering

---

## [2.4.1] - 2026-02-19

### Fixed

- **Map PathLayer cache**: Clear PathLayer on toggle-off to prevent stale WebGL buffers
- **Sentry noise**: Null guard for `getProjection()` crash and 6 additional noise filters
- **Markdown docs**: Resolve lint errors in documentation files

---

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
