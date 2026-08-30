# Residual review findings — #7376 / PR #7415

Accepted residuals after applying important review fixes (preserve SSR on soft failure, crisis `dateModified` date-only, UTC `formatStaticDateTime`).

## Accepted (out of scope or intentional)

1. **Hazard / airspace tools still use Loading / undated timestamps** — outside the #7376 country / chokepoint / crisis live-signal tile scope. Follow-up when those tools get a committed pulse freeze.

2. **Partial country pulses still show score `—` with “No current score”** — intentional: advisory/sanctions-only rows are published without fabricating an instability score. Do not overclaim “zero em-dashes” for partial pulses. **Scale:** 31 of 196 committed country records carry a published instability score; the other 165 are partial and publish advisory + sanctions only. `tests/crawlable-corpus.test.mjs` asserts a floor on the scored count so a future freeze cannot silently degrade it to zero.

3. **Partial country pulses publish no `<time datetime>`** — intentional, and a correction to the first cut of this PR. When the upstream supplies no computable timestamp, the freeze records `asOf: null` (keeping the harvest instant in `retrievedAt` for operator forensics) and the tile renders an undated `<span data-live-updated>`. Stamping the freeze wall clock would have published a machine-readable retrieval claim for data whose vintage is unknown, on 165 of 196 country pages.

## Closed since the original review

- **`npm run freeze:crawlable-live-pulse`** — wired; no longer operator-memory only.
- **Refresh automation** — `.github/workflows/crawlable-pulse-refresh.yml` refreshes the snapshot monthly and opens a review PR, mirroring `resilience-snapshot-refresh.yml`. `resolveLatestLivePulseSnapshotPath` additionally rejects a snapshot older than 45 days, so a failed or forgotten refresh reds the build instead of republishing stale numbers under a “Current signal” heading.
- **Freeze-script coverage tests** — `tests/freeze-crawlable-live-pulse.test.mjs` now exercises `freezeCrawlableLivePulse()` itself against a stubbed fetch, covering the country and chokepoint coverage gates and a chokepoint-status outage. A live-network integration test remains out of scope; these gates are pure in-memory arithmetic and need no network.
