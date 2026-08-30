# Five-factor scorecard v1 hand check

Date: 2026-08-29

This is a deterministic methodology check, not production coverage evidence.
The fixture chooses ten country labels and stores an independently frozen,
heterogeneous table of raw source values plus reviewer expectation notes. The
test in `tests/five-factor-scorecard-hand-check.test.mts` converts those values
to the landed upstream source shapes, runs the production source adapter, and
then checks every production scorer result. It does not derive expected values
from the production normalization registry at run time.
Supplier diversity remains explicitly unavailable with
`redistribution-blocked`; defense renormalizes its other available weight.

| Label | Food | Energy | Demographics | Technology | Defense | Reviewer expectation |
|---|---:|---:|---:|---:|---:|---|
| US | 89.64 | 85 | 76.43 | 82.81 | 72.2 | strong, with defense below technology and food |
| DE | 74.29 | 65 | 76.86 | 77.31 | 78.2 | consistent high capability |
| JP | 60.36 | 40 | 66.07 | 76.81 | 66 | technology leads mixed energy |
| IN | 65.36 | 55 | 58.21 | 51.88 | 49 | food leads otherwise mixed pillars |
| BR | 72.14 | 95 | 48.93 | 41.56 | 68 | energy and food lead capability inputs |
| ZA | 41.43 | 25 | 45 | 45.94 | 45 | energy is the material deficit |
| AE | 18.93 | 100 | 46.79 | 57.31 | 89 | energy and defense contrast with food |
| MX | 55.71 | 20 | 42.86 | 38.75 | 47 | mixed pillars with weaker energy and technology |
| ID | 47.5 | 70 | 44.29 | 37.81 | 26 | energy leads technology and defense |
| ZW | 13.93 | 5 | 13.93 | 10.19 | 8 | all five pillars remain severe deficits |

This cohort exercises both sides of the 20, 40, 60, and 80 band boundaries,
linear and logarithmic normalization, lower-is-better inputs, coverage
renormalization, heterogeneous component weights, all five pillar weight sets,
the source-adapter mappings, and the SIPRI policy block. Exact
boundary behavior is covered separately in
`tests/five-factor-scorecard-scoring.test.mts`.

## Seeder measurement

The first read-only production-source audit on 2026-08-29 built 196 countries
and a 3,716,740-byte snapshot in 1.82 seconds, with 220,577,792 bytes maximum
resident set size. It predated the per-pillar publication guard.

The refreshed read-only audit on 2026-08-30 built 196 country objects, 187 with
at least one scoreable pillar, and a 3,629,008-byte snapshot. Scoreable counts
were food 91, energy 0, demographics 176, technology 0, and defense 40. The
strengthened validator correctly rejected that cohort: the deployed source
cache does not yet contain the new complete physical-energy pairs or the new
source-preserving World Bank technology observations from this change.

No dry-run modified Redis. Production acceptance remains gated on deploying
and running those two upstream producer changes, then observing a scorecard run
that meets all frozen publication floors. Repository tests and a local dry-run
do not prove a Railway deployment, a scheduled production write, public API
availability, or acceptance completion.
