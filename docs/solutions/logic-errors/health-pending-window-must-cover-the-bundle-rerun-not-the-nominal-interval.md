---
title: A health pending window must outlast the bundle's real re-run, not its nominal interval
date: 2026-11-07
category: logic-errors
module: api-health
problem_type: logic_error
component: background_job
symptoms:
  - "Caught in review before merge (PR #10274): a single retained GDACS or EONET miss would still have opened a naturalEvents health incident"
  - "The pending window (maxPendingMin 150) closed before the next Natural-Events run could publish its verdict, which can land up to about 152 minutes after the miss"
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags: [health-check, source-failure, pending-window, bundle-runner, cadence, natural-events, sentry-1ag]
---

# A health pending window must outlast the bundle's real re-run, not its nominal interval

## Problem

A source-scoped `sourceFailure` policy in `api/health.js` holds a single upstream miss as pending until a `maxPendingMin` deadline counted from the first failure (`api/health.js:3811`). The next seeder run settles the question. If it succeeds, the failure clears. If it misses again, the second consecutive miss alarms. That only works if the next run publishes **before** the deadline. Otherwise the window closes on a single miss and opens the incident it was meant to suppress.

PR #10274 set `maxPendingMin: 150` for the naturalEvents GDACS/EONET policy (the fix for Sentry WORLDMONITOR-1AG). 150 sits just above the bundle's 144-minute eligibility point, but below the time the next verdict can actually land.

## Root cause

The seeder runs from the climate bundle, not a dedicated cron, so its re-run time is the sum of three terms:

1. **Eligibility.** `scripts/_bundle-runner.mjs:693` skips a section until `intervalMs * 0.8` has passed since its last publish. Natural-Events has `intervalMs: 3 * HOUR` (`scripts/seed-bundle-climate.mjs:5`), so that is 144 min.
2. **Cron tick.** The bundle fires every 5 minutes, which adds up to 5 min.
3. **Run time.** The section can run up to its `timeoutMs` of 180 s before its meta is written.

Worst case: 144 + 5 + 3 = **152 min** after the miss. Neither the nominal interval (180 min) nor the eligibility point (144 min) is the right number.

## Solution

Set the window past the worst-case re-run with margin. #10274 changed it to `maxPendingMin: 210`, which matches the NHC policy on the same key, and added a regression test. The test checks that a single retained miss is still pending at +152 min. It failed at 150.

A longer window costs nothing on real failures. A second consecutive miss turns pending off as soon as it publishes. The deadline is also still capped by `maxStaleMin` and the source's `retainedUntil` (`api/health.js:3811`).

## Prevention

- When you add or tune a `sourceFailure.maxPendingMin`, derive it from the producer's real schedule: `0.8 × intervalMs + cron tick + section timeoutMs` for a bundle section, or cron interval plus run time for a dedicated cron. Then add margin.
- Pin the derivation in a test that classifies the entry at the computed worst-case time. The test should not assert the constant.
- An `earlyRetry` (`retryAt`) can bring a re-run forward, but never later. Size the window for the eligibility path, not the retry path.
