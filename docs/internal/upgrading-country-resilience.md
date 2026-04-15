I reviewed the live product surface, the public docs, and the public repo trail. Verdict: strong work, not world class yet. I rate the current country resilience work **7.4/10**. ([World Monitor][1])

This is real work, not a cosmetic score. The resilience service exposes country score and ranking endpoints with overall score, domain breakdowns, trend, 30-day change, baseline score, stress score, imputation share, low-confidence flag, optional score intervals, greyed-out low-coverage countries, and rank-stability flags. Underneath that, the model scores **13 dimensions across 5 weighted domains**, and the recent delivery path covered handlers, static seeding, a client wrapper, a widget, and a choropleth map layer. ([GitHub][2])

The strongest part is the architecture. The model already separates structural baseline from live stress. It tracks coverage and imputation explicitly instead of hiding missing data. It seeds country snapshots from **11 data slots**, runs smoke checks against live sources, keeps six-hour score and ranking caches, persists daily history points, and warms missing countries in the ranking path in a way sized to cover the full static index in one cold pass. The test surface also looks serious: scorer-ordering tests, edge-case energy tests, handler tests, ranking tests, and shared statistical utilities such as Cronbach’s alpha, trend detection, changepoint detection, and forecasting. ([GitHub][3])

What keeps it below top tier is methodology. The resilience material I found is mostly code, API schema, issues, and implementation notes. World Monitor already gives the Country Instability Index a full public methodology page with formulas and bias handling. The reference standard for composite country indices from OECD/JRC puts heavy weight on transparent framework design, component selection, source quality, and country-ranking method. INFORM, ND-GAIN, WorldRiskIndex, and the Fragile States Index also publish clear conceptual structures and indicator logic. World-class indices win on method and auditability, not just on code quality. ([GitHub][4])

The second gap is calibration. The resilience model uses fixed domain weights, simple score bands, and explicit absence-based imputations. That is a practical way to get global coverage. It is not enough for a reference-grade index until the team publishes sensitivity tests and benchmark error. The border-security bug from April 4, 2026 shows the problem clearly: Norway and the US both hit 100 under current fixtures, which broke the intended ordering and exposed a ceiling effect at the top end of the ranking. ([GitHub][3])

The third gap is conceptual completeness. The current design is strong on readiness and current stress. It does **not** expose hazard exposure and recovery capacity as first-class top-level pillars. INFORM centers hazard, vulnerability, and coping capacity. ND-GAIN centers vulnerability and readiness. WorldRiskIndex separates exposure from societal vulnerability. The current World Monitor structure reads as a strong readiness-plus-stress model, not yet a full resilience model. Confidence also stays too coarse in the product surface: the API tracks coverage, imputation share, and optional score intervals, yet the widget reduces that mostly to a single confidence label. ([GitHub][2])

My scorecard:

Architecture: **8.5/10**
Data breadth: **8.0/10**
Engineering and productization: **8.5/10**
Methodological rigor: **6.0/10**
Validation and backtesting: **5.5/10**
Explainability: **6.5/10**
Overall: **7.4/10**

To make it world class, I would do six things.

**1. Publish a real methodology pack.**
Give resilience the same treatment CII already gets. Publish the conceptual model, all 13 dimensions, formulas, weight rationale, normalization ranges, missing-data rules, source recency, interval method, and a versioned change log. Build it to OECD/JRC standards. ([GitHub][4])

**2. Rebuild the top layer into three scores.**
Expose **structural readiness**, **live shock exposure**, and **recovery capacity**. Keep the current baseline and stress machinery underneath. Add recovery as its own pillar. That puts the model much closer to INFORM, ND-GAIN, and WorldRiskIndex and makes the product easier to reason about. ([DRMKC][5])

**3. Add a benchmark and backtest suite.**
Run country-by-country correlations and outlier analysis against INFORM, ND-GAIN, WorldRiskIndex, and FSI. Then backtest against real outcomes: FX stress, sovereign stress, prolonged power outages, food-crisis escalation, refugee surges, sanctions shocks, and conflict spillover. Put every major weight and imputation rule through sensitivity analysis. ([DRMKC][5])

**4. Replace binary confidence with decomposed uncertainty.**
Show per-dimension coverage, imputation share, source freshness, interval width, and rank stability. Compute intervals from bootstrap or Monte Carlo perturbations on weights and missing-data choices. The current fields are a good base. They are not enough for a reference-grade index. ([GitHub][2])

**5. Deepen the data model where resilience actually breaks.**
Add fiscal space, reserve adequacy, short-term external debt coverage, import concentration, fuel-stock days, grid reliability, telecom redundancy, hospital surge capacity, and state continuity metrics. Rework absence-based imputations into four classes: stable absence, unmonitored, source failure, and not applicable. Fix top-end ceiling effects across all dimensions, starting with border security. For the information/cognitive dimension, normalize social-velocity and threat inputs by language and source density. Right now that dimension blends RSF, social velocity, and threat summary, which invites coverage bias unless you calibrate hard. ([GitHub][6])

**6. Make the product explanatory.**
Show why the score moved in the last 7 and 30 days. Add a waterfall from dimension to domain to total score. Show peer-country comparisons. Surface freshness badges next to every dimension. Let users toggle structural resilience, current stress, and recovery capacity. That turns the feature from a score into an analyst tool. ([GitHub][7])

My 90-day plan would be simple. Month one: publish the methodology paper, indicator registry, and source-recency badges, then fix ceiling bugs and ship dimension-level confidence. Month two: build the benchmark suite, run sensitivity tests, and add a recovery-capacity pillar. Month three: ship change attribution, peer comparison, bootstrapped intervals, and an external expert review.

Do that, and this becomes a reference-grade country resilience product. Skip it, and it stays a strong feature inside a broader intelligence platform.

[1]: https://www.worldmonitor.app/?lat=20.0000&layers=conflicts%2Cbases%2Chotspots%2Cnuclear%2Csanctions%2Cweather%2Ceconomic%2Cwaterways%2Coutages%2Cmilitary%2Cnatural%2CiranAttacks&lon=0.0000&timeRange=7d&view=global&zoom=1.00 "https://www.worldmonitor.app/?lat=20.0000&layers=conflicts%2Cbases%2Chotspots%2Cnuclear%2Csanctions%2Cweather%2Ceconomic%2Cwaterways%2Coutages%2Cmilitary%2Cnatural%2CiranAttacks&lon=0.0000&timeRange=7d&view=global&zoom=1.00"
[2]: https://raw.githubusercontent.com/koala73/worldmonitor/main/docs/api/ResilienceService.openapi.yaml "https://raw.githubusercontent.com/koala73/worldmonitor/main/docs/api/ResilienceService.openapi.yaml"
[3]: https://raw.githubusercontent.com/koala73/worldmonitor/main/server/worldmonitor/resilience/v1/_dimension-scorers.ts "https://raw.githubusercontent.com/koala73/worldmonitor/main/server/worldmonitor/resilience/v1/_dimension-scorers.ts"
[4]: https://github.com/koala73/worldmonitor/blob/main/docs/country-instability-index.mdx "https://github.com/koala73/worldmonitor/blob/main/docs/country-instability-index.mdx"
[5]: https://drmkc.jrc.ec.europa.eu/inform-index/INFORM-Risk/Methodology "https://drmkc.jrc.ec.europa.eu/inform-index/INFORM-Risk/Methodology"
[6]: https://raw.githubusercontent.com/koala73/worldmonitor/main/scripts/seed-resilience-static.mjs "https://raw.githubusercontent.com/koala73/worldmonitor/main/scripts/seed-resilience-static.mjs"
[7]: https://raw.githubusercontent.com/koala73/worldmonitor/main/src/components/ResilienceWidget.ts "https://raw.githubusercontent.com/koala73/worldmonitor/main/src/components/ResilienceWidget.ts"

## Editor's Note: Changelog (2026-04-11)

The original text of this review, above, is preserved as written. The
notes below are appended amendments, not edits, so the record of the
review as originally filed stays auditable.

### T1.1 investigation outcome (not reproduced)

The review states above that "Norway and the US both hit 100 under
current fixtures, which broke the intended ordering and exposed a
ceiling effect at the top end of the ranking." Phase 1 task T1.1 of
the implementation plan committed to reproducing this claim with a
failing regression test before any fix landed. The investigation was
completed on 2026-04-11 and is published as a regression test on
PR #2941 (`tests/resilience-release-gate.test.mts`, the
`T1.1 regression: Norway and US do not both pin at 100` test case).

The claim does NOT reproduce. Measured scores under the current
release-gate fixtures and the post-PR-#2847 domain-weighted-average
formula:

- Norway (elite tier):  overallScore = 86.58, baseline 86.85, stress 84.36
- US (strong tier):     overallScore = 72.80, baseline 73.15, stress 70.58
- Delta:                NO minus US = 13.78 points
- Ceiling:              neither country approaches 100; the
  domain-weighted sum cannot reach 100 without every dimension
  saturating, which does not happen for any fixture tier.

The ordering elite > strong > stressed > fragile is preserved, and
there is no hard 100 ceiling in `_dimension-scorers.ts`. The original
symptom is therefore misattributed or stale: it likely predates
PR #2847's revert of the multiplicative `baseline * (1 - stressFactor)`
formula that had been over-penalizing every country, or references an
older fixture set. The underlying scorecard section ("Methodological
rigor: 6.0/10", "Validation and backtesting: 5.5/10") and the six
prescribed improvements remain valid; only the specific Norway=US=100
illustration is retracted.

The regression test itself is kept in the release-gate suite so a
real top-of-ranking ceiling bug, if one is ever introduced in the
future, is caught immediately by CI instead of being rediscovered by
another reviewer.

### Side finding: release-gate fixture same-tier collisions

During the T1.1 investigation the release-gate fixtures were found
to use a single `qualityFor(profile)` value per tier, so every
country inside an `elite`, `strong`, `stressed`, or `fragile` tier
produces byte-identical scores. This is not a scorer bug; it is a
fixture-design limitation that makes the release-gate suite unable
to detect within-tier ordering regressions. Diversifying the
fixtures along a real-world axis (e.g. sampling each tier from the
live indicator registry) is a follow-up for Phase 2 validation work
and is not in scope for Phase 1.

### Plan tracking

The full Phase 1 through Phase 3 build is tracked in the reference-
grade upgrade plan at `docs/internal/country-resilience-upgrade-plan.md`,
landed alongside this review in the same PR.


