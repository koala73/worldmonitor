# Desktop / Web Parity Matrix

> Baseline established 2026-07-31 for #5902 from `origin/main` @ `7fc700303`.
> Maintained document: update rows when desktop-coupled behavior changes, and
> re-verify the whole matrix before each desktop release. Supersedes
> `docs/local-backend-audit.md` and `docs/Docs_To_Review/local-backend-audit.md`
> for desktop route coverage (both predate the current routing and cite removed
> files).

**Parity** here means a user-visible web capability is either (1) working in
the supported desktop build, (2) intentionally unavailable with a documented
reason and usable fallback, or (3) tracked by a named blocker. It does not mean
pixel-for-pixel equivalence: the desktop app reuses the SPA.

Classifications: `parity` · `intentional difference` · `blocked` · `n/a`.

## Headline state (2026-07-31)

| Fact | Value | Evidence |
| --- | --- | --- |
| Repo version | 2.10.0 (package.json = tauri.conf.json = Cargo.toml; `npm run version:check` green) | `scripts/sync-desktop-version.mjs` |
| Newest published desktop release | v2.5.23, built from `e51058e17` (2026-03-01); no `-tech` tag has ever been published | GitHub releases; `gh run list` |
| Release delta | ~5 months of `main` unreleased; the unified map-layer catalog (`src/config/map-layer-definitions.ts`, #943) postdates the release entirely | `git show e51058e17` — file absent |
| Shipped-build capability loss | **Fixed by #5905**: all Tauri build steps now declare the desktop-required client `VITE_*` set (Clerk/Convex/cyber + relay/basemap parity keys; web-push VAPID remains intentionally excluded on Tauri), a two-way completeness gate (`scripts/check-desktop-build-env.mjs`, `npm run desktop:check-env`) blocks regressions, and tag-push or published manual releases hard-fail on empty client secrets. Capabilities activate once the repo secrets are provisioned (ops step in the #5905 PR). Historical state: only `VITE_VARIANT`, `VITE_DESKTOP_RUNTIME`, `VITE_WS_API_URL`, `CONVEX_URL` were passed — sign-in, subscription entitlements, web push, and the Cyber Threats layer were silently disabled in every CI-built release | `.github/workflows/build-desktop.yml` build-leg env blocks; `scripts/check-desktop-build-env.mjs` |
| PR CI before #5902 gates | `src-tauri/` (non-sidecar) changes ran **zero** PR CI; `version:check` self-excluded from src-tauri-only diffs; sidecar handler bundling ran only at release time; the inline Rust tests had never run in CI | `test.yml` / `lint-code.yml` change filters |
| PR CI after #5902 gates | `desktop-config` + `desktop-rust` jobs gate desktop-coupled paths; twice-weekly installed-app canary (`Desktop Canary (Linux)`) asserts launch, sidecar readiness, rendered content | this repo, Test workflow |

## Release blockers (tracked)

| Blocker | Issue | Status |
| --- | --- | --- |
| Tauri origin-confusion CVE-2026-42184 (CVSS 8.8): lockfile pins tauri 2.10.3, needs ≥ 2.11.1; `Cargo.toml` carries an unbounded `version = "2"` caret | #5518 | open — release-blocking security finding |
| Desktop build env omits Clerk/Convex/VAPID/cyber `VITE_*` vars → sign-in, Pro, push, Cyber Threats dead in shipped builds | #5905 | fix landed (env declared + completeness gate + release preflight); remaining ops step: provision the four new repo secrets, after which release builds hard-fail if they go empty again |
| Linux secret storage fails without an activatable Secret Service; every keyring error in `SecretsCache::load_from_keychain` is silently swallowed (`if let Ok`), so users get an empty vault with zero diagnostics | #802 / #1905 | open — needs secure fallback + migration + diagnostics |
| Released 2.5.23 lacks Internet Outages / Cyber Threats layers | #5829 | diagnosed — three compounding causes, see row below |
| Desktop readiness/error diagnosability; `src/services/desktop-readiness.ts:64-65` still cites deleted `/api/risk-scores` routes in the Service Status UI; sidecar readiness is assumed on port-file timeout (`main.rs:1443-1452`) rather than verified | #1942 | open — reassess with this evidence |
| AppImage update metadata (AppImageUpdate/zsync) | #5757 | open |
| Uninstall experience | #5435 / #5487 | open |

### #5829 diagnosis (Internet Outages + Cyber Threats missing)

Three compounding causes, none of them SPA desktop-gating:

1. **Release staleness** — v2.5.23 predates the unified layer catalog entirely.
2. **Cyber Threats: build-env omission** — `CYBER_LAYER_ENABLED` requires
   `VITE_ENABLE_CYBER_LAYER === 'true'` (`src/App.ts:155`); `build-desktop.yml`
   never sets it, so even a fresh release today would hide the layer (force-off
   at boot `App.ts:901-903`, toggle hidden `App.ts:1770-1771`).
3. **Internet Outages: keyring capability gating** — on desktop,
   `isFeatureAvailable('internetOutages')` requires a valid
   `CLOUDFLARE_API_TOKEN` in the OS keyring (`src/services/runtime-config.ts:431-444`);
   without it the toggle is hidden (`App.ts:1767-1769`) with no explanatory UI.
   Intentional gating presenting as a missing feature (feeds #1942).

## Capability matrix

Rows classified from code inspection at `7fc700303`. "Desktop" means what the
current code does in a current desktop build — not the stale v2.5.23 binary.

### Runtime & data routing

| Capability | Desktop behavior vs web | Classification | Evidence |
| --- | --- | --- | --- |
| API routing | All `/api/*` calls proxied through the Rust `proxy_local_api_request` command to a bundled Node sidecar on `127.0.0.1:46123` (port-file discovery, default 46123); web uses direct fetch | intentional difference (richer: local-first) | `src/services/runtime.ts:115-126,346-413`; `src-tauri/src/main.rs:25` |
| Cloud fallback | Only with a valid `WORLDMONITOR_API_KEY` in the keyring, except a small key-free allowlist (`register-interest`, `leads/*`, `version`); web N/A | intentional difference — default install is local+anonymous-cloud-free | `src/services/runtime.ts:299-304,367-378` |
| Sidecar route surface | 60 routes: 34 sebuf `{domain}/v1/[rpc].js` (esbuild-bundled at release) + 26 raw `.js`; `.ts`-only routes (87 files) are cloud-only | mixed — see gaps | `src-tauri/sidecar/local-api-server.mjs:531-557`; `scripts/build-sidecar-handlers.mjs` |
| Seed-backed RPC data | **GAP**: sidecar has no Redis credentials; seed-backed handlers return empty 200 locally and the `!ok` cloud fallback never fires; hardcoded `cloudPreferred` covers only market/economic/infrastructure/news/research (5 of 34 domains) + `/api/bootstrap`. 29 domains — incl. all 9 added since v2.5.23 — can serve blank panels | blocked → #5906 | `local-api-server.mjs:686-705,1764-1767`; `server/_shared/redis.ts:86-88` |
| `api/v2/shipping` family | **GAP**: invisible to the handler-build glob (`api/{domain}/v1/[rpc].ts` only); cloud-only + Pro-gated on desktop, undeclared | blocked → #5907 | `scripts/build-sidecar-handlers.mjs:26-29`; `src/shared/premium-paths.ts:52-53` |
| Non-`[rpc]` sibling routes (`scenario/v1/run`…, `supply-chain/v1/country-products`…) | Mis-routed to the local `[rpc].js` bracket match, recovered via cloud fallback — works but wastes a local round-trip | blocked (minor) → #5906 | `local-api-server.mjs:483-529,1764-1767` |
| Bootstrap timing | Longer budgets (fast tier 5s vs 1.2s; slow 8s vs 3s); boot awaits sidecar readiness poll (3s) | intentional difference | `src/services/bootstrap.ts:427,333`; `src/App.ts:1189,1377-1381` |
| Widget agent (SSE) | Bypasses sidecar entirely → Railway relay direct (sidecar buffering breaks SSE) | intentional difference | `src/utils/proxy.ts:16-32` |
| Geolocation | Skips `/api/geo`; timezone inference instead | intentional difference | `src/utils/user-location.ts:84-93` |
| Anonymous `wms_` HMAC session | Web-only | intentional difference | `src/App.ts:1389-1394` |

### Panels, map layers, variants

| Capability | Desktop behavior vs web | Classification | Evidence |
| --- | --- | --- | --- |
| Map layer catalog | Identical shared registry; no desktop gating of `outages`/`cyberThreats` entries (see #5829 diagnosis for why they still don't show) | parity in code; blocked in shipped builds | `src/config/map-layer-definitions.ts:80-81` |
| Desktop-locked panels | `forecast`, `oref-sirens`, `telegram-intel` locked; `cii`, `strategic-risk`, `gdelt-intel`, `supply-chain` downgraded to enhanced | intentional difference (documented here as the fallback statement) | `src/config/panels.ts:32-36,64,118-119` |
| Layers not loaded on desktop | AIS, Iran attacks, GPS jamming (premium/relay-dependent); military flights uses direct OpenSky w/ 15-min cache instead of proto RPC | intentional difference | `src/app/data-loader.ts:1050,1055,3138`; `src/services/military-flights.ts:63-72` |
| Variant selection | Web: hostname. Desktop: `localStorage` override with in-app switching (reload in place), falling back to build-time `VITE_VARIANT` | intentional difference | `src/config/variant.ts:20-38`; `src/app/event-handlers.ts:1594-1598` |
| Variant switcher scope | **GAP**: switcher accepts commodity/energy, but no desktop artifact, updater variant, or package path exists for them (updater knows full/tech/finance; packaging stops at full/tech) | blocked → #5908 | `variant.ts:23`; `src/app/desktop-updater.ts:15-21`; `scripts/desktop-package.mjs:23` |
| Runtime-config panel | Force-enabled on desktop boot; hidden on web | intentional difference | `src/App.ts:881-892`; `src/settings-window.ts:63` |
| Runtime detection | **GAP (cosmetic/dev)**: two detectors disagree — `isDesktopRuntime()` (VITE flag + broad heuristics) vs raw `__TAURI__` checks in 6 files; split-brain under `desktop:dev` early boot and `VITE_DESKTOP_RUNTIME=1` browser builds | blocked (minor) → #5912 | `src/services/runtime.ts:72-113`; `src/config/variant.ts:20` |

### Auth, billing, entitlements

| Capability | Desktop behavior vs web | Classification | Evidence |
| --- | --- | --- | --- |
| Clerk sign-in | No desktop gating in code; CSP allowlists Clerk — but **dead in shipped builds** (missing `VITE_CLERK_PUBLISHABLE_KEY`) | blocked → #5905 | `src/services/clerk.ts:30-49,233-236`; `src-tauri/tauri.conf.json:32` |
| Convex entitlements | Same pattern: `VITE_CONVEX_URL` missing from the desktop build (workflow passes non-`VITE_` `CONVEX_URL`, which never reaches the client) | blocked → #5905 | `src/services/entitlements.ts:96-99`; `vite.config.ts` (no define) |
| Premium access | `WORLDMONITOR_API_KEY` from keyring is the only working Pro path in shipped builds; sidecar attaches the key natively (renderer skip is by design) | parity for key users; blocked for subscribers | `src/services/panel-gating.ts:53-58`; `src/services/premium-fetch.ts:223-237` |
| Billing portal / checkout | **GAP**: `openBillingPortal()` and `startCheckout()` have no desktop branch — they navigate/pop the WebView instead of `open_url` to the OS browser; checkout return URL is built from `window.location.origin` (a `tauri://`/localhost origin on desktop); several upgrade entry points likewise unguarded | blocked → #5911 | `src/services/billing.ts:338-357`; `src/services/checkout.ts:886,1048-1051` |
| #5901 unified user menu | No desktop-specific handling; hosts the billing surface above; menu itself requires Clerk (so absent from shipped builds until the env fix lands) | inherits the two rows above | `src/app/event-handlers.ts:1963` (commit `53181fb71`) |
| Locked-panel affordances | `isPanelEntitled` returns entitled for `premium:'locked'` on any desktop runtime; real gates use `hasPremiumAccess()` so leak is cosmetic (settings picker / CMD+K / analyst offer panels that render locked) | intentional-ish, cosmetic; noted for the desktop UX pass | `src/config/panels.ts:1243-1245`; `src/app/panel-layout.ts:2150` |

### Settings & secrets

| Capability | Desktop behavior vs web | Classification | Evidence |
| --- | --- | --- | --- |
| Secret storage | OS keyring via consolidated `secrets-vault` JSON entry (one prompt), 29 allowlisted keys, plaintext never returns to renderer; web: no-op | intentional difference (desktop richer) | `src-tauri/src/main.rs:38-68,110-161`; `src/services/runtime-config.ts:456-460,528-548` |
| Linux keyring | **blocked** — #802/#1905 (see blockers) | blocked | `main.rs:110-161` silent `if let Ok` |
| Feature availability | Desktop requires every declared secret valid locally (25 runtime features); web defers to server | intentional difference | `src/services/runtime-config.ts:431-444` |
| Dedicated settings window | Desktop-only `settings.html` window with cross-window `wm-secrets-updated` sync | intentional difference | `src/settings-main.ts`; `runtime-config.ts:394,474` |
| Local LLM / Ollama | Desktop-first: ML worker always on, Insights hardcodes cloud+browser models | intentional difference | `src/App.ts:1323-1324`; `src/components/InsightsPanel.ts:352` |
| Cloud prefs sync | Fully disabled on desktop | intentional difference — local settings stay local | `src/utils/cloud-prefs-sync.ts:185-187` |

### Live channels, links, media

| Capability | Desktop behavior vs web | Classification | Evidence |
| --- | --- | --- | --- |
| External links | Capture-phase interceptor rewrites cross-origin anchors to `open_url` (https-only + localhost http); GHSA-2x6r-safe opener | intentional difference (trusted path); covered by `src-tauri/open-url-safety.test.mjs` | `src/app/event-handlers.ts:724-750`; `src-tauri/src/main.rs:732-745` |
| YouTube embeds | Local sidecar embed bridge (`/api/youtube-embed`) to dodge `tauri://` origin error 153, runtime fallback to cloud bridge, dedicated login window for auth-walled streams | intentional difference | `src/components/LiveNewsPanel.ts:389-394,1589-1594,1688-1692` |
| Fullscreen button | Not wired on desktop | intentional difference (minor); document in UX pass | `src/app/event-handlers.ts:669` |

### Updates, notifications, PWA

| Capability | Desktop behavior vs web | Classification | Evidence |
| --- | --- | --- | --- |
| Update discovery | Custom 6-hourly poll of `api.worldmonitor.app/api/version` (no Tauri updater plugin, no signed update artifacts); per-arch download via `/api/download` | intentional mechanism; **blocked on correctness** — see #5908 (`-tech` tag would NaN-poison `isNewerVersion`; both endpoints read only `/releases/latest`) | `src/app/desktop-updater.ts:26,73-75,112-162`; `api/version.js:13`; `api/download.js` |
| Web push / service worker | Intentionally desktop-excluded (Tauri check) and doubly so via missing `VITE_VAPID_PUBLIC_KEY` | intentional difference — fallback: in-app alerts | `src/services/push-notifications.ts:42`; `src/main.ts:496` |
| Breaking-news alerts | Run on desktop; posted via raw XHR to bypass the fetch interceptor | parity | `src/services/breaking-news-alerts.ts:214-228` |
| Stale-bundle check | Web-only (desktop has the updater instead) | intentional difference | `src/main.ts:405` |
| Persistent cache | Tauri file storage instead of IndexedDB, with browser fallback; 1 KiB key / 5 MiB value bounds enforced in Rust | intentional difference | `src/services/persistent-cache.ts:123-219`; `src-tauri/src/cache_bounds.rs` |

## Release/packaging drift register

Condensed from the release-infra audit; each row feeds a child issue or the
release-candidate checklist:

1. Variant release model structurally broken: `/api/version` + `/api/download`
   read only `/releases/latest`; `-tech` tags build the **full** variant on tag
   push; release-notes step targets the wrong tag; `workflow_dispatch` default
   `draft: true` makes builds invisible to the endpoints; finance is advertised
   (`api/download.js:21`, docs) but unbuildable (workflow + packager stop at
   full/tech). → #5908.
2. Bundled Node 22.14.0 vs CI Node 24 everywhere; SHASUMS fetched without GPG
   verification. → #5909.
3. README/docs drift: "Stable" label, missing Linux ARM64 row, `windows-exe`
   badges vs `windows-msi` in-app, wrong updater host/TTL in
   `docs/desktop-app.mdx`, phantom 50 MB cap in `docs/usage-rate-limits.mdx`,
   `api/api-route-exceptions.json` misdescribing `api/fwdstart.js`, no Linux
   packaging doc. → #5910.
4. macOS updater artifacts (`.app.tar.gz`) ship without `.sig` — no signed
   update chain. Documented as unsigned fallback; revisit with the release
   train. → tracked in #5902 §3.

## Drift prevention (current state)

- `desktop-config` (Test workflow): version consistency, release AppImage
  post-processing script syntax, and Tauri config/capability JSON parse — on
  any `src-tauri/**`, version-file, packaging-script, or desktop-workflow
  change.
- Sidecar handler bundle build + per-domain output assertion (Test workflow,
  `unit` job): runs on every code PR, because the bundled handlers' esbuild
  import graph spans `src/` and `server/` via the `@/` alias — a narrower
  path filter would miss bundle-breaking changes.
- `desktop-rust` (Test workflow): `cargo test --locked` (the previously
  never-in-CI inline tests in `main.rs` / `cache_bounds.rs`) on Rust-affecting
  changes.
- `Desktop Canary (Linux)`: twice-weekly scheduled installed-app run from
  current `main` — hard-fails on crashed app, unreachable sidecar
  (127.0.0.1:46123 probe), or blank render; screenshots/logs always uploaded.
- Cross-platform artifact builds + smoke remain on release candidates
  (`build-desktop.yml`).
- Desktop build-env parity (`scripts/check-desktop-build-env.mjs`): discovers
  every Tauri workflow, scans syntax-aware `VITE_*` property reads, and runs in
  both the workflow-change and source-change CI legs; a route-table contract
  test asserting every `server/worldmonitor/` domain has an explicit
  desktop-path decision remains a future candidate.
