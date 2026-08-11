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
