# Five-factor scorecard v1 hand check

Date: 2026-08-29

This is a deterministic methodology check, not production coverage evidence.
The fixture chooses ten country labels and gives every available input the same
independently selected normalized anchor. The test in
`tests/five-factor-scorecard-hand-check.test.mts` converts each anchor back to
the frozen raw goalposts, runs the production scorer, and checks every pillar.
Supplier diversity remains explicitly unavailable with
`redistribution-blocked`; defense renormalizes its other available weight.

| Country label | Anchor | Expected band | Checked pillars |
|---|---:|---:|---|
| US | 90 | 5 | all five |
| DE | 75 | 4 | all five |
| JP | 62 | 4 | all five |
| IN | 58 | 3 | all five |
| BR | 50 | 3 | all five |
| ZA | 45 | 3 | all five |
| AE | 39 | 2 | all five |
| MX | 25 | 2 | all five |
| ID | 19 | 1 | all five |
| ZW | 8 | 1 | all five |

This cohort exercises both sides of the 20, 40, 60, and 80 band boundaries,
linear and logarithmic normalization, lower-is-better inputs, coverage
renormalization, all five pillar weight sets, and the SIPRI policy block. Exact
boundary behavior is covered separately in
`tests/five-factor-scorecard-scoring.test.mts`.

## Seeder measurement

A read-only `node scripts/seed-five-factor-scorecard.mjs --dry-run` against the
configured production source cache built and validated 196 countries on
2026-08-29. The snapshot was 3,716,740 bytes, the process used 1.82 seconds of
wall time, and `/usr/bin/time -lp` reported 220,577,792 bytes maximum resident
set size. The dry-run did not publish the snapshot. This proves local placement
and the 5 MB storage bound against that source cohort; it does not prove a
Railway deployment, a scheduled production write, or public API availability.
