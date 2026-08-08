---
title: Health must not grade a deliberately-unconfigured optional source
date: 2026-07-14
category: logic-errors
module: api-health
problem_type: logic_error
component: service_object
symptoms:
  - "/api/health reports SEED_ERROR for a source the deployment never supplied a credential for"
  - "A warn that no operator action can clear except obtaining a third-party API key"
  - "The producer distinguishes 'unavailable' from 'stale'/'error' but health reports all three identically"
root_cause: logic_error
resolution_type: code_fix
severity: medium
related_components: [background_job, frontend_stimulus]
tags: [health-monitoring, seed-meta, classifier, status-codes, optional-sources]
---

# Health must not grade a deliberately-unconfigured optional source

## Problem

`/api/health` reported `globalTendersSam: SEED_ERROR` on **every run** since the
Global Tenders feature shipped. The SAM.gov adapter requires `SAM_GOV_API_KEY`,
which had never been provisioned — so the warn could not be cleared by any
engineering action, only by obtaining a US government API key.

Health was grading the deployment on a source it had never opted into.

## Symptoms

- A permanent `warn` on `/api/health` that no code change can fix.
- The seeder's own logs say the source is *unavailable*, not *failing*.
- The docs explicitly describe the unconfigured state as supported
  (`docs/global-procurement-intelligence.mdx`), yet health calls it an error.

## Root cause

The producer emits **four** distinct source states — `ok`, `stale`, `error`, and
`unavailable` — and `unavailable` is written from exactly one place in the repo:
the adapter's missing-credential branch. But the classifier collapsed every
non-`ok` state into a single bucket:

```js
// api/health.js — before
const sourceDegraded = typeof meta?.sourceState === 'string' && meta.sourceState !== 'ok';
...
if (seedError) status = 'SEED_ERROR';   // warn
```

So *"this deployment never opted into the adapter"* was graded identically to
*"this adapter was tried and is broken."* Those are different claims and only
one of them is actionable.

## Solution (PR #5295, merged)

Classify `sourceState: 'unavailable'` as its own status, bucketed `ok` and
excluded from the compact `problems` map:

```js
// api/health.js:806 — "never opted in" is not a fault
const sourceUnavailable = meta?.sourceState === 'unavailable';
const sourceDegraded = typeof meta?.sourceState === 'string'
  && meta.sourceState !== 'ok'
  && !sourceUnavailable;
...
if (sourceUnavailable) status = 'NOT_CONFIGURED';
else if (seedError) status = 'SEED_ERROR';
```

It is **self-clearing**: once the credential lands, the next seed run writes
`sourceState: 'ok'` and the key flips to `OK` with no health-config change.

## Two traps that make the naive fix worse

Both are load-bearing, and both are pinned by mutation-tested assertions.

**1. Exempting `unavailable` without a dedicated status turns a warn into a
`crit`.** Removing it from `sourceDegraded` lets the check fall through to the
`records === 0` branch and land on `EMPTY_DATA`, which buckets to `crit`. The
"fix" would have escalated the very thing it was meant to silence.

**2. An unregistered status silently re-becomes the warn.** The summary does:

```js
const bucket = STATUS_COUNTS[entry.status] ?? 'warn';   // api/health.js
```

so a new status that is not explicitly registered in `STATUS_COUNTS` defaults
straight back to `warn`. The exemption only holds because `NOT_CONFIGURED: 'ok'`
is listed there.

## Sweep every problem surface, not just the one you are looking at

The first commit fixed the compact `problems` map and **missed two identical
hardcoded filters** feeding the console failure log and the `?history=1`
incident signature:

```js
c.status !== 'OK' && c.status !== 'OK_CASCADE' && c.status !== 'EMPTY_ON_DEMAND'
```

That path runs whenever `overall !== 'HEALTHY'` — precisely the state an
*unrelated* crit puts the fleet in. Production was `DEGRADED` at the time, so
operators would still have seen a permanent `NOT_CONFIGURED` problem, and the
dedupe signature would have been permanently salted with a non-problem.

The fix is a single `STATUS_COUNTS`-derived predicate shared by every surface,
so a future `ok`-bucket status cannot be honoured on one and ignored on another:

```js
function isProblemStatus(status) {
  return STATUS_COUNTS[status] !== 'ok';
}
```

**One intentional asymmetry survives:** the failure log additionally suppresses
`EMPTY_ON_DEMAND` (warn-for-visibility only; it never flips `overall`), while
the compact map *does* surface it. Verify divergences like this against
production before "unifying" them — flattening it would have been a regression.

## Prevention

- **When a producer distinguishes states, the consumer must too.** A classifier
  that reduces N states to a boolean is throwing away the exact signal the
  producer paid to compute.
- **Grep for sibling filters before declaring a status change done.** The bug
  here was not the logic; it was fixing one of three copies. Derive shared
  predicates from the status table rather than hardcoding status lists.
- **A permanent warn nobody can clear is a bug, not noise.** It trains operators
  to ignore the channel, which is how a real failure gets missed.

## Verified

`globalTendersSam` disappeared from `/api/health` problems in production, while
`globalTendersCanadaBuys` — a genuinely *broken* source in the same bundle —
kept reporting `SEED_ERROR`. That contrast is the regression guard proving
itself: the deliberately-unconfigured source went quiet, the actually-broken one
still shouts.

## Related

- [Reject degraded China macro snapshots at the seed publish boundary](reject-degraded-china-macro-seed-publication.md)
  — the mirror-image concern at the *publish* boundary rather than the health boundary.
- PR #5295 — the `NOT_CONFIGURED` status and the shared `isProblemStatus` predicate.
