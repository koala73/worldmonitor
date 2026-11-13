---
title: CII coverage ledger
noindex: true
---

# CII coverage ledger

The coverage floor is a list of countries, not a count that another country can
replace. [Issue #10577](https://github.com/koala73/worldmonitor/issues/10577), R28,
requires each release's scored set to contain its predecessor. An upstream
failure does not change this floor: label the missing input, alarm and restore it.

`shared/cii-coverage-baseline.json` records completed coverage steps in order.
The last step is active. Append a step when its coverage is ready; do not add
planned C2–C4 country sets before their admission and release decisions.

| Step | Recorded | Scored | Economic stress expected | Evidence |
|---|---|---:|---:|---|
| C0 | 2026-11-13 | 31 | 25 | OQ9; producer #10606; quote cleaning and replacement source #10613 |

The 25 expected economic countries are US, RU, CN, UA, IR, IL, TW, SA, TR, PL,
DE, FR, GB, IN, PK, VE, MX, BR, AE, KR, IQ, LB, EG, JP and QA. KP, CU, SY, YE,
MM and AF are recorded gaps, not zero-stress observations. Other input families
have no measured-country floor recorded here yet; this is not a claim that they
cover every scored country. U23 will inventory their global coverage.

Health requires each expected economic country to retain at least one fresh
member. It reports `missingExpectedCountries` in operator details and strips the
names from public compact responses. A newly measured country cannot substitute
for a lost expected one. This supersedes the former count-only alarm at 23;
initial economic deployment acceptance remains 25. The producer still publishes
readable partial coverage; the health alarm does not veto publication or change
any score.

## Owner-approved family removals

No removal is approved today. For an exception, add an entry to the JSON block
below with `from`, `to`, `family`, `country`, `ruling` (the owner's dated decision)
and `url` (the recorded ruling). Use the same step for `from` and `to` when
amending an existing step. An exception permits only the named family removal;
it never permits removal from the scored set. Do not record an upstream outage
as an exception. Supply a replacement source in the same PR or stop for the owner.

```json
{"exceptions": []}
```

The tests compare consecutive steps, the original C0 floor and the branch's base
snapshot. They reject deleting a recorded step or family and unapproved country
removals. They also exercise an approved family-removal example without recording
that example as a real owner ruling. Run `npm run generate` after changing the
baseline so the legacy edge endpoint receives the same data.
