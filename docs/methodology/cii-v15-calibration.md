# CII v15 calibration: pre-registration

Registered at 2026-11-12T19:26:40.877672+00:00 before any candidate formula is evaluated in this session. The final study will be committed after U2. No scorer implementation is authorized by this document.

## Fixed acceptance thresholds

- Must pass: P1 subject to OQ1, P2, P3a/b/c, P5a/b/c, P7a/b, P8a, P14, P15a–e and P9 on a located production fixture. All thresholds in the final U2 brief remain fixed.
- P1: score increment ≥0.5 for each scored channel and country when initial score below 95, with strike feed present and absent. Headline increment is measured separately pending OQ1.
- P2: range of logit score increments ≤0.25, measured on unrounded latent as well as the existing rounded-score test, with strike feed present and absent.
- P5b: at most 7 of 31 scores in every half-open 5-point interval on every committed fixture. Use the existing scorer’s integer score convention; report continuous values separately.
- P15 anchors: quiet OECD 0–15, OECD riots 35–55, OECD strike campaign45–65, all-country chronic civil war 70–100, all-country full-scale war 85–100. Use the existing scenario inputs unchanged first; report proposed per-capita scenario separately.
- P13a target: ≥ 50% of cross-country score variance attributable to evidence under 30 days old on each fixture. Define B as the score after removing all evidence under 30 days old, L=S-B; share = Cov(L,S)/Var(S). This assigns the covariance equally to the two components and makes the baseline and live shares sum to 1. Do not clip negative shares or shares above1; report zero-variance cases as undefined. This is a target requiring owner sign-off if missed, not a must-pass property. Choose 50% because the stated product problem is that old/static inputs dominate cross-country variation; it is fixed before results.
- Benchmark: Spearman rank agreement with GPI risk direction ≥0.75 and decrease from released v14 ≤0.02. Any shortfall needs a stated construct reason; missing benchmark coverage is unverified, never a pass. Use the same country intersection for both formulas and report it.
- No floor, named-country calibration target, arbitrary prior, threshold relaxation, or new input family.

## Candidate design matrix

Compare linear evidence with a high cap and smooth saturating evidence; per-family maximum and incident deduplication plus bounded union; UCDP per-capita-only and a documented population-normalised/absolute combination. Do not select constants using country identities. Priors use z=a-b*PV with the verified pinned 2025 WGI estimates. Record analytic bounds on a,b from quiet/riot/strike bands, and war bounds for lowest-prior and largest-population countries. Search a bounded disclosed grid and report empty regions honestly.

OQ1–4 remain owner decisions. Candidate exploration is throwaway; only study results and proposed exact amendments enter the docs PR. No U4 before owner rulings.

## Result and stop condition

Study run on 2026-11-12 UTC after preregistration commit `0cb082e534`.
Stage B is integrated at `74c4d196e115771e1fe8931fab4070708b759290`.
The complete final brief was read; its SHA-256 is
`9082469721497ccfd6f49d3b5c4f3a72faa9154a3f61706d044c430d4b7c951f`.

**No tested design meets the exit bar. Do not start U4.** There are non-empty
anchor-only regions, but every tested anchor-feasible point fails at least one
of P1, P2, P5b or the benchmark filter. This is a bounded search result, not a
proof that every possible log-odds model is infeasible. No scorer, expected
table, protocol hash or acceptance threshold was changed for this study.

## Inputs and reproducibility

The replay inputs are the three committed fixtures `2026-10-21T0628Z`,
`2026-10-23T0756Z` and `2026-10-23T0946Z`, in that order in every vector below.
The WGI input is pinned 2025 `GOV_WGI_PV.EST`: all 31 countries covered, with
Taiwan from the matching official 2026 bulk release. The read-only API dry run
covers 208 country entries. WGI source URLs and license are recorded in U3,
PR #10590. These live source values are study inputs, not new production-score
fixtures.

The benchmark is the public GPI score in all 31 `resilience:static:<ISO2>`
payloads, read GET-only at 2026-11-12T19:49:07.763Z. Every record reports 2026;
higher means less peaceful. The same country intersection is used throughout.
No production write or deployment occurred. GPI is one benchmark; this does
not establish the consensus/outcome tests P13 or P16.

Exploration code is intentionally throwaway under U15. The equations, full grid,
selection rule and representative measured results below define the replay.
No country-specific coefficient or desired country score is used.

## Candidate equations and grid

For every country, `z = a - b*PV + V + U`; `S = 100*sigmoid(z)`.
The final score is rounded to an integer for the existing P1/P2/P5 tests.

- Strike pressure is the daily maximum of the confirmed tally, confirmed events
  and the existing GDELT strike backstop, decayed with a five-day half-life.
  Exploration retains a 60-day tail. This tests the requested five-day decay,
  rather than inheriting the current three-day strike decay.
- UCDP rate `r` is B6's decay-weighted deaths per million per year, with the
  365-day window and 91.25-day half-life. `d` is its weighted absolute deaths.
  The per-capita input is `log(1+r)`; the combined variant adds `log(1+d/100)`.
  The combined variant is a proposal under OQ4, not an accepted change to P10.
- GDELT conflict and protest use only positive `log((current+50)/(baseline+50))`,
  multiplied by `articles/(articles+50)`; sustained conflict level is excluded.
  The fixed smoothing/credibility value 50 is exploratory. The six-country
  article-volume fixture is still required before calibration can be accepted.
- Violence members are `ks*pressure`, `ku*UCDP`, `kg*conflict` and the existing
  OREF boost divided by 10. Unrest members are `kg*protest` and 1.5 times the
  existing outage boost divided by 30. These reuse the current outage eligibility
  and OREF attribution, without adding an input family. News, advisories,
  displacement and cross-border stock/surge have zero scored contribution.
- Each member uses either `min(C,x)` (linear to a high cap) or
  `C*(1-exp(-x/C))` (smooth saturation). Within each family compare `max(x)`
  with bounded union `C*(1-product(1-x/C))`. Strike sources are merged before
  this step. Aggregate fixtures cannot prove incident deduplication between
  UCDP and strike sources; P6 remains unverified.

Disclosed grid: `a=-4..-1` in 0.1 steps; `b=0..1.5` in 0.1 steps;
`ks={0.02,0.04,0.06,0.08,0.10}`; `ku={0.25,0.5,1,2,4,8,16}`;
`kg={2,3,4}`; `C={4,8,16}`. All eight shape/merge/normalisation combinations
use this same grid: 156,240 points each, 1,249,920 in total. A second disclosed
capacity sweep extended the initial `C=8` run to `{4,8,16}`; acceptance thresholds
were unchanged. This is exploratory search, not sensitivity proof for a selected
production constant.

For a band `[L,H]` and evidence `E_c`, each scenario gives
`logit(L/100)+b*PV_c-E_c ≤ a ≤ logit(H/100)+b*PV_c-E_c`, omitting an endpoint
when L=0 or H=100. Intersect these bounds across each anchor's countries and
then intersect with the disclosed grid box. Chronic/full-war constraints include
all 31 countries, including the largest populations and lowest-prior cases.
Quiet/riot/strike use the exact seven stable-OECD countries and unchanged input
magnitudes from the suite. Context inputs in those scenarios do not score.

Even before fitting, equal riot/strike evidence across the seven countries
bounds `b`: their PV range is 1.5606698. The riot latent band has width
`logit(.55)-logit(.35)=0.8197`, so `b≤0.5253`; the strike band gives the same
bound. A proposed `b=0.8` cannot meet both ends without changing these scenarios.
The quiet band also requires `a ≤ logit(.15)+b*min(PV_OECD)`.

## Measurements

All anchor-feasible points were screened for P1 (three scored channels, both
strike-feed settings), P2 (latent and existing rounded/clamped logit), P5b and
the GPI rule. Headline response is exactly zero by design and needs OQ1.
A point that fails this subset already cannot pass the full exit bar; P3,
P5a/c, P7, P8 and located P9 are not claimed to pass.

A representative is chosen among anchor-feasible points by the lowest disclosed
failure cost: P1 failure count + 100 times each excess P2 range + 10 times each
excess integer P5b count + 100 times each benchmark shortfall. This ranking
selects a diagnostic example, not a production recommendation.

| Shape / merge / UCDP | Anchor-feasible grid points | Exit subset feasible | P1 failures / cases | P2 latent / rounded range | Largest integer band counts by fixture |
|---|---:|---:|---:|---:|---|
| linear / max / percap | 160 | 0 | 44/360 | 0.200 / 0.275 | 11, 11, 11 |
| linear / max / combined | 382 | 0 | 56/396 | 0.200 / 0.275 | 10, 10, 10 |
| linear / union / percap | 145 | 0 | 1/360 | 0.080 / 0.166 | 11, 11, 11 |
| linear / union / combined | 351 | 0 | 9/414 | 0.100 / 0.166 | 10, 10, 10 |
| saturating / max / percap | 156 | 0 | 52/378 | 0.294 / 0.356 | 10, 10, 10 |
| saturating / max / combined | 424 | 0 | 53/396 | 0.294 / 0.382 | 10, 10, 9 |
| saturating / union / percap | 151 | 0 | 8/375 | 0.080 / 0.193 | 10, 10, 10 |
| saturating / union / combined | 419 | 0 | 4/387 | 0.198 / 0.309 | 10, 10, 10 |

The maximum permitted band count is 7. Continuous band counts are also reported below; rounding does not explain the clustering.

### linear/max/percap

Parameters: `a=-1.8, b=0.2, ks=0.04, ku=8, kg=2, C=8`. At these other parameters, the anchor intersection for a is [-1.822742, -1.795017].

P15 ranges (continuous scores): quiet 11.39–14.94; riot 40.17–47.84; strike 45.56–53.35; chronic 85.16–99.88; war 99.74–99.88.

P1 with strike feed present: 22/180 failures; absent: 22/180.

Continuous P5b counts: 11, 11, 11. P13a shares: 6.96%, -1.13%, -1.19%. GPI rho: 0.8145, 0.8109, 0.8137.

Illustrative OQ4 variant with a constant 25 weighted deaths per million per year: chronic range 99.74–99.88. This changes the scenario and is not an acceptance pass.

### linear/max/combined

Parameters: `a=-1.8, b=0.2, ks=0.04, ku=4, kg=2, C=8`. At these other parameters, the anchor intersection for a is [-1.822742, -1.795017].

P15 ranges (continuous scores): quiet 11.39–14.94; riot 40.17–47.84; strike 45.56–53.35; chronic 99.44–99.88; war 99.74–99.88.

P1 with strike feed present: 28/198 failures; absent: 28/198.

Continuous P5b counts: 10, 10, 10. P13a shares: 6.12%, -1.93%, -1.99%. GPI rho: 0.7972, 0.7984, 0.8008.

Illustrative OQ4 variant with a constant 25 weighted deaths per million per year: chronic range 99.74–99.88. This changes the scenario and is not an acceptance pass.

### linear/union/percap

Parameters: `a=-1.8, b=0.2, ks=0.02, ku=8, kg=2, C=16`. At these other parameters, the anchor intersection for a is [-1.824216, -1.795017].

P15 ranges (continuous scores): quiet 11.39–14.94; riot 40.17–47.84; strike 45.60–53.39; chronic 85.16–100.00; war 100.00–100.00.

P1 with strike feed present: 1/180 failures; absent: 0/180.

Continuous P5b counts: 11, 11, 11. P13a shares: 7.14%, -0.74%, -0.77%. GPI rho: 0.8085, 0.8085, 0.8065.

Illustrative OQ4 variant with a constant 25 weighted deaths per million per year: chronic range 100.00–100.00. This changes the scenario and is not an acceptance pass.

### linear/union/combined

Parameters: `a=-1.8, b=0.2, ks=0.02, ku=2, kg=2, C=16`. At these other parameters, the anchor intersection for a is [-1.824216, -1.795017].

P15 ranges (continuous scores): quiet 11.39–14.94; riot 40.17–47.84; strike 45.60–53.39; chronic 84.34–100.00; war 100.00–100.00.

P1 with strike feed present: 5/207 failures; absent: 4/207.

Continuous P5b counts: 10, 10, 10. P13a shares: 9.26%, 4.21%, 4.24%. GPI rho: 0.8117, 0.8077, 0.8040.

Illustrative OQ4 variant with a constant 25 weighted deaths per million per year: chronic range 99.32–100.00. This changes the scenario and is not an acceptance pass.

### saturating/max/percap

Parameters: `a=-2, b=0.2, ks=0.06, ku=8, kg=3, C=8`. At these other parameters, the anchor intersection for a is [-2.016352, -1.992094].

P15 ranges (continuous scores): quiet 9.52–12.57; riot 47.02–54.80; strike 52.95–60.60; chronic 70.34–99.80; war 99.65–99.85.

P1 with strike feed present: 26/189 failures; absent: 26/189.

Continuous P5b counts: 10, 10, 10. P13a shares: 6.10%, -2.18%, -2.29%. GPI rho: 0.8016, 0.8250, 0.8230.

Illustrative OQ4 variant with a constant 25 weighted deaths per million per year: chronic range 99.57–99.80. This changes the scenario and is not an acceptance pass.

### saturating/max/combined

Parameters: `a=-2.1, b=0.3, ks=0.06, ku=4, kg=3, C=8`. At these other parameters, the anchor intersection for a is [-2.193113, -2.022302].

P15 ranges (continuous scores): quiet 7.74–11.82; riot 41.45–53.07; strike 47.31–58.92; chronic 92.75–99.73; war 99.58–99.87.

P1 with strike feed present: 27/198 failures; absent: 26/198.

Continuous P5b counts: 10, 10, 10. P13a shares: 4.38%, -1.05%, -1.08%. GPI rho: 0.8238, 0.8323, 0.8298.

Illustrative OQ4 variant with a constant 25 weighted deaths per million per year: chronic range 98.51–99.79. This changes the scenario and is not an acceptance pass.

### saturating/union/percap

Parameters: `a=-2, b=0.2, ks=0.02, ku=8, kg=3, C=8`. At these other parameters, the anchor intersection for a is [-2.016352, -1.992094].

P15 ranges (continuous scores): quiet 9.52–12.57; riot 47.02–54.80; strike 46.14–53.93; chronic 70.34–99.80; war 99.68–99.85.

P1 with strike feed present: 4/186 failures; absent: 4/189.

Continuous P5b counts: 11, 10, 10. P13a shares: 6.89%, -1.48%, -1.52%. GPI rho: 0.8016, 0.8206, 0.8177.

Illustrative OQ4 variant with a constant 25 weighted deaths per million per year: chronic range 99.57–99.80. This changes the scenario and is not an acceptance pass.

### saturating/union/combined

Parameters: `a=-2.3, b=0.3, ks=0.04, ku=4, kg=3, C=8`. At these other parameters, the anchor intersection for a is [-2.373811, -2.221048].

P15 ranges (continuous scores): quiet 6.43–9.89; riot 36.70–48.08; strike 51.80–63.18; chronic 91.28–99.67; war 99.51–99.84.

P1 with strike feed present: 2/192 failures; absent: 2/195.

Continuous P5b counts: 10, 10, 10. P13a shares: 8.47%, 1.20%, 1.22%. GPI rho: 0.8149, 0.8222, 0.8230.

Illustrative OQ4 variant with a constant 25 weighted deaths per million per year: chronic range 98.19–99.74. This changes the scenario and is not an acceptance pass.

## P13a and benchmark interpretation

For P13a, remove under-30-day UCDP rows and current strike, GDELT, outage and
OREF evidence, then compute `Cov(S-B,S)/Var(S)` with no clipping. The negative
shares are valid: recent evidence can reduce the cross-country separation
created by older evidence. All representatives miss the registered 50% target.
This does not prove predictive correlation with future outcomes.

For released v14, the same counterfactual also removes its current news,
threat, instrument, temporal and cross-border-surge inputs. Undated structural
stocks/advisories remain in B; the fixtures cannot attribute their observation
age, so this is an explicit study convention, not precise event-age provenance.
Released v14 shares: -14.89%, -7.37%, -7.71%.

Released v14 GPI rho: 0.7567, 0.7354, 0.7249. Every representative exceeds 0.75 and does not drop more than 0.02 from v14; benchmark agreement alone does not establish a usable score.

## Proposed owner rulings and exact amendments

These are proposals. No owner ruling is recorded yet.

- **OQ1:** Amend P1 to “Each scored family responds to its evidence; changing
  headline counts leaves the score unchanged and may change context.” Replace
  the information injection with a zero-score-response assertion. This resolves
  the direct conflict with context-only news; it does not waive any scored-family
  responsiveness failure above.
- **OQ2:** Amend P6's merge wording to “Deduplicate observations of the same
  incident; distinct evidence members may use a bounded union that is monotone
  in every unsaturated member and never exceeds their sum.” Plain max has an
  analytic zero derivative for every dominated member. Bounded union improves
  P1 but the tested forms still fail the exit subset; it is not a selected formula.
- **OQ3:** Amend P14 to “S equals 100*sigmoid(z_prior + emitted evidence terms)
  within rounding tolerance 0.5.” Amend P5c to compare countries whose emitted
  evidence and prior both dominate the other country's. Keep the existing
  numeric tolerance and zero-reversal requirement.
- **OQ4:** Do not change P15d or select a combined absolute term yet. Both
  normalisation variants can meet the unchanged chronic anchor within this
  search; both still fail the complete screening subset. A per-capita scenario
  can make that anchor easier without fixing score-band collapse. First decide
  whether an absolute component is consistent with P10 and continue design
  research under the unchanged must-pass tests.

Recommendation: accept the semantic corrections in OQ1–3 if they match the
product intent, retain the existing P15d scenario for now, and reject all eight
representatives as production candidates. Continue the feasibility search before
U4. Do not remove P5b/P15d blockers, weaken the integer parity test, tune a named
country, add a floor or raise an amplitude to bypass this result.

The owner must supply the rulings. Independent methodology review is still
required and has not occurred. U3, U16 and U10 remain separate main-targeted
PRs; deployment and the located/37-target production captures remain gated.
