# Reading field Web Vitals — INP, CLS, LCP (2026-08-05)

How to grade a performance change against our field data **without** computing a number
that moves the wrong way. Applies to all three reporters: `src/bootstrap/inp-report.ts`,
`cls-report.ts`, `lcp-report.ts`.

> **The one-line rule:** never compute a p75 or a mean over captured Sentry Web-Vital
> events. Sentry gives you a **rate**; CrUX gives you a **percentile**.

## Why the obvious number is wrong

Two filters sit between the field and Sentry:

1. **The good-trim (#4565).** Each reporter returns early on `metric.rating === 'good'`
   (`inp-report.ts:59`, `cls-report.ts:90`, `lcp-report.ts:64`). That drops ~70% of events.
2. **Uniform tail sampling (`WEB_VITAL_SAMPLE_RATE = 0.2`).** Keeps 20% of what survives.

Step 2 is shape-preserving. Step 1 is not. Anything you average or take a percentile of in
Sentry is conditioned on the bad tail — it is `p75(metric | metric ≥ bad threshold)`, not
`p75(metric)`. Those are different statistics, and they move in **opposite directions**,
because a real fix pushes moderate interactions across the threshold into `good`, which
*removes them from the sample* and leaves the survivors worse on average.

### Worked example — a genuine improvement reading as a 25% regression

1000 reporting pageviews. INP thresholds: good < 200 ms, poor > 500 ms.

**Before**

| Bucket | Count | Value |
|---|---:|---:|
| good | 700 | 150 ms |
| needs-improvement | 200 | 220 ms |
| needs-improvement | 50 | 480 ms |
| poor | 50 | 600 ms |

- Captured (non-good) = 300 → **p75 = 480 ms**, mean = 98,000/300 = **326.7 ms**
- True field p75 (rank 750 of 1000) = **220 ms**; bad-event rate = **30%**

**After** — ship a fix that moves only the common 220 ms interaction to 180 ms. Nothing else changes.

- 900 good, 50 @ 480 ms, 50 @ 600 ms. Captured = 100 → **p75 = 600 ms (+25%)**, mean = **540 ms (+65%)**
- True field p75 = **≤180 ms (−18%)**; bad-event rate = **10%** (3× better)

Every headline number the Sentry pipeline can produce moved the wrong way.

**The flat variant.** Fix the common 200–350 ms band and leave the device-bound tail
(~700 ms) alone: captured p75 sits inside the 700 ms block before *and* after. Identical
number, large true improvement. "No change" is not evidence of "no effect."

## What to compute instead

### 1. Sentry — bad-event rate (a rate, never a percentile)

```
poor_rate ≈ (count of events where tags.webvital = 'inp' AND tags['inp.rating'] = 'poor')
            × (1 / tags.sampleRate)
            ÷ <pageviews over the same window, same formFactor>
```

- `sampleRate` ships on every captured event, so the ×1/sampleRate reconstruction is exact.
- Facet by `formFactor` (`mobile|desktop`) and compare like with like.
- **Sentry holds no denominator.** It never receives `good` events, so it has no pageview
  count, and `sentry-defer.ts:36-46` documents that users who leave before the deferred
  init get no session either — so Sentry sessions are *also* not a valid denominator.
  That same comment names **Vercel Analytics** (`inject()` in `main.ts`) as the primary
  traffic metric, explicitly because it is unaffected by the deferral; use it. Umami works
  as a cross-check.
- Note `formFactor` is our own fold (`web-vitals-utils.ts:46-60`) and neither Vercel
  Analytics nor Umami computes it. Either segment the denominator by viewport as an
  approximation and say so, or compare the *unsegmented* rate and treat the formFactor
  split as directional only.

### 2. CrUX — the actual page-level p75

Use `queryHistoryRecord` for `/dashboard`. It observes the whole distribution, so none of
the above applies to it. This is the number to quote in a PR that claims an INP win.

Caveats that still apply to CrUX: it is a 28-day trailing window (a fix takes weeks to
fully land), and it is origin/page-level, so it pools all traffic to that URL.

## Known blind spots in the Sentry pipeline

These are properties of the pipeline, not of the app. Do not read a change in any of them
as a performance change.

- **A tab that is never hidden reports nothing.** `onINP` reports on `visibilitychange`
  only. A dashboard parked on a second monitor — our actual monitoring-wall use case —
  contributes no INP for the whole session. Losing OS focus does not fire it.
- **Session length confounds the value.** The reported INP is a p98-style estimate over the
  whole page load, so a 4-hour session reports a near-max over hundreds of interactions and
  a 2-minute session reports the worst of three. A shift in how long people keep the tab
  open reads as a perf change.
- **Short sessions are under-represented.** Sentry init is deferred ~10 s
  (`sentry-defer.ts:71`) into an in-memory queue with no beacon, so a report fired at hide
  before init dies with the page. That deletes bounce sessions — the users who hit a slow
  dashboard and left — which flatters the number.

## Verifying a perf change — the checklist

1. State which interaction or surface the change targets.
2. Pull captured INP events grouped by `interactionTarget` (`inp-report.ts:81`) before and
   after, to confirm the targeted surface is actually where the mass is.
3. Report the **poor-event rate** per formFactor, with the denominator named.
4. For anything claiming a p75 move, wait for **CrUX `queryHistoryRecord`** and quote it.
5. Never quote p75 or mean of captured Sentry events. If a dashboard or saved query does
   this, fix the query — the number is not weak, it is inverted.
