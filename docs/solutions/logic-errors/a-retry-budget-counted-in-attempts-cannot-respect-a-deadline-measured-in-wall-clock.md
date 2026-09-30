---
module: scripts/_seed-utils, scripts/seed-token-panels, scripts/seed-stablecoin-markets, seed-bundle-runner
date: 2026-09-24
problem_type: logic_error
component: background_job
severity: high
symptoms:
  - Railway pages "Deploy Crashed!" for all 13 sections of `seed-bundle-market-backup` while no data is lost
  - "`section=Token-Panels status=FAILED elapsed=120.0s reason=timeout after 120s (signal SIGTERM)`"
  - Five consecutive `CoinGecko 429 — waiting Ns` lines and zero CoinPaprika requests in the same run
  - A fallback source that exists specifically for the failing condition never appears in the logs
  - The crash self-heals on the next tick, so a status-only scan reports the service green
root_cause: logic_error
resolution_type: code_fix
related_components: [tooling, testing_framework]
tags: [retry-semantics, wall-clock-budget, unreachable-fallback, copy-paste-divergence, railway-cron, seed-bundle-runner, prose-comment-does-not-propagate, static-config-gate]
---

# A retry budget counted in attempts cannot respect a deadline measured in wall clock

## Problem

`seed-bundle-market-backup` crashed on 2026-09-20. The `Token-Panels` section was SIGTERMed at its 120s section timeout, `_bundle-runner.mjs` counted `failed:1` and exited 1, and Railway paged for all 13 sections.

The retry loop was bounded by attempt count while the thing that kills it is bounded by wall clock. Nothing reconciled the two.

## Symptoms

```
[Token-Panels]   CoinGecko 429 — waiting 10s (attempt 1/5)
[Token-Panels]   CoinGecko 429 — waiting 20s (attempt 2/5)
[Token-Panels]   CoinGecko 429 — waiting 30s (attempt 3/5)
[Token-Panels]   CoinGecko 429 — waiting 40s (attempt 4/5)
[Token-Panels]   CoinGecko 429 — waiting 50s (attempt 5/5)
[Token-Panels] Failed after 120.0s: timeout after 120s — sending SIGTERM
[Bundle:market-backup] section=Token-Panels status=FAILED elapsed=120.0s
[Bundle:market-backup] Finished in 141.1s, ran:2 skipped:10 deferred:0 failed:1 graceful:0 stalled:0
```

The backoff ladder was `Math.min(10_000 * (i + 1), 60_000)` over 5 attempts: `10+20+30+40+50 = 150s` of sleep alone, 225s once each attempt's 15s request timeout is counted. The section is declared `timeoutMs: 120_000`.

**The damage was not the crash.** `fetchFromCoinGecko` only throws once the ladder exhausts, and `fetchTokenPanels` only calls `fetchFromCoinPaprika` in the catch of that throw. The process was killed 30s before the throw could fire, so the CoinPaprika fallback — added in #1977 for exactly this failure — was unreachable under sustained rate-limiting. It had never once served traffic in the condition it was written for.

## What Didn't Work

**Reading the crash as a data-loss incident.** It was not one. `runSeed`'s SIGTERM handler released the lock and extended last-good TTLs, and the next 5-minute tick succeeded. `/api/health` showed the token-panel keys fresh throughout. Treating a graceful exit as "nothing to fix" is how this survived: the diagnostic classifier called an identical earlier crash "action: None."

**Trusting the green badge.** Railway rewrites a crashed deployment to `REMOVED` once a later tick succeeds, so a status-only scan showed the service healthy. The crash was only recoverable by re-pulling the REMOVED deployment's logs inside the retention window.

**Assuming the nominal retry count was the real one.** The loop advertised five attempts. It could never reach the fifth: the successful run five minutes earlier took 100.3s after four 429s, leaving 20s of headroom and no room at all for the fallback. The configuration had been one 429 away from crashing for months.

**Raising `timeoutMs`.** Considered and rejected. The bundle runs 13 sections on a 5-minute cron, and `_bundle-runner.mjs` already load-sheds against `maxBundleMs`; a larger section timeout moves the wall without making the fallback reachable in the worst case.

## Solution

Make the budget wall-clock and a true ceiling, then gate the arithmetic in CI.

One shared helper replaces three copied loops (`scripts/_seed-utils.mjs`, added after `coingeckoEndpoint`):

```js
export async function fetchCoinGeckoWithRetryBudget(url, {
  headers, requestTimeoutMs, budgetMs, fetchFn = fetch, sleepFn = sleep, now = Date.now,
}) {
  const startedAt = now();
  for (let attempt = 1; ; attempt++) {
    const resp = await fetchFn(url, { headers, signal: AbortSignal.timeout(requestTimeoutMs) });
    if (resp.status === 429) {
      const elapsed = now() - startedAt;
      const wait = Math.min(5_000 * 2 ** (attempt - 1), 60_000);
      // Charge the NEXT attempt's full request timeout alongside the sleep, so
      // budgetMs caps the whole phase and not merely when the last retry starts.
      if (elapsed + wait + requestTimeoutMs > budgetMs) throw new Error(/* ... */);
      await sleepFn(wait);
      continue;
    }
    if (!resp.ok) throw new Error(`CoinGecko HTTP ${resp.status}`);
    return resp;
  }
}
```

A missing or non-positive `budgetMs` throws a `TypeError` rather than comparing `NaN` and retrying forever — the exact failure class the helper exists to rule out.

Each seeder declares its budget as data, with the fallback side **derived** rather than hardcoded so mapping a new token widens the budget instead of silently breaking the invariant:

```js
export const COINGECKO_RETRY_BUDGET_MS = 45_000;
const COINPAPRIKA_CONCURRENCY = 4;
export const COINPAPRIKA_WORST_CASE_MS =
  Math.ceil(COINPAPRIKA_IDS.length / COINPAPRIKA_CONCURRENCY) * REQUEST_TIMEOUT_MS;
```

The concurrency and timeout are passed explicitly to `fetchCoinPaprikaTickersById` so the derivation describes the call as made, not the helper's defaults.

| seeder | CoinGecko ceiling | CoinPaprika worst case | total | section |
|---|---|---|---|---|
| token-panels | 45s | 60s (16 ids ÷ 4) | 105s | 120s |
| stablecoin-markets | 45s | 30s (5 ids ÷ 4) | 75s | 120s |

Shipped in PR #8429.

## Why This Works

The budget is now a ceiling on the *phase*, not on when the last retry may begin. Because the loop charges the next attempt's full request timeout before deciding to sleep, the final attempt can only start at `budgetMs - requestTimeoutMs` and must finish by `budgetMs`. That is what makes `COINGECKO_RETRY_BUDGET_MS + COINPAPRIKA_WORST_CASE_MS <= timeoutMs` a sound claim rather than an optimistic one.

Verified by driving the seeder against a local always-429 CoinGecko with real clocks, racing a 120s timer. Before:

```
coingecko attempts=5  coinpaprika attempts=0
fallback reached: false
REPRO: section killed at 120.0s (budget 120s)
```

After, with the same harness unchanged:

```
coingecko attempts=3  coinpaprika attempts=16
fallback reached: true
PASS: settled at 15.0s -> {"ok":true,"total":16}
```

Fewer nominal retries, and for the first time a fallback that actually runs. The service was crash-free for 48h after merge.

## Prevention

**1. The real lesson: a prose comment does not propagate.** This exact bug, with this exact arithmetic, was diagnosed on 2026-04-14 and recorded at `scripts/seed-crypto-quotes.mjs`:

```js
// CoinPaprika is the PRIMARY source — CoinGecko's free tier 429s frequently
// and its 5-step retry budget (10+20+30+40+50=150s) overruns the bundle's
// 120s timeout, killing the section before the fallback can fire (Railway
// bundle log 2026-04-14 07:17 UTC).
```

That fix was applied to **one of three byte-identical copies**. Five months later the same loop in `seed-token-panels.mjs` crashed production, and a third copy in `seed-stablecoin-markets.mjs` was still live and unfixed in the *same bundle at the same timeout*. Copy-paste divergence is why the lesson did not travel. The fix therefore deletes both remaining copies into one shared helper — the duplication was the root cause, not the number.

**2. Encode the invariant as a gate, not a fourth comment.** `tests/seed-fetch-budget.test.mjs` resolves each seeder's section `timeoutMs` **statically from the bundle manifest** via `tests/helpers/bundle-section-parser.mjs` (manifests cannot be imported — top-level `runBundle` would spawn real seeders), then asserts the declared budgets fit. It is registry-driven, so covering another seeder is one table entry:

```js
assert.ok(
  COINGECKO_RETRY_BUDGET_MS + COINPAPRIKA_WORST_CASE_MS <= section.timeoutMs,
  `... exceeds the section's ${section.timeoutMs}ms timeoutMs. `
  + 'The runner SIGTERMs the seeder before the fallback can run. '
  + 'Lower COINGECKO_RETRY_BUDGET_MS; do not raise timeoutMs.',
);
```

The gate fails loudly when it cannot find exactly one section for a seeder, rather than skipping — a section it cannot read is one it cannot vouch for.

**3. Assert the ceiling behaviourally, not just the arithmetic.** The static sum is only sound if the budget really bounds the phase. A companion test drives the seeder under `t.mock.timers` with every upstream answering 429, charges each CoinGecko call its full request timeout, and asserts CoinPaprika is first reached at `<= COINGECKO_RETRY_BUDGET_MS`. A mutant dropping `+ requestTimeoutMs` from the deadline check is caught by that assertion and by nothing else.

**4. A graceful exit is not an absence of a bug.** Exit 75 means no data was lost. It does not mean nothing needs fixing: every occurrence burns the run's compute and pages a human. A graceful crash that recurs is a bug to make exit 0.

**5. Check for the pattern, not the instance.** The crash was in one seeder. Grepping for the loop found three copies and a fourth in `scripts/seed-crypto-sectors.mjs` (left alone — a standalone Railway service in no bundle, so it has no section timeout to race).

## Related

- [an-admission-guard-that-ignores-prior-runtime-cost-repeats-the-bug-it-guards](an-admission-guard-that-ignores-prior-runtime-cost-repeats-the-bug-it-guards.md) — the *outer* invariant in the same runner (section `timeoutMs` vs `maxBundleMs`). This learning is the inner one: a seeder's own fetch phase vs its section timeout. `tests/bundle-budget-admission.test.mjs` guards the outer; `tests/seed-fetch-budget.test.mjs` now guards the inner.
- [../best-practices/a-requirement-and-its-bound-must-share-a-clock](../best-practices/a-requirement-and-its-bound-must-share-a-clock.md) — the same family of defect: a requirement and its bound anchored to different clocks. There the mismatch is item-relative vs now-relative retention; here it is attempt-count vs wall-clock.
- [railway-seeder-watch-paths-can-skip-deployments](../integration-issues/railway-seeder-watch-paths-can-skip-deployments.md) — why the deployed SHA may not be the merged one when a seeder misbehaves in a way the source says is impossible.

## Still Open

The general case is untouched and tracked in issue #8479. `scripts/_seed-utils.mjs` exports `withRetry(fn, maxRetries = 3, delayMs = 1000)` with **no deadline parameter**, and `runSeed` calls it with one argument, so a throwing `fetchFn` runs four times. `runSeed`'s own fetch deadline defaults to `lockTtlMs + FETCH_PHASE_DEADLINE_MARGIN_MS` (240s), which is tied to the **lock**, not to the bundle section. `scripts/seed-mineral-production.mjs` is a confirmed second instance: `lockTtlMs: 180_000` with no `fetchPhaseTimeoutMs` gives a 300s fetch deadline inside a 180s section.
