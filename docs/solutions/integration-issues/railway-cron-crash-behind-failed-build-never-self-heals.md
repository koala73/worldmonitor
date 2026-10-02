---
title: A Railway cron crash behind a FAILED build never self-heals, and the deployments window cannot see it
date: 2026-09-05
category: integration-issues
module: railway-seeders
problem_type: integration_issue
component: development_workflow
symptoms:
  - "The fleet diagnostic reported 'No faults needing action' for seed-fred-rates while its active deployment was already CRASHED and no further cron tick would fire"
  - "railway status --json showed activeDeployments[0].status CRASHED on a deployment id that appeared nowhere in a deployments(first:40) window of SKIPPED pushes and one FAILED build"
  - "Cron ticks kept running on the old deployment for three hours after the latest deployment went FAILED (a build-only failure that never ran)"
  - "After the 18:08Z tick ended with '=== Failed gracefully ===', nextCronRunAt kept advancing hour over hour and no tick ever started"
  - "/api/health flagged seed-meta:economic:fred-rates only when it crossed its 180-minute maxStaleMin, two hours after the cron had already stopped"
root_cause: wrong_api
resolution_type: tooling_addition
severity: high
related_components: [background_job, tooling, documentation]
tags: [railway, cron, seeders, deployment, self-heal, health-monitoring, graphql, diagnostics]
---

# A Railway cron crash behind a FAILED build never self-heals, and the deployments window cannot see it

## Problem

A Railway build failure on `seed-fred-rates` left the service's *latest* deployment in `FAILED` while an older `SUCCESS` deployment kept serving the hourly cron. When that older deployment crashed on a transient proxy outage, the cron stopped firing entirely and never came back on its own. The routine signals stayed green for hours: the fleet diagnostic reported "No faults needing action" and `/api/health` reported zero stale sources.

## Symptoms

- `/diagnose-railway-seeders` full fleet scan at 18:48Z: **"No faults needing action"**, production freshness 0 stale, tool exit 0. The `seed-fred-rates` row read class `NO_LOGS`, severity `info`, cadence `24S 1F` (24 SKIPPED + 1 FAILED across the 25-record deployments window), latest deployment FAILED.
- `railway status --json` told a different story. (The hex ids below are Railway deployment UUIDs quoted verbatim, not commits; commits are cited by PR number.) The service had a `latestDeployment` of `7dda7ddb-5fea-4700-96e9-265bc8141f11`, status **FAILED**, created 2026-09-05T15:28:14Z, `meta.buildOnly: true`, at the commit for **#7707**. Its `activeDeployments[0]` was a *different, older* deployment `7acf93db-825b-4e1e-a85f-1e8ef65719b5`, created 2026-09-04T20:16:48Z at the commit for **#7671**, with status **CRASHED**, `instances[0].status: CRASHED`, and `deploymentStopped: true`.
- That active deployment id does **not** appear anywhere in `deployments(first:40, ...)`. The whole window is SKIPPED pushes plus the one FAILED build, and all 39 SKIPPED records carry `meta.skippedReason: "No changes to watched files"`.
- The active deployment's log is a multi-tick stream on a single id. Ticks ran cleanly at 09:03, 10:04, 11:02, 12:01, 13:01, 14:01, 15:00, 16:01 and 17:04Z, then:

```
17:04:47 → 17:05:02   === Done (15078ms) ===
18:04:05 → 18:08:07   === Failed gracefully (240593ms) ===
```

- Inside the 18:04Z tick:

```
[fredFetch] proxy failed after retries (Proxy CONNECT: HTTP/1.1 522 Server Error) — retrying direct     (x41, plus CONNECT tunnel timeout variants)
FRED WALCL: fetch failed — direct: The operation was aborted due to timeout                              (and the other 23 series)
FRED series: 0/24 (series-meta cache: 24/24 hits)
[WARN] FRED series: 0 fetched — all series failed or returned no observations. Check FRED_API_KEY and PROXY_URL.
Retry 1/3 in 1000ms: FRED returned no usable series
Retry 2/3 in 2000ms: FRED returned no usable series
FETCH FAILED: economic:fred-rates fetch phase exceeded 240000ms deadline (likely a non-settling await — see issue #4786)
  Extended TTL on 2 key(s) (93600s)
=== Failed gracefully (240593ms) ===
```

- Then nothing. **No tick at 19:00Z and no tick at 20:00Z.** The log's last line stayed at 2026-09-05T18:08:07Z while `nextCronRunAt` advanced from 19:00 to 20:00; a poller watched until 20:12Z. Every earlier tick had started within 5 minutes of the hour.
- Data impact: `/api/health` watches `fredRatesSeeder` at `api/health.js:1185` with `maxStaleMin: 180`:

```js
fredRatesSeeder:   { key: 'seed-meta:economic:fred-rates', maxStaleMin: 180, minRecordCount: 24 },
```

  Redis held `{"fetchedAt":1788627902508,"recordCount":24,"sourceVersion":"fred-v1"}` (17:05:02Z, the last clean tick). That crossed 180 minutes at **20:04Z**, so health only started flagging the seeder roughly two hours after the cron had actually died.

- The FAILED build itself was Railway infrastructure, not this repository's code. `railway logs 7dda7ddb-… -b` shows repeated `failed to fetch snapshot` and `scheduling build on Metal builder` across three different builders (`builder-asxpvd`, `builder-twgrcy`, `builder-zeswmr`), with no npm or nixpacks error anywhere.

## What Didn't Work

**Scanning the deployments window.** The diagnostic walked `deployments(first:25)` (and a manual re-check at `first:40`), which is the natural way to ask "what has this service been doing?". It cannot work here: Railway creates a deployment record for *pushes* and *builds*, not for cron ticks. The deployment that was actually running the cron was 24 hours old and had been pushed out of the window by SKIPPED push records. The scan saw 24 SKIPPED and 1 FAILED, concluded nothing had run recently in an interesting way, and reported `NO_LOGS`/`info`. The state that mattered was only ever visible in `activeDeployments[]`, which the tool never read.

**Treating exit 75 as self-healing.** `=== Failed gracefully ===` with exit 75 is a designed outcome (`scripts/_seed-utils.mjs:810`, `GRACEFUL_FETCH_FAILURE_EXIT_CODE = 75`), and the fleet's standing assumption is that a graceful crash is a one-off that the next tick cleans up. Issue #5037 documented the same FRED-plus-proxy-outage crash on `seed-economy` and closed with exactly that assumption. It held for months because it is normally true. It is false when there is no next tick. Waiting for the 19:00Z tick to fix it burned an hour, and the 20:00Z non-tick burned another.

**Counting FAILED as a run crash.** The tool's classifier lumped a `FAILED` deployment record in with run failures. Railway's `FAILED` is a build or deploy outcome (`meta.buildOnly: true`, the container never started); a non-zero *run* exit is `CRASHED`. Conflating the two both hid the build failure as ordinary crash noise and let the "is this recurring?" heuristic score a build outage against the wrong denominator. The repository already knew the distinction elsewhere: `scripts/check-railway-deploy-drift.mjs:312` emits its own `BUILD_FAILED` verdict and resolves the truly running commit through `RUNNING_STATUSES` (`scripts/railway-deployments.mjs:24`: SUCCESS, REMOVED, CRASHED, SLEEPING). The seeder diagnostic had simply never adopted it.

## Solution

### Operational remediation

```bash
railway redeploy --service seed-fred-rates --from-source -y
```

This creates a fresh build at head. When it succeeds it becomes both the latest *and* the active deployment, and the hourly cron resumes ticking on it. The `--from-source` flag matters: issue #5288 found that a bare `railway redeploy` re-runs the latest deployment's own commit, which here would be the failed build.

**Status: applied 2026-09-06.** The diagnosing session could not run the command (its permission classifier blocked it), so the cron stayed dark through the 19:00Z and 20:00Z ticks. A rebuild from source landed at 02:55 UTC on 2026-09-06 as deployment `df49be50-d21d-4ed3-a9d5-b6167fd6cd9f` at the commit for #7760. No watched path had changed, so this was not a push-triggered build. Its 03:03 UTC tick wrote all 24 series, ended with `=== Done (16918ms) ===`, and refreshed `seed-meta:economic:fred-rates`. The outage lasted from 18:08 UTC to 03:03 UTC.

Verification, in order:

1. `railway status --json` and confirm `activeDeployments[0].id` is a *new* id (no longer `7acf93db-825b-4e1e-a85f-1e8ef65719b5`) with deployment status `SUCCESS`.
2. Wait for the next top-of-hour tick and confirm the log shows a fresh `Starting Container` and `=== Done (…) ===`; the instance status reads `EXITED` after a clean tick.
3. Confirm Redis `seed-meta:economic:fred-rates` has a `fetchedAt` newer than the tick, with `recordCount: 24`.
4. Confirm `/api/health` no longer flags `fredRatesSeeder`.

### The one-liner that exposes the truth

`railway status --json` is the only surface that carries `activeDeployments`. This is the diagnostic to reach for before anything else:

```bash
railway status --json | jq '.environments.edges[0].node.serviceInstances.edges[].node
  | select(.serviceName=="seed-fred-rates")
  | {cronSchedule, nextCronRunAt,
     latest: .latestDeployment.status,
     active: [.activeDeployments[] | {id, status, inst: [.instances[].status], sha: .meta.commitHash}]}'
```

A healthy service shows `latest` and `active[0]` agreeing. The failure signature is `latest: "FAILED"` with an `active[0]` that is older, at a different SHA, and `CRASHED`. Note that `railway status --json` embeds full commit messages and exceeds 1 MB on this project, so any `execSync`/`execFileSync` wrapper needs a large `maxBuffer`.

### Diagnostic-tool change (user-global, outside this repo)

`~/.claude/skills/diagnose-railway-seeders/diagnose-railway-seeders.mjs` was updated so this state can never be reported as healthy again:

- `railwayStatus()` now reads `activeDeployments` from `railway status --json` (with a 64 MB `maxBuffer`).
- `activeCrash()` marks a service red when the active deployment or its instance is `CRASHED`, and pulls *that* deployment's log rather than the newest record's.
- `tickTally()` counts `=== Done`, `=== Failed gracefully`, FATAL and `RETRY FAILED` markers inside the multi-tick log, so the chronic-versus-one-off decision is made per tick instead of per deployment record.
- `FAILED` records now tally as build failures, not run crashes, with a new `BUILD_FAILED` (warn) class and a combined `<CLASS>+BUILD_FAILED`.

Per the diagnosing session: selftest 52/52, and the live rerun flags `seed-fred-rates` as `GRACEFUL+BUILD_FAILED` (warn) with exit 1. The skill's SKILL.md gotchas were updated to match.

### What did *not* need fixing

The running image's code was already correct. `scripts/railway-services.json:1380-1405` declares 11 watch patterns for this service (`scripts/_seed-contract.mjs`, `scripts/_seed-envelope-source.mjs`, `scripts/_fred-seeder.mjs`, `scripts/_seed-utils.mjs`, `scripts/_upstash-rest.mjs`, `scripts/_proxy-utils.cjs`, `scripts/lib/llm-telemetry.cjs`, `scripts/seed-fred-rates.mjs`, `scripts/nixpacks.toml`, `scripts/package.json`, `scripts/package-lock.json`) alongside `"cronSchedule": "0 * * * *"` at line 1403. A `git diff --stat` of #7671's commit against `origin/main` restricted to those 11 paths came back empty, which is exactly why the 24 pushes after 15:28Z were correctly SKIPPED with "No changes to watched files". The corollary is the trap: because nothing in the watch set had changed, **no future push would ever rebuild this service on its own**. Only an explicit redeploy breaks the deadlock.

## Why This Works

**Railway cron ticks re-run the active deployment and create no records.** A tick starts a new container from the existing active deployment; it does not mint a deployment row. So `deployments(first:N)` is a log of pushes and builds, and a busy repository can push a service's own running deployment out of that window in a day. Cron health lives in `serviceInstances[].activeDeployments[]`, full stop.

**`FAILED` is a build outcome, `CRASHED` is a run outcome.** `meta.buildOnly: true` on the FAILED record confirms the container never started. This distinction is what makes the failure mode possible at all: because the *build* failed rather than the run, Railway had a previous SUCCESS deployment to fall back to.

**The fallback keeps ticking, until the fallback crashes.** Ticks at 16:01, 17:04 and 18:04Z all ran *after* the 15:28Z build failure, on the old deployment. That is the fallback working as designed. But once that fallback deployment went `CRASHED` with `deploymentStopped: true`, there was nothing left for the scheduler to tick: the latest deployment is unrunnable (never built) and the active one is stopped. The cron went silent while `nextCronRunAt` kept advancing, which is the cruel part, since that field is a schedule projection and not a promise.

The contrast case makes the rule precise. Per the diagnosing session (the skill's own notes and selftest fixture), `seed-military-flights` on 2026-08-03 crashed on 45 consecutive ticks over 7.5 hours. There the crashed deployment *was* the latest, and Railway re-ran it every tick anyway. So:

- **CRASHED deployment that is itself the latest** → keeps ticking (noisy, self-evident, recoverable).
- **CRASHED active deployment sitting behind a FAILED latest build** → the cron stops (silent, and never recovers on its own).

**The graceful path is why there was no data loss.** When the fetch phase throws, `runSeed` catches, logs `FETCH FAILED` (`scripts/_seed-utils.mjs:2473`), calls `preserveExistingKeys()` (line 2475) which extends the TTL on the existing keys (`Extended TTL on 2 key(s) (93600s)`, line 1274; 93600s is `FRED_TTL` at `scripts/_fred-seeder.mjs:15`, 26 hours), prints the graceful marker (line 2477), and only then exits 75 (line 2478). So the last good payload from the 17:05Z tick stayed served with a fresh 26-hour lease instead of expiring. That bought roughly a day of runway on a cron that was going to be dark indefinitely. The seeder failed correctly; the platform did not.

**Why the 240 s deadline was breached despite concurrency 12.** `scripts/_fred-seeder.mjs:32-35` states the intent plainly:

```js
// Keep the 24-series loop inside runSeed's fetch-phase deadline even when the
// proxy is fully down. At concurrency 12, the 24 requests finish in two waves
// instead of turning a proxy outage into a sequential 24-series timeout.
export const FRED_CONCURRENCY = 12;
```

Each FRED request has a 20 s ceiling on both legs: the proxy leg at `scripts/_seed-utils.mjs:1404` (`timeoutMs = 20_000`) and the direct leg at line 1450 (`AbortSignal.timeout(20_000)`). Two waves of 20 s should be 40 s, not 240 s. What the budget did not model is the *product* of three multipliers: the proxy attempt retries before giving up, each failure then falls back to a direct fetch which *also* has to time out (FRED direct appears to be unreachable from Railway's region, since all 24 series timed out on the fallback), and `withRetry` (`scripts/_seed-utils.mjs:854`, one attempt plus three retries) wraps the whole 24-series batch and runs it up to four times. The deadline itself is `lockTtlMs + FETCH_PHASE_DEADLINE_MARGIN_MS` unless the seeder overrides it (`scripts/_seed-utils.mjs:2447-2449`, margin 120 s at line 2197), which for this seeder is 240 s, and `raceFetchDeadline` (line 2199) is what finally cut it off with the message at line 2203.

The proxy outage was genuinely transient: per the diagnosing session, a CONNECT probe from a laptop to `api.stlouisfed.org:443` at 19:13Z answered `HTTP/1.1 200 OK` in 1753 ms, and other proxy consumers (`seed-gdelt-intel`, `seed-economy`) logged zero 522 / `proxy failed` / `CONNECT tunnel` lines over the same window. A transient upstream blip caused a single graceful crash. The outage lasted a hundred times longer than the blip because of the deployment state it landed in.

## Prevention

**Alert on the state, not on the symptom.** The specific condition to page on is: `latestDeployment.status == FAILED` **and** `activeDeployments[0]` is an older deployment. That combination means the service is running on borrowed time, with no automatic path back to head, and one crash away from silence. It is detectable the moment the build fails, roughly three hours before `/api/health` would notice (`maxStaleMin: 180` at `api/health.js:1185`), and longer for seeders with a laxer stale window.

**Treat `BUILD_FAILED` as time-critical, not as backlog.** The instinct is that a failed build is harmless because the old image is still serving. That is true right up until it isn't, and the window is unbounded. A Railway-infrastructure build failure (`failed to fetch snapshot` across multiple Metal builders, no npm or nixpacks error) is *especially* worth an immediate retry, since nothing in the repo needs changing for it to succeed.

**The diagnose tool now catches this class.** `activeCrash()`, `tickTally()`, and the `BUILD_FAILED` / `<CLASS>+BUILD_FAILED` classes together mean a green fleet report can no longer be produced while a service's active deployment is crashed or its latest build failed. Keep the selftest fixture for this case; it is the only thing standing between the fleet and a silent repeat. The in-repo `scripts/check-railway-deploy-drift.mjs` answers the neighbouring question ("is production running head?") fleet-wide and already names `BUILD_FAILED` when the build for head failed; it needs `RAILWAY_PROJECT_ID` in the environment, and its verdict for this incident was not captured.

**Consider making a FAILED build page immediately.** A suggestion, not a done thing: Railway already emails on deploy crashes. Routing build failures to the same alerting path (or to the seeder diagnostic's warn tier as a hard gate) would remove the dependence on someone running a fleet scan.

**Consider a seeder-side fail-fast.** Another suggestion: when *every* proxy CONNECT in the first wave returns a 5xx, the run could abort the batch immediately rather than grinding through the direct fallback and three `withRetry` rounds until the 240 s deadline fires. Failing at 15 s instead of 240 s would not have prevented this outage (the crash would still have happened), but it would leave a much clearer log signature and stop the seeder holding its lock for four minutes. Worth weighing against the risk of aborting on a partial proxy blip that would have recovered.

**Operator habit.** After any Railway build failure on a cron service, run `railway redeploy --service <name> --from-source` right away. Do not wait for the next merge to trigger a rebuild: if the failure was infrastructural, nothing in the watch set has changed, so no future push will ever rebuild that service on its own.

## Related Issues

- [Railway defers deploys on a red check suite, not on watch paths](./railway-seeder-watch-paths-can-skip-deployments.md): the sibling doc for the SKIPPED half of this deployment's window, and the origin of the `BUILD_FAILED` verdict concept this doc re-derives for a different tool.
- [A Railway cron schedule lives on the deployment manifest, not the service config](./railway-cron-schedule-lives-on-the-deployment-manifest.md): count ticks in the active deployment's own logs, never by polling the deployments list.
- [A merged seeder fix is not live until its cron fires](./merged-is-not-ran-long-cron-seeders.md): the sibling "deployment list overstates activity" failure mode, a schedule gap rather than a post-crash gridlock.
- #5037: the same FRED, proxy-down, 240 s deadline, exit-75 shape on `seed-economy`, closed on the assumption that the next tick self-heals.
- #5288: a bare `railway redeploy` re-runs the same commit; recovery needs a build from source.
- #6483: the contrast case, a real exit-1 crash behind a SKIPPED build (cache-key skew), which does not self-heal for a different reason.
- #6141: the origin of the watch-path SKIPPED investigation.
- #4786: defines the fetch-phase deadline that the crash log cites.
- #4994: the bounded-concurrency fix pattern for recurring exit-75 crashes.
- `CONCEPTS.md`, Graceful Skip: the vocabulary for what the seeder did right here.
