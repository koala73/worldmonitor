---
noindex: true
---

# U23 global producer coverage inventory

Captured 2026-11-13T11:58:14.170Z from production Redis with ten GETs (6907 ms total). All calculations and 50 summary repetitions ran locally on Node 24.20.0. No producer, deployment, repair download, or Redis write was run. The cross-key read is sequential, not an atomic calibration fixture.

## Published and candidate coverage

| Input | Live rows/countries | Candidate rows/countries | Live bytes | Candidate bytes |
|---|---:|---:|---:|---:|
| Pinned WGI 2025 prior | 208 | unchanged | 31006 | unchanged |
| UCDP located country-day groups | 84 | unchanged | 1350728 | unchanged |
| UCDP party groups | 2397 | unchanged | included above | unchanged |
| Economic stress country rows | 31 | 199 | 20209 | 108888 |
| Economic countries with a fresh derived member | 25 | 149 | included above | included above |
| GDELT summary mapped codes | 186 | 232 | 135046 | 141550 |

Economic members (candidate): currency 45, inflation 145, yield 26. All 31 scored countries remain present. The named C0 expected 25 retain a fresh member; the candidate health check is OK. Additional countries with no fresh member retain their absence reasons.

## GDELT cost and article-volume distribution

The bulk parser already counts all mapped countries; no new download or per-country request is needed. This snapshot holds 30 daily buckets and 6177 country-day counter rows. The summary drops quiet countries despite their measured article volume. Retaining those rows adds 46 mapped codes: AD, AI, AN, AS, BT, CI, CV, EH, FM, GA, GQ, IO, KI, KM, KN, LI, MC, MF, MG, MH, MO, MQ, MS, NC, NF, NI, NR, NU, PF, PN, PW, SB, SH, SJ, SL, SM, SZ, TC, TK, TL, TO, TV, VA, VG, VU, YT. Every previously published summary row is byte-identical on the same snapshot. The existing FIPS map includes the retired AN code; it is outside the pinned-prior universe and the fixture target validator excludes it. The 232 is a producer row count, not a count of admissible countries.

Summary-only mean run time over 50 repetitions: 1.460 ms before, 1.341 ms after. These are local same-snapshot timings, not end-to-end seed timings. The full fetch/publish runtime was not measured because it writes production. Download count, daily counters, repair allowance, and stored day rows do not change. Added summary bytes: 6504. This cost does not require a wider collection run.

GDELT readiness: currentComplete=true, baselineDays=28, weekDays=7. Week article counts are coded article appearances summed over seven complete days; they are not unique documents across the week. Distribution over the 208 prior countries (absent summary row shown as 0 for this volume gate only): 0–0: 1; 1–49: 69; 50–199: 57; 200–999: 60; 1000–up: 21. Minimum 0, p25 35, median 100, p75 380, maximum 41456.

## Proposed OQ11 clauses (not an admission ruling)

Universe: the 208 countries in the pinned prior. Pinned finite prior: 208. Global UCDP located window available: 208; absence of events means zero observed deaths in the published window, not a missing country. The window ends 2026-09-30; it reports complete=true, no gapMonths, and upstreamGapMonths=2026-10, 2026-11. These unpublished months are a freshness limit, not evidence of no recent violence.

Published GDELT week ready and at least the existing level-term minimum of 200 articles: 81. At least one fresh economic member: 149. Prior + UCDP + volume: 81; all four clauses: 72. Economic coverage is proposed as a label condition, so it does not reduce the 81 candidate count. The owner has not ruled OQ11. No country is admitted and no score is changed here.

## Per-country evidence

`Economic members` lists fresh derived members only. `UCDP` means the global window is available, including real zero observations; see its lag above. `Volume` uses the existing 200-article threshold, not a newly selected constant. Countries not in the pinned prior are outside this OQ11 universe.

| Country | Pinned prior | UCDP | Week articles | Volume | Economic members |
|---|---|---|---:|---|---|
| AD | yes | yes | 5 | fail | unmeasured |
| AE | yes | yes | 616 | pass | currency |
| AF | yes | yes | 424 | pass | unmeasured |
| AG | yes | yes | 100 | fail | unmeasured |
| AL | yes | yes | 78 | fail | inflation |
| AM | yes | yes | 380 | pass | inflation |
| AO | yes | yes | 37 | fail | inflation |
| AR | yes | yes | 394 | pass | currency, inflation |
| AS | yes | yes | 13 | fail | unmeasured |
| AT | yes | yes | 261 | pass | inflation, yield |
| AU | yes | yes | 2965 | pass | currency, inflation, yield |
| AW | yes | yes | 31 | fail | unmeasured |
| AZ | yes | yes | 529 | pass | inflation |
| BA | yes | yes | 18 | fail | inflation |
| BB | yes | yes | 99 | fail | unmeasured |
| BD | yes | yes | 628 | pass | inflation |
| BE | yes | yes | 505 | pass | inflation, yield |
| BF | yes | yes | 30 | fail | inflation |
| BG | yes | yes | 220 | pass | inflation |
| BH | yes | yes | 172 | fail | currency, inflation |
| BI | yes | yes | 9 | fail | inflation |
| BJ | yes | yes | 64 | fail | inflation |
| BM | yes | yes | 102 | fail | unmeasured |
| BN | yes | yes | 44 | fail | inflation |
| BO | yes | yes | 34 | fail | unmeasured |
| BR | yes | yes | 486 | pass | currency, inflation |
| BS | yes | yes | 237 | pass | inflation |
| BT | yes | yes | 30 | fail | inflation |
| BW | yes | yes | 50 | fail | inflation |
| BY | yes | yes | 110 | fail | inflation |
| BZ | yes | yes | 143 | fail | inflation |
| CA | yes | yes | 3886 | pass | currency, inflation, yield |
| CD | yes | yes | 43 | fail | unmeasured |
| CF | yes | yes | 18 | fail | unmeasured |
| CG | yes | yes | 83 | fail | inflation |
| CH | yes | yes | 453 | pass | currency, inflation, yield |
| CI | yes | yes | 28 | fail | inflation |
| CL | yes | yes | 253 | pass | currency, inflation, yield |
| CM | yes | yes | 85 | fail | unmeasured |
| CN | yes | yes | 4800 | pass | currency, inflation |
| CO | yes | yes | 213 | pass | currency, inflation |
| CR | yes | yes | 41 | fail | inflation |
| CU | yes | yes | 326 | pass | unmeasured |
| CV | yes | yes | 8 | fail | inflation |
| CY | yes | yes | 214 | pass | inflation |
| CZ | yes | yes | 104 | fail | currency, inflation, yield |
| DE | yes | yes | 1381 | pass | inflation, yield |
| DJ | yes | yes | 86 | fail | inflation |
| DK | yes | yes | 264 | pass | currency, inflation, yield |
| DM | yes | yes | 10 | fail | unmeasured |
| DO | yes | yes | 89 | fail | inflation |
| DZ | yes | yes | 72 | fail | inflation |
| EC | yes | yes | 65 | fail | inflation |
| EE | yes | yes | 43 | fail | inflation |
| EG | yes | yes | 650 | pass | currency, inflation |
| ER | yes | yes | 29 | fail | unmeasured |
| ES | yes | yes | 892 | pass | inflation, yield |
| ET | yes | yes | 210 | pass | inflation |
| FI | yes | yes | 159 | fail | inflation, yield |
| FJ | yes | yes | 160 | fail | unmeasured |
| FM | yes | yes | 6 | fail | unmeasured |
| FR | yes | yes | 2227 | pass | inflation, yield |
| GA | yes | yes | 27 | fail | unmeasured |
| GB | yes | yes | 8393 | pass | currency, inflation, yield |
| GD | yes | yes | 48 | fail | unmeasured |
| GE | yes | yes | 57 | fail | inflation |
| GH | yes | yes | 824 | pass | inflation |
| GL | yes | yes | 40 | fail | unmeasured |
| GM | yes | yes | 97 | fail | unmeasured |
| GN | yes | yes | 58 | fail | unmeasured |
| GQ | yes | yes | 20 | fail | inflation |
| GR | yes | yes | 504 | pass | inflation, yield |
| GT | yes | yes | 55 | fail | inflation |
| GU | yes | yes | 54 | fail | unmeasured |
| GW | yes | yes | 12 | fail | inflation |
| GY | yes | yes | 138 | fail | inflation |
| HK | yes | yes | 265 | pass | currency, inflation |
| HN | yes | yes | 61 | fail | unmeasured |
| HR | yes | yes | 40 | fail | inflation |
| HT | yes | yes | 171 | fail | inflation |
| HU | yes | yes | 168 | fail | currency, inflation, yield |
| ID | yes | yes | 549 | pass | currency, inflation |
| IE | yes | yes | 1830 | pass | inflation, yield |
| IL | yes | yes | 3399 | pass | currency, inflation |
| IN | yes | yes | 7578 | pass | currency, inflation |
| IQ | yes | yes | 499 | pass | inflation |
| IR | yes | yes | 3898 | pass | inflation |
| IS | yes | yes | 66 | fail | inflation |
| IT | yes | yes | 1128 | pass | inflation, yield |
| JM | yes | yes | 234 | pass | inflation |
| JO | yes | yes | 264 | pass | currency, inflation |
| JP | yes | yes | 1171 | pass | currency, inflation, yield |
| KE | yes | yes | 881 | pass | currency, inflation |
| KG | yes | yes | 86 | fail | unmeasured |
| KH | yes | yes | 148 | fail | unmeasured |
| KI | yes | yes | 5 | fail | unmeasured |
| KM | yes | yes | 3 | fail | inflation |
| KN | yes | yes | 3 | fail | unmeasured |
| KP | yes | yes | 164 | fail | unmeasured |
| KR | yes | yes | 662 | pass | currency, inflation, yield |
| KW | yes | yes | 101 | fail | currency |
| KY | yes | yes | 32 | fail | unmeasured |
| KZ | yes | yes | 160 | fail | inflation |
| LA | yes | yes | 25 | fail | inflation |
| LB | yes | yes | 340 | pass | currency, inflation |
| LC | yes | yes | 17 | fail | unmeasured |
| LI | yes | yes | 4 | fail | unmeasured |
| LK | yes | yes | 516 | pass | inflation |
| LR | yes | yes | 200 | pass | unmeasured |
| LS | yes | yes | 24 | fail | inflation |
| LT | yes | yes | 86 | fail | inflation |
| LU | yes | yes | 62 | fail | inflation |
| LV | yes | yes | 57 | fail | inflation |
| LY | yes | yes | 90 | fail | inflation |
| MA | yes | yes | 220 | pass | inflation |
| MC | yes | yes | 47 | fail | unmeasured |
| MD | yes | yes | 40 | fail | inflation |
| ME | yes | yes | 18 | fail | inflation |
| MG | yes | yes | 22 | fail | unmeasured |
| MH | yes | yes | 26 | fail | unmeasured |
| MK | yes | yes | 40 | fail | inflation |
| ML | yes | yes | 36 | fail | inflation |
| MM | yes | yes | 29 | fail | unmeasured |
| MN | yes | yes | 31 | fail | inflation |
| MO | yes | yes | 58 | fail | unmeasured |
| MR | yes | yes | 17 | fail | inflation |
| MT | yes | yes | 35 | fail | inflation |
| MU | yes | yes | 26 | fail | inflation |
| MV | yes | yes | 36 | fail | inflation |
| MW | yes | yes | 211 | pass | inflation |
| MX | yes | yes | 818 | pass | currency, inflation |
| MY | yes | yes | 608 | pass | currency, inflation |
| MZ | yes | yes | 46 | fail | inflation |
| NA | yes | yes | 142 | fail | inflation |
| NC | yes | yes | 1 | fail | unmeasured |
| NE | yes | yes | 98 | fail | inflation |
| NG | yes | yes | 3459 | pass | currency, inflation |
| NI | yes | yes | 35 | fail | unmeasured |
| NL | yes | yes | 544 | pass | inflation, yield |
| NO | yes | yes | 270 | pass | currency, inflation, yield |
| NP | yes | yes | 225 | pass | unmeasured |
| NR | yes | yes | 1 | fail | unmeasured |
| NZ | yes | yes | 815 | pass | currency, inflation |
| OM | yes | yes | 185 | fail | currency, inflation |
| PA | yes | yes | 73 | fail | inflation |
| PE | yes | yes | 317 | pass | inflation |
| PF | yes | yes | 4 | fail | unmeasured |
| PG | yes | yes | 84 | fail | unmeasured |
| PH | yes | yes | 1461 | pass | currency, inflation |
| PK | yes | yes | 1624 | pass | currency, inflation |
| PL | yes | yes | 788 | pass | currency, inflation, yield |
| PR | yes | yes | 104 | fail | unmeasured |
| PS | yes | yes | 299 | pass | unmeasured |
| PT | yes | yes | 232 | pass | inflation, yield |
| PW | yes | yes | 6 | fail | unmeasured |
| PY | yes | yes | 230 | pass | inflation |
| QA | yes | yes | 613 | pass | currency |
| RO | yes | yes | 270 | pass | currency, inflation |
| RS | yes | yes | 55 | fail | unmeasured |
| RU | yes | yes | 2832 | pass | inflation |
| RW | yes | yes | 112 | fail | inflation |
| SA | yes | yes | 1024 | pass | currency, inflation |
| SB | yes | yes | 25 | fail | inflation |
| SC | yes | yes | 31 | fail | inflation |
| SD | yes | yes | 247 | pass | unmeasured |
| SE | yes | yes | 229 | pass | currency, inflation, yield |
| SG | yes | yes | 691 | pass | currency, inflation |
| SI | yes | yes | 19 | fail | inflation |
| SK | yes | yes | 46 | fail | inflation |
| SL | yes | yes | 35 | fail | inflation |
| SM | yes | yes | 3 | fail | unmeasured |
| SN | yes | yes | 84 | fail | inflation |
| SO | yes | yes | 202 | pass | inflation |
| SR | yes | yes | 17 | fail | inflation |
| SS | yes | yes | 121 | fail | unmeasured |
| ST | yes | yes | 0 | fail | inflation |
| SV | yes | yes | 127 | fail | inflation |
| SY | yes | yes | 391 | pass | unmeasured |
| SZ | yes | yes | 4 | fail | unmeasured |
| TD | yes | yes | 53 | fail | inflation |
| TG | yes | yes | 25 | fail | inflation |
| TH | yes | yes | 460 | pass | currency, inflation |
| TJ | yes | yes | 60 | fail | inflation |
| TL | yes | yes | 13 | fail | inflation |
| TM | yes | yes | 77 | fail | unmeasured |
| TN | yes | yes | 37 | fail | inflation |
| TO | yes | yes | 20 | fail | inflation |
| TR | yes | yes | 1134 | pass | currency, inflation |
| TT | yes | yes | 122 | fail | inflation |
| TV | yes | yes | 10 | fail | unmeasured |
| TW | yes | yes | 571 | pass | currency |
| TZ | yes | yes | 200 | pass | inflation |
| UA | yes | yes | 2236 | pass | currency, inflation |
| UG | yes | yes | 418 | pass | inflation |
| US | yes | yes | 41456 | pass | inflation, yield |
| UY | yes | yes | 170 | fail | inflation |
| UZ | yes | yes | 132 | fail | inflation |
| VC | yes | yes | 15 | fail | inflation |
| VE | yes | yes | 403 | pass | inflation |
| VI | yes | yes | 10 | fail | unmeasured |
| VN | yes | yes | 680 | pass | currency, inflation |
| VU | yes | yes | 21 | fail | unmeasured |
| WS | yes | yes | 52 | fail | inflation |
| XK | yes | yes | 20 | fail | unmeasured |
| YE | yes | yes | 393 | pass | unmeasured |
| ZA | yes | yes | 1402 | pass | currency, inflation, yield |
| ZM | yes | yes | 61 | fail | inflation |
| ZW | yes | yes | 247 | pass | unmeasured |

## Release acceptance still required

After the owner merges and deploys this PR, wait for natural producer runs. Use GET-only reads to confirm the published superset and named expected coverage; do not force a seed. Append the completed C1 baseline only after global publication is observed. This inventory is candidate evidence and does not replace the active C0 floor. Recompute the dated counts if source freshness changes. U21 remains responsible for calibration fixtures and their production-table match.
