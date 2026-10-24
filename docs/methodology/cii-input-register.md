# CII input register

This register has one row per input the CII reads. Under `docs/methodology/cii-change-brief.md`, no input may be scored without a row here, and a change to an input's construct, attribution, window or normalisation updates its row in the same PR.

## Sources and vocabulary

- **Rows** describe the formula named by `CII_FORMULA_VERSION` (v14) as the 2026-10-23 first-principles review found it.
- **Verdicts** are that review's, adjusted for the owner's decisions of the same day. They are not yet implemented; Stage B and Stage C carry them out.
- **Attribution** says whose instability the input credits: the *victim/location* (where the event happens), or the *actor* (who caused or reported it).
- **Verdict** is one of:
  - **keep**: correct construct;
  - **reweight**: correct construct, wrong shape, window or weight;
  - **context**: show it beside the score, do not score it;
  - **remove**: wrong construct or dead.

## Owner decisions that shape the verdicts

- There is no ACLED access and none is coming.
- The violence family is UCDP (continuous and decayed), the GDELT strike counter and the strike feed, deduplicated and attributed to the target.
- The output splits into a structural score and a live score, with no floors in either.
- Strikes score the target in full. The attacker gets a smaller belligerency term, not per-strike counts.

## Register

| Input (key) | Construct it measures | Attribution | Window | Coverage | Normalisation | Known failure mode | Verdict |
|---|---|---|---|---|---|---|---|
| Baseline risk, event multiplier (`shared/cii-weights.ts`) | Editorial structural prior | Country | Static | 31 countries | None; hand-set | Carries 23.5% of cross-country variance alone. The multiplier is non-monotone below 0.7 and applies only to the dark ACLED terms. | **reweight**: replace the prior with a published structural index entering once, in log-odds; remove `eventMultiplier` |
| ACLED (`fetchACLEDEvents`) | Geolocated political violence and protest | Location | 30 days | None since 2026-07 | Per-country counts × multiplier | Credentials gone. One row anywhere switches GDELT off for every country. | **remove**: delete the dormant code paths and the global GDELT switch |
| UCDP events (`conflict:ucdp-events:v1`) | Organised violence | Location | Classes assume 2 years; the cache spans about 10 months, 78% of rows from the last 60 days | Global, 2,000-row cap | None: event count over 100 or deaths over 1,000 gives "war" (floor 70); over 10 events gives "minor" (floor 50) | MX scores "war" from cartel events. IL sits at exactly 100 events: one more is +20. BR is "minor" from 35 gang events. | **reweight**: continuous, decayed, per-capita term; assert the window at read time; no class floors |
| GDELT conflict level (`gdelt:bulk:country-events:v1` `week.conflict`) | Share of coverage coded conflict | Location, as coded | 7 complete days | Global | Share of the country's own coverage | A topic-mix measure: UA reads 0.141 against a 0.14 floor and scores 0 during a war. | **remove**, or rebuild before rescoring |
| GDELT conflict and protest escalation (`conflict`, `protest`) | A spike in conflict or protest coverage over the country's own norm | Location, as coded | 24 h against a 28-day median | Global | Ratio to the country's own baseline | A chronic war reads as its own norm by day 15. Article volume moves the score with shares fixed (P12b). | **reweight**: protest as a spike signal only; conflict inside one violence family |
| GDELT strike counter (`strikes`, CAMEO 194/195) | Reported strikes on the country | Target | Daily, sustained 4 of 7 days | Global | Share of the country's coverage, over a noise floor | Strike articles are a subset of Conflict, so they are double counted. On SA alone it gives P = 46.5. | **keep**, inside one violence family, merged by max |
| Strike feed (`conflict:iran-events:v1`, tally `conflict:strike-pressure:v1`) | Confirmed strikes | Event location (country code from the feed's gazetteer) | 21 days, 3-day half-life | Middle East only | Severity-weighted counts; floor `40 + 8·log2(P/5)` from P = 5; boost capped at 10 | Retrospective reposts make up 46–60% of SA weight. Dammam is counted three times. Intercepts are counted as strikes. Hormuz tankers are scored to Iran, the actor. The floor jumps 0→40 at P = 5. | **reweight**: dedupe by incident, drop reposts and intercepts, attribute to the target; at least 80% precision before it may set anything; no floor |
| OREF alerts (`relay:oref:history:v1`) | Rocket and air-raid alerts | Location (IL only) | Active plus 24 h | Israel only | Absolute counts; IL-only boost | Missing on 2026-10-23, so IL's alert terms read 0 with no flag. Counted twice (Conflict and blend). | **keep**, inside a cross-country air-raid-alert family; no IL-only term |
| Internet outages (`infra:outages:v1`) | Connectivity shutdowns | Location | Current | Global | Severity counts | Dead since #989: the seeder writes a country name, the scorer reads `countryCode`, so 0 of 15 records map, and health reports "quiet". | **reweight**: fix the mapping; score only government-directed or military causes, inside a window |
| Climate anomalies (`climate:anomalies:v2`) | Weather anomaly | Climate zone fanned out to 5–9 countries | Current | Zones | Severity × 3, capped at 15 | A natural-hazard construct. One zone raises CN, UA, TW, KR and JP by 8 each. | **remove** |
| Fires (`wildfire:fires-summary:v1`) | Satellite fire detections | Location | Current FIRMS pass | Global | Absolute counts, capped | Counts gas flares and agricultural burning (TR −8, IR −6, SY −6 when removed). Fire outweighs Conflict, Unrest and Information combined. | **remove**, or score explosion candidates with industrial sites masked |
| GPS jamming (`intelligence:gpsjam:v2`) | Navigation interference | Hex location | Daily | Where ADS-B receivers are | Hex counts, capped at 35 | Kaliningrad's jamming scores Poland; US test ranges score the US. At the cap in 12 countries. Scales with receiver density. | **remove**, or keep only high hexes with ≥10 aircraft, area-normalised |
| Travel advisories (`intelligence:advisories:v1`) | Danger to travellers plus foreign policy | Country | Current | US and Australian levels | Level → +5/+10/+15 boost and a 50/60 floor | A different construct (QA/AE "reconsider" cites Iranian missiles). Counted twice, as a boost and a floor. Removing it moves QA −35, KP −27, AE −20. | **context**: a validation signal only; no floor, no boost |
| Advisory fallback table (`ADVISORY_LEVELS_FALLBACK`) | An embedded copy of advisory levels | Country | Frozen | 15 countries | As above | Disagrees with live for CU/LB/RU/IR/IQ and has no KP/QA/AE/SA entry. A live→fallback flip on 2026-10-21 moved QA by −42 with no alarm. | **remove**: missing means unknown; add a provenance-flip alarm |
| Last good advisory snapshot (`intelligence:advisories:cii-last-good:v1`) | The Tier-1 levels of the last advisory read a build scored live (Stage B2, replaces the fallback table) | Country | At most 72 hours from the seeder's `fetchedAt` (`CII_ADVISORY_MAX_AGE_MS`) | Tier-1 countries the live feed listed | As above | Read on every build and rewritten by every live read. Each country carries its last live sighting. It stands in for a missing or stale read, and fills a Tier-1 country a live read lost (one level source down) while that sighting is within 72 hours; after that the country is absent and reported in `droppedCountries` (a health warning, not a dead input, while the register is otherwise live), and it is purged after 30 days. A level that changed during the outage scores the old value for up to 72 hours. Health reports `fallback` with `snapshotAt` and `filled`, or `sourcesMissing`, from the first affected build. An unreadable snapshot does not fail the build (`snapshotReadFailed`). | **keep** while advisories are scored; goes with them in Stage C |
| UNHCR displacement (`displacement:summary:v1:<year>`) | Displaced population stock | Country of origin | Annual | Global | log10 of the stock, capped at 20 | Outbound refugee stocks persist for decades (SY −14 and UA −11 when removed). | **reweight**: IDPs plus the change in refugees; IOM DTM is already ingested |
| Cross-border surge (`displacement:cross-border:v1`, border sources) | A fresh surge of arrivals | Destination and origin | Monthly or daily by source | The registered border sources | Flat +5 | Credits the receiving country, not only the origin. | **context**, or origin only |
| News top stories (`news:insights:v1`) | Headline threat level | Every country a headline names | Current digest | Global, English | Absolute weighted count | Keyword attribution ("pentagon" → US); a headline on A's strike abroad raises A (P11a). Information is counted three times (news + summary + urgency boost). | **context**, or merge at low weight with the summary |
| Threat summary (`news:threat:summary:v1`) | Classified headline counts | Country named | About 20-minute TTL | Global | Absolute counts, capped at 20 | Null on 2026-10-21, so Information was 0 for all 31 countries with no flag. Volume-sensitive (P12b). | **context**, or merge at low weight |
| Aviation delays (`aviation:delays-bootstrap:v2`) | Airport delays and closures | Airport country | Current | FAA plus international feeds | Absolute counts per airport | The US reports far more airports than most countries. Ten more delayed airports raise S (P10). | **remove** |
| Earthquakes (`seismology:earthquakes:v1`) | Magnitude ≥5.5 quakes | Epicentre | 7 days | Global | Counts by magnitude band, capped at 25 | A natural hazard, not instability. | **context** |
| Sanctions (`sanctions:pressure:v1`, `sanctions:country-counts:v1`) | Sanctions list entries | Listed address country | Stock | OFAC lists | Entry-count bands | Front-company addresses score their host country (UA/DE/GB −5 when removed). | **remove** |
| Foreign military flights and vessels (`intelligence:military-cii:v1`) | Foreign military presence | Location | Current | ADS-B and AIS coverage | Absolute counts × 2 | NATO transports at cruise altitude. 88% of "military" vessels are AIS types 35 and 50–59 (pilot, SAR, tugs). Security correlates −0.60 with baseline. | **remove** |
| AIS disruptions (same key) | Shipping disruption | Location | Current | AIS coverage | Counts, capped at 10 | Station density, not instability. | **context** |
| Temporal anomalies (`temporal:anomalies:v1`) | Activity anomalies | Global only | Current | Global | Not scored | Read but never scored: the producer emits region "global" only. | **remove** the read |

## Missing families (Stage D)

1. Verified, geolocated political violence with actor and target.
2. Protest size and repression.
3. Regime and elite instability: coups, irregular exits, emergency decrees.
4. State repression and shutdowns.
5. Economic stress: FX, inflation, food prices, IPC.
6. IDP change (IOM DTM).
7. Criminal violence per capita.
8. Population and area normalisers.
9. Air-raid alerts beyond OREF.
10. A per-family "unknown" state.
