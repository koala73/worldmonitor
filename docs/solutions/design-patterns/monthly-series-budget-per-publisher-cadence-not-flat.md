---
title: "A flat content-age budget on a monthly multi-market series flags routine skipped releases; size it per publisher from measured cadence and serve the fresher publisher"
date: 2026-10-21
category: design-patterns
module: yield-curves
problem_type: design_pattern
component: seeder
severity: medium
applies_when: "A seeder serves many markets from one monthly upstream whose release lag varies by market, and health reports STALE_CONTENT on a single late release"
tags: [content-freshness, oecd, fred, ecb, cadence, provenance, seed-meta, yield-curves, alfred]
---

# A flat content-age budget on a monthly multi-market series flags routine skipped releases; size it per publisher from measured cadence and serve the fresher publisher

## Context

`oecdLtRates` serves 27 markets' monthly 10y government bond yields from FRED's
reprint of the OECD MEI series. #9443 made health assess every market's latest
observation against one 80-day budget. On 2026-10-21 eight EU markets (IT, NL,
BE, AT, IE, DK, CZ, HU) still had August while nineteen had September, so the
probe was about to report STALE_CONTENT. Widening the budget would have hidden
the lag; the real question was whether the lag was abnormal and whether a
fresher publisher existed.

## Guidance

Measure before sizing a budget, and measure per publisher, not per dataset.

- FRED's ALFRED API gives the first-publication date of every observation in
  one call: `series/observations?output_type=4&realtime_start=<start>&realtime_end=9999-12-31`.
  Lag = `realtime_start - observation date`. For the OECD MEI long-term rates
  the normal lag is 43-47 days from the period start; a release skipped for
  some countries lands at 74-77 days, two skips at 105-106, and a three-skip
  (FI 2025-08) at 136. One skipped release is routine, so a budget that fires
  on it is noise.
- The ECB Data Portal has no vintages, but `updatedAfter=<ISO>` on the data
  query bisects the publication date to the day. The ECB published every EU
  member's September 2026 long-term rate (dataset IRS, key
  `M.<CC>.L.L40.CI.0000..N.Z`, currency wildcarded for DKK/CZK/HUF/PLN/SEK) on
  2026-10-12, three days before FRED's copy and without skipping a market.
- Compare values numerically on the overlap before switching: over 32-33
  months ECB and FRED agree to 0.011 pp for 15 EU markets and 0.055 pp for FR.
- OECD SDMX direct (`sdmx.oecd.org`) returned HTTP 500 on every data query,
  including unrelated dataflows, across two attempts fifteen minutes apart;
  do not assume the originating statistics office is a usable live source.

Then encode the measurement in the structure rather than in one number
(`scripts/lib/yield-curves/oecd-lt.mjs`):

- One source table keyed by source id with the measured release lag; the
  budget is derived, `lag + one normal cycle + one skipped release + seed
  interval + margin`, so the test pins the derivation and the reviewer can
  re-measure.
- Each market records the `source` of its latest print and is judged at that
  source's budget. Health pins the widest budget (the worker exports it as the
  max of the table) and the producer applies the tighter one before publishing.
- Merge by month with the primary publisher (ECB) winning on every month both
  print and the longer history (FRED) backfilling the rest, so switching
  publishers neither shortens history (ECB starts in 1986-1993 for markets FRED
  covers from 1955-1970) nor revises overlapping months when the slower
  publisher catches up. `source` names whichever publisher supplied the latest
  print, so a FRED month newer than every ECB month is still attributed to FRED.
- Carry provenance through every projection (`:latest` key, RPC `source`
  field) and default a legacy payload with no `source` to the old publisher so
  the reader never guesses.

A dead primary publisher is not a health signal by itself when a fallback
exists: the served data is judged at the fallback's cadence, and the seeder
logs the failover. Health warns only when the served data is older than its
own publisher's cadence explains, which is the signal operators want.

## Verification

The budget measures the age of a market's latest print, not the lag of the
print that eventually arrives. One missed release leaves the latest print at
most 47 + 62 = 109 days old (fresh under 120); a second consecutive miss
carries it past 120 and health reports STALE_CONTENT, which is also when the
delayed print's own lag reaches the measured 105-106 days. Tests in
`tests/oecd-lt-content-freshness.test.mjs` pin the measured lags, the derived
budgets, that boundary (August markets fresh on 2026-10-21, stale once the
second release is missed), and the per-source divergence at 114 vs 120 days. A live dry run of `fetchOecdLtRates()`
with Upstash env stripped returned all 27 markets at 2026-09-01, the 16 EU
markets from ECB, with FRED history retained back to 1955 (PR #9510).
