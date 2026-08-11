# Global Intelligence Mother Reconstruction — Master Status

**Controlling specification:** `D:\google\Codex_5.6_Terra_极高_全球情报母体重构执行书_2026-08-11.md`
**Updated:** 2026-08-11T20:24:00+08:00
**Official product brand:** 全球实时热点追踪·探长版
**Current working branch:** `integration/pokieticker-maritime-china-factory`
**Formal mother repository:** `daking32168-byte/worldmonitor` (AGPL-3.0-only)

## Phase status

## Effective current phase status

This current-status receipt supersedes the historical preflight rows below.

| Phase | Status | Scope | Commit | Evidence |
|---|---|---|---|---|
| 0 | completed | Safety inventory and recoverability closure | recorded | `evidence/phase0-closure.md` |
| 1 | completed with recorded data-suite limitation | Real upstream mother baseline, independent brand, AGPL/PokieTicker notices, Windows build and production preview | `c889fcfbdab4bf2bcd7a28f85ed32114f288d6aa` | `evidence/phase1-mother-baseline.md` |
| 2 | completed | Provider/data contracts, generated API, explicit disabled state and historical-fixture isolation | `2df9ef0a133564789bb398d7a9f363de171e78b8` | `evidence/phase2-data-contract.md` |
| 3 | completed for code and automated gates; licensed-live acceptance pending | Server-only Massive REST/WebSocket relay, exchange-calendar status, symbol isolation and explicit no-key/no-entitlement denial | `9cb8cb6efe2164891ea26cb6b2f51b6a3da086b0` | `evidence/phase3-authorized-stock-relay.md` |
| 4 | completed for native UI, browser layout and no-provider truthfulness; licensed-live visual acceptance pending | `/stocks` / `/stocks/:symbol`, priority selector, provider-only search, D3 chart shell, event/research panels and independently scrollable responsive workspace | `PENDING_BACKFILL` | `evidence/phase4-stock-workspace.md`, `POKIETICKER_COMPONENT_MIGRATION.md` |

| Phase | Status | Scope | Commit | Evidence |
|---|---|---|---|---|
| 0 — Safety inventory, backup, workspace decision | completed | Old-project checkpoint, mother workspace, source locks, legacy-data baseline, recoverability audit | `81369e41cfd0e3dd454dbd37ae3739b5aa53b056`; `8cf5937b8c4bad406e7c64eba8e50a51ac473ce6` | `ACCEPTANCE_EVIDENCE.md`, `evidence/phase0-closure.md` |
| 1 — Sync and establish WorldMonitor mother baseline | blocked — local GitHub HTTPS unavailable | Safe `--ff-only` eligibility check, upstream baseline, legal/brand implementation | — | `ACCEPTANCE_EVIDENCE.md`, `evidence/phase1-preflight-network.md` |
| 2–12 | not started | Contracts, market, PokieTicker, maritime, China factory, controls, desktop, final acceptance, PR | — | — |

## Phase 0 result

- The legacy simplified project is preserved at `D:\使用AI专属文件夹\global-intelligence-earth\全球热点追踪`; it is not a Git repository and therefore has no origin, upstream, branch or Git dirty state.
- A local recoverable snapshot was created at `D:\使用AI专属文件夹\global-intelligence-earth\backups\old-simplified-pre-worldmonitor-mother-20260811-161129` (5,900 files, 1.828 GB). It remains local-only and must never be added to Git.
- The new formal mother workspace is `D:\使用AI专属文件夹\global-intelligence-earth\worldmonitor-integrated`.
- Local branch `backup/pre-worldmonitor-mother-20260811-162026` points to the untouched fork baseline `0fca203c776dd5fa4913c4bd52f99cd2c3c13a25`.
- All Phase 0 work is isolated on `integration/phase0-safety-inventory`; `main` remains untouched.
- The initial full clone exceeded the desktop execution time limit. A Git-native sparse checkout using an isolated index completed against the fork baseline without deleting the incomplete clone objects or the legacy project. See `DECISIONS.md`.
- The Phase 0 closure audit used `GIT_INDEX_FILE=.git/index.phase0` because the normal index remains absent while `.git/index.lock` is host-protected. With the isolated index, the branch was clean and one commit ahead of `origin/main`; the default-index deletion listing is not treated as source deletion evidence.
- A deterministic, non-sensitive 20-file backup sample and a three-file restoration/readability probe passed on 2026-08-11. Raw commands, output, hashes, exit codes, and the temporary-directory cleanup limitation are in `evidence/phase0-closure.md`.

## Hard constraints in force

1. WorldMonitor is the only formal code mother. The legacy React/Express project is not to be merged into this root.
2. No data source is labelled real-time unless the Provider contract explicitly permits it and the live path has been verified.
3. PokieTicker SQLite remains `HISTORICAL_SNAPSHOT`; it is never a live-market fallback label.
4. AIS reports cannot prove cargo, origin, buyer, or final discharge. Modelled trade links stay visibly modelled.
5. News alignment, sentiment and realised returns remain separate; no correlation is written as a proven cause.
6. No API key, credential, browser session, CAPTCHA bypass, iframe of either upstream, or non-user-authorised data source may be introduced.

## Phase 1 preflight result

- The user explicitly confirmed AGPL-3.0-only network-distribution obligations and independent branding in chat on 2026-08-11. The confirmation panel's on-disk values still read `未确认`, so the user’s direct message — not an unobserved file edit — is the legal-confirmation evidence.
- The connected GitHub app compared the two locked commits. It reports `0fca203...` as the merge base and ancestor of `ae0a0fe...`; upstream is ahead by 43 and behind by 0. A future local sync can therefore be a safe fast-forward **only after the real local object graph has been fetched**.
- Local `git fetch` attempts did not obtain any upstream object. The checkout remains shallow, `upstream/main` does not exist locally, and the local GitHub 443 diagnostic failed. No branch, main ref, code file, dependency, Provider configuration, or data artifact was changed by the Phase 1 preflight.

## Next action

## Phase 1 implementation correction — 2026-08-11

This section supersedes the prior preflight-only state. After GitHub 443 recovery,
local HTTP/1.1 fetches succeeded and proved merge-base
`0fca203c776dd5fa4913c4bd52f99cd2c3c13a25` with
`origin/main...upstream/main = 0 43`. The dedicated branch
`integration/pokieticker-maritime-china-factory` is rooted at upstream
`ae0a0fe26bcbdb683b366899e4dc38fb8ccfb5ad`; `main` remains unchanged.

Phase 1 has implemented the independent visible brand, AGPL source notice,
PokieTicker MIT/source trace, Windows-safe blog build and production build.
The final DOM/browser checks passed. `test:data` was invoked but exceeded the
64-second noninteractive limit; its final result is recorded as inconclusive,
not passed. See `evidence/phase1-mother-baseline.md`.

**Phase 1 implementation commit:** `c889fcfbdab4bf2bcd7a28f85ed32114f288d6aa`
(`chore(integration): establish WorldMonitor mother baseline`).

Proceed with Phase 2 provider/data contracts from the completed Phase 1 baseline. Missing Provider credentials must result in tested disabled states, never invented data or real-time claims.

## Phase 2 implementation correction — 2026-08-11

Phase 2 adds eight Market v1 RPC contracts: `SearchStocks`, `GetStockBars`,
`GetStockQuote`, `ListStockNews`, `GetStockEventTimeline`, `AnalyzeStockRange`,
`GetStockForecast`, and `FindSimilarStockEvents`. Every response has the same
provider/freshness/fallback/license envelope and every front-end provider status
has one display mapping.

Without a configured contract-backed Provider, the live handlers return an
explicit `PROVIDER_STATUS_NOT_CONFIGURED` response with empty arrays or absent
value objects. They do not return a blank success, static company data, a
synthetic OHLC series, fabricated news, a prediction, or a causal assertion.
The symbol validator rejects empty and illegal symbols; the cache-key primitive
requires `provider:symbol:interval:range`; and the bar validator rejects a
cross-symbol, duplicate-time, negative-volume, or invalid-OHLC series.

**Phase 2 implementation commit:** `2df9ef0a133564789bb398d7a9f363de171e78b8`
(`feat(market): establish truthful stock data contracts`). See
`evidence/phase2-data-contract.md`.

## Phase 3 — authorized stock relay and truthful runtime boundary

Phase 3 adds a server-only Massive adapter for bars, quotes, ticker search and
company news, plus a server-only WebSocket-to-SSE relay. Its REST requests,
WebSocket authentication and Redis/in-memory keys are symbol-qualified; a
response whose ticker does not match the requested symbol, a duplicate-timestamp
series, invalid OHLC/volume, or six identical traded bars is rejected instead of
rendered. The browser receives only normalized SSE events and never receives an
upstream API key.

The stock handler now fails closed: without `MASSIVE_API_KEY`, the SSE endpoint
returns `503 PROVIDER_STATUS_NOT_CONFIGURED`; without an explicit
`MASSIVE_REALTIME_DISPLAY_AND_REDISTRIBUTION_CONFIRMED=true`, it returns
`409 DELAYED_UNVERIFIED` and does not open a WebSocket. A configured REST
response remains delayed/unverified unless the separately documented commercial
display/rebroadcast entitlement has been confirmed. Finnhub/Alpha Vantage may
provide an explicitly labelled quote fallback only; they never fill a missing
bar series.

The US equity session calculation handles weekends, named full closures and
documented early-close dates. `MARKET_CLOSED` is therefore not a simple weekday
guess. The recorded PokieTicker values remain test-only historical fixtures;
they are not a runtime source and are not claimed to be live or delayed market
data.

**Phase 3 implementation commit:** `9cb8cb6efe2164891ea26cb6b2f51b6a3da086b0`
(`feat(market): add authorized stock relay safeguards`). Automated evidence is
in `evidence/phase3-authorized-stock-relay.md`.
No actual licensed-live browser acceptance is claimed yet because no Provider
secret or display/rebroadcast confirmation has been supplied.

## Next action

Proceed automatically to Phase 4 stock workspace implementation while the
manual licensed-live acceptance gate remains pending. A production chart may
only render returned, provenance-labelled bars; it must show the disabled or
delayed state rather than a sample or shared K-line.

## Phase 4 — native stock workspace and responsive scroll correction

Phase 4 introduces the native, full-screen stock workspace at `/stocks` and
`/stocks/:symbol`. It is not a second React application or a PokieTicker
iframe: it uses WorldMonitor's existing Market v1 client and a native D3/DOM
surface. AAPL, MSFT, NVDA, AMZN, GOOGL, META, TSLA and BABA appear first as
high-market-capitalization S&P 500-oriented starting points; no other company
is invented by the search field when the Provider cannot return it.

The user-reported vertical-scroll defect was reproduced in the dashboard shell:
the document intentionally had `overflow-y: hidden` while the stock workspace
was taller than its viewport. The route now owns `height: 100vh` and
`overflow-y: auto`. Browser wheel testing reached its bottom at 1440×900, and
the route was checked at 1280×720 and 390×844 with no mobile horizontal
overflow. See `evidence/phase4-stock-workspace.md` for measurements and
screenshots.

No Provider secret or commercial display/rebroadcast confirmation was supplied.
Accordingly the chart has no substitute bars, the quote is absent, the search
returns no unverified symbol results, and the news/analysis/similar/prediction/
story panels are explicit disabled/empty states. This is a completed UI and
truthfulness gate, **not** a licensed-live K-line or price-accuracy claim.

**Phase 4 implementation commit:** `PENDING_BACKFILL`.

## Next action

Proceed automatically to Phase 5 evidence-linked news, analysis and causality
boundaries. Missing keys do not block adapters, disabled states and tests; they
continue to block only a real Provider visual-data acceptance.
