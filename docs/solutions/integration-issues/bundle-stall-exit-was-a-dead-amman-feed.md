---
title: "seed-bundle-macro stall crash was a dead Amman feed, not budget starvation"
module: seed-bundle-macro
date: 2026-11-16
category: integration-issues
problem_type: integration_issue
component: background_job
severity: medium
symptoms:
  - "seed-bundle-macro CRASHED on the 08:00 UTC tick: \"1 deferred section(s) are older than 2x their interval — starvation while the bundle reported progress. Exiting non-zero.\""
  - "Food-AMMAN deferred with \"its data is 5764min old — over 2x its 1440min interval\""
  - "/api/health STALE_SEED warning for foodPricesAmman"
root_cause: wrong_api
resolution_type: code_fix
tags: [bundle-runner, stall, starvation, food-prices, amman, asp-net, graceful-exit, exit-75]
---

# seed-bundle-macro stall crash was a dead Amman feed, not budget starvation

## Problem

On 2026-11-16, `seed-bundle-macro` crashed on its 08:00 UTC tick. The bundle runner's stall guard flagged Food-AMMAN as starved: deferred, with data more than 2× its interval old. The section had not been starved. It ran on every tick for 4 days and failed upstream each time.

## Symptoms

- Bundle summary `ran:32 skipped:8 deferred:22 failed:0 graceful:2 stalled:1`, then exit non-zero.
- Earlier deployments' logs (2026-11-14 and 2026-11-15) show Food-AMMAN admitted on every tick and ending in `FETCH FAILED: amman report date missing; format changed` / `=== Failed gracefully ===` (exit 75). Those bundle runs reported `stalled:0` and exited 0.

## What Didn't Work

- Reading it as budget pressure. 22 sections were deferred and the budget is 550 s, so it looks like starvation. On the 09:00 and 10:00 ticks, though, the section was admitted and failed. Rebalancing order or budget would not have produced data.

## Solution

In `scripts/lib/food-prices-adapters/amman.mjs`, `collect()` read the report date from the GET landing page before posting any date. Since about 2026-11-12, `ammancity.gov.jo/ar/market/prices.aspx` returns only the empty search form on a GET ("الرجاء إدخال تواريخ صحيحة"), so `ammanReportDate(first)` threw. The fix reuses the landing page only when it carries a dated report and posts back otherwise:

```js
let firstDate = '';
try { firstDate = ammanReportDate(first); } catch { /* no report on the landing page */ }
const report = async date => {
  const html = date === firstDate ? first : await ctx.get(AMMAN_URL, { method: 'POST', /* … */ });
```

The POST-back response format is unchanged. A live check returned 166 prices for 2026-11-16 and 2026-11-09. Fix: PR #10833 (unmerged as of this writing).

## Why This Works

The bundle runner counts a member's exit 75 as a graceful skip, so a source that fails every tick keeps the bundle green. The stall guard in `scripts/_bundle-runner.mjs` fires on "deferred AND seed-meta age > 2× interval". It sees only the age, not why the data is old. So the first loud signal of a dead source is often a stall exit on whichever tick happens to defer that section. Fixing the source clears both the staleness and the stall.

## Prevention

- When a bundle exits on `stalled:N`, grep the stalled section's own lines in the previous ticks' logs (`railway logs <deploymentId> -d`, including REMOVED deployments) before touching budget or order. Read the admitted/deferred sequence across those ticks. If the section was admitted on consecutive recent ticks and each one ended `Failed gracefully` with the same error, suspect a dead source and confirm it against the upstream directly. One graceful failure can be a transient blip such as rate limiting. If it has been deferred on every recent tick, it is starved, whatever its older failures were, and fixing the source alone will not restore its data.
- For ASP.NET postback scrapers, don't depend on the landing GET carrying data. Treat it as a source of form state only. A regression test now covers a landing page with no dated report (`tests/food-prices-amman.test.mjs`).
- A POST for a date with no report still returns the dated title with "لا يوجد نتائج" (no results), so `parseAmman` returns `[]` and the five-day search continues. Do not wrap per-date errors in a catch-all; that would hide a real layout change.
