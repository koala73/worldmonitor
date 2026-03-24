# Changelog

All notable changes to World Monitor are documented here.

## [Unreleased]

---

## [2.7.2] - 2026-03-24

### Fixed

- CI typecheck compatibility for XML parser callbacks in aviation and arXiv ingestion paths, preventing release pipeline failures against stricter callback signatures.
- Release docs no longer pin stale download/version strings in README and docs badges.

### Changed

- Added release-doc sync regression coverage so docs and changelog stay aligned with `package.json` version updates.

---

## [2.7.0] - 2026-03-16

### Fixed

- Desktop release version syncing now updates and validates `package-lock.json` and `src-tauri/Cargo.lock`, preventing release doctor failures caused by partial version bumps.
- Desktop local-token generation now uses the `getrandom` 0.3 API (`fill`) so the Tauri Rust app compiles cleanly with the pinned dependency set.

### Changed

- Desktop app metadata advanced to `2.7.0` across the Node and Tauri release files.

---

## [2.6.1] - 2026-03-16

> This release supersedes an unpublished `v2.6.0` Git tag. The latest public GitHub release moves directly from `v2.5.25` to `v2.6.1`.

### Added

- **Claude Intelligence Agent panel** — new agentic panel powered by Anthropic's tool-use API. Ask natural-language questions; Claude autonomously calls live-data tools (news headlines via GDELT, country risk scores, market data, cyber threat IOCs) and synthesizes a structured intelligence brief. Accessible via the Intelligence category in the panel picker. Requires `ANTHROPIC_API_KEY`. Four preset queries provided for quick situational awareness.
- **Communications Health panel** — consolidated monitoring surface for internet outages, infrastructure incidents, and communications disruption signals.
- **Economic Stress panel** — composite stress view wired through the sidecar, panel layout, and data-loader for rapid macro deterioration checks.
- **Yahoo Finance → free data sources migration** — all sidecar routes now use Stooq batch CSV + FRED CSV, eliminating Yahoo Finance dependency entirely
  - `/api/market-quotes`: Stooq batch CSV (cl.f, gc.f, spy.us, qqq.us, etc.) + FRED VIXCLS for VIX
  - `/api/btc-etf-flows`: Stooq batch CSV for IBIT, FBTC, ARKB, BITB, HODL
  - `/api/macro-signals`: Stooq for BTC/QQQ/XLP/SPY/Gold price signals
  - `/api/fred-fallback`: FRED CSV (VIXCLS + FEDFUNDS) replaces Yahoo finance quotes
  - `/api/energy-fallback`: Stooq for WTI (cl.f) and NatGas (ng.f); FRED DCOILBRENTEU CSV for Brent crude
  - `/api/stock-chart`: Stooq daily historical CSV replaces Yahoo chart API
- **Comprehensive free-API fallbacks** for resilient data loading across markets, ETF flows, stablecoins, macro signals, and AI posture
- **API Keys UX overhaul** — prominent signup card for missing keys, grouped features by category, masked sentinel for stored password keys
- **Unified settings modal** — single modal for all entry points, removed duplicate settings mounts
- **Expanded FIRMS monitoring** — 18 global wildfire regions
- **Professional sound design** — replaced klaxons/sweeps with sine-wave alerts, overhauled all mode audio
- **Arrival Choreography** — canvas overlay for animated world events (wavefront ripple, corona pulse, global flare)
- **Shareable URL state** — LZ-compressed `?view=&zoom=&lat=&lon=&layers=&timeRange=` with `Cmd+S` shortcut
- **Ollama streaming** — real-time typewriter effect for AI panel summaries with Stop button
- **Natural Disaster Mode** — 4th monitoring mode with amber/orange theme, auto-triggers, and synthesized audio

### Fixed

- Desktop Anthropic secret support is now wired end-to-end across the Rust keychain vault, the local sidecar allowlist, and provider validation
- Release documentation now distinguishes between branch state, local packaging capability, and the latest published GitHub release artifacts
- Webcam iframes use `127.0.0.1` instead of `localhost` to satisfy CSP `frame-src`
- Window drag replaced CSS drag region with JS `startDragging()` for reliability
- Toolbar drag zones expanded to title, status, and clock elements
- Toolbar title renamed Crystal Ball → World Monitor

### Security

- Hardened desktop trust boundaries around local secret handling and sidecar validation paths
- Hardened secret detection, IndexedDB cap, idle throttle, AISSTREAM validation
- Fixed oscillator leak, Ghost Mode analytics gap, CSP, and proxy timeout
- Decompression bomb guard for URL state; OLLAMA_MODEL validation; arrival choreography memory caps

### Changed

- **Claude AI model upgraded to Sonnet 4.6** — Anthropic provider now uses `claude-sonnet-4-6` (released February 2026), replacing Haiku 4.5. Sonnet 4.6 offers improved reasoning, advanced coding assistance, and a 1M-token context window, making AI intelligence briefs and panel summaries significantly more capable.
- `src/services/oref-locations.ts` — 1,478 Hebrew→English location translations (cherry-picked from upstream)

### Upstream sync (cherry-picked from koala73/worldmonitor)

- `8970335` fix: suppress map renders during resize drag
- `7c8943d` feat: add Iran & Strait of Hormuz zones, upgrade Ukraine polygon
- `697f334` fix: replace dead Tel Aviv live stream
- `cd86433` fix(oref): prevent LLM translation cache poisoning + add static Hebrew→English translations
- `1933b3a` feat(cmdk): disambiguate Map vs Panel commands + add Czech locale
- `58cb2b6` feat(cmdk): rotating contextual tips in empty state
- `f4e1159` feat(header): add Download App button for web users
- `bb31b43` feat(header): download dropdown + move system status into Settings (merged with API Keys tab)
- `8a41422` fix: harden Windows installer update path and map resize behavior

---

## [2.6.0] - Unpublished tag

> `v2.6.0` exists as a Git tag on GitHub but was never shipped as a proper GitHub release. Its releasable changes were rolled forward into `v2.6.1`.

---

## [2.5.25] - 2026-03-01

### Highlights

- **API Keys tab in Settings** — Desktop Configuration panel removed from sidebar; all API key management now lives in the gear-icon Settings modal under a new "API Keys" tab (matches original upstream fork design)
- **AI Summary button** — ✦ button added to every non-video panel header; calls the configured AI provider (Ollama / Groq / Claude) and overlays a contextual summary of current panel data
- **Immersive monitoring modes** — Peace / Finance / War modes now each carry a full visual theme (War: red alert with animated glow; Finance: green trading floor; Peace: clean default) plus distinct synthesized audio cues
- **Intelligent mode auto-triggers with deescalation** — War Mode now triggers on 5 signal types (hotspot escalation, military surge, geo convergence, velocity spike, keyword spike); Finance Mode triggers on S&P 500 ≥2.5%, BTC ≥5%, Oil ≥4%, or Gold ≥2% moves; both modes auto-restore to Peace after signals quiet down
- **Panel reordering on mode switch** — panels dynamically reorder when mode changes (war panels to top in War Mode, finance panels to top in Finance Mode); original order restored on Peace Mode
- **Mode-change sound design** — synthesized audio for each mode transition: War (staccato sawtooth alarm), Finance (ascending C-E-G chime), Peace (432 Hz resonant bell)
- **Apple-style map controls** — map layer panel, zoom buttons, time slider, and basemap selector redesigned with macOS frosted-glass aesthetic (dark translucent backgrounds, backdrop-filter blur, Apple system blue, rounded corners)
- **Basemap button layout** — Dark/Light/Satellite/Terrain now displayed in a 2×2 grid (previously 4 buttons in one cramped row)
- **Performance optimizations** — VirtualList ResizeObserver disconnected on destroy (memory leak fix), DeckGL theme color calculation cached (CPU reduction), 5 MB log rotation for desktop.log and local-api.log
- **i18n** — `tabApiKeys` translation added to all 18 locale files

### Added

- `src/services/sound-manager.ts` — Web Audio API synthesizer for mode-transition sounds; War (sawtooth alarm), Finance (sine arpeggio), Peace (resonant 432 Hz bell); lazy AudioContext init; mute toggle persisted in localStorage
- `src/services/mode-manager.ts` — `evaluateCommodityTrigger()`: Oil (CL=F) ≥4% or Gold (GC=F) ≥2% daily move triggers Finance Mode; `velocity_spike` and `keyword_spike` signal types added to War Mode detector; auto-deescalation: War Mode auto-restores to Peace after 20 min of zero signals; Finance Mode auto-restores after 60 min of calm markets; Finance Mode auto-trigger dispatches system notification
- `src/app/panel-layout.ts` — `_applyModePanelOrder()`: reorders sidebar panels on mode change; War panels to top (alert-center, cyber-threats, oref-sirens, etc.), Finance panels to top (crypto, markets, stablecoins, etc.); original order saved and restored on Peace Mode
- `src/styles/macos-native.css` — immersive War Mode theme (red sidebar gradient, animated top-line glow, red panel borders/headers, red toolbar title with text-shadow); Finance Mode theme (green equivalent); Peace Mode resets to default
- `src/components/UnifiedSettings.ts` — "API Keys" tab (desktop only); lazy-creates and mounts `RuntimeConfigPanel` in full mode inside the Settings modal
- `src/components/Panel.ts` — `getContentElement()` public accessor; `_runAiSummary()` / `_extractSummaryText()` methods; AI summary overlay with loading spinner, provider label, and close button; excludes `live-webcams`, `live-news`, `map` from AI button
- `src/app/data-loader.ts` — wires `evaluateCommodityTrigger()` after commodity data loads; wires `evaluateFinanceTrigger()` after crypto data loads
- `src/App.ts` — calls `initSoundManager()` during Phase 3 init
- `src/styles/main.css` — AI summary panel CSS (`.panel-ai-btn`, `.panel-ai-overlay`, spinner, result header); API Keys tab overflow scroll; Apple-style map control CSS with backdrop-filter blur and system blue accents
- All 18 locale files — `header.tabApiKeys` translated (ar, de, el, es, fr, it, ja, ko, nl, pl, pt, ru, sv, th, tr, vi, zh)

### Changed

- `src/App.ts` — removed force-enable block for `runtime-config` panel; added one-time migration to delete `runtime-config` from localStorage (panel moved to Settings modal)
- `src/app/panel-layout.ts` — removed `RuntimeConfigPanel` import, instantiation, sidebar ordering, and i18n special-case
- `src/app/event-handlers.ts` — removed `runtime-config` i18n special-case
- `src/config/variant.ts` — desktop runtime auto-corrects stale `'happy'` variant to `'full'` (prevents sidebar nav and mode buttons disappearing)
- `src/components/VirtualList.ts` — `ResizeObserver` stored as class field; disconnected in `destroy()` to prevent memory leak
- `src/components/DeckGLMap.ts` — module-level `_cachedTheme` variable; `getOverlayColors()` only recomputed when theme actually changes
- `src-tauri/src/main.rs` — `rotate_log_if_needed()` rotates desktop.log and local-api.log at 5 MB (3 backups each)
- Map basemap buttons layout: `display: flex` → `display: grid; grid-template-columns: 1fr 1fr`
- War Mode auto-trigger threshold lowered from 3 to 2 signals; signal set expanded from 3 to 5 types

### Removed

- `RuntimeConfigPanel` from sidebar (was position 1 with alert banner on desktop) — accessible via Settings → API Keys

---

## [2.5.24] - 2026-03-01

### Highlights

- **App Modes — Peace / Finance / War** — three monitoring lenses accessible from the macOS sidebar; War Mode auto-activates when 3+ conflict correlation signals are detected in a session
- **Auto War Mode trigger** — `hotspot_escalation`, `military_surge`, and `geo_convergence` signals feed a live threat score; threshold breach fires a native desktop notification and switches the UI to War Mode
- **Alert Family** — one-tap button in War Mode copies a pre-formatted safety message to the clipboard for sharing with family/friends
- **Code hardening** — World Bank cache eviction (prevents unbounded memory growth), AlertCenterPanel in-place array truncation, `fetchIndicator` wrapped in try/catch for graceful CORS/network failure handling
- **Satellite & terrain basemaps** — Esri World Imagery + label overlay and Esri World Topo Map available as base layer alternatives to the default dark/light styles, persisted across sessions
- **OSINT live channels** — S2 Underground, Task & Purpose, The War Zone, Military Summary added to the Intelligence & OSINT region of the Live News panel
- **CSS for 5 new panels** — SpaceWeather, DiseaseOutbreaks, AirQuality, CyberThreats, AlertCenter now have full severity-coded styling (previously rendered unstyled)
- **Dependabot** — weekly automated dependency scanning for npm, Cargo, and GitHub Actions

### Added

- `src/services/mode-manager.ts` — `AppMode` type (`peace | finance | war`), `getMode()`, `setMode()`, `initMode()`, `evaluateWarThreat()`, `alertFamily()`; persists to localStorage; dispatches `wm:mode-changed` and `wm:war-score` custom events
- Mode selector UI in macOS sidebar (above footer): 🕊 Peace | 💰 Finance | ⚔ War buttons with color-coded active states
- War Mode: red pulsing button, red sidebar accent border, red toolbar title
- Finance Mode: green sidebar accent border, green toolbar title
- Alert Family button appears in War Mode — copies ISO-8601 timestamped safety message to clipboard
- Threat score badge on War button (shows count/threshold when signals detected but not yet in War Mode)
- `evaluateWarThreat()` wired into all `addToSignalHistory()` call sites in data-loader.ts
- Satellite basemap (Esri World Imagery + Esri Reference Labels overlay) — `/map-styles/satellite.json`
- Terrain basemap (Esri World Topo Map) — `/map-styles/terrain.json`
- Basemap selector in the map layer panel (Dark / Light / Satellite / Terrain), persisted to localStorage
- S2 Underground, Task & Purpose, The War Zone, Military Summary YouTube channels with live detection + pinned video fallback
- Intelligence & OSINT region in Live News panel with `regionOsint` i18n key
- Full CSS styling for SpaceWeatherPanel, DiseaseOutbreakPanel, AirQualityPanel, CyberThreatPanel, AlertCenterPanel in `panels.css`
- i18n keys for all 6 new panel titles and OSINT region label
- `.github/dependabot.yml` — weekly scanning for npm, Cargo, GitHub Actions

### Fixed

- **Live News black screen** — embed URL changed from `http://localhost:PORT` to `http://127.0.0.1:PORT` to match Tauri CSP `frame-src http://127.0.0.1:*` (CSP treats them as different origins in WKWebView)
- AlertCenterPanel array truncation now mutates in-place (`splice(100)`) instead of creating a new array
- World Bank `fetchIndicator()` wrapped in try/catch — CORS or network failures now return null values instead of throwing
- World Bank profile cache evicts expired entries when it exceeds 250 entries (prevents unbounded memory growth)
- CHANGELOG updated with full release history for v2.5.22 and v2.5.23

---

## [2.5.23] - 2026-03-01

### Highlights

- **Space Weather Panel** — NOAA SWPC real-time Kp index, solar wind, Bz, X-ray flares, geomagnetic storm alerts
- **Disease Outbreaks Panel** — WHO Disease Outbreak News + ReliefWeb health situation reports, no API key required
- **Air Quality Panel** — Open-Meteo AQ API for 18 global cities, US EPA AQI scale, PM2.5/PM10/O3/NO2
- **Native macOS notifications** — osascript-based desktop alerts for critical/high breaking news events
- **Security hardening** — rate-limited notifications, HTTPS-only URL opening, bundle ID verification on updates, href injection fixes, tightened CSP

### Added

- Space Weather Panel with NOAA SWPC data: Kp index, solar wind speed/density, Bz IMF, X-ray flare class, active alerts
- Disease Outbreak Panel aggregating WHO DON JSON + ReliefWeb, deduplicated, severity-ranked
- Air Quality Panel with Open-Meteo AQ API, AQI color coding (Good → Hazardous), 18 global cities
- DesktopNotifications module — native macOS alerts via osascript for breaking news events
- CSS styles for all 5 new panels (Space Weather, Disease Outbreaks, Air Quality, Cyber Threats, Alert Center)
- `send_notification` Tauri command with 30-second rate limit and input length caps

### Security

- `open_url`: HTTPS-only enforcement, blocks loopback/LAN/`.local` addresses, 4096-char URL limit
- `install_update`: bundle identifier verification via `plutil` before overwriting `/Applications/World Monitor.app`
- `send_notification`: 30-second global rate limit, 128/256-char length caps, control character stripping
- `fetch_polymarket`: path traversal rejection, 2048-char params length limit
- CSP: added `object-src 'none'; base-uri 'self'; form-action 'self';`
- Fixed href injection in AlertCenterPanel, DiseaseOutbreakPanel, SecurityAdvisoriesPanel, MacroSignalsPanel, MapPopup

---

## [2.5.22] - 2026-03-01

### Highlights

- **Claude AI Intelligence Brief** — on-demand AI summarization of all active panels using Claude Haiku
- **Earthquakes Panel** — USGS real-time earthquake feed, M4.5+ globally with depth/magnitude coloring
- **ISW/GDACS feeds** — Institute for the Study of War daily situation reports + Global Disaster Alert feeds
- **Live Cyber Threat Map** — IOC visualization layer from Feodo, URLhaus, C2Intel, OTX, AbuseIPDB (500 IOCs, 15-min refresh)
- **Cyber Threats Panel** — sortable IOC table by severity, with type/country/source/age columns
- **Alert Center Panel** — persistent scrollable history of correlation signals and breaking alerts with unread badge
- **World Bank Country Profiles** — GDP, GDP/capita, military %, trade %, population injected into AI country intelligence context
- **Auto-update** — GitHub Releases API polls every 4 hours, `install_update` Tauri command handles DMG extraction

### Added

- Claude AI panel with on-demand intelligence brief (Haiku model, 15-min cache)
- Earthquakes Panel using USGS GeoJSON feed (M4.5+, 30-day window)
- ISW daily situational analysis and GDACS disaster alert feeds
- CyberThreatPanel: severity-coded IOC table (Feodo, URLhaus, C2Intel, OTX, AbuseIPDB)
- AlertCenterPanel: aggregates CorrelationSignals + BreakingAlerts with unread badge counter
- World Bank REST API service (`/v2/country/{iso}/indicator/{indicator}`) for country economic profiles
- Desktop auto-updater checking GitHub Releases every 4h (`install_update` Tauri command)
- Live cyber threat DeckGL ScatterplotLayer enabled by default (`VITE_ENABLE_CYBER_LAYER=true`)

---

## [2.5.21] - 2026-03-01

### Highlights

- **Iran Attacks map layer** — conflict events with severity badges, related event popups, and CII integration (#511, #527, #547, #549)
- **Telegram Intel panel** — 27 curated OSINT channels via MTProto relay (#550)
- **OREF Israel Sirens** — real-time alerts with Hebrew→English translation and 24h history bootstrap (#545, #556, #582)
- **GPS/GNSS jamming layer** — detection overlay with CII integration (#570)
- **Day/night terminator** — solar terminator overlay on map (#529)
- **Breaking news alert banner** — audio alerts for critical/high RSS items with cooldown bypass (#508, #516, #533)
- **AviationStack integration** — global airport delays for 128 airports with NOTAM closure detection (#552, #581, #583)
- **Strategic risk score** — theater posture + breaking news wired into scoring algorithm (#584)

### Added

- Iran Attacks map layer with conflict event popups, severity badges, and priority rendering (#511, #527, #549)
- Telegram Intel panel with curated OSINT channel list (#550, #600)
- OREF Israel Sirens panel with Hebrew-to-English translation (#545, #556)
- OREF 24h history bootstrap on relay startup (#582)
- GPS/GNSS jamming detection map layer + CII integration (#570)
- Day/night solar terminator overlay (#529)
- Breaking news active alert banner with audio for critical/high items (#508)
- AviationStack integration for non-US airports + NOTAM closure detection (#552, #581, #583)
- RT (Russia Today) HLS livestream + RSS feeds (#585, #586)
- Iran webcams tab with 4 feeds (#569, #572, #601)
- CBC News optional live channel (#502)
- Strategic risk score wired to theater posture + breaking news (#584)
- CII scoring: security advisories, Iran strikes, OREF sirens, GPS jamming (#547, #559, #570, #579)
- Country brief + CII signal coverage expansion (#611)
- Server-side military bases with 125K+ entries + rate limiting (#496)
- AVIATIONSTACK_API key in desktop settings (#553)
- Iran events seed script and latest data (#575)

### Fixed

- **Aviation**: stale IndexedDB cache invalidation + reduced CDN TTL (#607), broken lock replaced with direct cache + cancellation tiers (#591), query all airports instead of rotating batch (#557), NOTAM routing through Railway relay (#599), always show all monitored airports (#603)
- **Telegram**: AUTH_KEY_DUPLICATED fixes — latch to stop retry spam (#543), 60s startup delay (#587), graceful shutdown + poll guard (#562), ESM import path fixes (#537, #542), missing relay auth headers (#590)
- **Relay**: Polymarket OOM prevention — circuit breaker + concurrency limiter (#519), request deduplication (#513), queue backpressure + response slicing (#593), cache stampede fix (#592), kill switch (#523); smart quotes crash (#563); graceful shutdown (#562, #565); curl for OREF (#546, #567, #571); maxBuffer ENOBUFS (#609); rsshub.app blocked (#526); ERR_HTTP_HEADERS_SENT guard (#509); Telegram memory cleanup (#531)
- **Live news**: 7 stale YouTube fallback IDs replaced (#535, #538), broken Europe channel handles (#541), eNCA handle + VTC NOW removal + CTI News (#604), RT HLS recovery (#610), YouTube proxy auth alignment (#554, #555), residential proxy + gzip for detection (#551)
- **Breaking news**: critical alerts bypass cooldown (#516), keyword gaps filled (#517, #521), fake pubDate filter (#517), SESSION_START gate removed (#533)
- **Threat classifier**: military/conflict keyword gaps + news-to-conflict bridge (#514), Groq 429 stagger (#520)
- **Geo**: tokenization-based matching to prevent false positives (#503), 60+ missing locations in hub index (#528)
- **Iran**: CDN cache-bust pipeline v4 (#524, #532, #544), read-only handler (#518), Gulf misattribution via bbox disambiguation (#532)
- **CII**: Gulf country strike misattribution (#564), compound escalation for military action (#548)
- **Bootstrap**: 401/429 rate limiting fix (#512), hydration cache + polling hardening (#504)
- **Sentry**: guard YT player methods + GM/InvalidState noise (#602), Android OEM WebView bridge injection (#510), setView invalid preset (#580), beforeSend null-filename leak (#561)
- Rate limiting raised to 300 req/min sliding window (#515)
- Vercel preview origin regex generalized + bases cache key (#506)
- Cross-env for Windows-compatible npm scripts (#499)
- Download banner repositioned to bottom-right (#536)
- Stale/expired Polymarket markets filtered (#507)
- Cyber GeoIP centroid fallback jitter made deterministic (#498)
- Cache-control headers hardened for polymarket and rss-proxy (#613)

### Performance

- Server-side military base fetches: debounce + static edge cache tier (#497)
- RSS: refresh interval raised to 10min, cache TTL to 20min (#612)
- Polymarket cache TTL raised to 10 minutes (#568)

### Changed

- Stripped 61 debug console.log calls from 20 service files (#501)
- Bumped version to 2.5.21 (#605)

---

## [2.5.20] - 2026-02-27

### Added

- **Edge caching**: Complete Cloudflare edge cache tier coverage with degraded-response policy (#484)
- **Edge caching**: Cloudflare edge caching for proxy.worldmonitor.app (#478) and api.worldmonitor.app (#471)
- **Edge caching**: Tiered edge Cache-Control aligned to upstream TTLs (#474)
- **API migration**: Convert 52 API endpoints from POST to GET for edge caching (#468)
- **Gateway**: Configurable VITE_WS_API_URL + harden POST-to-GET shim (#480)
- **Cache**: Negative-result caching for cachedFetchJson (#466)
- **Security advisories**: New panel with government travel alerts (#460)
- **Settings**: Redesign settings window with VS Code-style sidebar layout (#461)

### Fixed

- **Commodities panel**: Was showing stocks instead of commodities — circuit breaker SWR returned stale data from a different call when cacheTtlMs=0 (#483)
- **Analytics**: Use greedy regex in PostHog ingest rewrites (#481)
- **Sentry**: Add noise filters for 4 unresolved issues (#479)
- **Gateway**: Convert stale POST requests to GET for backwards compat (#477)
- **Desktop**: Enable click-to-play YouTube embeds + CISA feed fixes (#476)
- **Tech variant**: Use rss() for CISA feed, drop build from pre-push hook (#475)
- **Security advisories**: Route feeds through RSS proxy to avoid CORS blocks (#473)
- **API routing**: Move 5 path-param endpoints to query params for Vercel routing (#472)
- **Beta**: Eagerly load T5-small model when beta mode is enabled
- **Scripts**: Handle escaped apostrophes in feed name regex (#455)
- **Wingbits**: Add 5-minute backoff on /v1/flights failures (#459)
- **Ollama**: Strip thinking tokens, raise max_tokens, fix panel summary cache (#456)
- **RSS/HLS**: RSS feed repairs, HLS native playback, summarization cache fix (#452)

### Performance

- **AIS proxy**: Increase AIS snapshot edge TTL from 2s to 10s (#482)

---

## [2.5.10] - 2026-02-26

### Fixed

- **Yahoo Finance rate-limit UX**: Show "rate limited — retrying shortly" instead of generic "Failed to load" on Markets, ETF, Commodities, and Sector panels when Yahoo returns 429 (#407)
- **Sequential Yahoo calls**: Replace `Promise.all` with staggered batching in commodity quotes, ETF flows, and macro signals to prevent 429 rate limiting (#406)
- **Sector heatmap Yahoo fallback**: Sector data now loads via Yahoo Finance when `FINNHUB_API_KEY` is missing (#406)
- **Finnhub-to-Yahoo fallback**: Market quotes route Finnhub symbols through Yahoo when API key is not configured (#407)
- **ETF early-exit on rate limit**: Skip retry loop and show rate-limit message immediately instead of waiting 60s (#407)
- **Sidecar auth resilience**: 401-retry with token refresh for stale sidecar tokens after restart; `diagFetch` auth helper for settings window diagnostics (#407)
- **Verbose toggle persistence**: Write verbose state to writable data directory instead of read-only app bundle on macOS (#407)
- **AI summary verbosity**: Tighten prompts to 2 sentences / 60 words max with `max_tokens` reduced from 150 to 100 (#404)
- **Settings modal title**: Rename from "PANELS" to "SETTINGS" across all 17 locales (#403)
- **Sentry noise filters**: CSS.escape() for news ID selectors, player.destroy guard, 11 new ignoreErrors patterns, blob: URL extension frame filter (#402)

---

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
