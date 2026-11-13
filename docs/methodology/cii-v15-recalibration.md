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
| P13a | At least 50% on every calibration capture under the definition below | Each capture's share, denominator, coverage and shortfall against 50% |

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

The target is **50% on every calibration capture**. Most cross-country score variation should be attributable to current evidence if v15 addresses the static-prior problem. A complete annual war window measures continuing war burden at the source's publication cadence. Discarding its older deaths from the live definition confuses event age with source freshness and excludes most of the very signal the index is meant to measure. The target is fixed before candidate results. This is an OQ10 definition proposal, not an amendment to the brief without the owner's ruling.

## GPI benchmark

Spearman rank agreement with the Global Peace Index in risk direction must be **at least 0.75**, with **no drop greater than 0.02 from released v14** on any calibration capture. Higher GPI scores mean higher risk. Use average ranks for ties and the same country intersection and pinned GPI vintage for both formulas. Record the source payload, retrieval date, vintage, country intersection and missing countries before candidate evaluation. Missing benchmark data or undefined correlation is unverified, never a pass. No construct explanation silently waives either numerical rule.

## Anchor episode selection

Only committed fixtures explicitly marked `calibration: true` are eligible. October fixtures are regression snapshots and cannot select episodes or constants. Freeze the episode manifest after the second U21 capture lands and before candidate evaluation. Select over those captures' 31 scored countries, with the quiet and unrest selectors restricted to the seven stable democracies already named in the brief. Break equal selection statistics by earliest capture time and then ISO2 code. Missing required observations make an episode unavailable, not quiet. If no eligible episode exists, report that blocker without substituting a synthetic magnitude or selecting by score.

Each manifest entry records the source commit, fixture, country, observation dates, selection statistic, copied magnitudes and units. These country names identify evidence, never score targets. Scenario backgrounds retain each destination's own prior and population, live empty advisories and zero other evidence. Copied rates and shares are the same for every destination in the existing anchor set. Keep each chosen episode's temporal profile. Do not combine maxima from different countries.

| Anchor | Input-only selection rule | Scenario and unchanged acceptance band |
|---|---|---|
| Quiet week | Among complete observed weeks with zero confirmed strike units, zero factual territorial war deaths in the UCDP window, no active government-directed outage, and no positive fresh economic member, select the lowest GDELT protest share. Require a measured GDELT week and at least one fresh economic member. | Copy that week's GDELT counts, medians and shares and its measured quiet inputs to each stable democracy. Score ≤15. |
| Sustained unrest above norm | Among measured stable-democracy weeks with positive protest median and current protest count above that median, select the greatest weekly protest share. | Copy current count, median, weekly articles and protest count together, without fixed smoothing. Apply to each stable democracy. Score 35–55. The separate AE9 check repeats the observed level for eight weeks with current equal to median and requires a positive unrest term. |
| Strike campaign | Select the country-capture with the greatest confirmed weighted strike units per day over the seven complete UTC days preceding capture. Use existing severity weights and the confirmed tally, never add duplicate event-feed counts. Require a fresh confirmed feed and positive units. | Copy the seven daily magnitudes and their spacing to each stable democracy. Score 45–65. Report the rate and source days. |
| Chronic war | Among country-captures with positive factual territorial deaths in at least nine of the twelve complete calendar months of the UCDP window, select the lower median annual deaths-per-million rate. Count factual deaths from party-month groups once by location, never the activity totals that clamp zero-death events to one. | Copy the monthly per-million profile, annualised by 365 divided by the window length in days. Scale by each destination's population, for all 31 countries. Score ≥70. This implements the proposed OQ4 scenario; report it separately from the unchanged legacy absolute-death scenario until ruled. |
| Full-scale war | Among the same complete-window country-captures with positive deaths in at least nine complete months, select the greatest annual territorial deaths-per-million rate. | Copy that episode's monthly per-million profile to all 31 countries. Score ≥85. No extra strike or unrest maxima from other episodes. |

The proposed wider OQ6 bands are not registered as accepted thresholds. Any future owner amendment must be dated and retain the results against the original bands.

## Blind pairwise measurement

At least three judges must attest that they have seen neither the v14 table nor any candidate table. Prior exposed judges cannot count. Freeze one candidate and its constants before pair selection. Obtain all judgments before revealing either table or aggregating results. No judgment, aggregate or control result may tune that candidate or select another design.

Enumerate distinct unordered country pairs on each calibration date. A disagreement requires strict opposite ordering by v14 and the frozen candidate; ties in either table do not qualify. Select 30 disagreement cases by ascending SHA-256 of `U18-blind-v1|fixture|ISO2-low|ISO2-high`, retaining each country pair only once across dates. If fewer than 30 distinct disagreement pairs exist, report insufficient pairs; do not duplicate pairs or tune to manufacture disagreement. Add ten distinct control pairs with strict matching order, selected by the same rule and excluded from the disagreement set. Insufficient controls are also reported.

Randomise presentation order and left/right position with a recorded seed held by the coordinator. Judges receive the same dated country-risk evidence packets, the R21 construct and the options left higher, right higher, tie or insufficient evidence. Packets contain no formula, scores, ranks, model identity, predicted winner or control label. Lock ballots separately before discussion.

A pair is decided only when at least two thirds of all participating judges choose the same strict ordering. Ties, abstentions and unresolved pairs remain in the report but not the denominator. The candidate passes when it matches **at least two thirds of decided disagreement pairs**. Zero decided pairs is undefined, never a pass. Report decided and undecided counts, judge agreement, all disagreement outcomes and control outcomes separately. Controls cannot inflate the primary pass fraction. Preserve ballots and the selection seed for audit. This is a reported measurement only and ends at the owner-ruling stop, even if it fails.
