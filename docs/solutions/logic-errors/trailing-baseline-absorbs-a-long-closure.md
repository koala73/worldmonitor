---
title: "A trailing 90-day baseline read a closed Strait of Hormuz as 82% of normal"
date: 2026-11-15
category: logic-errors
module: scripts/seed-chokepoint-flows.mjs
problem_type: logic_error
component: background_job
severity: high
symptoms:
  - "The chokepoint flow estimate showed Hormuz at 0.818 of baseline, close to normal, while the server's status rated it red"
  - "The Supply Chain status dots were green for every chokepoint, including ones the API rated red or yellow"
  - "The Hormuz Trade Tracker showed empty charts dated September, so it looked broken rather than reporting a closure"
root_cause: logic_error
resolution_type: code_fix
tags: [chokepoints, portwatch, baseline, trailing-window, hormuz, flow-estimate, dwt]
---

# A trailing 90-day baseline read a closed Strait of Hormuz as 82% of normal

## Problem

`computeFlowEstimate` in `scripts/seed-chokepoint-flows.mjs` compared the last
7 days of tanker traffic with the 90 days before them. Once Hormuz had been
closed for more than 90 days, those 90 days were the closure itself. The
closure became the definition of normal, and the estimate published 0.818 of
baseline for a closed strait.

## Symptoms

- Flow estimate for `hormuz_strait`: 0.818, source `portwatch-counts`, not
  disrupted.
- Every chokepoint status dot was green. The strip's local `statusColor()`
  matched words the API never sends; `get-chokepoint-status` returns
  `green | yellow | red`.
- The Hormuz Trade Tracker charts were all zero, under a September date. The
  zeros were real: Power BI sent explicit 0s. The date was the WTO commentary
  date, not the data date.

## What Didn't Work

- Reading the panels alone. The Chokepoints tab's transit chart, built from
  PortWatch history, was healthy throughout. The fault was only visible by
  comparing the flow estimate with raw daily tanker counts in Redis.
- Treating the Hormuz zeros as a parser bug. The Power BI payload had no nulls
  and no null-mask records; the zeros were measured.

## Solution

Measure flow against the same strait a year earlier, which a closure shorter
than a year cannot contaminate (PR #10784):

- `scripts/seed-portwatch.mjs` `fetchBaselineStats` asks ArcGIS
  `outStatistics` for tanker count and tanker DWT means over the 12 months
  ending one year before the run (`BASELINE_WINDOW_DAYS` and
  `BASELINE_LAG_DAYS` are both 365). The Hub CSV path computes the same
  statistics from rows.
- `buildBaseline` stores each mean only with its own coverage. The count mean
  needs `tanker_days >= 300`. The DWT mean needs positive DWT on at least half
  of the rows it averages (`cap_tanker_days >= ceil(cap_tanker_rows / 2)`),
  because zero-filled gaps lower it.
- `computeFlowEstimate(rawHistory, baselineMbd, yearBaseline)` uses the
  year-earlier DWT mean, then the year-earlier count mean, and falls back to
  the trailing window only when neither is usable.

PortWatch stores a blank tanker capacity as 0, so a day with tankers and zero
DWT is unreported tonnage, not zero flow:

```js
const recentDwtReported = last7.every(d => (d.capTanker ?? 0) > 0 || (d.tanker ?? 0) === 0);
```

DWT is chosen only when `recentDwtReported` holds, on the year-earlier path and
on the trailing fallback (the fallback check landed in PR #10787). Zero tankers
with zero tonnage stays on DWT, as the closure signal.

The UI fixes from PR #10784: both status strips use the shared
`chokepointStatusColor(status)`; the Hormuz panel shows "No shipments recorded"
for an all-zero series, drops blank or non-numeric points at the parser, and
labels the daily data date separately from the WTO commentary date.

Live result on production data: Hormuz 0.02 (disrupted), Bab el-Mandeb 0.588
(disrupted), Bosphorus 0.609 (disrupted), and the other four chokepoints
normal.

## Why This Works

A trailing baseline answers "is this week unusual compared with the recent
past?". During a disruption longer than the window, the recent past is the
disruption, so the question has the wrong answer built in. The year-earlier
window answers "is this week unusual compared with the same strait a year
ago?", which stays correct for any closure shorter than a year.

The window still moves: `baselineWindow()` covers `[now - 730d, now - 365d)`
and advances on every run. A closure that lasts more than a year starts to
enter it, and after two years it fills it, so the estimate would drift back
towards "normal". Protection beyond that needs a baseline pinned to a date
before the event, which this fix does not do.
The coverage gates keep a thinly reported year from defining normal, and the
unreported-DWT rule keeps a missing value from reading as a measured zero.

## Prevention

- When a metric compares recent values with a trailing window, ask what it
  reports once a disruption outlasts the window. If the answer is "normal",
  move the window further back, and state how long a disruption it covers. A
  lagged window only delays the problem by its lag; only a baseline pinned
  before the event removes it.
- Store a mean only with the count of the rows it averages, and gate each mean
  on its own coverage. A coverage check that divides by another field's day
  count can pass while the mean itself is mostly zero-filled.
- When a source stores a blank as 0, decide per field what a zero means. Apply
  that rule on every path that chooses the signal, including fallbacks; a
  fallback that skips it reintroduces the bug in exactly the cases the main
  path rejects.
- Test the long-closure case directly: 90+ days of zeros before the recent
  week, with a year-earlier baseline, must not read as normal
  (`tests/chokepoint-flows-seed.test.mjs`).
- A UI status color must come from the API's own enum. A mapping that matches
  words the API never sends silently falls through to its default.

## Related Issues

- PR #10784: year-earlier baseline, status colors, Hormuz panel.
- PR #10787: unreported-DWT rule on the trailing fallback.
- [keyword-spike-baseline-window-outran-the-capped-fetch.md](keyword-spike-baseline-window-outran-the-capped-fetch.md):
  another baseline whose stated window did not match the data it averaged.
