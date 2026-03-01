# Changelog

All notable changes to World Monitor are documented here.

## [2.5.22] - 2026-03-02

### Highlights

- **AI Deduction & Forecasting** — interactive LLM-powered geopolitical analysis with live headline context injection and cross-panel deep-linking (#636, #642)
- **Headline Memory (RAG)** — opt-in browser-local vector store that embeds every RSS headline via ONNX, enabling semantic search across 5,000 headlines in IndexedDB (#675)
- **Server-side feed aggregation** — single `listFeedDigest` RPC replaces per-client feed fan-out, reducing Vercel Edge invocations by ~95% (#622)
- **Gulf Economies panel** — live GCC indices, currencies, and oil prices with sparklines (#667)
- **18+ HLS native channels** — Fox News, ABC News AU, NHK World, TV5Monde, Tagesschau24, India Today, KAN 11, and more bypass YouTube iframes entirely (#660, #682, #689)
- **Mobile-native map** — touch pan with inertial animation, pinch-to-zoom, bottom-sheet popups, and timezone-based region detection (#619)
- **Locale-aware feed boost** — new installations start with ~101 curated sources; non-English users automatically get native-language feeds enabled (#699)

### Added

- AI Deduction panel — free-text geopolitical queries answered by LLM with auto-populated headline context, Redis-cached results (1h TTL), and `wm:deduct-context` event for cross-panel triggering (#636, #642)
- Headline Memory (RAG) — opt-in ONNX embedding pipeline (`all-MiniLM-L6-v2`, 384-dim) in Web Worker, IndexedDB vector store with 5K cap and LRU eviction, cosine-similarity search (#675)
- Server-side feed aggregation via `listFeedDigest` RPC — batched 20-concurrent fetches, 15-min digest cache, per-feed 10-min cache, keyword classification at aggregation time (#622)
- Gulf Economies panel with GCC indices (Tadawul, DFM, Abu Dhabi, Qatar, Muscat MSM 30), currencies (SAR/AED/QAR/KWD/BHD/OMR vs USD), and oil (WTI/Brent) (#667)
- Native mobile map experience — single-finger pan with 8px threshold and inertial velocity (0.92 decay), two-finger pinch-to-zoom, bottom-sheet popup with drag-to-dismiss, timezone-based region detection (#619)
- Smart default source reduction (~101 from 150+) with one-time locale-aware boost for 17 languages (#699)
- Fox News HLS stream + fullscreen toggle for Live News panel (#689)
- CNN & CNBC HLS streams via sidecar proxy (#682)
- Expanded live channels with HLS support, Oceania region tab (ABC News AU), and YouTube fallbacks — 18+ total HLS channels (#660)
- Cache-purge admin edge function — targeted Redis key deletion with HMAC auth, glob patterns, dry-run mode, and protected prefix safeguards (#657)
- Badge pulse animation with settings toggle (opt-in, default off) (#676)
- Breaking news click-through — banner click scrolls to source panel with 1.5s flash highlight (#690)
- OREF history persistence to Redis with two-phase bootstrap (Redis-first → upstream retry with exponential backoff) (#674)
- 1,478 Hebrew→English OREF location translations from pikud-haoref-api cities.json (#661)
- OREF sirens wired into breaking news banner (#661)
- Conditional GET (ETag/If-Modified-Since) on Railway relay RSS feeds (#625)
- Asharq News & Business feeds added to Middle East category (#683)
- Oman Observer and NDTV feeds + NDTV live TV (#650)
- Redis caching for GPS jamming data (#646)
- 104 missing Italian and Spanish translation keys (#687)
- Missing translations backfilled for 17 locales (#692)

### Fixed

- **OREF**: sanitize Hebrew Unicode control chars (bidirectional marks, zero-width spaces) for reliable translation (#694), grab newest history records and preserve bootstrap data (#653), show history count in badge and stop swallowing fetch errors (#648)
- **Live news**: remove LiveNOW from FOX channel (YouTube error 150) (#693)
- **Mobile**: improve responsiveness — collapsible map, panel sizing, font bump (#688)
- **PWA**: stop auto-reload on service worker update (#686)
- **Sentry**: triage 10 unresolved issues — 2 code fixes + 8 noise filters (#681), add noise filters for 7 more unresolved issues (#698)
- **Country intel**: align strike/aviation matching with CII bounds fallback (#677)
- **Market**: replace dead Yahoo Finance Gulf index tickers (#672)
- **CI**: strip bundled GPU/Wayland libs from AppImage to fix black screen on non-Ubuntu distros (#666)
- **Map**: stabilize deck.gl layer IDs to prevent interleaved-mode null crash (#664), sync layer toggles to URL for shareable links (#621)
- **Finance**: restore 6 missing news categories + add finance favicons (#654)
- **Server**: cache hardening across 27 RPC handlers (#651)
- **Aviation**: prevent AviationStack API quota blowout (#623), increase cache TTL from 30min to 2h (#617)
- **Desktop**: route register-interest to cloud when sidecar lacks CONVEX_URL (#639), backoff on errors to stop CPU abuse + shrink settings window (#633)
- **Linux**: sanitize env for xdg-open in AppImage (#631)
- **Sidecar**: add AVIATIONSTACK_API and ICAO_API_KEY to env allowlist (#632)
- **Military**: narrow ICAO hex ranges to stop civilian false positives (#627)
- **Sentry**: null guards for classList teardown crashes + noise filters + regex fix (#637), guard pauseVideo optional chaining + 4 noise filters (#624)
- Remove accidental intelhq submodule entry (#640)

### Performance

- Lazy-load DeductionPanel to exclude DOMPurify from web bundle (#685)
- Optimize DeckGLMap pan/zoom by deferring work off hot path (#620)
- Raise news refresh interval to 10min and cache TTL to 20min (#612)
- Bump all sub-5min cache TTLs and polling intervals (#626)

### Changed

- Cost/traffic hardening, runtime fallback controls, and PostHog removal — replaced with Vercel Analytics (#638)
- Investments panel redesigned with card layout and collapsible filters (#663)
- Harden cache-control headers for polymarket and rss-proxy (#613)
- Bumped version to 2.5.22
- Comprehensive README update documenting 15+ unmentioned features with 21 new roadmap items

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
