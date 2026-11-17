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

### Amendment 1: daily-file screen, 2.0 confirmation (registered 2026-11-16)

The owner chose option 1 on 2026-11-16, with a margin below the volume floors. This amendment is registered before any in-window count is read. The only in-window bytes fetched so far are 20 quarter-hour exports for 2024-03-15, downloaded by a throughput test that recorded their byte size and never unzipped or parsed them.

**Why the registered gate failed.** On 2026-11-10, GB's daily-file article count was 5.1% above the 2.0 rebuild, against a 5% limit. The daily file and the 2.0 rebuild hold the same events. The daily file flags 2.3% more of them `IsRootEvent=1`, and the seeder counts root events only (see "Validation results"). Article counts in both the week and the norm rise by a few percent together, so protest share falls slightly in both and the ratio between them barely moves.

**The daily file only screens.** No episode is selected from daily-file counts, and no magnitude is copied from them.

**Admission gate, replacing the 5% article gate.** The daily file is admissible as a screen if, for each of the seven countries, the rule's ratio `week share / n` computed from daily files is within 10% of the same ratio from the 2.0 rebuild. The check is made at capture days 2026-11-13 and 2026-11-14. Both lie outside the window, and the 2.0 rebuild already covers 2026-10-15 to 2026-11-14. On these days the norm is 22 and 23 present days, above the 21-day minimum. A country whose 2.0 norm share is zero has no ratio and is not tested. The 10% tolerance matches the margin below the volume floors. Ratio criteria 4–6 are tested at the threshold, so a screen that shifted the ratio by more than the margin would drop real episodes. If the gate fails, the scan is not run and the finding is reported.

**Screen criteria.** Criteria 1–3, the article-volume floors, admit weeks at 90% of each floor or above: week articles ≥ 180, week protest ≥ 31.5 (so 32), and norm protest ≥ 25.2 (so 26). This keeps near-floor weeks the daily file's root-flag noise could otherwise drop. The ratio (4, 6), duration (5), significance (7), norm-day and completeness requirements are unchanged. Episodes, peak days and their ordering are formed from screen results exactly as registered.

**Confirmation of every screened episode.** Every screened episode's peak day is rebuilt from the 2.0 exports (days `T-35` to `T`, 96 exports each) and tested against the registered criteria 1–7 at their registered thresholds, plus the scorer eligibility check, exactly as in "Confirmation on the 2.0 stream". An episode that fails anywhere is dropped, and the reasons are recorded. The selection ordering (peak ratio ascending, then date, then ISO2) and the lower median are applied to the confirmed episodes only, with each episode's peak ratio taken from the 2.0 rebuild. The selected episode and every confirmed episode above or below it in the ranking therefore pass every registered threshold on the 2.0 rebuild. The report gives the number of screened episodes that fail on 2.0 and the failed criteria for each one. If no screened episode confirms, P15b has no episode.

Everything else in this section stands as registered: thresholds, clustering, selection position and copied magnitudes. All copied magnitudes come from the 2.0 rebuild.

### Results of amendment 1 (2026-11-17)

**Admission gate: passes.** All 14 country-days are within 10%. The largest difference is DE on 2026-11-14 at −5.8% and on 2026-11-13 at −6.1%. Daily-file ratios run from −6.1% to +0.5% of the 2.0 ratios, mostly a little low. The screen is therefore more likely to drop a borderline episode than to add a spurious one.

| Country | 2026-11-13: 2.0 ratio | daily ratio | difference | 2026-11-14: 2.0 ratio | daily ratio | difference |
|---|---|---|---|---|---|---|
| DE | 0.4446 | 0.4173 | −6.12% | 0.5186 | 0.4887 | −5.76% |
| FR | 0.3008 | 0.2911 | −3.23% | 0.2565 | 0.2460 | −4.08% |
| GB | 1.0232 | 1.0261 | +0.28% | 0.9565 | 0.9611 | +0.48% |
| JP | 1.1395 | 1.1425 | +0.26% | 0.8948 | 0.8965 | +0.19% |
| KR | 1.3936 | 1.3796 | −1.00% | 1.1879 | 1.1751 | −1.07% |
| PL | 0.4603 | 0.4408 | −4.23% | 0.4393 | 0.4210 | −4.17% |
| US | 0.6607 | 0.6414 | −2.92% | 0.6795 | 0.6552 | −3.57% |

**Screen.** It read every daily file from 2015-02-25 to 2026-10-31. GDELT's archive has no daily file for 20 days, which count as missing: 2022-11-10, 2023-03-23, and 2025-06-14 to 2025-07-01. For 2023-03-22, GDELT's `md5sums` list gives `9fa71d95…`, but the stored object and two downloads of it are `a246cae9…`. The file was accepted on the stored object's own MD5 header and recorded (`md5ListMismatches` in the scan output). 167 capture days qualified on the screen. They form 48 episodes.

**Confirmation: 26 of 48 confirm, 22 fail on 2.0.**

- **19 fail completeness.** A week day or the capture day has fewer than 96 quarter-hour exports in GDELT's 2.0 archive, so under the registered rule that day is missing, as it would be for the scorer. Eleven of the 19 are short on one to four days, by 1 to 9 exports a day. The other eight fall in long archive gaps: late July to August 2017, October 2017, March 2018, July 2018, and late October to early November 2020 (as few as 21 exports a day). In those eight, the norm also has 0 to 3 complete days, and the scorer's readiness checks fail too. The daily file has no such gaps, which is why the screen admitted them.
- **3 fail a registered threshold on complete data.**
  - DE 2019-08-28 fails the current-day share (1.30% against 2n = 1.40%).
  - DE 2020-08-08 fails duration: 3 of 7 elevated days on 2.0, against 5 or more on the screen.
  - JP 2026-10-11 has 25 norm protest articles on 2.0, under 28. It passed the screen's 90% floor of 25.2 on the daily file. This is the near-floor case the margin was registered to keep for confirmation.
- Every episode that met criteria 1–7 on 2.0 also passed the scorer eligibility check.

**Every screened episode.** In screen order (peak ratio ascending on the daily file). Qualifying days are counted on the screen. For incomplete days, the number of exports present is in brackets. The 2.0 ratio is blank where the 2.0 week is incomplete.

| Screen rank | Country | Qualifying days | Peak | Screen ratio | 2.0 ratio | 2.0 result |
|---|---|---|---|---|---|---|
| 0 | US | 2024-04-26 to 2024-05-02 (6) | 2024-05-02 | 2.23 | 2.24 | confirmed, position 0 |
| 1 | DE | 2019-03-18 to 2019-03-18 (1) | 2019-03-18 | 2.27 | – | fails: incomplete: 03-13 (95) |
| 2 | JP | 2023-03-13 to 2023-03-13 (1) | 2023-03-13 | 2.47 | – | fails: incomplete: 03-08 (95), 03-09 (95), 03-11 (94), 03-12 (95) |
| 3 | JP | 2024-03-06 to 2024-03-07 (2) | 2024-03-06 | 2.55 | 2.57 | confirmed, position 3 |
| 4 | DE | 2019-08-28 to 2019-08-28 (1) | 2019-08-28 | 2.55 | 2.45 | fails: current share 1.30% < 2n = 1.40% |
| 5 | US | 2026-01-13 to 2026-01-13 (1) | 2026-01-13 | 2.55 | 2.44 | confirmed, position 1 |
| 6 | FR | 2021-07-21 to 2021-07-21 (1) | 2021-07-21 | 2.56 | 2.51 | confirmed, position 2 |
| 7 | JP | 2017-08-01 to 2017-08-01 (1) | 2017-08-01 | 2.57 | – | fails: incomplete: 07-25 (91), 07-26 (94), 07-27 (92), 07-28 (94), 07-29 (92), 07-30 (95), 07-31 (92), 08-01 (92); norm 1 of 28 days |
| 8 | US | 2016-07-13 to 2016-07-13 (1) | 2016-07-13 | 2.72 | – | fails: incomplete: 07-11 (95) |
| 9 | FR | 2026-10-24 to 2026-10-25 (2) | 2026-10-24 | 2.78 | 2.70 | confirmed, position 4 |
| 10 | FR | 2020-11-01 to 2020-11-03 (3) | 2020-11-03 | 2.80 | – | fails: incomplete: 10-27 (44), 10-28 (46), 10-29 (36), 10-30 (23), 10-31 (21), 11-01 (38), 11-02 (46), 11-03 (30); norm 1 of 28 days |
| 11 | DE | 2020-08-08 to 2020-08-08 (1) | 2020-08-08 | 2.83 | 2.74 | fails: 3 of 7 elevated days |
| 12 | JP | 2021-02-10 to 2021-02-13 (4) | 2021-02-10 | 2.89 | 2.87 | confirmed, position 5 |
| 13 | DE | 2020-06-07 to 2020-06-07 (1) | 2020-06-07 | 3.01 | 2.94 | confirmed, position 6 |
| 14 | FR | 2023-03-18 to 2023-03-19 (2) | 2023-03-19 | 3.04 | – | fails: incomplete: 03-12 (95), 03-14 (94), 03-16 (95), 03-19 (95) |
| 15 | PL | 2016-03-17 to 2016-03-17 (1) | 2016-03-17 | 3.10 | – | fails: incomplete: 03-12 (95), 03-13 (95) |
| 16 | KR | 2016-07-17 to 2016-07-19 (2) | 2016-07-19 | 3.16 | – | fails: incomplete: 07-18 (95) |
| 17 | US | 2025-06-13 to 2025-06-13 (1) | 2025-06-13 | 3.31 | – | fails: incomplete: 06-12 (87) |
| 18 | KR | 2020-08-21 to 2020-08-21 (1) | 2020-08-21 | 3.36 | – | fails: incomplete: 08-14 (95) |
| 19 | FR | 2024-05-02 to 2024-05-05 (3) | 2024-05-03 | 3.41 | 3.42 | confirmed, position 7 |
| 20 | US | 2017-08-17 to 2017-08-20 (4) | 2017-08-19 | 3.48 | – | fails: incomplete: 08-12 (90), 08-13 (93), 08-14 (91), 08-16 (94), 08-17 (92), 08-18 (93), 08-19 (92); norm 1 of 28 days |
| 21 | FR | 2024-01-30 to 2024-02-04 (6) | 2024-02-04 | 3.50 | 3.46 | confirmed, position 8 |
| 22 | PL | 2018-03-13 to 2018-03-15 (3) | 2018-03-15 | 3.67 | – | fails: incomplete: 03-08 (86), 03-09 (95), 03-11 (92), 03-12 (93), 03-13 (85), 03-14 (94), 03-15 (89); norm 1 of 28 days |
| 23 | FR | 2018-11-22 to 2018-12-10 (12) | 2018-11-24 | 3.89 | 3.94 | confirmed, position 11 |
| 24 | DE | 2018-09-02 to 2018-09-08 (5) | 2018-09-03 | 3.94 | 3.98 | confirmed, position 12 (**selected**) |
| 25 | PL | 2017-07-23 to 2017-07-25 (3) | 2017-07-24 | 3.96 | – | fails: incomplete: 07-17 (90), 07-18 (89), 07-20 (93), 07-21 (87), 07-22 (91), 07-23 (93), 07-24 (91); norm 0 of 28 days |
| 26 | GB | 2024-08-05 to 2024-08-11 (7) | 2024-08-08 | 3.97 | 3.72 | confirmed, position 9 |
| 27 | FR | 2025-09-09 to 2025-09-11 (2) | 2025-09-11 | 4.02 | 3.98 | confirmed, position 13 |
| 28 | JP | 2020-06-04 to 2020-06-07 (4) | 2020-06-07 | 4.05 | 3.91 | confirmed, position 10 |
| 29 | PL | 2016-12-19 to 2016-12-19 (1) | 2016-12-19 | 4.18 | 4.75 | confirmed, position 16 |
| 30 | PL | 2017-10-20 to 2017-10-21 (2) | 2017-10-20 | 4.28 | – | fails: incomplete: 10-13 (95), 10-14 (91), 10-15 (95), 10-16 (95), 10-17 (94), 10-18 (92), 10-19 (95); norm 1 of 28 days |
| 31 | JP | 2023-08-25 to 2023-08-31 (6) | 2023-08-28 | 4.38 | 4.54 | confirmed, position 15 |
| 32 | PL | 2020-08-11 to 2020-08-13 (2) | 2020-08-11 | 4.38 | 4.45 | confirmed, position 14 |
| 33 | KR | 2024-02-25 to 2024-02-27 (3) | 2024-02-27 | 4.94 | 4.95 | confirmed, position 17 |
| 34 | KR | 2015-11-20 to 2015-11-20 (1) | 2015-11-20 | 5.01 | – | fails: incomplete: 11-15 (95), 11-18 (95) |
| 35 | JP | 2026-10-11 to 2026-10-11 (1) | 2026-10-11 | 5.34 | 5.60 | fails: norm protest 25 < 28 |
| 36 | KR | 2016-11-03 to 2016-11-07 (4) | 2016-11-05 | 5.39 | – | fails: incomplete: 11-01 (95), 11-04 (95) |
| 37 | JP | 2022-09-26 to 2022-09-28 (3) | 2022-09-28 | 5.54 | 5.36 | confirmed, position 19 |
| 38 | FR | 2020-06-05 to 2020-06-13 (8) | 2020-06-08 | 5.56 | 5.41 | confirmed, position 20 |
| 39 | KR | 2024-12-05 to 2024-12-14 (9) | 2024-12-10 | 5.73 | 5.42 | confirmed, position 21 |
| 40 | FR | 2023-07-04 to 2023-07-07 (4) | 2023-07-05 | 5.80 | 5.25 | confirmed, position 18 |
| 41 | PL | 2018-07-06 to 2018-07-09 (4) | 2018-07-08 | 5.90 | – | fails: incomplete: 07-01 (92), 07-02 (95), 07-03 (91), 07-04 (95), 07-05 (95), 07-06 (92), 07-07 (95), 07-08 (91); norm 3 of 28 days |
| 42 | GB | 2020-06-05 to 2020-06-14 (9) | 2020-06-07 | 6.15 | 5.94 | confirmed, position 22 |
| 43 | KR | 2020-06-07 to 2020-06-08 (2) | 2020-06-08 | 6.35 | 6.41 | confirmed, position 24 |
| 44 | FR | 2026-10-04 to 2026-10-13 (9) | 2026-10-07 | 6.59 | 6.39 | confirmed, position 23 |
| 45 | PL | 2020-10-29 to 2020-11-03 (5) | 2020-10-30 | 6.76 | – | fails: incomplete: 10-23 (30), 10-24 (33), 10-25 (46), 10-26 (44), 10-27 (44), 10-28 (46), 10-29 (36), 10-30 (23); norm 1 of 28 days |
| 46 | PL | 2016-10-06 to 2016-10-10 (4) | 2016-10-07 | 6.79 | – | fails: incomplete: 10-04 (95) |
| 47 | US | 2020-06-02 to 2020-06-09 (8) | 2020-06-05 | 10.81 | 10.53 | confirmed, position 25 |

**Selection.** The 26 confirmed episodes, ordered by 2.0 peak ratio ascending, then date and ISO2, give a lower median at position `floor((26 - 1) / 2) = 12`: **DE, episode 2018-09-02 to 2018-09-08, peak day 2018-09-03**. Ratio 3.98: a week share of 4.06% (165 of 4,065 articles) against a norm share of 1.02% (114 of 11,172). Six of seven week days are at 2n or above. The current-day share is 5.12% (31 of 606). Binomial tail 3.1 × 10⁻⁴⁸. Every confirmed episode passes every registered threshold on the 2.0 rebuild, so the condition that the selected episode and every episode ranked above it confirm on 2.0 holds.

### Episode manifest entry: P15b sustained unrest (amendment 1)

| Anchor | Episode | Selection statistic | Candidates considered |
|---|---|---|---|
| Sustained unrest above norm | DE, capture clock 2018-09-03T23:59:59.999Z (cursor `20180903234500`, `nowMs` 1536019199999), from the GDELT 2.0 archive rebuild | week share / norm share = 0.04059 / 0.01020 = 3.98, the lower median (position 12) of 26 confirmed episodes | 48 screened episodes in the table above; 26 confirmed |

- **Source.** GDELT 2.0 quarter-hour exports, each verified against the master list's size and MD5. Rebuilt by `scripts/cii-gdelt-archive-rebuild.mjs` and selected by `scripts/cii-unrest-episode-scan.mjs confirm`, with tools as of commit `98d61a1dff`.
- **Dates.** Week 2018-08-27 to 2018-09-02. Current day 2018-09-03 (96 of 96 exports). Rule norm 2018-07-30 to 2018-08-26: 26 of 28 days complete, because 2018-08-10 has 94 exports and 2018-08-21 has 88. The scorer baseline covers 2018-08-05 to 2018-09-01 at that clock, 26 days, with `baselineReady`.
- **Copied magnitudes, exactly as recorded** (`summarizeCountryEvents` for DE at that clock, coded articles per day):
  - GDELT protest current 31 against median 4.
  - Conflict current 78 against median 43.5.
  - Week of 4,065 articles: 454 conflict-coded and 165 protest-coded.

  Applied to each of DE, FR, GB, JP, KR, PL and US. Strike days are not copied, and other evidence stays at zero. The AE9 check repeats this week's level for eight weeks with current equal to median.
- **Replaces** the KR 2026-11-13T0952Z episode in the frozen U18 manifest for the next study's registration. The U18 manifest itself stays as frozen.

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

For each combination, `a` is solved analytically as the interval that keeps every anchor inside its band. With interval width `h = hi − lo`, properties are measured at `k + 1` evenly spaced values of `a` from `lo` to `hi` inclusive, where `k = max(1, min(m, floor(h/0.05)))`. `m` is 8 on the main grid (at most nine points) and 4 on the extension grids (at most five points).

### Grids

| Grid | Constants | Combinations | Anchor-feasible | Points measured | Pass every must-pass |
|---|---|---|---|---|---|
| Main | merge union / max; b 0–0.8 step 0.1; ks 0.03 / 0.05 / 0.08 / 0.12; ku 0.25 / 0.5 / 1 / 1.5 / 2; w 0 / 0.5 / 1; kg 0.5 / 1 / 2 / 4 / 8; φ 0.02 / 0.05 / 0.1; (kl, fp) in (0, 0.02), (1, 0.005), (1, 0.01), (1, 0.02), (2, 0.005), (2, 0.01), (2, 0.02), (4, 0.005), (4, 0.01), (4, 0.02); ke 0 / 0.5 / 1 / 2; C 4 / 8; n0 200; ko 2; smin 1; log UCDP | 1,296,000 | 7,968 | 38,808 | 0 |
| Extension | merge union / max; b 0–0.8 step 0.1; ks 0.05 / 0.12; ku 0.1 / 0.25 / 0.5 / 1 / 1.5 / 2; w 0 / 1; kg 1 / 2 / 4 / 8; φ 0.02 / 0.1; (kl, fp) in (0, 0.02), (1, 0.005), (1, 0.01), (2, 0.005), (2, 0.01), (4, 0.01); ke 0 / 1; smin 1 / 5; UCDP log / square root; C 8; n0 200; ko 2 | 165,888 | 2,468 | 9,768 | 0 |
| Extension without P15b (diagnostic only) | same as the extension; P15b dropped from the anchor set and counted as passing | 165,888 | 36,736 (5,248 sampled) | 24,176 | 0 |

When an extension run has more than 6,000 anchor-feasible combinations, it keeps every `ceil(N/6000)`-th combination in enumeration order, starting with the first. Enumeration nests merge, b, ks, ku, w, kg, φ, (kl, fp), ke, smin and the UCDP transform, in the listed value order, with the last varying fastest. The main grid and the registered extension measure every anchor-feasible combination.

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
- **P8a.** Give UCDP and GDELT a B2-style last-good snapshot, read through the real path with the existing honesty checks. Keep K = 10, measured with the snapshot present, plus a separate report of the no-snapshot move. Without a snapshot, no tested design passes P8a: it fails at all 38,808 main-grid points and all 9,768 extension points. This is a result for the tested family, not a proof for every design. Any design that keeps a high live share still has to bound the move when its largest live input reads null.
- **P3c.** Exclude countries whose score is at or above 95 before the campaign, as P1 and P2 already do. Measured: 1 silent case remains at the representative and 0 of 9,768 extension points pass, so this is necessary but not sufficient.
- **P12b and R14/KTD-8.** The credibility weight and the volume invariance cannot both hold. The owner chooses between them:
  - keep credibility and redefine P12b to apply only at or above the OQ11 volume floor (200 weekly articles); or
  - drop credibility and rely on the OQ11 volume floor alone.
- **P15c and AE12.** Ship B3's version 2 tally writer to `main`, then capture a third calibration fixture holding a fresh version 2 tally before any rerun.

After these rulings, the next study needs new captures (for the unrest and strike episodes) and a fresh pre-registration of the changed rules. Re-running this grid against amended thresholds would be selecting rules from results.

## Diagnostic addendum (2026-11-15, after the results)

Everything in this section is post hoc. It was run on the same two captures after the results above were known, so it registers nothing and proves nothing about a future design. Its purpose is to tell the owner which rulings would change the outcome. Any design or rule taken from it must be confirmed on new captures under a fresh pre-registration.

### Three corrections to the proposals above

1. **The unrest anchor is not an unrest episode.** The selected KR week has a protest share of 1.81%. FR's ordinary week on the same capture has 2.96%, and was ineligible only because its current count was not above its own median. The selection rule takes the largest eligible week without requiring that any week be unusual. The OQ6 proposal above (a volume floor) does not fix this.

   Proposed instead: rule the unrest anchor unavailable on these captures, as the strike anchor already is. Rebuild it from a recorded historical episode, using GDELT's archived event exports and the seeder's own day-rebuild code (`rebuildCountryEventsDay` in `scripts/_gdelt-country-events.mjs`).

2. **The structural prior double-counts violence.** WGI PV.EST is itself a lagged measure of political violence. Adding it to the UCDP term stacks the same evidence twice, and puts ten war countries in one band above 95. That is the P5b failure.

   Proposed instead: make the prior a member of the violence union, `P = b·max(0, 1.5 − PV)`, under the brief's own rule of deduplicating and never summing. The score becomes `z = a + union(P, strikes, UCDP, burden, GDELT conflict, OREF) + U + E`.

3. **P1 and P3c inject fixed amounts.** Twenty-five deaths, or fifteen strike units, added to a country that already carries hundreds, move the score by less than the threshold. That is correct behaviour, and excluding scores of 95 and above does not cover it.

   Proposed instead, in two parts:

   - P1's violence injection is stated per capita, as OQ4 does for the war anchor. The runs below use 25 deaths at the median population of the 31 countries, which is 0.4845 per million.
   - P1 and P3c count only cases where the injection raises the country's existing level in that channel by at least a stated fraction. The runs below use 25%; the owner sets the number before any rerun.

### What the corrections change

Each run drops P15b, measures P8a with a last-good snapshot for UCDP and GDELT, and excludes scores of 95 and above from P3c.

| Run | Design and rules | Points | Pass all | Closest miss |
|---|---|---|---|---|
| A | additive prior; per-capita P1 | 38,922 | 0 | 23 points fail only P5b (12 to 15 quiet countries in one band) |
| B | additive prior, b 0.4 to 1.2 | 1,512 | 0 | P5b fails at every point (ten war countries above 95) |
| C | prior in the union; knee and C varied | 5,670 | 0 | P5b passes at 381 points; P1 and P3c fail everywhere |
| C2 | as C, with the relative-increment rule for P1 and P3c | 5,670 | 0 | 4 points fail only P5b, by one or two countries |
| E | as C2, finer grid | 67,068 | 3 | 547 points fail one property |

Run E's grid: b 0.3 / 0.4 / 0.5 / 0.6 / 0.8; ks 0.03 / 0.04 / 0.05 / 0.06; ku 0.75 / 1 / 1.25 / 1.5; knee 0.1 / 0.3 / 1; w 0.5 / 0.75 / 1; kg 0.5 / 1 / 2; φ 0.02; (kl, fp) in (0, 0.02), (1, 0.01), (2, 0.02); ke 0 / 0.5; C 5 / 6 / 8 / 10; union merge; n0 200; ko 2; strike half-life 5 days. That is 51,840 combinations, of which 16,632 are anchor-feasible. Each is measured at `k + 1` values of `a`, with `k = max(1, min(4, floor(h/0.1)))`.

Run E's failures per property, out of 67,068 points: P3c (amended) 63,771; P5b 63,393; P1 (amended) 48,962; AE9 44,712; P3b 25,560; P2 7,617; P5a 6,207; GPI 30.

**Three points pass every amended must-pass property, and they are isolated.** They are three different combinations, with no two adjacent on the grid. All three use kg 2, kl 1 and ke 0. On the first of them:

- GPI ρ is 0.800 and 0.819 (v14: 0.730 and 0.786).
- P13a is 90.8% on both captures.
- P12a passes (median 0.3, p99 4.7).
- P4 and P12b still miss (P12b: 22.8 at four times the volume).
- The worst P5b band holds exactly 7, the limit.

This is not a design to build on. It shows the amended rule set is satisfiable, and that two properties now bind:

- **P5b at the quiet end.** Seven to nine countries with no live evidence and similar priors sit within five points of each other. The passing points separate them with a GDELT weight of 2, which means small-count noise is doing the separating. The owner should decide whether P5b applies to countries whose live families are all empty.
- **P3c's window.** The 4 to 6 day window is measured on the score, and the sigmoid and the union stretch the apparent half-life as a country nears saturation. Measuring the half-life on the latent strike term would test the decay the formula actually applies.

GPI stops binding once the unrest anchor is removed: it fails at 30 of 67,068 points, against 38,516 of 38,808 in the registered main grid.

### Revised list for owner ruling

- Stand as proposed: OQ1, OQ2, OQ3, OQ4, OQ8 (the weight `w` is no longer pinned at 1; passing points use 0.5 and 0.75), OQ10, the P8a snapshot, and shipping B3's version 2 tally writer to `main`.
- Replace the OQ6 proposal with correction 1.
- Add corrections 2 and 3.
- New questions: whether P5b covers countries with no live evidence, and whether P3c's half-life is measured on the latent term.
- Unchanged: the P12b and R14/KTD-8 conflict.

## Owner rulings and rerun (2026-11-15)

The owner ruled on three questions on 2026-11-15, after the diagnostic addendum. The reruns below use the same two captures, so they remain diagnostic. A design is accepted only after it passes on new captures under a fresh pre-registration.

### Rulings

1. **P5b exemption.** Countries whose every live family term is exactly zero are exempt from the band count. The exempt set is reported on every run, and those countries carry the label "structural estimate, no live inputs". The limit stays at 7 of 31.
2. **P3c measurement.** The half-life is measured on the latent strike term and must fall in 4 to 6 days. P3b stays on the score. A new check requires that a finished campaign's contribution to the score never rises by more than 0.2 between 3-hour samples.
3. **Strike half-life.** Five days, as the brief's P3 row states. The live constant `CII_STRIKE_HALF_LIFE_DAYS` is 3 and the public methodology page says 3; v15 changes both.

The relative-increment fraction for P1 and P3c is 25% in these runs. The owner has not ruled on that number.

### Rerun

Design: the prior inside the violence union, as in the addendum. Rules: the rulings above, P15b dropped, P8a with a last-good snapshot for UCDP and GDELT, P1 violence injected per capita, and the 25% relative-increment rule.

Grid: b 0.3 / 0.4 / 0.5 / 0.6 / 0.8; ks 0.03 / 0.05 / 0.08 / 0.12; ku 0.75 / 1 / 1.25 / 1.5; w 0.5 / 1; kg 0.25 / 0.5 / 1 / 2; knee 0.1 / 0.3 / 1; (kl, fp) in (0, 0.02), (1, 0.01); ke 0 / 0.5; C 6 / 8 / 10; φ 0.02; n0 200; ko 2. That is 23,040 combinations, of which 8,512 are anchor-feasible. Every fourth anchor-feasible combination in enumeration order is measured (2,128), at up to five values of `a`.

| Run | P5b exemption | Points | Pass all | Distinct combinations |
|---|---|---|---|---|
| G0 | as ruled: every live term exactly zero | 9,008 | 10 | 8 |
| G1 | not ruled: live evidence moves the score by less than 1 point | 9,008 | 59 | 36 |

Findings:

- **The exemption as ruled covers two countries per capture.** The other quiet countries carry small non-zero terms and still share a band. Under G1 the exemption covers five or six countries, and the passing set grows about sixfold. The owner should decide whether the exemption is "exactly zero" or "under 1 point".
- **The G1 passing set is a region, not a point.** It spans b 0.3 to 0.6, ku 1 to 1.5, every knee value, C 8 and 10, and kg 0.25 to 2. Most passes use kg 0.25 or 0.5, so GDELT noise is no longer doing the separating.
- **Three constants are pinned.**
  - ks is 0.05 in 55 of 59 passes, on a grid with steps at 0.03 and 0.08.
  - kl is 1 in every pass.
  - ke is 0 in every pass, which means the economic family carries no weight. OQ7 puts economic stress inside the construct, so a rerun needs values of ke between 0 and 0.5.
- **Targets on a typical G1 pass:**
  - P13a is 89.4% and 89.5% (v14: 14.8% and 16.0%).
  - P12a passes (median 0.1, p99 5.0).
  - P12b misses at 7.2 (limit 1).
  - P4 misses: the smallest response is +0.8 at 48 hours.
- **GPI on that pass.** ρ is 0.828 on both captures, against v14's 0.730 and 0.786.
- **The latent half-life is 5.13 to 5.25 days.** Eight cases fall under the relative increment. They are countries where the GDELT backstop already reports more strikes on the day than the injected campaign, and the formula takes the larger source.

### Fourth ruling and full grid (2026-11-15)

4. **P5b exemption threshold.** The owner ruled that a country is exempt when live evidence moves its score by less than 1 point, measured as the score minus the prior-only score. This replaces "exactly zero" in ruling 1. The exempt set is still reported and labelled.

The full grid measures every anchor-feasible combination under rulings 2 to 4, and adds in-between economic and strike weights.

Grid: b 0.3 / 0.4 / 0.5 / 0.6 / 0.8; ks 0.03 / 0.04 / 0.05 / 0.06 / 0.08; ku 0.75 / 1 / 1.25 / 1.5; w 0.5 / 1; kg 0.25 / 0.5 / 1 / 2; knee 0.1 / 0.3 / 1; (kl, fp) in (1, 0.01), (2, 0.02); ke 0 / 0.1 / 0.25 / 0.5; C 8 / 10 / 12; φ 0.02; n0 200; ko 2. Other rules are as in the rerun above.

| Measure | Count |
|---|---|
| Combinations | 57,600 |
| Anchor-feasible | 25,520 |
| Points measured | 110,960 |
| Points passing every amended must-pass property | 1,691 |
| Distinct passing combinations | 1,055 |

**The passing set is a connected region.** A neighbour is the same combination with one constant moved one grid step.

- The best combination has 12 of its 14 neighbours passing.
- 426 of the 1,055 passing combinations have at least half their neighbours passing; the median is 45%.

**Passing combinations per constant value:**

| Constant | Passing combinations |
|---|---|
| b | 0.3: 394; 0.4: 315; 0.5: 191; 0.6: 137; 0.8: 18 |
| ks | 0.03: 66; 0.04: 195; 0.05: 375; 0.06: 419; 0.08: none |
| ku | 0.75: 58; 1: 360; 1.25: 350; 1.5: 287 |
| w | 0.5: 874; 1: 181 |
| kg | 0.25: 378; 0.5: 348; 1: 176; 2: 153 |
| knee | 0.1: 365; 0.3: 552; 1: 138 |
| ke | 0: 518; 0.1: 479; 0.25: 58; 0.5: none |
| C | 8: 260; 10: 430; 12: 365 |
| (kl, fp) | (1, 0.01): 1,055; (2, 0.02): none |

- The economic family can carry weight: 537 passing combinations have ke above 0, up to 0.25.
- The strike weight is no longer pinned; it passes from 0.03 to 0.06.

**Failures per property,** out of 110,960 points: P5b (as ruled) 93,153; AE9 55,480; P3c (as ruled) 49,417; P1 (amended) 43,310; P2 25,628; P3b 22,042; P5a 15,182; P8a (with snapshots) 1,376; GPI 26.

**The most robust combination** is b 0.4, ks 0.05, ku 1.25, w 0.5, kg 0.25, knee 0.3, kl 1, fp 0.01, ke 0, C 10. It passes at four values of `a`; at a −2.74309:

- GPI ρ is 0.832 and 0.829 (v14: 0.730 and 0.786).
- P13a is 91.1% on both captures (v14: 14.8% and 16.0%).
- Anchors: quiet week 6.6 to 11.4; chronic war 76.1 to 92.1; full-scale war 97.8 to 98.6.
- P2 spread is 0.196 (limit 0.25).
- The worst P5b band holds 6. Seven countries are exempt on each capture.
- P12a: median 0.1, p99 5.3 (limits 2 and 6).
- P12b misses at 8.1 (limit 1).
- P4 misses: the smallest response is +0.9 at 48 hours.

Across all passing points, P13a passes at every one and P12a at 1,659 of 1,691. P4 and P12b pass at none. Both need an owner sign-off or a design change before release.

This is still a diagnostic on the two captures the rules were adjusted against. It shows that a robust design exists under the rulings. It does not select the constants.

### What still blocks U4

- The unrest and strike anchors are unavailable on these captures. Both need new evidence: a historical unrest episode rebuilt from GDELT's archive, and a capture holding seven days of the version 2 strike tally.
- ~~Rulings are still open on OQ1 to OQ4, OQ8 and OQ10, the P8a snapshot, the prior inside the violence union, the per-capita and relative-increment forms of P1 (including the 25% fraction), and the P12b and R14/KTD-8 conflict.~~ Ruled 2026-11-16; see the next section.
- ~~P4 and P12b miss at every passing point.~~ P4 is signed off as a listed miss; P12b needs the strike-backstop change in the next section.
- Nothing here has been confirmed on captures the design has not seen.

## Owner rulings on the open questions (2026-11-16)

The owner accepted all eleven recommendations on 2026-11-16. Each ruling below states what the next study registers. Two of them, the relative injection in ruling 9 and the share-based strike backstop in ruling 10, change the design or a test and have not been measured; the fresh pre-registration measures them for the first time. Nothing here selects constants. The brief carries the matching amendments in its section 6.

1. **OQ1, headlines.** Headlines and news are context only and never move the score. P1 measures the scored families; the ten-headline injection is an assertion that the score moves by exactly 0. P10b and P11a then pass by construction, and the amendment says so. The context still renders wherever news used to explain the score: the country panel, the methodology pages and the API. The v15 release changes `docs/algorithms.mdx` lines 27 and 36. This flips if the blind judges consistently rank a news-heavy crisis below where readers expect it and no scored family sees that crisis.
2. **OQ2, merging inside a family.** Sources in one family merge by the bounded union `C·(1 − exp(−Σ/C))`, after incident deduplication. The union assumes independent sources, so deduplication must run first, as P6 requires. Each run reports `C` with the range over which every property holds.
3. **OQ3, P14 and P5c.** P14 is `|S − 100·sigmoid(z_prior + Σ emitted terms)| ≤ 0.05`, the rounding bound for scores emitted to one decimal place. P5c counts pairs where a country with an equal or higher prior and every family term at least as high still scores lower. P5c in this form is a regression guard: an additive, monotone model passes it, and a floor or override that lifts a country above one with equal or stronger evidence breaks it. P5c does not catch a floor that only ties scores (a floor of 70 on scores of 50 and 60); P14 does, because a floored score no longer equals the sigmoid of its emitted terms.
4. **OQ4, chronic-war anchor.** The P15d scenario copies a recorded chronic war's monthly deaths-per-million profile (MX, manifest above). The absolute-death scenario stays as a reported diagnostic, not a gate. This flips if the blind judges consistently rank populous countries with large absolute conflicts, such as India or Nigeria, above where per capita puts them.
5. **OQ8, war burden abroad.** A state party carries a conflict's deaths outside its borders, per million of its own population, through the same transform as territorial violence. The next study pre-registers `w` in {0.5, 0.75}, and the confirmation run picks it. Only primary parties are charged. Before the confirmation run, check whether the party table carries UCDP's secondary supporters; if it does, exclude them.
6. **OQ10, P13a.** P13a stays as registered: the share over the full source window, at least 50% and above v14. Each run also reports a non-gating 30-day split. Wherever P13a is published it is labelled "live-source share", not freshness.
7. **P8a, failed inputs.** UCDP and GDELT get a B2-style last-good snapshot with an age limit per source: GDELT 72 hours, as advisories use; UCDP about 45 days, one publication cycle plus a margin. While a snapshot stands in, the country shows a "held" label. When the snapshot expires, the input reads unknown, the country's coverage drops and the input-down alarm fires. The expired case joins the P8a scenarios, as it already does for advisories. K stays 10.
8. **The structural prior.** The prior is a member of the violence union, `P = b·max(0, 1.5 − PV)`, recorded as a dated amendment to the brief's section 1. It came from the post hoc diagnostics, so it counts as proven only after the confirmation run. If the union fails on fresh captures, the fallback is a non-violence structural index (regime type or government effectiveness), which reopens #10590 and needs a new study. R10, "a missing prior never reads as calm", is unchanged.
9. **P1 form.** P1's violence injection is stated per capita (25 deaths at the median population of the scored countries, 0.4845 per million). The 25% case filter is replaced by a relative injection: inject the larger of the per-capita base and 25% of the country's current level in that channel. Every case stays in the test and the 0.5-point threshold is unchanged. The same form applies to P3c's strike injection. The 25% figure is ruled. Not yet measured: a rough estimate puts a 25% rise at about +0.28 latent at ku 1.25, or +1.6 points at a score of 94.
10. **P4 and P12b.**
    - P4 is signed off as a listed miss with its measured value and both causes: the logistic shape is slow at both ends (scores 7 to 11 gain +3.6 to +4.9 at 48 hours but reach +10 within seven days; scores 76 to 94 gain under +3.2 after seven days), and countries already saturated with strikes respond little. It enters v15's `KNOWN_GAPS` with the measured values.
    - P12b's main miss is a volume leak in the GDELT strike backstop, not the credibility weight. Root cause 5 above describes the registered grid, where `kg` reached 4; across the passing region the credibility weight explains only the smaller residuals. At the most robust combination, SA's strike term moves from 44.7 units to 32.4, 55.2 and 63.5 under volume ×0.5, ×2 and ×4, and its score by up to 8.1. The backstop changes to measure strike articles as a share of the country's articles against its own baseline, as the other GDELT terms already do. That is a design change, measured first in the fresh pre-registration.
    - The credibility weight stays (R14, KTD-8). Its own residuals are 1.2 to 2.2 points (VE 1.6, BR 1.5, KR 1.5, KP 2.2). If credibility still moves a score by more than 1 after the backstop change, that residual is signed off with its measured value, or credibility is held fixed in the P12b test.
11. **Economic weight.** `ke` must be above zero. The next study pre-registers `ke` in {0.1, 0.25}. A zero weight would make the methodology page's economic family untrue. This flips to reopening OQ7 (economics as context only) if no combination with `ke` above zero passes on fresh captures.

**What the next study registers, in one place.** The design is the prior inside the violence union, with bounded unions inside each family after deduplication and a share-based strike backstop. The rules are the brief as amended in its section 6, together with the 2026-11-15 rulings (P5b exemption under 1 point, P3c on the latent strike term, a 5-day strike half-life). The pre-registered grids include `w` in {0.5, 0.75} and `ke` in {0.1, 0.25}. The unrest anchor comes from #10796, and the strike anchor from a capture holding seven days of the version 2 tally (no earlier than 2026-11-24). The registration is frozen before any candidate is evaluated on the new captures.
