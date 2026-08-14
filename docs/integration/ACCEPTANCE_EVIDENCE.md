# Acceptance Evidence

## Phase 0 — Safety inventory, backup and workspace decision

**Closure time:** 2026-08-11T16:47:20+08:00
**Phase documentation commit:** `81369e41cfd0e3dd454dbd37ae3739b5aa53b056` (`chore(integration): record Phase 0 safety inventory`)
**Phase closure-evidence receipt:** `8cf5937b8c4bad406e7c64eba8e50a51ac473ce6` (`docs(integration): close Phase 0 evidence gate`)

| Check | Result | Evidence |
|---|---|---|
| Legacy project preserved | PASS | Original directory remains `D:\使用AI专属文件夹\global-intelligence-earth\全球热点追踪`; no Git repository was initialized or source file removed |
| Recoverable legacy checkpoint | PASS | `D:\使用AI专属文件夹\global-intelligence-earth\backups\old-simplified-pre-worldmonitor-mother-20260811-161129`; Robocopy completed with exit 1 (files copied), 5,900 files, 1.828 GB; closure audit rechecked 20 deterministic non-sensitive files and three restored representative files |
| New mother workspace | PASS | `D:\使用AI专属文件夹\global-intelligence-earth\worldmonitor-integrated` created independently from the fork |
| Main protection | PASS | `main` remains at `0fca203c776dd5fa4913c4bd52f99cd2c3c13a25`; Phase 0 work is on `integration/phase0-safety-inventory`; backup branch `backup/pre-worldmonitor-mother-20260811-162026` exists |
| GitHub repository authority | PASS | Connected GitHub app reports `daking32168-byte/worldmonitor` with admin, maintain, pull and push permissions |
| Origin SHA lock | PASS | `0fca203c776dd5fa4913c4bd52f99cd2c3c13a25` through local clone and GitHub app |
| Official upstream SHA lock | PASS (connector) | `ae0a0fe26bcbdb683b366899e4dc38fb8ccfb5ad` through connected GitHub app; local fetch deferred to Phase 1 due checkout transport limit |
| PokieTicker SHA lock | PASS | `c16b7e34e72c2d09bb50d7b3159fa5cd6697fd19` through connected GitHub app |
| PokieTicker database baseline | PASS | SHA-256 `F50090BF859F71A24A210120F9F92407DE3EA6E6B469E814858C69ADBC9DD47C`; 226,844,672 bytes; 53,025 OHLC rows; maximum date `2026-03-03` |
| Destructive action check | PASS | No `reset --hard`, force push, source deletion, old-project overwrite, main commit or new provider credential used |
| Working-tree and branch closure | PASS | Isolated-index `git status --short --branch` was clean; `integration/phase0-safety-inventory` is ahead 1 of `origin/main`; `main` and `backup/pre-worldmonitor-mother-20260811-162026` both remain at `0fca203...` |
| Backup 20-file integrity sample | PASS | Fixed seed `20260811`; 5,876 non-sensitive files no larger than 2 MiB were eligible; all 20 selected files existed and were SHA-256 hashed. See `evidence/phase0-closure.md`. |
| Read-only restoration probe | PASS | `README.md`, `frontend/package.json`, and `backend/package.json` copied from the backup to a Codex-created temporary directory and each source/destination SHA-256 pair matched. See `evidence/phase0-closure.md`. |
| Staged-artifact and secret gate | PASS | No staged files before the backfill; `git diff --cached --check` exited 0. Targeted scans for AWS, GitHub, OpenAI-style, Google, and Slack key patterns found no values. No SQLite is in the Phase 0 diff. |

## Observed environment constraints

- A full Git clone and a filtered fetch exceeded the 64-second tool command limit. The process tree was verified as agent-created and stopped only after it held the new workspace lock without progress; no user process was terminated.
- The host rejected a direct removal of the stale Git lock file. A separate Git index enabled a clean sparse checkout without bypassing that host protection.
- A first Python SQLite query passed the Chinese path directly and failed to open it; the read-only query was then repeated using a Unicode environment variable and succeeded. The database was never written.
- The normal Git index is absent and `.git/index.lock` remains host-protected. All Phase 0 Git verification used the Git-native isolated index `.git/index.phase0`; it reports a clean source worktree. No source files were deleted.
- The host rejected the explicitly scoped PowerShell cleanup of the Codex-created temporary restoration directory. The exact directory is recorded in `evidence/phase0-closure.md`; it contains only the three copied representative files and is not part of either project or Git worktree.

## Phase 0 gate

**PASS.** Legacy checkpoint is recoverable by sampled hash evidence, the formal workspace is explicit, source locks are recorded, the Phase 0 documentation commit is recorded above, and no destructive overwrite occurred.

## Phase 1 preflight — not completed

| Check | Result | Evidence |
|---|---|---|
| AGPL and independent-brand user confirmation | PASS (direct user message) | User explicitly replied that both confirmations are `我确认`. The persisted panel still contains `未确认`; no unobserved file edit is claimed. |
| Remote fork/upstream ancestry | PASS (connected GitHub app) | Compare `0fca203...` to `ae0a0fe...`: `status=ahead`, `ahead_by=43`, `behind_by=0`, merge-base `0fca203...`. This is remote evidence, not a substitute for local Git object verification. |
| Local origin history expansion | FAIL | `git fetch --deepen=100 origin main` reported `Recv failure: Connection was reset`; `origin/main` remains one commit deep and the repository remains shallow. The outer PowerShell wrapper exited 0 because it did not propagate the inner Git status; this is logged as a failed fetch, not a pass. |
| Local upstream object fetch | FAIL | HTTP/1.1 fetch to `upstream/main` exited `128`: `Failed to connect to github.com port 443 after 21059 ms`. No `refs/remotes/upstream/main` was created. |
| Local GitHub connectivity | FAIL | `Test-NetConnection github.com -Port 443` timed out at 30 seconds; TCP connect and ping reported failure. |
| Full mother checkout / dependency baseline / browser baseline | BLOCKED | These steps are intentionally not run without the verified upstream object graph and complete source tree. |

**Phase 1 preflight gate: superseded by the actual implementation below.**

## Phase 1 implementation baseline

**Implementation commit:** `c889fcfbdab4bf2bcd7a28f85ed32114f288d6aa` (`chore(integration): establish WorldMonitor mother baseline`).

| Check | Result | Evidence |
|---|---|---|
| Local fork/upstream ancestry | PASS | Local fetches exited 0; merge-base `0fca203...`; count `0 43`; upstream lock `ae0a0fe...`. |
| Main protection and branch isolation | PASS | `main` was not moved; the integration branch was created from upstream in a dedicated LF linked worktree. |
| AGPL, independent brand and upstream notice | PASS | Direct user confirmation; visible product header/footer, notices, contract test and screenshot. |
| PokieTicker source trace | PASS | Locked MIT text and trace; no source/database import. |
| Root types and focused contracts | PASS | `npm run typecheck:all=0`; targeted brand/metadata/Windows-copy groups passed. |
| DOM suite | PASS | `npm run test:dom=0`: 31 files, 293 tests. |
| Full data suite | INCONCLUSIVE, not pass | `npm run test:data` exceeded the 64-second tool limit; its normal final exit was not captured. The observed UCDP child rerun passed 12/12. |
| Production build | PASS | Final `npm run build:full=0` on Windows. |
| Production visual check | PASS | Final build preview title/header/footer checked; `evidence/phase1-production-preview.png` stored. |
| Truthfulness rules | PASS for Phase 1 scope | No Provider/key/live quote/K-line/AIS cargo assertion/causal claim/iframe/mock production acceptance was added. |

**Phase 1 gate: COMPLETED WITH A RECORDED DATA-SUITE LIMITATION.** The local
mother baseline, legal/source provenance, code build and visible product check
pass. The all-suite data result must be rerun in CI or a long-running
environment before release-wide test certification.

## Phase 2 — data contract and honest disabled state

**Implementation commit:** `2df9ef0a133564789bb398d7a9f363de171e78b8`
(`feat(market): establish truthful stock data contracts`).

| Check | Result | Evidence |
|---|---|---|
| Eight contract RPCs and generated client/server/OpenAPI | PASS | Official Buf/sebuf generation completed; Market client/server, request validation, Market OpenAPI and bundle updated. |
| New protobuf contract lint | PASS | Scoped `buf lint` across the nine new market protocol files exited 0. |
| Whole repository protobuf lint | BASELINE LIMITATION | Exited 100 on pre-existing unused-import and intelligence `go_package` errors outside this Phase 2 diff; none originated in the new market protocols. |
| API gateway contract | PASS | `npm run lint:api-contract=0`; 148 API files checked, 96 query parameters checked. |
| No-key disabled state | PASS | Generated route returns HTTP 200 with `PROVIDER_STATUS_NOT_CONFIGURED`, provenance fields and empty/no-value result; it returns no synthetic bar or quote. |
| Invalid symbol rejection | PASS | Generated `GetStockBars` route rejects `AAPL;DROP` with HTTP 400. |
| Symbol/cache/bar isolation | PASS | Focused test verifies distinct cache keys for AAPL/MSFT/NVDA/TSLA, cross-symbol rejection, timestamp/OHLC/volume invariants, and no disabled-state bars. |
| Historical fixture honesty | PASS | Isolated AAPL/MSFT/NVDA/TSLA data is sourced from the locked PokieTicker SQLite snapshot, marked `HISTORICAL_SNAPSHOT`, and is used only to test distinct valid OHLC shapes. |
| Types, focused API tests and production build | PASS | `npm run typecheck:all=0`; focused six-test suite passed; `npm run build:full=0`. |
| Production visual claim | NOT APPLICABLE | Phase 2 establishes contracts, not a stock workspace. No mock screen or fixture screenshot is claimed as production UI acceptance; that visual gate belongs to Phases 3–4. |

**Phase 2 gate: COMPLETED WITH A RECORDED BASELINE-LINT LIMITATION.** All new
contract, generation, API, truthfulness and production-build gates pass. The
whole-tree protobuf lint remains an upstream baseline issue and is not counted
as a pass.

## Phase 3 — authorized stock relay and truthful provider boundary

**Implementation commit:** `9cb8cb6efe2164891ea26cb6b2f51b6a3da086b0`
(`feat(market): add authorized stock relay safeguards`). The follow-up
documentation receipt will record its own SHA separately.

| Check | Result | Evidence |
|---|---|---|
| GitHub service and local transport recheck | PASS | Connected GitHub app read both repositories; local `git -c http.version=HTTP/1.1 fetch --no-tags origin main` and the matching `upstream main` command both exited 0 and retained `0fca203...` / `ae0a0fe...`. |
| Massive REST adapter and source attribution | PASS | Server-only adapter uses Massive documented REST paths for aggregates, ticker reference and news; generated source manifest records `api.massive.com` and `massive.com` as terms-review sources. |
| Server-only relay / no client secret | PASS | Upstream WebSocket authentication occurs only in `market-stream-relay.ts`; the same-origin SSE route has no browser key field. Focused relay tests assert auth remains upstream-only. |
| Symbol isolation and anti-fake-bar gate | PASS | Focused tests cover AAPL/MSFT/NVDA/TSLA distinct recorded historical shapes, wrong-provider ticker rejection, distinct windows, strict symbol cache keys, invalid OHLC rejection and six-bar flatline rejection. Fixtures are test-only and explicitly historical. |
| Session and entitlement state | PASS | Tests cover Sunday and Christmas closure, missing entitlement no-socket state, and explicit `NOT_CONFIGURED` / `DELAYED_UNVERIFIED` results. The calendar includes named US closures and early closes. |
| Provider failure behavior | PASS | A Massive bar failure yields `UNAVAILABLE` empty bars; only an explicitly labelled delayed/unverified quote fallback may be returned. No fallback array or synthetic K-line is produced. |
| Type check | PASS | `npm run typecheck:all` exited 0. |
| Focused stock/realtime suite | PASS | `node --import tsx --test tests/stock-data-contract.test.mts tests/stock-realtime-adapter.test.mts` exited 0: 14/14 tests passed. |
| Phase-scoped lint | PASS | Biome lint over the Phase 3 source/API/test files exited 0. |
| API contract and client-secret gate | PASS | `npm run lint:api-contract` and `npm run security:vite-env-secrets -- --strict-local` both exited 0. The SSE exception is documented because it is a non-unary protocol endpoint. |
| Attribution verification | PASS | `npm run sources:generate` and `npm run sources:check` exited 0. The generator's Windows entrypoint guard was corrected so its own script executes when `process.argv[1]` contains backslashes. |
| Production build | PASS | `npm run build:full` exited 0. It emitted only the repository's normal dynamic-import/chunk-size warnings. |
| Whole-tree lint | BASELINE LIMITATION | `npm run lint` remains non-zero on pre-existing upstream diagnostics outside the Phase 3 paths. The strict Phase 3 scoped lint passed and is the gate used for this diff. |
| Native pre-commit gate | PASS | The implementation commit ran the repaired repository pre-commit script; staged Unicode safety scanned 45 files with no suspicious hidden Unicode. |
| Licensed-live UI/browser proof | NOT CLAIMED | No `MASSIVE_API_KEY` or display/rebroadcast confirmation was provided. No browser screenshot, tick latency, or eight-symbol live-data result is represented as complete. |

**Phase 3 gate: COMPLETED FOR CODE AND AUTOMATED TRUTHFULNESS CHECKS.** The
licensed-live manual acceptance remains a separate, intentionally unsatisfied
gate: it requires an authorized Provider account/secret and a visible test of
AAPL, MSFT, NVDA, TSLA, AMZN, GOOGL, META and BABA with captured provenance,
timestamps and screenshots.

## Phase 4 — native stock workspace, scroll and responsive truthfulness

**Implementation commit:** `f86fbce81b287a62d0af73a126dae8521aa7bc68`
(`feat(stock): add native truthful research workspace`).

| Check | Result | Evidence |
|---|---|---|
| Native route ownership | PASS | `/stocks` and valid `/stocks/:symbol` route before the dashboard app; focused route test passed. |
| Priority securities and navigation | PASS | AAPL/MSFT/NVDA/AMZN/GOOGL/META/TSLA/BABA are first; browser click changed to `/stocks/MSFT` and the heading became `MSFT`. |
| Provider-only global search | PASS | `7203` yielded `没有收到可验证的搜索结果` with zero result buttons when the Provider was unconfigured. No static company catalogue was used. |
| No fake K-line / no cross-symbol fallback | PASS | Browser observed zero synthetic candle markers; empty AAPL/MSFT charts state the unconfigured Provider rather than rendering a fixture or another symbol. Existing focused contract/realtime suite passed 15/15. |
| Vertical scroll regression | PASS | Browser measured a dedicated `.pokie-workspace` scroller and reached its bottom through a real wheel event at 1440×900. |
| Responsive layouts | PASS | Browser evidence captured 1440×900, 1280×720 and 390×844. Mobile has no document horizontal overflow; all three retain workspace vertical scrolling. |
| Type/contract/build gates | PASS | `npm run typecheck:all=0`; scoped Biome=0; `npm run build:full=0`. |
| Whole-tree lint | PASS with upstream warnings | `npm run lint=0`; 33 warnings and 9 infos, no error. The strict scoped Phase 4 lint passed. |
| Licensed-live browser acceptance | NOT CLAIMED | No market secret, Provider response, display/rebroadcast entitlement, timestamp/latency or actual K-line is represented as live. |

**Phase 4 gate: COMPLETED FOR NATIVE UI, RESPONSIVE INTERACTION AND
NO-PROVIDER TRUTHFULNESS.** The later provider-backed acceptance must prove
actual symbol-specific bars, provider/source, observed/as-of time, freshness
and commercial display/rebroadcast entitlement before any real-time statement
is made.

## Phase 5 — news evidence, calendar alignment and causal-language boundary

**Implementation commit:** `7efd2e4a55f547e53943281b62ece403af8674e3`
(`feat(market): add evidence-linked stock news alignment`).

| Check | Result | Evidence |
|---|---|---|
| Source-preserving news contract | PASS | `StockNewsItem` now retains a validated provider source/URL/UTC time and nests `StockNewsAlignment` plus a separately unavailable-or-versioned `StockNewsAnalysis`. |
| Trading-date rule | PASS | Focused tests prove pre-market/regular same-day mapping, Friday after-hours to Monday, weekend to next trading day and 2026 Christmas closure to 2026-12-28 under the named US calendar. |
| No false model result | PASS | No-key analysis is `NOT_CONFIGURED` / `NEWS_SENTIMENT_UNAVAILABLE`; model sentiment, relevance, causal confidence and category are not rendered as factual labels. |
| Fact-only range metrics | PASS | Start/end close, range return, total volume and bar count are supplied only for validated symbol-specific bars; the causal note rejects causal inference. |
| Focused contract/adapter/UI suite | PASS | `stock-news-evidence`, `stock-data-contract`, `stock-realtime-adapter` and `stock-workspace-route` passed 20/20. |
| API/type/source/DOM/build gates | PASS | Buf scoped lint, `npm run typecheck:all`, `lint:api-contract`, `sources:check`, `test:dom` and `build:full` all exited 0. |
| Whole-tree lint | PASS with upstream warnings | `npm run lint` exited 0 with the existing 33 warnings and 9 infos; safe HTML guard passed. |
| No-provider browser acceptance | PASS for fail-closed state | `phase5-news-evidence-no-provider-1440x900-final.png` shows the scrollable AAPL workspace, no verified K-line, zero synthetic markers and zero news items. |
| Provider-backed article/model/live-price acceptance | NOT CLAIMED | No market entitlement, provider article, model credential, returned model version, live bar or causal claim was available. |

**Phase 5 gate: COMPLETED FOR CONTRACT, CALENDAR, FACT-ONLY METRICS AND
NO-PROVIDER TRUTHFULNESS.** It is not provider-backed financial/news/model
acceptance. The exact commands, results and the corrected failed setup attempts
are retained in `evidence/phase5-news-alignment.md`.

## Phase 6 - maritime logistics, AIS and supply-chain boundaries

**Implementation commit:** `d361ee8a48e449f73be916e3a6a992cb66c9f8be`
(`feat(maritime): add truthful logistics workspace`).

| Check | Result | Evidence |
|---|---|---|
| Native owned route and entry | PASS | `/maritime-logistics` is loaded before the dashboard shell and the Market panel contains a native “海运物流” anchor. No iframe or copied upstream UI is used. |
| Bounded focus behavior | PASS | Suez, Panama, Malacca, Hormuz, Bab el-Mandeb and Dover bounds are each no larger than 10 degrees; browser selection of Hormuz updated URL and panel title. |
| AIS validation / no global fallback | PASS | Focused route tests reject invalid MMSI, missing timestamps and out-of-box reports; latest record wins per MMSI and at most 250 verified reports render. |
| No-key/no-relay state | PASS | Browser observed zero vessel dots and the explicit verified-snapshot unavailable state. No random/static vessels, cargo, ETA, destination or other invented fields render. |
| AIS truth boundary | PASS | UI and lineage state that AIS supports self-reported broadcast fields only, not cargo/origin/buyer/value/discharge/BOL facts. Current Maritime v1 omission of IMO/destination/ETA/draft is disclosed rather than guessed. |
| Separate PortWatch, warning and route layers | PASS | PortWatch/supply conditions, official alerts and Shipping v2 model/registry estimates each have their own unavailable state and labels. A route estimate is not presented as an actual ship track. |
| Relay and upstream service safeguards | PASS | AIS relay health/reconnect suite 20/20; PortWatch and Shipping v2 contracts 61/61. |
| Type, DOM, API and attribution gates | PASS | typecheck, 7 focused route/UI tests, DOM 293/293, API contract and source checks exited 0. |
| Lint and production build | PASS | Scoped Biome 0; whole-tree lint exited 0 with existing 33 warnings/9 infos; final background production build recorded exit 0. |
| Browser vertical scroll | PASS | At 1440x900, the owned workspace had `overflow-y:auto`, height 1404 versus client 900, and a real scroll reached `scrollTop=504`. |
| Provider-backed live maritime acceptance | NOT CLAIMED | No AISStream key, relay URL/auth, PortWatch runtime source response or provider timestamp was configured. The browser evidence is fail-closed only. |

**Phase 6 gate: COMPLETED FOR NATIVE UI, BOUNDARY VALIDATION AND
NO-PROVIDER TRUTHFULNESS.** It does not certify real-time vessel availability,
cargo, destination, port calls, route completion or Provider licence terms.
## Phase 7 - China industrial-cluster export explorer

**Implementation commit:** `0ef6e668bbf96d436dc37cc861804a217760d6e5`
(`feat(trade): add China industrial cluster export explorer`).

| Check | Result | Evidence |
|---|---|---|
| Native owned route and entry | PASS | `/china-factory` is a local TypeScript/CSS workspace with a native `中国世界工厂` market link; it contains no iframe, copied tracker page or upstream UI bundle. |
| Seed-source boundary | PASS with disclosed scope | Registry has 22 source-labelled records: 20 MIIT 2024 reference clusters plus Huidong/Putian footwear. The 20 reference-only records have no claimed HS mapping and are statistics-disabled; only the two reviewed footwear records map to HS 64. |
| Requested Huidong and Putian access | PASS | Browser selected Huidong at `/china-factory?cluster=huidong-womens-footwear&period=2024&hs2=64` and Putian at its own canonical URL. Both show source, publication-date availability, administrative scope and HS 64 boundary. |
| No fabricated trade values | PASS | Without an authorized returned Comtrade/customs record the page says `无经验证的观测贸易记录`; it substitutes neither sample values nor zero-export claims. |
| No port/vessel/BOL inference | PASS | Potential port rankings remain an explicit `MODELLED_ESTIMATE` unavailable state; no contracted B/L provider yields zero shipment/container/vessel/buyer records. |
| Period/product filter isolation | PASS | Route tests require reporter 156, selected integer year and the selected HS-2 prefix; results cannot cross a cluster's HS filter. |
| China map compliance | PASS | No unaudited China administrative boundary or sensitive map claim is rendered; the UI explicitly records that no audited boundary dataset is loaded. |
| CSV template and export provenance | PASS | A maintainable reviewed-import CSV template is supplied. The browser CSV exports only returned observed records or an explicit no-value-bearing marker, never a plausible sample. |
| Type/route/DOM/API/source gates | PASS | `typecheck:all` 0; focused suite 23/23; DOM 293/293; API contract 149/114/96; source generate/check 0 with 533 active hosts. |
| Lint and production build | PASS with pre-existing warnings | Scoped Biome 0; full lint 0 with 33 warnings/9 infos; final `build:full` 0. The build retained existing chunk/dynamic-import warnings only. |
| Provider-backed factory/port/BOL acceptance | NOT CLAIMED | No configured Comtrade/customs response, official port data response, commercial bill-of-lading contract, credential, licence confirmation or timestamped live data exists in this environment. |

**Phase 7 gate: COMPLETED FOR NATIVE EXPLORATION, SOURCE/HS BOUNDARIES AND
NO-PROVIDER TRUTHFULNESS.** It does not claim town-level exports, real-time
trade, port routing, shipments, containers, vessels, buyers, cargo, customs
manifests, or bill-of-lading coverage.

## Phase 8 - economy-first full layout and truthful posture degradation

**Implementation commit:** `7c231dc82acd40f40ce0066dc25486391edf7dcd`
(`feat(layout): prioritize markets and truthful posture states`).

| Check | Result | Evidence |
|---|---|---|
| Existing dashboard ownership | PASS | The implementation changes `VARIANT_DEFAULTS.full`, `App` migration and `PanelLayout`; no duplicate dashboard, iframe or copied upstream UI exists. |
| Market and stock priority | PASS | Fresh local-dev browser DOM/order begins `markets`, `stock-analysis`, `stock-backtest`, `daily-market-brief`, `market-implications`; Market header exposes native `/stocks/AAPL`. |
| Required domain order | PASS | Macro/trade and supply-chain/China workspaces precede news; news precedes disaster/infrastructure; provider-dependent posture panels are ordered last. |
| Saved-layout ownership | PASS | Migration writes only a version marker when a saved `panel-order` exists. It never reorders that persisted user layout. |
| First-use collapse | PASS | With a fresh localhost-origin profile, military and escalation panels rendered at the tail with `panel-collapsed`; their entries remain within the free-panel cap. |
| Provider/status/manual action | PASS | Military and aviation surfaces carry a value-free Provider readiness notice: configuration status, no verified observation time, and non-secret Desktop Configuration/server authorization action. |
| No false aviation LIVE | PASS | Tests reject enabled-layer implication, blank source, stale and future observations. Header becomes `OBSERVED` only for a sourced, valid, non-future observation within five minutes. |
| Browser visual evidence | PASS | `phase8-full-dashboard-market-first-1440x900.jpg` and `phase8-full-dashboard-first-use-1440x900.jpg`; inspected fresh local dev instance at `127.0.0.1:4185`. |
| Focused/type/DOM/API/source/lint gates | PASS | Focused 21/21; `typecheck:all` 0; DOM 293/293; API contract 149/114/96; source check 533 hosts; full lint 0 with existing 33 warnings/9 infos and Safe HTML guard. |
| Production build | PASS | Final background `build:full` exited 0 in 28.77 seconds and generated 252 PWA precache entries. Raw local transcript is retained separately from versioned Markdown evidence. |
| Provider-backed military/aviation acceptance | NOT CLAIMED | No current OpenSky relay/OAuth, Aviationstack key, provider response, licence confirmation or verified observation timestamp was configured. |

**Phase 8 gate: COMPLETED FOR ECONOMY-FIRST LAYOUT, SAVED-ORDER OWNERSHIP AND
NO-PROVIDER TRUTHFULNESS.** This phase does not claim real-time military or
aviation tracking merely because a map layer is enabled.

## Phase 9 - Provider operations, scheduling and local control-center boundary

**Implementation commit:** `b9276fab8c592a6942f7e25fbc0e7eb6667517bd`
(`feat(ops): add truthful provider control center`).

| Check | Result | Evidence |
|---|---|---|
| Owned native control surface | PASS | `/provider-operations` is local TypeScript/CSS, routed in `main.ts` and linked from Markets. It contains no iframe or copied Provider UI. |
| Required operation contracts | PASS | Nine operations cover stock REST/stream, news ingest/analysis, AIS, PortWatch, Comtrade, China Customs and model evaluation. Every operation specifies cadence, idempotency, lock, bounded retry and truth boundary. |
| Config/secret disclosure | PASS | The UI receives configuration presence/validity only. It renders no plaintext, tail, raw hash or reversible key fingerprint. Server-managed web state is explicitly `SERVER_MANAGED_UNKNOWN`. |
| Safe retry / audit | PASS for no-provider state | Browser click recorded `Safe retry not executed: readiness is SERVER_MANAGED_UNKNOWN.`; no executor means no Provider request. The local audit distinguishes scheduler, operator and executor events. |
| No silent data loss | PASS | Callback false/error records a scheduling failure but does not overwrite owner data; executor contracts keep last successful time separate from failure time. |
| Self-host safety | PASS | `SELF_HOSTED_MODE=true` forces `cloudFallback=false`; targeted sidecar test also proves `LOCAL_API_TOKEN` authentication remains required and `/api/local-status` reports the non-secret mode. |
| Focused/type/API/source/DOM gates | PASS | New contract 5/5; targeted sidecar 4/4; typecheck 0; API contract 149/114/96; source check 533; DOM 293/293. |
| Full lint / production build | PASS with existing warnings | Corrected final lint exited 0 with existing 33 warnings/9 infos and Safe HTML 0 legacy sinks; final `build:full` exited 0 in about 45.2 s with 254 PWA entries. |
| Browser visual evidence | PASS for truthful disabled state | `phase9-provider-operations-default-1280x720.png` and `phase9-safe-retry-no-executor-1280x720.png`. |
| Provider-backed operations | NOT CLAIMED | No credential, entitlement, model result, queue metric, AIS message, market bar, trade record or executor response was configured in this environment. |

**Phase 9 gate: COMPLETED FOR CONTROL CONTRACTS, SAFE FAIL-CLOSED OPERATION,
SELF-HOST CLOUD-FALLBACK PROHIBITION AND OBSERVABILITY UI.** It does not claim
that a background job, Provider or local database is running until its own
authenticated executor reports a source-bearing result.

## Phase 10 - native Windows desktop delivery, integrity and fail-closed market view

**Implementation commit:** `b44689019ce6c21d30aa785f9525d98a69387545`
(`feat(desktop): deliver native branded launcher`).

| Check | Result | Evidence |
|---|---|---|
| Tauri 2 / independent brand | PASS | Branded `全球实时热点追踪·探长版` Tauri configuration, menus and native window retain explicit World Monitor / AGPL-3.0-only attribution without a copied page or Electron shell. |
| Frontend embedding refresh | PASS | `build.rs` watches desktop `dist` entrypoints/assets; final installed application opened the complete native overview instead of the earlier rejected `asset not found: index.html` build. |
| Checksum-verified local runtime | PASS | Official Node 22.14.0 archive and binary SHA-256 checks passed; the Node MIT LICENSE is bundled next to the installed sidecar runtime. |
| Final installer and shortcut | PASS | Final NSIS installation exit 0; SHA-256 `9F0A44E20B847BEF42AE22A0F20E8C85F48616DA0E677A2B40C5F7518074D371`; Desktop shortcut regenerated with exit 0. |
| Native process and local API | PASS | Launcher exit 0 created the branded installed application and installed Node sidecar; sidecar listener observed at `127.0.0.1:46123`. Duplicate launch exited 0 without a duplicate process. |
| Legacy isolation | PASS | Launcher tests and review prohibit ports 4000/5173, bare release execution and old-project fallback. The legacy project/shortcut remain untouched. |
| Secret safety | PASS | Strict Vite secret check passed; desktop build gate classified all required variables; logs recorded zero injected keychain secrets. No Provider secret was inspected or exposed. |
| Visible native acceptance | PASS for desktop shell | Windows UI Automation saw the branded native window, upstream attribution and native stock/maritime/China/Provider entry links. The live window was left open for review. |
| No fake market acceptance | PASS for no-provider state | Actual Markets content reported `加载市场数据失败`; premium paths requested authentication. No fake/common K-line, cross-symbol cache, historical-as-live label or Provider success was claimed. |
| Automated gates | PASS | Focused 6/6; typecheck 0; sidecar 371/371; DOM 293/293; full lint 0 (33 existing warnings/9 infos); API contract 0; source check 0. |
| Provider-backed stock / AIS / model acceptance | NOT CLAIMED | No valid Provider credential, entitlement, observed bar, source time, delay, news event, AIS message or model response was configured. |
| Windows signing | DEFERRED | Installed executable status is `NotSigned`; signing needs an owner-supplied certificate and must not be simulated. |

**Phase 10 gate: COMPLETED FOR NATIVE DESKTOP DELIVERY, INSTALLATION, LOCAL
SIDECAR STARTUP, LAUNCHER IDEMPOTENCY AND FAIL-CLOSED NO-PROVIDER DISPLAY.** It
does not certify any real-time financial, shipping, news or trade feed.

## Phase 11 - acceptance matrix and no-false-evidence regression gates

**Implementation commit:** `a640cb3c25ac393759b1907b3f6c687b5a57e974`
(`fix(phase11): harden dashboard reliability and acceptance`). The next receipt
commit backfills this immutable SHA.

| Check | Result | Evidence |
|---|---|---|
| Finance complete browser matrix | PASS | `phase11-e2e-finance-full-final-rerun2-20260814.log`: 232 passed, 20 declared variant/configuration skips, 0 failed, `EXIT_CODE=0`. |
| Variant pre-paint syntax | PASS | `phase11-variant-and-map-static-regressions-final-20260814.log`: 7/7. Every non-Full variant emits syntactically valid pre-paint JavaScript; unrelated HTML routes remain unchanged. |
| Deterministic map readiness and visual evidence | PASS | `phase11-map-harness-static-style-final-20260814.log`: 1/1 explicit-marker guard; reviewed Finance conflict baseline; `phase11-e2e-full-visual-final-rerun3-local-chrome-20260814.log`: Full layer/zoom goldens 1/1, `EXIT_CODE=0`, no snapshot update. |
| Type and data contracts | PASS | `phase11-typecheck-final-rerun4-20260814.log`, `EXIT_CODE=0`; `phase11-test-data-final-rerun6-primary-node24-20260814.log`: 23,022 tests / 3,551 suites / 23,009 pass / 0 fail / 0 cancelled / 13 skipped, `EXIT_CODE=0`. |
| DOM and local sidecar | PASS | `phase11-test-dom-final-rerun2-20260814.log`: 293/293; `phase11-test-sidecar-final-rerun2-20260814.log`: 371/371; both exit 0. |
| Lint and production variants | PASS | `phase11-lint-final-rerun2-20260814.log`: 0 errors, safe-HTML guard passed, 33 existing warnings/9 infos; Finance, Full and Happy builds all have `EXIT_CODE=0`. |
| Browser runner provenance | PASS with declared local runner | After standard `npm ci`, Playwright's pinned Chromium was not locally cached. The final visual run explicitly sets `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to installed local Chrome; config retains locked Chromium for CI. This is test infrastructure, not product evidence. |
| Provider truthfulness | PASS for fail-closed boundary | No fixture, cache, screenshot, sidecar, visual baseline or browser success is called live market, AIS, news, cargo, trade or factory data. No common K-line is accepted. |

**Phase 11 gate: COMPLETED FOR RELIABILITY, VARIANT BOOT INTEGRITY,
ACCESSIBILITY/MOBILE/PANEL REGRESSION, TEST-HARNESS HONESTY AND FINAL ACCEPTANCE
EVIDENCE.** It does not certify a licensed Provider observation, real-time
stock bar, AIS message, cargo inference, news causality or factory fact.

## Phase 12 - controlled publication preflight

**Implementation commit:** `77fce4c05805f46b358b6958be5f489796e0d167`
(`docs(integration): record Phase 12 publication preflight`). The following
receipt commit backfills its immutable SHA before the branch is published.

| Check | Result | Evidence |
|---|---|---|
| Integration branch identity | PASS | `integration/pokieticker-maritime-china-factory` is checked out; it is not `main` or `master`. |
| Origin main preservation | PASS | Remote `origin/main` and local `main` both resolve to `0fca203c776dd5fa4913c4bd52f99cd2c3c13a25`; `origin/main` is an ancestor of `446e2e57764c72dd6fa2ff98e4164cdb19097897`. |
| Prior acceptance receipt | PASS | Phase 11 implementation `a640cb3c25ac393759b1907b3f6c687b5a57e974` and receipt `446e2e57764c72dd6fa2ff98e4164cdb19097897` both resolve as local commit objects. |
| Connected GitHub repository verification | PASS | GitHub integration reports push/admin permission for `daking32168-byte/worldmonitor` and read-only access to its upstream `koala73/worldmonitor`; both default to `main`. |
| Publication mechanism | CONDITIONAL PASS | The connected GitHub integration is authorized; local `gh auth status` is unauthenticated and is not used as an authority to push or create the PR. |
| Main/force safety | PASS | No merge, rebase, reset, force push, `main` mutation or user-file deletion occurred in the preflight. |
| Documentation hygiene | PASS after receipt correction | The initial preflight commit had one Markdown hard-break trailing-space warning. The receipt removes it and reruns `git diff --cached --check`; no product/test result was changed. |

**Phase 12 preflight gate: PASSED FOR A BRANCH-ONLY DRAFT-PR PUBLICATION.** It
does not publish a branch yet, certify remote CI, deploy a service, or change
the status of any Provider/data claim.

## Phase 12 - publication transport result

| Check | Result | Evidence |
|---|---|---|
| Normal HTTPS push via Codex runtime Git | BLOCKED | `git push --porcelain -u origin integration/pokieticker-maritime-china-factory` exceeded the bounded wait; its owned process was stopped. Follow-up reads returned connection reset/failure to `github.com:443`. |
| Normal HTTPS push via system Git | BLOCKED | System Git `2.55.0.windows.3` can read `origin/main`, but the same non-force push failed: `Failed to connect to github.com:443 after 21073 ms`. |
| SSH alternative | BLOCKED | Batch SSH reached GitHub but returned `Permission denied (publickey)`; no private key was read, created or requested in chat. |
| Remote mutation check | PASS: none occurred | Final system-Git `ls-remote` returned only `origin/main` at `0fca203c776dd5fa4913c4bd52f99cd2c3c13a25`; the integration branch is absent remotely. |
| Plugin-only commit reconstruction | REJECTED | The connected GitHub integration lacks a local-object-pack upload operation. Creating replacement API commits would not preserve the real 72-commit local/reversible chain or its recorded SHA evidence. |

**Phase 12 publication gate: BLOCKED ON LOCAL NETWORK/AUTH TRANSPORT.** The
preflight remains valid, but the integration branch, Draft PR, remote CI and
deployment are not claimed. Resume only after the owner restores an
authenticated HTTPS Git path or authorized SSH key outside chat/Git.

**Transport-block record commit:**
`713572967a016143046800ec16598dfda1f124b3`
(`docs(integration): record Phase 12 transport block`). The following receipt
commit backfills this immutable SHA; it does not change the blocked result.

## Phase 12 - resumed publication and Draft PR result

| Check | Result | Evidence |
|---|---|---|
| Clean local publication input | PASS | Detached acceptance worktree had an empty `git status --short`; HEAD was `ace1b8b49c0d02fe93c86ce419d8d2bd99b3f401`; local `origin/main` was `0fca203c776dd5fa4913c4bd52f99cd2c3c13a25`. |
| GitHub identity and permission | PASS | Connected GitHub integration returned `daking32168-byte` and owner-fork permissions `admin=true`, `maintain=true`, `push=true`; default branch is `main`. |
| Duplicate remote target check | PASS | Before publication the integration branch search and open-PR search returned empty results. |
| First resumed HTTPS push | FAILED SAFELY | Normal non-force push returned exit `128`, `Recv failure: Connection was reset`; no branch was reported created. |
| HTTP/1.1 retry | FAILED SAFELY | Normal non-force retry returned exit `128`, `Failed to connect to github.com:443`; no force option was used. |
| Network-path diagnosis | PASS | `api.github.com` returned HTTP 200; local `github.com` address `20.205.243.166` timed out. GitHub `/meta` supplied official Git ranges; command-local routing to official Git endpoint `20.27.177.113` passed `ls-remote`. No hosts/global-Git/remote mutation occurred. |
| Integration branch push | PASS | `git -c http.version=HTTP/1.1 -c http.curloptResolve=github.com:443:20.27.177.113 push --no-verify --porcelain origin HEAD:refs/heads/integration/pokieticker-maritime-china-factory` exited `0` and reported `[new branch]`. `--no-verify` skipped only a duplicate hook run after the exact head had already passed the complete pre-push gate. |
| Remote commit verification | PASS | GitHub integration fetched `ace1b8b49c0d02fe93c86ce419d8d2bd99b3f401` with message `fix(phase12): remove unsupported cargo inference claims`. |
| Draft PR creation | PASS | GitHub integration created [PR #1](https://github.com/daking32168-byte/worldmonitor/pull/1) with `draft=true`, base `main@0fca203c776dd5fa4913c4bd52f99cd2c3c13a25`, and head `integration/pokieticker-maritime-china-factory@ace1b8b49c0d02fe93c86ce419d8d2bd99b3f401`. |
| Protected-main control | PASS | The push refspec named only the integration branch; GitHub reported the PR base SHA unchanged. There was no direct/force main push, merge or rebase. |
| Provider/data truth boundary | PASS | Publication did not add a key or entitlement and did not establish a live bar, AIS/cargo fact, news cause, model result, trade record or factory observation. Missing Providers remain disabled. |

### Final local publication gate

The complete pre-push wrapper exited `0` for the exact published source head.
Observed passing groups include typecheck, API typecheck and Convex audit,
Convex type, CJS syntax, Unicode across 2,854 files, dependency boundaries,
safe HTML, Sentry, health cutover, rate policy, premium fetch, edge bundle,
253/253 edge-function tests, 510/510 MDX checks, Markdown lint, source and
product-facts checks, locale freshness, Pro budget, generated artifact
freshness and version `2.10.0` synchronization. The changed-test gate evaluated
368 tests with zero failures and two explicit Windows filename skips; their
POSIX coverage remains active. Manual proto generation was repeated and was
idempotent at SHA-256
`78408C57CEE7F1BDBDF5D330C76A6B028D89D0803740B75132681EE6FD665F77`.

Raw gate log:
`docs/integration/evidence/phase12-full-prepush-20260814.log`, 141,634 bytes,
SHA-256
`9E87ECA6E4CE73E9F51A5E406C7AB58042D604074BC1C6741D95DDF7EF09347A`.
The log truthfully retains the missing `make` message; the separately installed
Go generators produced no diff and the hook's freshness check reported
`Proto-generated code is up to date`.

**Phase 12 controlled-publication gate: PASS.** The source branch and Draft PR
exist; main, upstream, deployment, Provider entitlements and secrets remain
unchanged. Remote CI, human review, readiness, merge and deployment are not
implied. Publication-document record commit:
`08ee150b7a4db24a85c7e567434e437e2e0cf7aa`; the following receipt backfills
it.

| Visible Draft PR review | PASS for review surface only | `docs/integration/evidence/phase12-draft-pr-created-20260814.png`, 1170x1073, 157,546 bytes, SHA-256 `651FF87ABAE15ECC3F9FD759248788B41000762DA0BECCEC26A7DF07B83FC034`. The page visibly shows `Draft` and `Not ready`; no readiness/merge/deploy action was taken. |
