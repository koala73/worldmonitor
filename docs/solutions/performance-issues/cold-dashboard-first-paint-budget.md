---
title: Give the cold-dashboard first-paint sample its own renderer budget
date: 2026-09-13
category: performance-issues
module: e2e/map-overlay-marker-budget.spec.ts
problem_type: test_coverage
component: testing_framework
severity: medium
root_cause: sample_budget_mismatch
resolution_type: test_fix
tags: [playwright, ci-artifacts, renderer-nodes, cold-load, performance-budget]
---

# Cold-dashboard first-paint renderer budget

[Issue #7867](https://github.com/koala73/worldmonitor/issues/7867) identified
that the cold-load spec applied the settled-dashboard ceiling to the
pre-hydration shell. The shell needs its own measured ceiling.

## CI evidence

Selection: the latest successful `Test` run on `main` on each UTC date from
September 9 through September 13, 2026. Each run has one cold-load metrics file
with three loads. These are five distinct commits and 15 loads, with no sample
removed from the first-paint range.

The files were read from `playwright-ci-smoke-1-<run>-1` artifacts. In each ZIP,
the path is
`map-overlay-marker-budget--86fe1-s-bounded-across-cold-loads-chromium/cold-dashboard-metrics.json`.
Counts below are post-GC Chromium renderer nodes. A comparable settled sample
requires `wait.quiesced`, `initialDataReady`, and zero `elementDriftDuringRead`.

| Run | Commit | First paint | Quiesced / total | Comparable settled / total | Comparable settled range |
| --- | --- | --- | --- | --- | --- |
| [34769842240](https://github.com/koala73/worldmonitor/actions/runs/34769842240) | `7c6618573ee5` | 8965–9477 | 3/3 | 3/3 | 10491–10537 |
| [34706058324](https://github.com/koala73/worldmonitor/actions/runs/34706058324) | `d1e545f04b60` | 9229–9358 | 3/3 | 3/3 | 10730–10753 |
| [34637125811](https://github.com/koala73/worldmonitor/actions/runs/34637125811) | `851467cf1891` | 9187–9526 | 3/3 | 2/3 | 10670–10671 |
| [34517875660](https://github.com/koala73/worldmonitor/actions/runs/34517875660) | `d90686923197` | 9165–10065 | 3/3 | 2/3 | 10473–10497 |
| [34391396339](https://github.com/koala73/worldmonitor/actions/runs/34391396339) | `e01b020d3441` | 8956–9327 | 3/3 | 2/3 | 10547–10557 |

All 15 loads quiesced, and every element drift was zero. The last load on
September 9, 10, and 11 missed the hydration-ready flag: their renderer counts
were 10,622, 10,521, and 10,693 respectively. Those three numbers remain in
the artifacts but are excluded from the comparable settled range.

## Decision

Use issue option 1: `FIRST_PAINT_METRIC_BUDGETS.rendererNodes = 12000`.
The observed first-paint range is 8,956–10,065. The new ceiling has 1,935 nodes
of headroom above the maximum, or 16.1% of the ceiling, compared with 4,935
nodes (32.9%) under the old ceiling. It is also 1,751 nodes above the earlier
10,249 maximum reported in the issue. A first-paint sample at 12,001 now fails;
previously it passed under 15,000.

Keep `DASHBOARD_METRIC_BUDGETS.rendererNodes = 15000` as the settled-page
contract. Comparable settled counts range from 10,473 to 10,753, but the
hydration-ready signal was missing on 3/15 loads. Moving the required gate to
that sample would add a readiness failure mode. Node-reduction product work
is not justified by this CI evidence. DOM-element and listener limits remain
12,000 and 1,500 for both samples.

## Verification contract

The existing source guard pins the cold-load call to both `firstPaint.postGc`
and `FIRST_PAINT_METRIC_BUDGETS`. The existing negative control checks both
budget objects, accepts each exact ceiling, and rejects each metric at its
ceiling plus one. This includes 12,001 first-paint renderer nodes.

The metric attachment remains backed by a file. Its top-level `budgets`
now describes the asserted first-paint sample; `recorded.budgets` preserves
the settled-dashboard contract. Missing or incomplete settled samples remain
visible through the existing counters and per-load diagnostics.

This checks the real local dashboard with off-origin traffic blocked. It is
a CI cold-load guardrail, not a measurement of live feed volume or proof of
production performance. The stress-harness tests separately exercise overlay
marker limits. No production code or UI changes are needed.
