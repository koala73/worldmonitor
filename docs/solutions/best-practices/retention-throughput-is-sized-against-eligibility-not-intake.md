---
module: analytics
date: 2026-08-04
problem_type: best_practice
component: background_job
severity: medium
applies_when: "Sizing the schedule or batch of any bounded retention, TTL, archival, or purge job that deletes rows older than a fixed age"
tags: [retention, capacity-planning, measurement, cron, umami, postgres]
---

# Size a retention job against the eligibility rate, not against intake

## Context

Issue #6148 activated a 90-day retention runner whose four hourly 10,000-row
batches retire up to 960,000 rows/day. The issue judged that margin thin by
comparing it against **intake** — 641,713 new events/day when written, 591,244
when measured — and concluded the backlog and the deletion contract "require
production measurement rather than assumption." The comparison was against the
wrong denominator, which made a comfortable 8-day drain look marginal.

## Guidance

A retention job that deletes rows older than N days does not race intake. It
races the rate at which rows **cross the N-day boundary** — which is the traffic
the system took N days ago, not today's.

Measure it directly rather than deriving it:

```sql
-- rows that will become eligible in the next 24h
SELECT count(*) FROM website_event
WHERE created_at >= now() - interval '91 days'
  AND created_at <  now() - interval '90 days';
```

For #6148 that returned **134,653/day** against **591,244/day** of intake — a
4.4x difference, because the boundary was still sweeping through much quieter
traffic from three months earlier (daily volumes either side of the cutoff ran
71k–204k).

Both numbers matter, for different questions:

| Question | Denominator |
|---|---|
| How long to clear the existing backlog? | eligibility rate (traffic N days ago) |
| Does the schedule hold once caught up? | intake (today's traffic) |

- **Drain:** `backlog / (capacity - eligibility)` → 6,924,840 / (960,000 - 134,653) ≈ **8.4 days**
- **Steady state:** `capacity / intake` → 960,000 / 591,244 ≈ **1.62x margin**

Sizing on eligibility alone under-provisions a growing system: as the boundary
walks forward it eventually reaches present-day volume and eligibility converges
on intake. Sizing on intake alone over-states the backlog drain and can argue a
healthy schedule into looking inadequate.

## Why This Matters

The two denominators diverge exactly when it is most tempting to guess: on a
system whose traffic has grown. The gap is the growth ratio over the retention
window, so a fast-growing service can show intake several times eligibility —
and a reviewer comparing capacity to intake will read a comfortable margin as a
knife-edge, or (in the opposite direction, on a shrinking system) approve a
schedule that never catches up.

A related trap: an eligibility rate sampled over a short window is not the daily
average, because it inherits the *hour-of-day shape* of traffic N days ago.
During #6148's evening observation the observed inflow was ~800/tick (≈79k/day)
against a measured daily figure of 134,653 — the short sample would have
overstated the drain rate by 40%. Use a full 24-hour band for the number you
publish; use short samples only to sanity-check direction.

## When to Apply

Any bounded delete-by-age job: analytics retention, log/audit TTL, soft-delete
reaping, archival sweeps, GDPR erasure batches. The rule generalizes past rows —
anything with an age-triggered queue (files, blobs, partitions) has the same two
denominators.

## Examples

Capacity claims should be stated against both, and the eligibility figure should
be a measurement, not an inference:

**Weak** — one denominator, unmeasured:

> Four bounded 10,000-row batches per hour can retire up to 960,000 event rows
> per day, safely above the roughly 300,000 events/day observed before #6024.

**Strong** — both denominators, both measured:

> Measured deletion throughput: 10,000 rows/tick x 4 ticks/h = 960,000/day,
> confirmed from every tick's log. Rows become eligible at 134,653/day (measured
> over the 90–91 day band), so the 6.89M backlog clears in ~8.3 days. Steady
> state is governed by intake at 591,244/day, leaving a 1.62x margin.

The measured-throughput half matters too: 960,000/day is a ceiling that assumes
every tick really reaches its cap. Confirm it from the job's own output
(`DELETE 10000` on each statement, each tick) before treating it as capacity.
See [the runner's activation record](../../analytics-collector-operations.md)
for the schedule this rule sized.
