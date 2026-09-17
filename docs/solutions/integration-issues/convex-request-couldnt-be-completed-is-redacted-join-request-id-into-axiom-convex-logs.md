---
title: "Convex's \"Your request couldn't be completed\" is redacted on both sides — join the request_id into Axiom convex-logs to tell a platform stall from our own function"
date: 2026-09-17
category: integration-issues
module: Convex functions and their Sentry / Axiom telemetry
problem_type: integration_issue
component: database
severity: medium
symptoms:
  - "WORLDMONITOR-S5 `Error: Your request couldn't be completed. Try again later.` — 3,781 lifetime events / 198 users since 2026-05-30, no stack, tags only `func`, `request_id`, `user`, `source: convex`"
  - "WORLDMONITOR-130, the `Uncaught Error: …` variant thrown out of an HTTP action (`convex/http.ts:1150`)"
  - "Per-user concentration in the issue (91, 79, 63 events on single users) that looks like data-dependent failures in our queries"
  - "The Convex log line for the same request carries the identical redacted string in `data.error_message`, so the dashboard log does not name a cause either"
root_cause: inadequate_documentation
resolution_type: documentation_update
related_components:
  - payments
  - authentication
tags:
  - convex
  - axiom
  - sentry
  - request-id
  - internal-server-error
  - diagnostics
---

# Convex's "Your request couldn't be completed" is redacted on both sides

## Problem

`Your request couldn't be completed. Try again later.` is the message Convex substitutes for an `InternalServerError` in production. It reaches Sentry twice: from Convex's own integration (`source: convex`, no stack) and, when the edge relays it, from `api/_convex-error.js`, which maps it to a 503 with `Retry-After`. Neither event says what actually failed, and the issue's shape — thousands of events, heavy per-user concentration — reads like one of our queries breaking on specific users' data. The question "is Convex timing out or is our code?" cannot be answered from Sentry.

## Symptoms

- Sentry S5 latest event: `func: POST /relay/channels`, `request_id: 59f127a648c5cddb`, `user: ip:…`, nothing else.
- `npx convex logs --prod --history 5000 --jsonl` streams forever and only covers the last few minutes on this deployment (~2,150 executions in 6 minutes), so it cannot reach an event from hours ago.
- The Convex dashboard's log entry for the request shows the same redacted string.

## What Didn't Work

- **Reading the issue's lifetime count as a current rate.** 3,781 events is May–August history; the last-30-day series had 10 events, all in one bucket at 02:00 UTC on 2026-09-17. `stats['30d']` on the issue, not `count`, is the number to read.
- **`npx convex logs` for anything older than minutes.** It dumps a short history and then tails; a `subprocess.run` on it just times out. Use a streaming read that stops when the stream goes quiet, and accept that it only sees the present.
- **The Convex status page.** No public incident for the 02:32 UTC window; sub-incident stalls do not appear there.

## Solution

The Convex deployment streams its logs into Axiom (dataset `convex-logs`, retention back to 2026-08-01 at the time of writing). Every execution is one row with `data.function.request_id`, `data.function.path`, `data.execution_time_ms`, `data.error_message`, and the deployment's queue counters. The Sentry `request_id` tag is the join key.

```text
# 1. What did this request actually do?
['convex-logs']
| where ['data.function.request_id'] == '59f127a648c5cddb'
| project _time, path=['data.function.path'], ms=['data.execution_time_ms'], err=['data.error_message']

# 2. Platform or us? Profile the minute around it.
['convex-logs']
| summarize n=count(), fails=countif(isnotempty(['data.error_message'])),
            p99=percentile(['data.execution_time_ms'], 99),
            mq=max(['data.mutation.num_queued']), aq=max(['data.action.num_queued'])
  by bin(_time, 1m)
| order by _time asc

# 3. What else fails, ever? (retention ≈ 6 weeks)
['convex-logs']
| where isnotempty(['data.error_message'])
| summarize c=count(), fns=dcount(['data.function.path']), mx=max(['data.execution_time_ms'])
  by err=substring(['data.error_message'], 0, 120)
| order by c desc
```

Run them with `AXIOM_API_TOKEN` from the main checkout's `.env.local` against `POST https://api.axiom.co/v1/datasets/_apl?format=tabular` (the response is column-major; zip `tables[0].columns`). Axiom's APL has no `any()` / `take_any()`; use `countif`, `dcount`, `percentile`, `min`, `max`.

The verdict rule that falls out of the baseline:

| Signal | Reading |
|---|---|
| Failures across several unrelated function paths in the same minute, `execution_time_ms` 1,000–3,500 on queries whose p50 is 0 ms, every queue counter at 0 | Convex backend stall. Resolve plainly; nothing to fix. |
| `Your request timed out performing too many system operations` at exactly ~15,00x ms on a cached read | The same stall hitting Convex's 15 s hard limit. Same disposition. |
| One function path failing while the minute's p99 is normal | Ours. Read that function; the request id gives you the exact execution. |
| `Uncaught ConvexError: Checkout failed: Request timed out` from `payments/checkout:internalCreateCheckout` at ~3,540 ms | Our action's own 3.5 s Dodo budget (WORLDMONITOR-WQ), a different problem. |

## Why This Works

The redaction happens inside Convex's runtime, so no consumer of the error string can see past it. What Convex does not redact is the execution record: how long the function ran, whether it returned, and what the deployment's queues looked like. Our hot queries (`entitlements:getEntitlementsForUser`, `payments/billing:getSubscriptionForUser`, `followedCountries:listFollowed`) are cached reads with p50 = 0 ms and p95 ≈ 25 ms measured over 10,000 executions, so a failure that took seconds on one of them is time spent waiting on Convex's storage layer, and a burst that spans unrelated paths in one minute is a shared cause, not per-function logic. On 2026-09-17 02:32 UTC the minute profile was: p99 from ~50–100 ms to 2,393 ms, 12 failures in ~1,000 executions across 6 paths, all queues 0, back to normal by 02:34. That is a platform stall, and the six-week baseline shows ~25 such bursts, several of them 15 s stalls (Aug 6, 13, 23, 26, 27, 31, Sep 8, 13, 17).

The per-user concentration in S5 is an artefact of the sampling: a user with a tab open through a stall generates one event per subscribed query per retry, so a handful of users dominate every burst.

## Prevention

- **Read `stats['30d']` on a Sentry issue before reading `count`.** A lifetime number on an issue that first fired months ago says nothing about now.
- **For any `source: convex` event, run the Axiom join before classifying.** The Sentry event is a pointer, not evidence.
- **Nothing here should become an `ignoreErrors` entry.** A future non-redacted error from our own function would arrive under the same `source` and must stay visible.
- **A monitor would close the loop.** Axiom has no monitors or notifiers configured for this org (checked via `/v2/monitors` and `/v2/notifiers` on 2026-09-17). A monitor on `['convex-logs'] | where isnotempty(['data.error_message']) and not(['data.error_message'] contains 'Client disconnected') | summarize count() by bin(_time, 5m)` with a threshold around 5, plus a p99 > 2,000 ms companion, would page on the next stall with the function paths attached. It needs a notifier target chosen first.
- **`convex_request_id` on the edge captures already exists** (`api/user-prefs.ts`); keep any new edge capture tagging it so the same join works from the browser-facing issue.

## Related

- [Sentry noise filtering with stack gating and signature matching](../best-practices/sentry-noise-filtering-with-stack-gating-and-signature-matching.md) — why the redacted string must not become a message filter.
- [Convex OCC write conflicts and hot-document write avoidance](../database-issues/convex-occ-write-conflicts-hot-document-write-avoidance.md) — the other Convex failure class, which is not redacted and shows up by name in the same dataset.
- `api/_convex-error.js` — the edge classification of Convex platform errors (WORLDMONITOR-PG / -PH lineage).
