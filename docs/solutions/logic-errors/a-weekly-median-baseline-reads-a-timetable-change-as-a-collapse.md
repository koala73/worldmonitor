---
module: air-traffic-collapse-detector
date: 2026-11-16
problem_type: logic_error
component: background_job
severity: high
symptoms:
  - "A European market raised a departure collapse on an ordinary evening (DE 2026-11-06 21:55Z, ratio 0.25) and an ordinary morning (DE 2026-11-10 05:35Z, ratio 0.30)"
  - "Both alerts sat at the edges of the operating day, with baselines only just above the 30-departure window floor"
  - "Ordinary readings for GB, FR and DE fell to 0.32 to 0.39 in the weeks after 2026-10-25, close to the 0.30 entry ratio"
root_cause: logic_error
resolution_type: code_fix
related_components: [testing_framework]
tags: [baseline, median, seasonality, timetable, dst, false-alarm, anomaly-detection, archive-replay, air-traffic]
---

# A weekly-median baseline reads a timetable change as a collapse

## Problem

The national air traffic collapse detector compares each departure window with the median of the same local-time window on the four prior weeks. After the 2026-10-25 change from summer to winter timetables, it read two ordinary German days as collapses. The longer archive replay found them after #10788 had already merged with only 61 days of European data.

## Root cause

Aligning bins to local time handles the clock change. It does not handle the timetable change that comes with it. Under the winter timetable, German departures stop earlier in the evening and start later in the morning, measured in local time. For about three weeks after the switch, most of the four baseline weeks still had the summer pattern. The median kept the summer shape, and at the steep edges of the operating day a normal winter evening read as a 75% drop.

| DE, Friday 22:45 to 23:00 local | Departures in 15 min |
|---|---|
| 9, 16 and 23 Oct (summer) | 24, 28, 33 |
| 30 Oct, 6 and 13 Nov (winter) | 9, 6, 10 |

## What didn't work

- **Use only baseline weeks with the same UTC offset.** On 2026-11-06 only one week qualified, below the two-week minimum, so the market would go blind for weeks after every switch. The US 2026-11-13 ground stop, the one validated US collapse, falls in that blind period after the 2026-11-01 US change, so this rule would have missed it.
- **The 61-day fixture.** It ended on 2026-10-09, before the switch, so the replay could not see this failure at all.

## Solution

Cap the signal baseline at the most recent usable week (`baselineAt(..., capAtLatest)` in `scripts/shared/air-traffic-detector.cjs`, #10809). A schedule change shows in last week's numbers first. A real collapse still compares against an ordinary week, so it still fires. The coverage baseline, the control baseline and the quiet-hours peak keep the plain median.

```js
if (values.length < MIN_BASELINE_DAYS) return null;
return capAtLatest ? Math.min(median(values), values[0]) : median(values);
```

Full replay with the cap, 111 US days and 97 European days:

- The US 2026-11-13 stop and the UK NATS failure of 2026-09-08 still enter at the same bins.
- Germany raises nothing.
- The lowest ordinary reading in any market is 0.38, against the 0.30 entry ratio.
- The US recovery lands one bin earlier, at 12:20Z.

The cost is that a disruption in the same window last week lowers this week's baseline, so a repeat collapse is harder to detect. That fails safe.

## Prevention

- A replay fixture used to validate a seasonal baseline must cover at least one timetable or clock change plus the four weeks after it.
- When a detector compares against prior periods, look first at the steep edges of the day, where the ratio is most sensitive to a small timing shift, and at the weeks after a schedule change.
- `tests/air-traffic-detector.test.mjs` has the regression test "a timetable change that last week already shows does not read as a collapse". It fails without the cap. The paired test "a collapse still enters when last week was ordinary" guards the other side.
- `tests/air-traffic-detector-replay.test.mjs` needs at least 90 European days, including 2026-10-25, 2026-11-06 and 2026-11-10.
