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
cover every scored country.

## U23 candidate inventory (13 November 2026)

The [global coverage inventory](cii-global-coverage-inventory.md) records a
GET-only read at 11:58 UTC and local evaluation of the proposed producers:

| Family | Live publication | Candidate publication | Measured coverage |
|---|---:|---:|---|
| Structural prior | 208 countries | unchanged | 208 pinned 2025 values |
| UCDP | 84 located country-day groups; 2,397 party groups | unchanged | Global published window through 30 September; October/November unpublished |
| Economic stress | 31 countries; 25 measured | 199 countries; 149 measured | At least one fresh derived member; the C0 expected 25 retained |
| GDELT | 186 summary codes | 232 summary codes | 81 of the 208 prior countries have at least 200 articles over the measured week |

The proposed OQ11 rule would qualify 81 countries before its optional economic label
condition, with 72 also economically measured. The report gives all clause
counts and per-country evidence. These counts are not an admission ruling.

C0 remains active. No scored country or formula changes in U23.

## The alarm covers scored countries only

Owner ruling, 13 November 2026: a family's expected list may name only countries
in that step's scored set. Health alarms by name on those countries and on no
others. Producers publish every country their sources carry, but coverage
outside the scored set is recorded in the inventory as dated counts, not in the
baseline. About 100 of the 149 measured economic countries rest on IMF inflation
alone; naming them would turn one late IMF release into a hundred warnings for
countries no score depends on. The tests reject an expected country that is not
scored.

A step is appended when the scored set grows, not when a producer widens. The
countries a release admits join the scored set and, where measured, the expected
lists in the same PR. Confirm U23's natural global publication with GET-only
reads and record the result in the inventory; it does not create C1.

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
amending an existing step; that ruling also permits the transition into the
amended step. An exception permits only the named family removal;
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
