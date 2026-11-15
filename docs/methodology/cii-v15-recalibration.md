---
noindex: true
---

# CII v15 recalibration pre-registration

Registered on 2026-11-13 for U18 of [#10577](https://github.com/koala73/worldmonitor/issues/10577). This commit contains acceptance and selection rules only. Candidate measurement starts only after the owner merges this pre-registration and U21 delivers two calibration captures from different UTC dates. The study ends for owner rulings on OQ1 to OQ10. Its session must not author U4 to U7.

## KTD-9 exit bar

Copied as written from the plan:

- Must pass as real assertions: P1 (as ruled in OQ1), P2, P3a, P3b, P3c, P5a, P5b, P5c, P7a, P7b, P8a, P14, every P15 anchor as rebuilt from recorded episodes (R25, AE8, AE12), the sustained-unrest, war-burden and economic checks (AE9 to AE11), and P9 on the located fixture (U16).
- Target; may ship listed with a measured value and owner sign-off: P4, P10b, P11a, P12a, P12b, and a new P13a, the share of cross-country score variance that comes from live evidence. P13a is the direct measure of the problem v15 exists to fix; its threshold is pre-registered in U15 and its v14 and v15 values are reported.
- Stay as todos: P6, the outcome-correlation half of P13, and P16.

U18 supersedes U15's P13a registration through OQ10. The GPI check below is separate from the consensus benchmark P16 todo. All thresholds in the integration branch's change brief remain fixed. Proposed OQ amendments are not approvals. P1 and P2 are measured with the strike feed present and absent. P5b reports every occupied half-open five-point band and its country count, including the worst band.

Owner sign-off means an explicit dated ruling attached to the measured property, fixture, tested revision, shortfall and construct reason. Silence, a green CI run or merging this registration is not approval of a later miss. Each target needs its own ruling if missed:

| Target | Fixed threshold | What the owner must explicitly accept on a miss |
|---|---|---|
| P4 | Five strike units per day give at least +5 in 48 hours and +10 in seven days, in every country | The measured minimum response and every failing country and horizon |
| P10b | Doubling news and classified-headline volume never raises the score | The maximum increase and the affected inputs and countries |
| P11a | A's strikes on B leave A unchanged | The measured attribution leakage and affected cases |
| P12a | Forty seeded draws of ±10% input noise give median absolute score change ≤2 and p99 ≤6 | Each exceeded statistic and the fixtures on which it fails |
| P12b | Article volume multiplied by 0.5, 2 or 4 with shares fixed moves each score by ≤1 | The maximum change, multiplier and affected cases |
| P13a | At least 50% and strictly above released v14 on every calibration capture under the same definition below | Each capture's v14 and v15 shares, denominator, coverage, shortfall against 50%, and failure to improve on v14 |

Must-pass failures cannot be converted to target exceptions. No floor, named-country target, loosened threshold or constant chosen from one country's score is permitted.

## P13a measures current evidence within its source window

For the same scored country set on each capture, let `S` be the full score and `B` the counterfactual score with eligible live evidence neutralised. Keep the prior, country metadata, source availability, coverage and stale or context inputs unchanged. Neutralisation is a zero contribution, not a failed read or a fallback. Let `L = S - B`.

`P13a = 100 * Cov(L, S) / Var(S)`.

Use population covariance and variance across all 31 scored countries, on the emitted score scale, with the unrounded result reported separately when available. This covariance allocation splits the cross term equally between `B` and `L`, so their shares sum to 100%. Do not clip negative values or values above 100%. Zero variance is undefined and cannot pass. Report `Var(S)`, `Var(B)`, `Cov(L,S)`, the eligible families and their coverage for each capture. Do not pool dates or remove countries with missing families.

Live means evidence from an operationally fresh source inside the measurement window declared for that source, rather than only records whose event date is under 30 days old:

- UCDP territorial violence and war burden include the complete published 365-day window, including deaths older than 30 days. The window must pass the existing read-time honesty check, have no missing published releases and end no more than 90 days before the capture. The same deaths enter at most once per country. Neutralise the window's violence and war-burden contributions together.
- Strikes, GDELT unrest and conflict, outages and OREF use their existing source freshness checks, attribution rules and scored windows. Neutralise their evidence contributions, including sustained unrest levels and decayed strike tails. Keep GDELT coverage volumes and reference medians fixed.
- Economic members count only while fresh under OQ9. Maximum ages are seven days for currency, four calendar months for monthly inflation, seven calendar months for quarterly inflation and three calendar months for monthly yields. Neutralise the measured changes, preserving reference levels and availability. Missing or expired members do not become measured zeroes.
- WGI, hand-set priors, advisory or displacement stocks, context-only feeds and unavailable evidence are not live contributions. Any legacy v14 contribution outside the eligible families stays in `B` and is disclosed.

The target is **at least 50% and strictly greater than released v14 on every calibration capture**, using the same live-evidence definition, country set and score scale for both. Report both shares and their difference in percentage points; an undefined value for either version cannot pass. Clearing 50% alone is insufficient: v15 must improve on v14 even if the full-window definition lets v14 clear that absolute threshold. Most cross-country score variation should be attributable to current evidence if v15 addresses the static-prior problem. A complete annual war window measures continuing war burden at the source's publication cadence. Discarding its older deaths from the live definition confuses event age with source freshness and excludes most of the very signal the index is meant to measure. The target is fixed before candidate results. This is an OQ10 definition proposal, not an amendment to the brief without the owner's ruling.

## GPI benchmark

Spearman rank agreement with the Global Peace Index in risk direction must be **at least 0.75**, with **no drop greater than 0.02 from released v14** on any calibration capture. Higher GPI scores mean higher risk. Use average ranks for ties and the same country intersection and pinned GPI vintage for both formulas. Record the source payload, retrieval date, vintage, country intersection and missing countries before candidate evaluation. Missing benchmark data or undefined correlation is unverified, never a pass. No construct explanation silently waives either numerical rule.

## Anchor episode selection

Only committed fixtures explicitly marked `calibration: true` are eligible. October fixtures are regression snapshots and cannot select episodes or constants. Freeze the episode manifest after the second U21 capture lands and before candidate evaluation. Select over those captures' 31 scored countries, with the quiet and unrest selectors restricted to the seven stable democracies already named in the brief. Break equal selection statistics by earliest capture time and then ISO2 code. Missing required observations make an episode unavailable, not quiet. If no eligible episode exists, report that blocker without substituting a synthetic magnitude or selecting by score.

Each manifest entry records the source commit, fixture, country, observation dates, selection statistic, copied magnitudes and units. These country names identify evidence, never score targets. Scenario backgrounds retain each destination's own prior and population, live empty advisories and zero other evidence. Copied rates and shares are the same for every destination in the existing anchor set. Keep each chosen episode's temporal profile. Do not combine maxima from different countries.

| Anchor | Input-only selection rule | Scenario and unchanged acceptance band |
|---|---|---|
| Quiet week | Among the seven stable democracies' complete measured GDELT weeks, select the week with the lowest protest share. Economic signs and magnitudes do not determine eligibility or selection. | Copy that week's GDELT counts, medians and shares and all its recorded economic readings, dates and availability states to each stable democracy, including positive readings without clipping or substitution. Score ≤15. |
| Sustained unrest above norm | Among measured stable-democracy weeks with positive protest median and current protest count above that median, select the greatest weekly protest share. | Copy current count, median, weekly articles and protest count together, without fixed smoothing. Apply to each stable democracy. Score 35–55. The separate AE9 check repeats the observed level for eight weeks with current equal to median and requires a positive unrest term. |
| Strike campaign | Select the country-capture with the greatest confirmed weighted strike units per day over the seven complete UTC days preceding capture. Use existing severity weights and the confirmed tally, never add duplicate event-feed counts. Require a fresh confirmed feed and positive units. | Copy the seven daily magnitudes and their spacing to each stable democracy. Score 45–65. Report the rate and source days. |
| Chronic war | Among country-captures with positive factual territorial deaths in at least nine of the twelve complete calendar months of the UCDP window, select the country at the lower median of the eligible countries' annual deaths-per-million rates. Use one episode per country: its earliest eligible capture. Sort these episodes by rate ascending, then by the stated tie-breakers, and take position `floor((n - 1) / 2)` with zero-based indexing. Count factual deaths from party-month groups once by location, never the activity totals that clamp zero-death events to one. | Copy the monthly per-million profile, annualised by 365 divided by the window length in days. Scale by each destination's population, for all 31 countries. Score ≥70. This implements the proposed OQ4 scenario; report it separately from the unchanged legacy absolute-death scenario until ruled. |
| Full-scale war | Among the same complete-window country-captures with positive deaths in at least nine complete months, select the greatest annual territorial deaths-per-million rate. | Copy that episode's monthly per-million profile to all 31 countries. Score ≥85. No extra strike or unrest maxima from other episodes. |

The proposed wider OQ6 bands are not registered as accepted thresholds. Any future owner amendment must be dated and retain the results against the original bands.

## Blind pairwise measurement

At least three judges must attest that they have seen neither the v14 table nor any candidate table. Prior exposed judges cannot count. Freeze one candidate and its constants before pair selection. Obtain all judgments before revealing either table or aggregating results. No judgment, aggregate or control result may tune that candidate or select another design.

Enumerate distinct unordered country pairs on each calibration date. A disagreement requires strict opposite ordering by v14 and the frozen candidate; ties in either table do not qualify. Each disagreement pair must also be at least five score points apart in both tables, on the emitted score scale. Select 30 disagreement cases by ascending SHA-256 of `U18-blind-v1|fixture|ISO2-low|ISO2-high`, retaining each country pair only once across dates. If fewer than 30 distinct disagreement pairs exist, report insufficient pairs; do not duplicate pairs or tune to manufacture disagreement. Add ten distinct control pairs with strict matching order, selected by the same rule and excluded from the disagreement set. Insufficient controls are also reported.

Randomise presentation order and left/right position with a recorded seed held by the coordinator. Judges use their own knowledge, consistent with the owner's invitation. They receive only the country names, assessment date, R21 construct and the options left higher, right higher, tie or insufficient evidence. No coordinator-authored evidence packets or model-input summaries are supplied. The ballot reveals no formula, scores, ranks, model identity, predicted winner or control label. Lock ballots separately before discussion.

A pair is decided only when at least two thirds of all participating judges choose the same strict ordering. Ties, abstentions and unresolved pairs remain in the report but not the denominator. The candidate passes when it matches **at least two thirds of decided disagreement pairs**. Zero decided pairs is undefined, never a pass. Report decided and undecided counts, judge agreement, all disagreement outcomes and control outcomes separately. Controls cannot inflate the primary pass fraction. Preserve ballots and the selection seed for audit. This is a reported measurement only and ends at the owner-ruling stop, even if it fails.

## Frozen inputs (2026-11-15, before any candidate evaluation)

Frozen at `cii-v15@b28c37a312` after the second U21 capture landed (#10618). Nothing in this section was chosen after a candidate score was computed; this commit precedes every candidate result.

### Calibration fixtures

| Fixture | `capturedAt` | SHA-256 of the parsed fixture (first 16 hex) |
|---|---|---|
| `tests/fixtures/cii/2026-11-13T0952Z.json` | 2026-11-13T09:52:18.324Z | `cd68ab468c563866` |
| `tests/fixtures/cii/2026-11-14T0556Z.json` | 2026-11-14T05:56:53.049Z | `423d2076d6538c28` |

Both are marked `calibration: true` and hold the full UCDP window (2025-09-30 to 2026-09-30, 365 days, `complete: true`, no missing releases), the party-month table, the prior map (208 countries) and the economic key (199 rows). No other fixture is eligible.

### GPI benchmark

Read GET-only from production `resilience:static:<ISO2>` at 2026-11-15T14:48:57Z for all 31 scored countries: source `gpi-voh`, vintage 2026, no country missing. Every score and rank is identical to the snapshot preserved in `cii-v15-calibration.md` (read 2026-11-12), so that table is the pinned benchmark payload. Intersection: all 31.

### Episode manifest

Selection follows the rules above exactly. Ties did not arise. Country names identify evidence, never score targets.

| Anchor | Episode | Selection statistic | Candidates considered |
|---|---|---|---|
| Quiet week | US on 2026-11-13T0952Z | protest share 312 / 41,456 = 0.00753, the lowest | 14 complete stable-democracy weeks (7 countries × 2 captures) |
| Sustained unrest above norm | KR on 2026-11-13T0952Z | protest share 12 / 662 = 0.01813, the greatest eligible | DE 11-13 (4.8 vs 3), KR 11-13 (2.6 vs 1), PL 11-13 (1.2 vs 1), DE 11-14 (3.8 vs 3), JP 11-14 (1.8 vs 1), KR 11-14 (1.5 vs 1) |
| Strike campaign | **Unavailable** | no fresh confirmed tally | see blocker below |
| Chronic war | MX on 2026-11-13T0952Z | 24.80 factual territorial deaths per million per year, position 6 of 13 | IN 0.22, BR 1.99, RU 2.78, IQ 4.92, PK 19.31, AF 20.69, **MX 24.80**, SY 26.03, MM 33.80, YE 125.63, IR 254.02, LB 771.02, UA 2263.15 (all 12/12 positive months) |
| Full-scale war | UA on 2026-11-13T0952Z | 2263.15 per million per year, the greatest | same 13 |

Copied magnitudes, exactly as recorded:

- **Quiet week (US, 2026-11-13T0952Z).** GDELT conflict current 727.3 against median 769.5 (coded articles per day); protest current 40.9 against median 65.5; week of 41,456 articles, 4,671 conflict-coded and 312 protest-coded; the recorded GDELT strike day counts (23 days from 2026-10-19 to 2026-11-12, at most 8 strike-coded of 4,099 articles on one day). Economic readings: inflation acceleration +0.7250 percentage points (IMF, observed 2026-09-30, fresh), 10-year yield +0.6942 percentage points against its trailing 12-month mean (OECD, observed 2026-09-30, fresh), currency absent as not applicable (dollar numeraire). Applied to each of DE, FR, GB, JP, KR, PL and US, with the US economic availability states, positive readings unclipped.
- **Sustained unrest (KR, 2026-11-13T0952Z).** GDELT protest current 2.6 against median 1 coded articles per day; week of 662 articles, 12 protest-coded (and 30 conflict-coded, carried as recorded in the week object). Applied to the same seven. The AE9 check repeats this week's level for eight weeks with current equal to median.
- **Chronic war (MX, 2026-11-13T0952Z).** Population 133 million (`CII_POPULATION_MILLIONS`). Factual deaths per million per calendar month, 2025-10 to 2026-09: 5.1203, 2.3308, 1.1429, 3.0150, 1.1278, 1.9850, 2.1278, 1.8045, 1.3459, 1.2030, 1.6090, 1.9699 (sum 24.78; the selection statistic, 24.80, also counts the window's single day of 2025-09-30). Annualisation factor 365 / 365 = 1. Scaled by each destination's population, for all 31.
- **Full-scale war (UA, 2026-11-13T0952Z).** Population 39.54 million. Per million per month, 2025-10 to 2026-09: 128.1234, 270.9408, 255.6146, 338.1892, 188.0627, 196.5604, 173.4193, 168.3359, 119.4992, 123.1411, 142.8680, 156.8538. Copied to all 31.

Each monthly profile keeps its dates relative to the episode's capture clock (`nowMs` 1794563535410).

### Blocker: no strike-campaign episode

Both calibration captures hold a `conflict:strike-pressure:v1` tally with `version: 1`, the relay writer on `main` (`scripts/lib/middle-east-strikes.cjs`). The integration branch reads only `CII_STRIKE_TALLY_VERSION = 2` (Stage B3, #9592), because a v1 tally counts retrospective reposts, duplicates and interceptions, and rejects v1 as unusable. So neither capture has a fresh confirmed feed and the rule selects nothing. Per the rule, no synthetic magnitude is substituted and no other source (the 72-hour event window or the GDELT backstop) is promoted into the selection. The strike anchor (P15c, and AE12) is unmeasurable until B3's v2 tally writer ships to `main` as a producer-only change and a third calibration capture holds a fresh v2 tally.

## Results (2026-11-15)

Measured on the two frozen calibration captures with the manifest above. The exploration code stays outside the repository, as the plan requires. Every number below comes from one run per grid and is reproducible from the frozen fixtures and the constants listed.

**Finding: no candidate design passes the must-pass list.** No point in either grid passes every must-pass property. U4 must not start. The study stops here for owner rulings on OQ1 to OQ6, OQ8 and OQ10, and on the further amendments proposed at the end of this section.

### Candidate family

`z = a − b·PV + V + U + E` and `S = 100·sigmoid(z)`, emitted to one decimal (`combined_score` is a double).

- `PV` is WGI PV.EST from `inputs.structuralPrior`.
- Violence family `V` has five members:
  - strikes: `ks` times decayed weighted units, with a five-day half-life over a 21-day window. Each day takes the maximum of the confirmed tally, the 72-hour events and the GDELT backstop. Sources are never added together.
  - territorial UCDP: `ku·ln(1 + rate/1.25)`, deaths per million per year over the full B6 window. The extension grid also tests `ku·sqrt(rate/1.25)`.
  - war burden: `w·ku·` the same transform, applied to the deaths a state party carries outside its own borders, per million of its own population (the OQ8 proposal).
  - GDELT conflict spike.
  - OREF: `orefBoost/50`.
- Unrest family `U` has three members:
  - GDELT protest spike.
  - protest level: `kl·cred·max(0, (share − fp)/0.06)`.
  - outages: `ko·points/50`.
- GDELT spike: `kg·cred·max(0, ln((current + s)/(median + s)))`.
  - `s = max(smin, φ·weekly articles/7)`.
  - `cred = n/(n + n0)`, where `n` is weekly articles.
- Family merge:
  - bounded union `C·(1 − exp(−Σ/C))` (the OQ2 proposal), or
  - capped maximum `C·(1 − exp(−max/C))`.
- Economic family `E`: `ke·max(1 − exp(−x/τ))` over fresh members only. The τ values are currency 10%, inflation 3 pp and yield 1 pp.
- News and headlines are context-only (the OQ1 proposal).

For each combination, `a` is solved analytically as the interval that keeps every anchor inside its band. Properties are measured at up to nine evenly spaced points inside that interval.

### Grids

| Grid | Constants | Combinations | Anchor-feasible | Points measured | Pass every must-pass |
|---|---|---|---|---|---|
| Main | merge union / max; b 0–0.8 step 0.1; ks 0.03 / 0.05 / 0.08 / 0.12; ku 0.25 / 0.5 / 1 / 1.5 / 2; w 0 / 0.5 / 1; kg 0.5 / 1 / 2 / 4 / 8; φ 0.02 / 0.05 / 0.1; (kl, fp) in 10 pairs; ke 0 / 0.5 / 1 / 2; C 4 / 8; n0 200; ko 2; smin 1; log UCDP | 1,296,000 | 7,968 | 38,808 | 0 |
| Extension | adds smin 1 / 5 and the square-root UCDP transform; ks 0.05 / 0.12; ku adds 0.1; kg 1 / 2 / 4 / 8; φ 0.02 / 0.1; 6 (kl, fp) pairs; ke 0 / 1; C 8 | 165,888 | 2,468 | 9,768 | 0 |
| Extension without P15b (diagnostic only) | same | 165,888 | 36,736 (5,248 sampled) | 24,176 | 0 |

**Anchor conflicts on the main grid.** For each infeasible combination, the binding pair is the anchor with the highest lower bound on `a` against the anchor with the lowest upper bound:

| Binding pair | Combinations |
|---|---|
| P15b lower vs P15a upper | 587,028 |
| P15d lower vs P15a upper | 544,272 |
| P15e lower vs P15a upper | 127,764 |
| P15d lower vs P15b upper | 27,132 |
| P15e lower vs P15b upper | 1,836 |

**Feasible region per constant (main grid, anchor-feasible combinations):**

| Constant | Count per value |
|---|---|
| b | 0: 3,696; 0.1: 1,704; 0.2: 936; 0.3: 732; 0.4: 576; 0.5: 324; 0.6 to 0.8: none |
| ku | 1.5: 1,512; 2: 6,456; 0.25 to 1: none |
| kg | 4: 1,104; 8: 6,864; 0.5 to 2: none |
| φ | 0.02: 5,940; 0.05: 1,968; 0.1: 60 |
| C | 4: 1,152; 8: 6,816 |
| ke | 0: 4,296; 0.5: 2,316; 1: 1,140; 2: 216 |
| merge | union: 4,284; max: 3,684 |
| ks, w | every value equal (the scenarios carry no strikes or burden) |

The anchors alone cap `b` at 0.5, as the brief's OQ6 analysis predicted for 20-point bands. The sustained-unrest anchor requires `kg ≥ 4`.

**Must-pass failures on the main grid,** as points failing each property out of 38,808: P1 38,808; P3c 38,808; P8a 38,808; AE8v 38,544; GPI 38,516; P5b 22,515; P2 22,473; P3b 15,709; AE9 15,552; P5a 5,026. Every other must-pass property passes everywhere.

**On the extension grid:**

- P3c, P8a and AE8v never pass at any point, and neither do the targets P4, P12a and P12b.
- P1 and P5b never pass together, and P5b and GPI never pass together.
- Without P15b, no pair of must-pass properties is mutually exclusive, yet still no point passes all of them. The common failing sets are P3c, P5b and P8a together, and P1, P3c, P8a and GPI together.
- P13a passes at every point of every grid.

### Representative design

The representative is chosen by a rule fixed before any pair selection: fewest failing must-pass properties, then fewest failing P1 cases, then the highest minimum GPI ρ, then the lowest P12a p99.

Its constants are: union merge, b 0.2, ks 0.03, ku 1.5 (log), w 1, kg 4, φ 0.02, kl 2, fp 0.005, ke 0, C 8, n0 200, ko 2, smin 1, a −1.88992.

This section gives aggregates only. Blind judges must see no country-level candidate table before the ballots are locked.

| Property | Tier | Result | Measured |
|---|---|---|---|
| P15a quiet week | must | pass | range 11.3–14.9; 0 of 7 outside 0–15 |
| P15b sustained unrest | must | pass | range 35.0–42.4; 0 of 7 outside 35–55 |
| P15c strike campaign | must | unmeasurable | no strike-campaign episode (see the blocker above) |
| P15d chronic war (per capita, OQ4) | must | pass | range 70.4–90.6; 0 of 31 below 70 |
| P15e full-scale war | must | pass | range 97.6–98.8; 0 of 31 below 85 |
| P1 | must | **fail** | 14 of 294 (country, channel, feed, date) cases move less than 0.5. All are the violence and strike channels in countries already near the ceiling or with high per-capita violence. Headlines move 0. |
| P2 | must | pass | spread in Δz for +5 strike units: 0.114 with the feed present and 0.114 with it absent (limit 0.25) |
| P3a | must | pass | largest step 0.8 per unit (limit 3) |
| P3b | must | pass | largest 3-hour drop 0.7 (limit 5) |
| P3c | must | **fail** | half-life 4.63–6.38 days (want 4–6); 14 of 62 cases show less than 1 point. Under the proposed wording below, 1 case below 95 stays silent. |
| P5a | must | pass | at most 2 countries share a score (limit 2) |
| P5b | must | pass | worst five-point band holds 7 of 31 on the first capture and 6 of 31 on the second (limit 7) |
| P5c (OQ3 form) | must | pass | 0 pairs |
| P7a | must | pass | 0 of 110 nulled-input cases keep their coverage |
| P7b | must | pass | reader-level and independent of the candidate; `tests/cii-outages-input.test.mts` passes, 37 of 37 |
| P8a | must | **fail** | largest move per failed input: UCDP −81.3, GDELT −57.8, Iran events −3.8, OREF −0.2; outages, strikes and economic 0 (limit 10) |
| P9 | must | pass | on both located fixtures |
| P14 (OQ3 form) | must | pass | ≤0.05 |
| AE9 | must | pass | unrest term 0.33 after 8 weeks at median |
| AE8v | must | **fail** | the same proportional rise at 10 times the article volume moves the unrest term by up to 0.35 (parity 0.25) |
| AE10 | must | pass | a party's deaths abroad add burden, territorial violence is unchanged, and deaths inside the party's own borders count once, as territorial |
| AE11 / OQ9 fairness | must | pass | at ke 0.5 and 1, equal readings give equal terms regardless of GDP; three members at the same stress score no higher than one; a country with no members scores 0 and is labelled not measured |
| GPI | must | pass | ρ 0.772 on both captures (v14 0.730 and 0.786) |
| P13a | target | pass | 94.2% and 94.0% (v14 14.8% and 16.0%). Var(S) 1112.3 and 1123.5; Var(B) 7.3 and 7.3; Cov(L,S) 1047.4 and 1056.4. |
| P4 | target | fail | 5 units a day: minimum +0.6 at 48 hours (32 of 49 cases below +5) and +1.0 at seven days (15 of 49 below +10) |
| P10b | target | pass | 0 |
| P11a | target | pass | 0 |
| P12a | target | fail | median 0.5, p99 9.8 (limits 2 and 6) |
| P12b | target | fail | up to 39.9 (limit 1) |

**The representative sits on a knife edge.** Each constant was varied one at a time, with `a` re-solved to the middle of its interval. Most constants keep every property the representative passes only at the representative's own value:

- `ks` holds from 0.01 to 0.03; `fp` holds at 0.005 and 0.0075; `n0` holds at 100 and 200; `smin` holds at 0.5 and 1.
- Every other constant loses GPI, P5b or anchor feasibility at its nearest grid neighbour.

This design is not a basis for U4 even after rulings that remove its four failures.

**Legacy scenarios,** run unchanged with absolute deaths and reported separately as the pre-registration requires:

- P15d legacy (150 events × 10 deaths over 700 days): 20.4–95.4, with the most populous country lowest.
- P15e legacy (400 × 50 over 180 days, plus 20 strike units a day for 14 days): 96.5–99.5.

### v14 baselines (released formula, same captures)

- The released v14 reproduces `expected.v14` on all 31 countries on both captures.
- GPI ρ: 0.7302 and 0.7859.
- P13a under the same definition: 14.78% and 16.01%.

### Root causes

1. **The recorded unrest episode is at noise level.** The KR week has about 2.6 protest-coded articles a day against a median of 1. Scoring 35–55 on it needs `kg ≥ 4`. At that weight, small counts in thin-coverage countries (0.8 against 0, or 3 against 1) produce large terms, which drives P12a's p99 to about 10 and puts pressure on GPI and P5b. Removing P15b multiplies the anchor-feasible set by about 15, but no design passes even then.
2. **P8a conflicts with a high live share.** When live evidence explains about 94% of score variance, losing one input moves countries a long way. A null UCDP read moves a high-violence country by 81 points, and a null GDELT read moves another by 58. B2 gave advisories a last-good snapshot; UCDP and GDELT have none.
3. **P3c fails near the ceiling.** In countries scoring above 95, the sigmoid flattens a campaign's contribution below 1 point. P1 and P2 already exclude scores of 95 and above; P3c does not.
4. **The per-capita log transform mutes violence where it is already high.** The violence and strike channels in populous, already-violent countries move less than 0.5, which is P1's failing set.
5. **The credibility weight conflicts with volume invariance.** R14/KTD-8's `n/(n + n0)` makes the unrest term depend on article volume by design, so P12b (thin-coverage country at 4 times volume: 39.9) and AE8v (0.35 against 0.25) cannot both pass with it.
6. **No strike episode.** Both captures hold only the version 1 tally; `cii-v15` reads version 2 (B3, #9592), so P15c and AE12 are unmeasurable.

### Blind pairwise selection

- 72 distinct disagreement pairs meet the rule (opposite strict order and at least 5 points apart in both tables). Thirty were selected, plus ten controls.
- The sealed key (seed, scores, control labels) and the ballot (country names, date, R21 construct and the four options only) are held by the owner as coordinator. Neither is committed.
- Judging is pending. It needs at least three unexposed judges, and it cannot change the finding above, because the representative already fails the must-pass list.

### Proposed amendments for owner ruling

These are proposals only. None is applied, and every threshold in the brief stays fixed until the owner rules.

- **OQ1 (adopt as proposed).** P1 measures the scored families only. The ten-headline injection becomes an assertion that the score moves by exactly 0. Measured: headlines move 0 at every grid point.
- **OQ2 (adopt as proposed).** Allow the bounded union `C·(1 − exp(−Σ/C))` inside a family, alongside incident deduplication. It rises with every member and never exceeds the sum. Measured: both are anchor-feasible (union 4,284 combinations, max 3,684). The representative uses the union. P1 fails under both merges for the reasons in root cause 4, so this ruling alone does not make P1 pass.
- **OQ3 (adopt as proposed).** P14: `|S − 100·sigmoid(z_prior + Σ emitted terms)| ≤ 0.05`. P5c counts pairs where a country with an equal or higher prior and every family term at least as high scores lower. Measured: both pass at every point.
- **OQ4 (adopt as proposed).** The P15d scenario copies a recorded chronic war's monthly deaths-per-million profile (MX, 24.80 per million a year, manifest above). It replaces the absolute-death scenario, which still spans 20.4–95.4 because the most populous countries bind it.
- **OQ6.** The registered 20-point bands cap `b` at 0.5, and P15a against P15b binds 587,028 combinations. A 30-point band does not fix the cause, which is the noise-level unrest episode (root cause 1). Proposed instead (a new rule, not measured here): change the unrest selection rule to require at least 20 protest-coded articles in the week's current day and at least 200 weekly articles, matching OQ11's volume floor. Keep the 35–55 band. Re-freeze the manifest on new captures if no current capture qualifies.
- **OQ8 (adopt as proposed, with weight w = 1).** A state party carries a conflict's deaths outside its own borders, per million of its own population, through the same transform as territorial violence, at `w = 1`. Deaths inside its borders score once, as territorial. Measured: AE10 passes, and `w < 1` loses GPI at the representative.
- **OQ10 (adopt as registered).** P13a is defined over the full source window, at 50% and above v14. Measured: 94% against v14's 15–16% at every grid point.
- **P8a.** Give UCDP and GDELT a B2-style last-good snapshot, read through the real path with the existing honesty checks. Keep K = 10, measured with the snapshot present, plus a separate report of the no-snapshot move. Without the snapshot, no design with a high live share can pass P8a.
- **P3c.** Exclude countries whose score is at or above 95 before the campaign, as P1 and P2 already do. Measured: 1 silent case remains at the representative and 0 of 9,768 extension points pass, so this is necessary but not sufficient.
- **P12b and R14/KTD-8.** The credibility weight and the volume invariance cannot both hold. The owner chooses between them:
  - keep credibility and redefine P12b to apply only at or above the OQ11 volume floor (200 weekly articles); or
  - drop credibility and rely on the OQ11 volume floor alone.
- **P15c and AE12.** Ship B3's version 2 tally writer to `main`, then capture a third calibration fixture holding a fresh version 2 tally before any rerun.

After these rulings, the next study needs new captures (for the unrest and strike episodes) and a fresh pre-registration of the changed rules. Re-running this grid against amended thresholds would be selecting rules from results.
