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

## P15b historical unrest episode

Registered on 2026-11-15, before any GDELT data inside the search window was downloaded or inspected. The U18 study found the P15b episode from the calibration captures (KR, week to 2026-11-13, protest share 1.81%) is not an unrest episode: the rule above takes the largest eligible week without requiring anything unusual to have happened. The owner ruled that anchor unavailable on the current captures and asked for it to be rebuilt from a recorded historical episode. This section replaces only P15b's selection rule. The P15b scenario and its 35–55 band are unchanged. Before this commit, the only GDELT files downloaded were for days on or after 2026-11-10, which are used to validate the rebuild tool and lie outside the window.

### Construct

Sustained unrest above norm is a stable democracy in which protest makes up a much larger share of its news coverage than usual, on most days of a week, at a volume large enough for the share to be measured. The share is used rather than the count because GDELT's article volume per country moves with the media cycle and has drifted over the years, while the share does not. The norm is the country's own, never another country's.

### Data and tools

- **Countries.** DE, FR, GB, JP, KR, PL and US, the seven stable democracies already named in the brief.
- **Window.** Capture days `T` from 2015-04-01 to 2026-10-31. The GDELT 2.0 export stream starts on 2015-02-18. 2015-04-01 is the first month start with the 35 prior days each rule needs. The end is the last full month before the calibration captures the owner has already ruled on.
- **Counts.** For each country and UTC day: articles `A` and protest-coded articles `P` (CAMEO root 14), counted by the seeder's own `parseCountryEventsExport` (`scripts/_gdelt-country-events.mjs`).
- **Selection source.** Rebuilding every day of the window from its 96 quarter-hour GDELT 2.0 exports is about 400,000 requests. At GDELT's sequential rate of about one per second, that takes more than four days. Selection therefore reads GDELT's one-file-a-day event export. It uses the same engine and the 1.0 column layout, and is mapped column-for-column to the 2.0 layout and parsed by the same parser (`scripts/cii-gdelt-archive-rebuild.mjs daily`). The daily file is admissible only if, on every validation day, each of the seven countries has article counts within 5% of the 2.0 rebuild and protest-coded counts within 10% of it (or within 3 when the 2.0 count is under 30). Otherwise the scan is not run and the finding is a blocker. The selected episode is then rebuilt from the 2.0 exports and must re-qualify there (below). All copied magnitudes come from the 2.0 rebuild.
- **Rebuild validity.** The 2.0 rebuild (`scripts/cii-gdelt-archive-rebuild.mjs v2`) must reproduce the `gdeltCountryEvents` block of both `calibration: true` captures. Integer counts must match exactly, `current` to within 0.05 (its one-decimal rounding) and `baselineMedian` exactly. A mismatch stops the study until it is explained.

### Rule

For country `c` and capture day `T`, using the scorer's clock at the end of day `T` (cursor `T 23:45:00`):

- **Week** `W`: the seven days `T-7` to `T-1`, the scorer's `week` at that clock. All seven must be present.
- **Current day**: `T` itself, the scorer's `current` at that clock. It must be present.
- **Norm** `N`: the 28 days `T-35` to `T-8`, the four weeks before the week, so the episode cannot raise its own norm. At least 21 of the 28 days must be present (the scorer's own minimum baseline). The norm share is `n = ΣP / ΣA` over the present days.

A missing day is unknown, never quiet. `T` qualifies when all of the following hold:

| # | Criterion | Threshold | Reason from the construct |
|---|---|---|---|
| 1 | Week articles `ΣA_W` | ≥ 200 | OQ11's volume floor. Below it, a share is a handful of articles. |
| 2 | Week protest articles `ΣP_W` | ≥ 35 | An average of five a day. Sustained unrest is reported every day, and below this, one multi-article story can make the week. |
| 3 | Norm protest articles `ΣP_N` | ≥ 28 | An average of one a day, so the norm is an estimate rather than a few events. The Poisson relative error is then at most 19%. |
| 4 | Magnitude: week share `ΣP_W / ΣA_W` | ≥ 2n | "Well above norm" is taken as protest's share of coverage at least doubling. A ratio of two is the conventional threshold for a large relative change in a rate. It is fixed here without reference to how shares vary in these countries. |
| 5 | Sustained: week days with daily share `P/A` ≥ 2n | ≥ 5 of 7 | Most days of the week, allowing two quiet days such as a weekend. Five is also the scorer's own minimum for a measured week (`COUNTRY_EVENTS_MIN_WEEK_DAYS`). |
| 6 | Current day share `P_T / A_T` | ≥ 2n | The scorer's `current` must lie inside the episode, not after it. |
| 7 | Significance: binomial upper tail `P(X ≥ ΣP_W)` with `X ~ Bin(ΣA_W, n)` | ≤ 1 × 10⁻⁶ | The scan makes about 30,000 country-day tests. A Bonferroni bound for a 5% family-wise error rate is 1.7 × 10⁻⁶, rounded down. |

**Episodes.** The qualifying days of one country that are at most seven days apart form one episode. An episode's statistic is the ratio `week share / n` on its peak day, the qualifying day with the greatest ratio. Ties go to the earliest day.

**Selection.** Sort all episodes of all seven countries by peak ratio ascending, then by earliest peak date, then by ISO2. Take the lower median, position `floor((m - 1) / 2)` with zero-based indexing, as the chronic-war rule does. The 35–55 band sits mid-scale, so the anchor should be a typical qualifying episode. The maximum over eleven years and seven countries is an extreme value that grows with the window. The median does not.

**Confirmation on the 2.0 stream.** Rebuild days `T-35` to `T` of the selected episode's peak day from the 2.0 exports. The peak day must satisfy criteria 1–7 on those counts. Every day must have all 96 exports, or the day counts as missing. `summarizeCountryEvents` at nowMs `T 23:59:59.999Z` with cursor `T 23:45:00` must also report `weekReady`, `baselineReady` and `currentComplete`, a positive protest `baselineMedian` and protest `current` above it (the original P15b eligibility). If confirmation fails, remove that episode and take the lower median of the rest. Repeat until one confirms or none remain. If none qualifies or confirms, report that P15b has no episode. Do not loosen any threshold after the scan.

### Copied magnitudes

From the confirmed episode's `summarizeCountryEvents` output for that country, unchanged: `protest.current`, `protest.baselineMedian`, `conflict.current`, `conflict.baselineMedian` and `week.articles`, `week.conflict` and `week.protest`. The same values go to each of DE, FR, GB, JP, KR, PL and US, as in the existing P15b scenario. GDELT strike days are not copied, and other evidence stays at zero. The AE9 check repeats this week's level for eight weeks, with current equal to median, as before. The manifest records the episode country, the capture clock, the week and norm dates, every criterion's value and the full candidate list with each episode's statistics. The country identifies evidence, never a score target.

### Validation results (2026-11-15)

**The 2.0 rebuild reproduces both captures exactly.** Days 2026-10-15 to 2026-11-14 were rebuilt from 2,904 quarter-hour exports, every one verified against the master list's size and MD5. `compare` then ran `summarizeCountryEvents` at each capture's own clock (cursor `20261113094500` and `20261114054500`). For each of the 37 captured countries, it checked protest and conflict `current` and `baselineMedian`, the three `week` counts and the strike days, plus the readiness flags and `strikeDays`. All 300 fields match on both captures, with no mismatch at any tolerance: `current` matches to its rounded decimal.

```
node scripts/cii-gdelt-archive-rebuild.mjs v2 --from 2026-10-15 --to 2026-11-13 --out full.json
node scripts/cii-gdelt-archive-rebuild.mjs v2 --from 2026-11-13 --to 2026-11-13 --cursor 20261113094500 --out partial.json
node scripts/cii-gdelt-archive-rebuild.mjs compare --snapshot full.json,partial.json --cursor 20261113094500 --fixture tests/fixtures/cii/2026-11-13T0952Z.json
```

**The daily-file gate fails, so the scan was not run.** Daily-file counts compared with the 2.0 rebuild, for the seven countries:

| Day | Country | 2.0 articles | Daily articles | Difference | 2.0 protest | Daily protest | Gate |
|---|---|---|---|---|---|---|---|
| 2026-11-10 | DE | 298 | 305 | 2.3% | 4 | 4 | pass |
| 2026-11-10 | FR | 455 | 472 | 3.7% | 5 | 5 | pass |
| 2026-11-10 | GB | 1,452 | 1,526 | 5.1% | 19 | 19 | **fail** |
| 2026-11-10 | JP | 194 | 199 | 2.6% | 1 | 1 | pass |
| 2026-11-10 | KR | 108 | 110 | 1.9% | 1 | 1 | pass |
| 2026-11-10 | PL | 85 | 87 | 2.4% | 3 | 3 | pass |
| 2026-11-10 | US | 7,351 | 7,631 | 3.8% | 67 | 69 | pass |
| 2026-11-11 | DE | 247 | 256 | 3.6% | 3 | 3 | pass |
| 2026-11-11 | FR | 367 | 376 | 2.5% | 3 | 3 | pass |
| 2026-11-11 | GB | 1,452 | 1,523 | 4.9% | 12 | 14 | pass |
| 2026-11-11 | JP | 180 | 184 | 2.2% | 0 | 0 | pass |
| 2026-11-11 | KR | 120 | 122 | 1.7% | 2 | 2 | pass |
| 2026-11-11 | PL | 99 | 99 | 0.0% | 3 | 3 | pass |
| 2026-11-11 | US | 7,213 | 7,487 | 3.8% | 51 | 51 | pass |
| 2026-11-12 | DE | 219 | 224 | 2.3% | 3 | 3 | pass |
| 2026-11-12 | FR | 353 | 358 | 1.4% | 9 | 9 | pass |
| 2026-11-12 | GB | 1,397 | 1,456 | 4.2% | 13 | 13 | pass |
| 2026-11-12 | JP | 187 | 192 | 2.7% | 1 | 1 | pass |
| 2026-11-12 | KR | 135 | 141 | 4.4% | 1 | 1 | pass |
| 2026-11-12 | PL | 60 | 62 | 3.3% | 2 | 2 | pass |
| 2026-11-12 | US | 7,304 | 7,573 | 3.7% | 53 | 55 | pass |

One of 21 country-days exceeds the registered 5% article tolerance. As registered, the scan was not run. A queued scan process started when the validation run finished. It was stopped before it had fetched any daily file inside the window. No in-window count has been read.

**Cause.** The daily file for 2026-11-10 holds exactly the same 124,504 events as that day's 96 quarter-hour exports: identical `GLOBALEVENTID` set, identical `SOURCEURL` and identical `ActionGeo_CountryCode` on every event. The only field that differs is `IsRootEvent`. 2,904 events (2.3%) are root events in the daily file but not in the quarter-hour exports, and none differ the other way. The seeder counts only root events, so the daily file over-counts articles by a few percent. The excess varies by country and day, and protest counts are almost unaffected. The daily file cannot reproduce the 2.0 root flag, so no column mapping repairs it.

**Status.** P15b still has no recorded episode. Running the registered rule needs one of these owner rulings, each made before any in-window data is read:

1. Amend the selection source: keep the daily file for screening, with the amended gate on the ratio the rule uses (week share over norm share) rather than on raw articles. The 2.0 confirmation step already re-tests every criterion on the scorer's own stream.
2. Run the rule on the 2.0 stream at full resolution: about 400,000 sequential requests, more than four days.
3. Shorten the window to what the 2.0 stream can cover in an acceptable time, justified from the construct.

The criteria, thresholds, clustering, lower-median selection and copied magnitudes above stay as registered under any of the three.
