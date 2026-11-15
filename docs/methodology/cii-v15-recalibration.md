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
