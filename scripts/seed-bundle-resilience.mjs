#!/usr/bin/env node
import { runBundle, HOUR, DAY } from './_bundle-runner.mjs';

// intervalMs note: the bundle runner skips sections whose seed-meta is newer
// than `intervalMs * 0.8`. The Resilience-Scores section must run more often
// than the ranking/score TTL (12h / 6h) so refreshRankingAggregate() can keep
// the ranking alive between Railway cron fires. A 2h interval → 96min skip
// window, so hourly Railway fires run this ~every 2h. The seeder is cheap on
// warm runs (~5-10s: intervals recompute + one /refresh=1 HTTP + 2 verify
// GETs); the expensive warm path only runs when scores are actually missing.
//
// timeoutMs note: section timeouts are sized against measured runtime and each seeder's own
// internal deadline, NOT against Railway's container cap. #6556: every section
// here was declared at 600-900s, which is above the 570s bundle budget once the
// runner's 10s kill grace is added, so the admission check deferred all three
// on every tick and exited 0 — the service published nothing for six hours
// under a green badge. A timeout above the container cap never bounded anything
// anyway: Railway SIGKILLs at 10 minutes, taking the logs with it.
await runBundle('resilience', [
  // Warm runs finish in ~5.7s — measured, not estimated: the last healthy
  // production tick before #6531 logged `[Resilience-Scores] Done (5.7s)` with
  // 196/196 scores pre-warmed (quoted in #6556). The work is an intervals
  // recompute, one /refresh=1 call bounded at 60s, and 2 verify GETs. Cold runs
  // are 1-2min. 240s is ~2x the cold path.
  //
  // Caveat: the individual laggard warm-up has no aggregate deadline of its
  // own — batches of 5 countries at a 30s per-request timeout over up to 196
  // countries is ~20min worst case, so a badly degraded run is SIGTERM'd here
  // at 240s rather than finishing. That is not a regression: the old 600s
  // timeout sat above Railway's 10-minute container kill, so the same run died
  // by container SIGKILL with its logs lost. Giving that phase its own budget
  // (like Food-Stocks' fetchPhaseTimeoutMs) is tracked separately.
  { label: 'Resilience-Scores', script: 'seed-resilience-scores.mjs', seedMetaKey: 'resilience:scores', intervalMs: 2 * HOUR, timeoutMs: 240_000 },
  // 11 dataset adapters run concurrently (Promise.allSettled), each fetch
  // withRetry(2, 750) over a 30s timeout, so the design worst case is ~92s for
  // the slowest chain plus a Redis pipeline publish. 280s is ~3x that.
  //
  // measured 2026-08-17: 2.7s full-run (196 records; 0 failed datasets), from
  // Railway deployment 0b181beb-20aa-498c-94be-088a344fe493 at commit 8b2bc625.
  // The source log fields and runner confirmation are frozen in
  // scripts/resilience-static-full-run-evidence.json. `--measure-fetch-only`
  // remains a diagnostic and is not timeout or placement evidence.
  //
  // Runtime admission uses timeout + 10s kill grace. Scores' 250s worst case,
  // Static's 290s worst case, and the runner's 15s admission headroom total
  // 555s, leaving 15s in the 570s budget. This keeps Static admissible even if
  // Scores consumes its full reservation; the timeout is not sized from 2.7s
  // alone.
  { label: 'Resilience-Static', script: 'seed-resilience-static.mjs', seedMetaKey: 'resilience:static', intervalMs: 90 * DAY, timeoutMs: 280_000 },
  // The seeder caps its own fetch phase at 420s (fetchPhaseTimeoutMs), so a
  // slow USDA PSD or FAOSTAT aborts through runSeed's graceful last-good path
  // rather than being SIGTERM'd here, which the runner counts as a hard
  // failure. 480_000 leaves that bound 60s of publish headroom.
  { label: 'Food-Stocks', script: 'seed-food-stocks.mjs', seedMetaKey: 'resilience:food-stocks', intervalMs: 30 * DAY, timeoutMs: 480_000 },
], {
  // Railway kills the container at 10 minutes. The runner admits a section only
  // when `timeoutMs + KILL_GRACE_MS` still fits the remaining budget, so without
  // this a 600s section plus grace could start with no room to finish and be
  // SIGKILLed mid-publish instead of skipped cleanly. Every section above must
  // fit this budget outright — runBundle now refuses to start otherwise, and
  // tests/bundle-budget-admission.test.mjs pins the arithmetic in CI.
  maxBundleMs: 570_000,
});
