---
title: Derive a health pending window from the live Railway schedule, not from repo files
date: 2026-11-07
last_updated: 2026-11-07
category: logic-errors
module: api-health
problem_type: logic_error
component: background_job
symptoms:
  - "During review of PR #10274, three different cadences were argued for the naturalEvents GDACS/EONET pending window (maxPendingMin), and two of them were wrong"
  - "A reply on the PR cited a */5 cron that belongs to a different service in scripts/railway-services.json; the climate bundle's entry has cronSchedule null"
  - "The key actually has two producers, and the one that sets the real cadence is not in scripts/railway-services.json"
root_cause: logic_error
resolution_type: documentation_update
severity: medium
tags: [health-check, source-failure, pending-window, railway, cron, bundle-runner, natural-events, sentry-1ag]
---

# Derive a health pending window from the live Railway schedule, not from repo files

## Problem

A source-scoped `sourceFailure` policy in `api/health.js` holds a single upstream miss as pending until a `maxPendingMin` deadline counted from the first failure (`api/health.js:3811`). The next producer run settles it: a success clears the failure, and a second consecutive miss alarms. The window must therefore outlast the time until the next run publishes. That time comes from the producer's real schedule, and during #10274 the schedule was inferred from repo files three times, wrongly twice:

1. **"Every 3 hours."** The comment next to `maxStaleMin` and the runbook describe the climate bundle at 3h. True for that service, but not the whole story.
2. **"`*/5`, eligible at 144 min."** `scripts/_bundle-runner.mjs:693` makes a section eligible at `intervalMs * 0.8`. The `*/5` cron quoted next to it came from a different service's entry. The climate bundle's own entry in `scripts/railway-services.json` has `cronSchedule: null`.
3. **The live config.** Railway's service config shows `seed-bundle-climate` on `0 */3 * * *`. A separate `seed-natural-events` service runs the same script on `*/30 * * * *` and writes the same keys. Its deploy logs show a run at about :01 and :31 every hour. That service is listed in `scripts/railway-native-autodeploy-fleet.json`, not in `scripts/railway-services.json`.

After a miss, the next verdict usually lands about 30 minutes later, from the standalone service. The bundle runs the section on every 3-hourly tick anyway; its logs show Natural-Events runs at 00:03 and 03:03Z on 2026-11-07 while the standalone service was publishing. The 144-minute eligibility gate (`scripts/_bundle-runner.mjs:693`) does not hold it back. The standalone runs leave the bundle's `seed-completion:natural:events` marker untouched, so the marker no longer matches the envelope's `fetchedAt`, and `readSectionFreshness` treats the section as due (`scripts/_bundle-runner.mjs:227`). If the standalone service stops, the bundle alone settles a miss within about 3 hours.

## Resolution

#10274 shipped `maxPendingMin: 210`, which matched the NHC policy on the same key. It covers the 30-minute producer with wide margin and also covers the bundle-only fallback: the next 3-hourly tick, plus the section's 180 s timeout, is inside 210 minutes. The earlier value of 150 was below that fallback. While a producer keeps running, a longer window does not delay real alarms: a second consecutive miss turns pending off as soon as it publishes. The tradeoff appears when every producer stops after a retained first miss. No second verdict arrives, so the incident opens at the deadline, 60 minutes later with 210 than with 150, unless `maxStaleMin` or the source's `retainedUntil` closes the window sooner (`api/health.js:3811`).

## Outcome

Neither producer was there by design. The standalone service predates the bundle, and Natural-Events joined the bundle as a one-line side change in the cyclone-attribution PR (#5296), whose doc assumed the bundle was the only producer. On 2026-11-07 the section was removed from `scripts/seed-bundle-climate.mjs`, and `seed-natural-events` was registered in `scripts/railway-services.json` with its `*/30` cron and exact watch paths. Health budgets were then sized for that single producer: `maxStaleMin` dropped from 540 to 120 (four runs) and both pending windows from 210 to 60 minutes. The 210-minute window described above is history.

## Prevention

- Before sizing a pending window or a staleness budget, read the producer's schedule from Railway itself (`mcp__railway__get-service-config`, field `deploy.cronSchedule`). Confirm it from deploy logs (look for `Starting Container`). Neither the runbook nor `scripts/railway-services.json` is authoritative: an entry can have a null schedule, and a service can be missing from it.
- List every service that writes the key. Search both `scripts/railway-services.json` and `scripts/railway-native-autodeploy-fleet.json` for the script name, then check each service's live config. The window must cover the slowest path that can actually be the only producer.
- For a bundle section, the re-run time is the bundle cron tick that comes after `0.8 × intervalMs`, plus time spent behind earlier sections, plus up to the section's `timeoutMs`. A section can also be deferred when the bundle's time budget runs low, so this is a lower bound, not a guarantee.
- When you correct a reviewer's cadence arithmetic, cite the live config, not a neighbouring line in a JSON file.
