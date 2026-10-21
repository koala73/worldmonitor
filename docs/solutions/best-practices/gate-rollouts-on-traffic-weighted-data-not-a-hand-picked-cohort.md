---
title: "Gate a rollout on traffic-weighted data, not a hand-picked cohort"
date: 2026-07-18
category: best-practices
module: "Bootstrap storage cutover verification (U-K3 gate, #5338)"
problem_type: best_practice
component: development_workflow
severity: medium
applies_when: "Writing the pass/fail gate for a migration, cutover, or A/B rollout — especially when the plan names a specific 'worst case' cohort to gate on"
tags: [verification-gate, rollout, percentile, sample-size, traffic-weighted, decision-criteria, measurement, cutover, p95]
---

# Gate a rollout on traffic-weighted data, not a hand-picked cohort

## Context

The plan for cutting the bootstrap public tier over to a new storage backend specified its verify
gate up front as: *"gate on the worst APAC cohort (hkg1/syd1/bom1/sin1) — the candidate's p99 must
be materially below the incumbent there."* Picking the worst-looking region and demanding the
candidate win there feels like the conservative, rigorous choice.

It was neither. When the measurement window actually ran, that gate produced a table nobody could
act on:

- **APAC is a minority of the traffic.** The user base was genuinely worldwide — the top countries
  by volume were the US, India, Italy, Australia, Germany, the UK, Japan, France, Singapore, and
  the UAE. Gating on four APAC cities decided a global cutover on a slice of it.
- **One of the four named cities never gathered enough data to judge.** Seoul finished the window
  with roughly 14–20 samples per side. It reported a "win" that meant nothing.
- **A per-city p95 on a thin cell is noise, not a verdict.** With ~20 samples, the 95th percentile
  *is* essentially the maximum observed value, so one slow read moves it arbitrarily.

Jakarta made the last point unmissable. Its p95 read **222 ms at n=4, then 1418 ms at n=32, then
1341 ms at n=56, then 799 ms at n=86** — a ~6× swing driven by sample count alone, before it
settled. A gate evaluated at any single one of those moments would have returned a confident and
different answer.

## Guidance

**Pick the gate's denominator from where users actually are.** Replace "does the candidate win in
cohort X" with a single traffic-weighted metric over *all* traffic — here, *the share of all reads
clearing the client latency budget*. Weighting is automatic, no cohort has to be chosen, and the
number is directly meaningful to the decision being made.

Then structure the gate as **two separate tests**, because they answer different questions:

1. **Relative (the blocker):** does the candidate regress anyone? Compare candidate vs incumbent
   per region, *but only in cells with enough samples to judge*. A regression in a well-sampled
   region blocks the rollout.
2. **Absolute (the quality bar):** what share of all traffic clears the target? Report it; hold it
   to a threshold. This is a bulk-quality measure, **not** a per-region hard requirement.

**Add a minimum-sample threshold so thin cells report `inconclusive` rather than a false PASS or
FAIL.** This is the single highest-value line in a gate script. Without it, small cells emit
confident verdicts that flip run to run.

Finally, keep the absolute bar from masquerading as a blocker. A region where the candidate is
*better than the incumbent yet still misses the absolute target* is a follow-up, not a stop —
because shipping still improves those users. Conflating the two is what made the first version of
this gate hard-fail on a 32-sample remote city while the candidate was beating the incumbent there.

## Why This Matters

Reframing from the APAC cohort to a global traffic-weighted metric did two things.

It produced a **decisive** answer where the cohort gate had produced an ambiguous one: the
candidate cleared the budget for **99.6 %** of all reads versus the incumbent's **84.4 %** — the
incumbent was missing roughly one request in six, globally.

More importantly, it **surfaced the findings the cohort lens had hidden entirely**:

- The incumbent was *catastrophic* in regions nobody had named as the worst case — clearing the
  budget for only ~40 % of reads in Africa and ~39 % in Oceania. The APAC-only gate would never
  have looked there.
- The incumbent's platform had **no Middle East region at all**, so MENA users were being served
  from Europe — while the candidate served them locally at ~270 ms with 100 % clearing the budget.
  For a MENA-centred user base this was arguably the single most valuable finding of the exercise,
  and the original gate could not have produced it.

The hand-picked cohort did not just measure the wrong thing — it pointed attention away from where
the real problem was.

## When to Apply

Apply whenever writing the accept/reject criteria for a cutover, migration, dependency swap,
infrastructure change, or performance A/B — particularly when a plan or ticket already names a
"worst case" cohort to gate on. Treat that named cohort as a *diagnostic view*, not the gate.

Also apply when reviewing a gate someone else wrote. The tells:

- The gate's denominator is a chosen subset rather than all traffic.
- Percentiles are computed per narrow cell with no sample-count guard.
- A single threshold serves as both "did anyone regress" and "is quality good enough".

Less relevant when the cohort genuinely *is* the population (a region-specific launch), or when
per-cell volumes are large enough that thin-cell noise cannot arise.

## Examples

**Before — cohort gate with a hard absolute clause and no sample guard:**

```python
APAC = ["hkg1", "syd1", "bom1", "sin1"]
for city in APAC:
    ok = kv_p95[city] < redis_p95[city] and kv_p95[city] < BUDGET_MS
    if not ok:
        gate_pass = False          # a 32-sample city can hard-fail the whole rollout
```

**After — traffic-weighted headline, sample-guarded relative test, separate quality bar:**

```python
MIN_SAMPLES  = 25    # below this a per-cell p95 sits on the near-max sample => inconclusive
BULK_TARGET  = 99.0  # % of ALL reads that must clear the budget

# 1. Relative test (the blocker) — only where the cell can actually be judged.
for city in regions:
    if kv_n[city] < MIN_SAMPLES or rds_n[city] < MIN_SAMPLES:
        verdict[city] = "thin"                      # inconclusive, NOT a pass or fail
    elif kv_p95[city] > rds_p95[city]:
        regressions.append(city)                    # this is what blocks
    elif kv_p95[city] > BUDGET_MS:
        budget_misses.append(city)                  # beats incumbent but misses target => follow-up

# 2. Absolute quality bar (traffic-weighted over ALL reads, no cohort chosen).
under_pct = 100.0 * reads_under_budget / reads_total

gate = (not regressions) and under_pct >= BULK_TARGET
```

The rewritten gate changed the reported outcome without any change in the underlying data: the
same window that "FAIL"ed on a 32-sample remote city under the first version returned a clean pass
with that city correctly reported as *"beats incumbent, misses absolute target — follow-up"*, and
the thin cell reported as *inconclusive* instead of a fabricated win.

## Related

- `docs/solutions/2026-07-16-bootstrap-kv-verify.md` — the verify artifact this gate produced,
  including the continent-level table that the cohort framing would have omitted.
- `docs/solutions/design-patterns/hedge-cache-read-against-origin-not-hard-timeout.md` — the same
  window's data used for a different decision, and another instance of the general habit: measure
  the distribution before committing to a constant.
