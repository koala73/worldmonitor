---
title: Upgrade Country Resilience to Reference-Grade Index
type: feat
status: active
date: 2026-04-11
origin: docs/internal/upgrading-country-resilience.md
---

# Upgrade Country Resilience to Reference-Grade Index

## Overview

Current Country Resilience is rated **7.4/10** by the internal review in
`docs/internal/upgrading-country-resilience.md`. The architecture, data breadth,
and engineering are already strong (8.0–8.5). What keeps it below reference
grade is **methodology rigor (6.0), validation/backtesting (5.5), and
explainability (6.5)**. This plan executes the six improvements prescribed in
the origin document and targets a scorecard of **≥9.0 overall** across all six
axes, with public methodology and independently verifiable numbers.

Concretely the upgrade rebuilds the top-level shape of the index into three
pillars (structural readiness, live shock exposure, recovery capacity), ships a
published methodology pack at parity with the Country Instability Index,
introduces a cross-index benchmark + backtest suite, replaces the binary
`lowConfidence` flag with a decomposed uncertainty surface, deepens the data
model on the dimensions where resilience actually breaks, and turns the widget
from a number into an analyst tool with waterfall explanations and peer
comparison.

## Construct Memo

Before any code, this plan commits to a one-page construct definition so the
index cannot be re-argued dimension by dimension later. (Review gap: *"the
construct is still not frozen"*.)

**What resilience means here.** The ability of a country to (a) absorb a
contemporary shock across economic, infrastructural, energy, social-governance,
and health-food channels, (b) continue delivering core state functions under
that shock, and (c) recover along a trajectory measurable within a 90-day to
24-month window. This is explicitly **not** climate resilience (ND-GAIN's
territory) or humanitarian crisis risk (INFORM's territory). It is **current
system robustness under acute stress**.

**Horizon.** Structural readiness is slow-moving (annual to 3-year). Live
shock exposure is fast-moving (daily to weekly). Recovery capacity is
medium-moving (quarterly). These horizons are enforced at seed time: each
signal is tagged with its native cadence and cannot contribute to a pillar
whose horizon it violates without explicit justification in the methodology.

**For whom.** Primary audience: intelligence analysts and operators making
country-level decisions over a 1–12 month window. Secondary audience: policy
researchers and external indices that may cite us. The widget is designed for
the primary audience; the methodology page is designed for the secondary.

**Polarity.** Higher score = more resilient. Every dimension's native polarity
is declared in the indicator registry with direction (`higher-better` /
`lower-better`) and goalposts (min, max). Sign flips like the RSF inversion
bug (PR #2847) are prevented by a build-time lint that reads the registry and
fails the build if a scorer disagrees with the declared direction.

**Aggregation philosophy, partly non-compensatory.**

- **Within a pillar:** coverage-weighted arithmetic mean of domains. Keeps
  today's fast-compute + imputation-aware path. Appropriate because
  dimensions inside a pillar are partially substitutable (multiple paths to
  the same capability).
- **Across pillars:** **penalized weighted mean**
  `Overall = (w_s·S + w_l·L + w_r·R) · penaltyFactor`
  where `penaltyFactor = 1 − α · max(0, (pillarMax − pillarMin) / 100)` and
  `α` is tuned on backtest. At α=0 this collapses to today's arithmetic mean.
  At α=1 a country with a 50-point gap between its strongest and weakest
  pillar loses half its overall score. INFORM uses multiplication;
  WorldRiskIndex uses the geometric mean of exposure × vulnerability. Both
  choices exist to prevent a country with severe exposure from washing that
  away with one strong institutional score. We adopt the same philosophy with
  a tunable α so the calibration team can pick the operating point from
  backtest + sensitivity evidence.
- **Why not pure geometric mean across pillars?** Geometric mean collapses
  toward zero when any pillar is low, which is brittle under imputation and
  under the `unmonitored` class. Penalized weighted mean degrades gracefully
  and stays interpretable on the widget.

**What this commits the plan to.** Tasks T2.1 and T2.3 ship the penalized
weighted mean as the v2.0 aggregation. Phase 2 sensitivity (T2.6) includes
α in `{0, 0.25, 0.5, 0.75, 1}` as a perturbation axis and publishes the
curve; the chosen α is documented in the methodology changelog with the
backtest evidence that justified it.

## Product Split: Reference Edition vs Live Monitor

The upgrade ships **two products**, not one, because citation-grade
reproducibility and real-time operational monitoring pull in opposite
directions. INFORM, ND-GAIN, WorldRiskIndex, and FSI all ship editioned
releases for exactly this reason. (Review gap: *"the plan tries to ship a
citation-grade index and a live operational monitor as one object"*.)

**Annual Reference Edition**, e.g., "Country Resilience Index 2026".
- Inputs frozen as of a cut date.
- Scores and ranks fixed for 12 months.
- Methodology locked to a specific version string.
- Snapshot manifest: SHA-pinned Redis dump + commit SHA of the scorer code
  + retrieval date + URL + SHA of every third-party file used.
- Reproducibility notebook under
  `docs/methodology/country-resilience-index/reference-edition/2026/reproduce.ipynb`
  that regenerates every published number from the manifest.
- Published as signed JSON + CSV + methodology PDF.
- **This is what external citations point at.**

**Live Monitor**, the continuation of today's product surface.
- Rolls forward every 6 hours (today's cache TTL).
- Shows stress, freshness, deltas, and waterfall **relative to the current
  Reference Edition baseline**.
- May use Experimental-tier signals not yet in the reference edition's core
  tier.
- Rank changes in the Live Monitor are advisory; they are **not** a revision
  of the Reference Edition until the next annual cut.

**Phase mapping.** Phase 1 ships the methodology page and fixes; Phase 2
ships the three-pillar rebuild + signal tiering + snapshot/reproducibility
tooling; Phase 3 ships the explanatory product + the first cut of the 2026
Reference Edition. The Live Monitor is the continuation of today's product
and never loses coverage during the transition.

## Origin & Source Decisions

**Origin document:** [`docs/internal/upgrading-country-resilience.md`](./upgrading-country-resilience.md)

Key decisions carried forward verbatim from the origin (see origin for full
rationale):

1. **Scorecard baseline:** Architecture 8.5, Data 8.0, Engineering 8.5,
   Methodology 6.0, Validation 5.5, Explainability 6.5 → overall 7.4.
   **Target:** lift every axis to ≥9.0 (see origin: "My scorecard").
2. **Top layer rebuilt into three pillars**, structural readiness, live shock
   exposure, recovery capacity. Keep the current baseline/stress machinery
   underneath but expose recovery capacity as its own first-class pillar
   (see origin: "2. Rebuild the top layer into three scores").
3. **Methodology pack at CII parity**, conceptual model, all dimensions,
   formulas, weight rationale, normalization ranges, missing-data rules,
   source recency, interval method, versioned changelog, built to OECD/JRC
   standards (see origin: "1. Publish a real methodology pack").
4. **Cross-index benchmark + real-outcome backtest**, correlate against
   INFORM, ND-GAIN, WorldRiskIndex, FSI; backtest against FX stress, sovereign
   stress, prolonged power outages, food-crisis escalation, refugee surges,
   sanctions shocks, and conflict spillover; sensitivity-test every major
   weight and imputation rule (see origin: "3. Add a benchmark and backtest
   suite").
5. **Decomposed uncertainty**, replace the single `lowConfidence` label with
   per-dimension coverage, imputation share, source freshness, interval width,
   and rank stability; intervals from bootstrap or Monte Carlo perturbations on
   weights and missing-data choices (see origin: "4. Replace binary confidence
   with decomposed uncertainty").
6. **Deepen the data model where resilience actually breaks**, add fiscal
   space, reserve adequacy, short-term external debt coverage, import
   concentration, fuel-stock days, grid reliability, telecom redundancy,
   hospital surge capacity, state continuity metrics; rework absence-based
   imputations into four explicit classes (stable absence / unmonitored /
   source failure / not applicable); fix top-end ceiling effects starting with
   border security; normalize information-dimension inputs by language and
   source density (see origin: "5. Deepen the data model where resilience
   actually breaks").
7. **Explanatory product**, waterfall from dimension → domain → total,
   peer-country comparison, freshness badges on every dimension, 7d/30d change
   attribution, and a toggle between structural resilience / current stress /
   recovery capacity (see origin: "6. Make the product explanatory").

**90-day cadence (from origin, adopted verbatim as Phases 1–3 below):**
- Month 1, methodology paper, indicator registry, source-recency badges; fix
  ceiling bugs; ship dimension-level confidence.
- Month 2, benchmark suite, sensitivity tests, recovery-capacity pillar.
- Month 3, change attribution, peer comparison, bootstrapped intervals,
  external expert review.

## Problem Statement

**The current resilience product is strong engineering on an under-documented
model.** Three specific gaps keep it below reference grade:

1. **Methodological opacity.** The only public artifacts are code, the OpenAPI
   schema, GitHub issues, and implementation notes. There is no public
   methodology page at CII parity. OECD/JRC reference standards for composite
   country indices require transparent framework design, component selection,
   source quality documentation, and an auditable country-ranking method.
   Without this, external analysts cannot reproduce, challenge, or cite the
   score, which is the bar for a reference-grade index.
2. **Under-calibration.** Fixed domain weights, simple score bands, and
   absence-based imputations work for global coverage but are not enough
   without published sensitivity tests and benchmark error. The origin doc
   points at a concrete symptom: a border-security bug from 2026-04-04 where
   Norway and the US both hit 100, exposing a ceiling effect at the top end of
   the ranking. **Repo research (see Research Findings → Discrepancy) did not
   reproduce a hard-100 ceiling in the current scorers, Phase 1 begins with
   verifying the exact shape of that bug before fixing it.**
3. **Conceptual incompleteness.** The current structure is strong on readiness
   and current stress but does not expose hazard exposure and recovery
   capacity as first-class top-level pillars. INFORM centers
   hazard/vulnerability/coping capacity. ND-GAIN centers vulnerability and
   readiness. WorldRiskIndex separates exposure from societal vulnerability.
   Today's WorldMonitor resilience reads as a "readiness-plus-stress" model,
   not a full resilience model. Confidence is also collapsed: the API exposes
   coverage, imputation share, and optional score intervals, but the widget
   reduces all of it to a single label.

## Proposed Solution

Execute the origin document's six improvements as three sequential phases
over ~90 days, building on the existing v3/v4/v5 roadmap and on the already-
shipped formula/direction fixes (PRs #2821, #2847, #2858). Each phase lands
behind a feature flag, ships with acceptance tests, and produces a publishable
changelog entry in `docs/methodology/country-resilience-index.mdx`.

**Phase 1, Transparency & Calibration Fixes** (methodology pack + ceiling
bugs + dimension-level confidence). This phase is mostly already scoped by
existing plans (`2026-04-07-002`, `2026-04-09-001`), this plan's job is to
finish it to origin-doc quality, not to redo it.

**Phase 2, Structural Rebuild** (three pillars incl. recovery capacity,
cross-index benchmark, sensitivity suite, new indicators).

**Phase 3, Explanatory Product** (waterfall, peer comparison, bootstrapped
intervals, change attribution, external expert review).

## Research Findings

### Current resilience implementation (summary)

- **13 dimensions across 5 weighted domains**, final aggregation is a
  domain-weighted average. Domain weights today: economic 0.22, infrastructure
  0.20, energy 0.15, social-governance 0.25, health-food 0.18.
  Source: `server/worldmonitor/resilience/v1/_dimension-scorers.ts`,
  `server/worldmonitor/resilience/v1/_shared.ts:~200`.
- **RPC handlers:** `GetResilienceScore(countryCode)` and
  `GetResilienceRanking()` under
  `server/worldmonitor/resilience/v1/{get-resilience-score.ts, get-resilience-ranking.ts, handler.ts}`.
- **Cache keys** (all in `_shared.ts`): `resilience:score:v7:<cc>` (6h),
  `resilience:ranking:v8` (6h, written only when all countries scored),
  `resilience:history:v4:<cc>` (daily sorted set, 30-day retention),
  `resilience:intervals:v1:<cc>` (95% CI from backtest).
- **Warmup:** handler-owned, up to 200 missing countries per ranking request
  via `warmMissingResilienceScores()` in `get-resilience-ranking.ts`.
- **Static seeding**, 11 slots in `scripts/seed-resilience-static.mjs` (WGI,
  infrastructure, GPI, RSF, WHO, FAO, Aquastat, IEA, TradeToGDP, FXReserves,
  AppliedTariffRate) with 400-day TTL, version `resilience-static-v7`, lock
  domain `resilience:static`.
- **Backtest + validation scripts already exist:**
  `scripts/seed-resilience-intervals.mjs`,
  `scripts/validate-resilience-backtest.mjs`,
  `scripts/validate-resilience-correlation.mjs`,
  `scripts/validate-resilience-sensitivity.mjs`. Phase 2's benchmark suite
  extends these, it does not replace them.
- **Statistical utilities** (reusable, pure functions) in
  `server/_shared/resilience-stats.ts`: `minMaxNormalize`, `cronbachAlpha`,
  `detectTrend`, `detectChangepoints` (CUSUM), `exponentialSmoothing`,
  `nrcForecast`.
- **Confidence surfaces today** (schema): `coverage`, `observedWeight`,
  `imputedWeight` per dimension; `lowConfidence` (bool), `imputationShare`
  (0–1), optional `scoreInterval {p05, p95}` on the top-level response. The
  widget collapses this to a single "Low confidence" label via
  `src/components/resilience-widget-utils.ts:formatResilienceConfidence`.
- **Methodology draft already in repo:** `docs/methodology/resilience-index.md`
  (5 domains, 13 dimensions, ~46 sub-metrics with sources, direction,
  goalposts, weights, cadence + missing-data imputation taxonomy). Phase 1
  promotes this to `.mdx` at CII parity.

### Related prior work (build on, don't redo)

- `docs/plans/2026-03-29-feat-country-resilience-score-plan.md`, original
  v1 implementation plan.
- `docs/plans/2026-04-07-002-fix-resilience-v3-phase1-coverage-correctness-plan.md`
 , three calibration bugs: zero-event feeds awarding 100, WTO absence as
  no-barriers, Cronbach alpha misused as formative-index confidence metric.
- `docs/plans/2026-04-09-001-fix-resilience-overall-score-formula-plan.md`
 , revert multiplicative formula `baseline * (1 - stressFactor)` to
  domain-weighted average; fix RSF press-freedom direction (0=free is good,
  currently scored higher-better). Most of Phase 1 inherits this.
- PR #2821: baseline/stress engine (added `data_version` field, never
  populated, Phase 1 wires this).
- PR #2769: scoring calibration (GPI anchor, inflation cap, gov revenue).
- PR #2847: formula revert + RSF direction fix.
- PR #2858: seed direct scoring.

### AGENTS.md conventions (must follow)

- **New RPCs:** define message in `proto/worldmonitor/<domain>/`, add RPC with
  `(sebuf.http.config)` annotation, `make generate`, create handler in
  `server/worldmonitor/<domain>/`, wire in domain's `handler.ts`, use
  `cachedFetchJson()` with request-varying params in the cache key.
- **4-file bootstrap wiring** for any new globally-bootstrapped RPC:
  `server/_shared/cache-keys.ts`, `api/bootstrap.js`, `api/health.js`
  (`SEED_META` registry, not `SEED_DOMAINS`), `server/_shared/gateway.ts`.
- **Edge functions** (`api/*.js`) are self-contained JS only; cannot import
  from `src/` or `server/`. Enforced by `tests/edge-functions.test.mjs` +
  pre-push esbuild check.
- **World coverage is non-negotiable**, no country subsets, no
  `MAJOR_REPORTERS`-style allowlists (repo memory: "world_coverage_never_subset").
- **Type safety**, JSDoc + `@ts-check` for `.mjs`, strict TS for `.ts`,
  `.types.d.ts` for shared shapes.

### Discrepancy to verify in Phase 1

The origin document states: *"Norway and the US both hit 100 under current
fixtures, which broke the intended ordering and exposed a ceiling effect at
the top end of the ranking."* Repo research did **not** find a hard 100 ceiling
in `_dimension-scorers.ts`, scores are `roundScore(clamp(value, 0, 100))` and
border-security uses a UCDP conflict metric + UNHCR displacement imputation at
85, neither of which produces a forced 100. The closest matching symptom in
the existing plans is the formula bug in `2026-04-09-001` (which
over-penalized rather than over-saturated) and the zero-event bias in
`2026-04-07-002` (which *does* cause untracked countries to appear perfect
but in the lower-impact cyber/outage dimensions). **Phase 1 task T1.1 is:
reproduce the exact ceiling scenario the origin doc references and write a
regression test before fixing it.** If it is the zero-event bias that was
misattributed to border security, update the origin doc's changelog entry to
reflect the true root cause.

### Out-of-scope for research, but relevant

- OECD/JRC Handbook on Composite Indicators (standard for "publishable"
  methodology).
- INFORM Risk Methodology, ND-GAIN technical documentation, WorldRiskIndex
  (Bündnis Entwicklung Hilft), Fragile States Index (FFP), source material
  for Phase 2 benchmark correlation targets and for the three-pillar rebuild.

## Technical Approach

### Architecture target

**Three top-level pillars** replace today's single `overallScore` as the
primary reporting shape:

```
StructuralReadiness  = f(baseline dimensions)   # long-run capacity
LiveShockExposure    = f(stress dimensions)     # current pressure
RecoveryCapacity     = f(new recovery dims)     # ability to absorb + rebound
OverallResilience    = weighted combine of the three pillars
```

The current 5 domains × 13 dimensions are preserved and regrouped under the
three pillars. Recovery capacity is a **new** pillar composed of:

- Fiscal space (gov debt / GDP, deficit, primary balance, reserve coverage)
- Reserve adequacy (FX reserves months of imports, short-term external debt
  coverage ratio)
- Hospital surge capacity (beds/10k + ICU capacity + health expenditure
  floor)
- Telecom redundancy (submarine cable count, peering points, national IXP
  presence)
- Grid reliability (SAIDI/SAIFI where published, generation mix diversity,
  `fuel-stock days`)
- State continuity (governance effectiveness anchor + conflict-zone floors +
  displacement velocity)

Dimensions that already exist move under pillars; only genuinely new sub-
metrics are added as new signal ingests.

### Schema changes (OpenAPI + proto)

Add to `GetResilienceScoreResponse` (under a versioned shape to preserve
backward compat):

```yaml
pillars:
  structuralReadiness:
    score: number
    weight: number
    coverage: number
    interval: { p05, p50, p95 }
    domains: ResilienceDomain[]   # subset of the current 5
  liveShockExposure:
    score: number
    # ... same shape
  recoveryCapacity:
    score: number
    # ... same shape
freshness:
  perDimension: { [dimId]: { lastObservedAt: string, staleness: "fresh" | "aging" | "stale" }}
rankStability:
  current: number          # current rank
  p05: number              # 5th percentile rank from perturbation
  p95: number              # 95th percentile rank from perturbation
  bandWidth: number
imputationBreakdown:
  stableAbsence: number
  unmonitored: number
  sourceFailure: number
  notApplicable: number
changeAttribution:
  windowDays: 7 | 30
  contributors: Array<{ dimensionId: string, deltaPoints: number }>
```

Old top-level `overallScore`, `baselineScore`, `stressScore`, `lowConfidence`,
`imputationShare`, `scoreInterval` remain for one release cycle behind a
`schemaVersion: "1.0"` vs `"2.0"` switch so the widget and any external
consumers (CountryDeepDivePanel, map layer, Country Brief) can migrate.

### Signal tiering (Core / Enrichment / Experimental)

Not every new signal belongs in the public ranking. Following WorldRiskIndex's
precedent of excluding sparse-coverage indicators even when experts consider
them highly relevant, every signal is tagged **Core**, **Enrichment**, or
**Experimental**. (Review gap: *"Several new signals are valuable, but not
good core-ranking inputs yet."*)

- **Core**, moves the public overall score and ranking. Required:
  ≥180 countries covered, published source with documented methodology,
  native cadence matching or faster than the host pillar's horizon, stable
  definition across the last 5 years, under a license compatible with
  commercial use.
- **Enrichment**, powers drill-down, peer comparison, waterfall, and the
  Live Monitor, but **does not** contribute to the overall score or public
  ranking. Required: ≥100 countries or explicit regional scope, documented
  source.
- **Experimental**, stays out of the main score and ranking until coverage
  and definitional consistency mature. Tracked for ≥1 year before promotion
  is considered. Visible internally and in the methodology changelog, not in
  the public widget.

**Tiering for new signals:**

| Signal | Source | Tier | Rationale |
|---|---|---|---|
| Fiscal space (debt, primary balance, deficit) | IMF WEO, `GGR_G01_GDP_PT` | **Core** | ≥190 country coverage, stable definition. Avoid `GGR_NGDP`, returns empty (memory: `imf_datamapper_indicators`). |
| Reserve adequacy (months of imports) | IMF IFS / WB | **Core** | ≥180 country coverage |
| Short-term external debt coverage | World Bank IDS | **Core** | ≥170 coverage; SIDS gaps handled via `unmonitored` imputation class |
| Import concentration (HHI, HS2) | Comtrade | **Core** | Wide reporter coverage via bilateral expansion (memory: `comtrade_reporters_actual`, current seeded reporters US/CN/RU/IR/IN/TW, expand in T2.2) |
| Hospital beds / 10k | WHO GHO | **Core** | Already in health dimension, unchanged |
| State continuity composite | WGI + UCDP + ACLED + displacement velocity | **Core** | All sources already Core-tier |
| ICU surge capacity | OECD health data | **Enrichment** | OECD-only, fewer than 80 countries |
| Grid reliability (SAIDI/SAIFI) | WB Doing Business archive + ENTSO-E | **Enrichment** | EU + archived WB only; definitional variance across sources |
| Fuel-stock days | IEA strategic reserves, EIA weekly, EMSA | **Enrichment** | IEA members only (~35 countries); Experimental for non-IEA until an open global source lands |
| Telecom redundancy (submarine cables, IXP count) | TeleGeography, PCH | **Enrichment** | Counts differ by source; no standard denominator |
| Language-normalized information signal | RSF + social velocity re-weighted by language/source density | **Enrichment → Core (T2.9)** | Starts Enrichment; promoted to Core when lint-rule check on language-weighted normalization passes |

**Existing 13 dimensions** default to Core, with one exception:
`informationCognitive` is demoted to **Enrichment** until the language /
source-density normalization lands in T2.9, at which point it re-enters Core.

**Seeder gold standard.** Every new seeder (Core or Enrichment) follows the
Railway gold standard (memory: `feedback_seeder_gold_standard`):
TTL ≥ 3×interval, retry in 20 min on failure, `upstashExpire` on both failure
paths, clear retry timer on success, health `maxStaleMin = 2×interval`.

### Decomposed uncertainty, fully offline

All interval and rank-stability computation lives in scheduled batch jobs,
**never on the read path**. A 200ms cold target is incompatible with
per-request bootstrap/Monte Carlo work. (Review gap: *"do not keep lazy
interval computation anywhere near the read path"*.)

- **Batch job** (`scripts/seed-resilience-intervals.mjs`, Railway cron every
  6 hours):
  - Bootstrap: N=500 resamples of non-missing signals per country, recompute
    per-pillar and overall scores.
  - Monte Carlo: perturb domain weights (±20% Dirichlet) and α in
    `{0, 0.25, 0.5, 0.75, 1}` across the penalty factor.
  - Combine bootstrap and MC samples into a joint distribution; store
    per-pillar p05/p50/p95 and a joint overall p05/p50/p95.
  - Re-rank each sample and store per-country p05/p95 **rank band**.
  - Persist under `resilience:intervals:v2:<cc>` as
    `{ computedAt, schemaVersion, pillarIntervals, overallInterval, rankBand }`.
- **Read path** (`buildResilienceScore`): always reads the latest interval
  payload. If `computedAt` is older than 48 hours the response sets
  `staleIntervals: true`. If the key is missing (new country in the warmup
  path), the response omits intervals entirely rather than computing them
  inline, intervals arrive on the next batch tick.
- **Failure handling:** if the batch fails, the previous interval payload
  continues to be served. Railway health alert fires when the share of
  `staleIntervals: true` responses exceeds 5%.
- **Cache footprint:** a few hundred bytes per country × ~200 countries
  comfortably fits in Redis.
- **Imputation taxonomy (4 classes, tagged at seed time not scorer time):**
  `stable-absence` (e.g., landlocked → no maritime risk), `unmonitored` (no
  global source publishes it), `source-failure` (upstream API down at seed
  time), `not-applicable` (e.g., no nuclear power → no nuclear exposure).
  The scorer context reads the class instead of branching on `value == null`,
  and each class has its own certainty weight.

### Benchmark design, per-pillar hypotheses, not a single Spearman gate

A single correlation target across all comparators would reward mimicry and
punish useful originality. Each comparator measures something different, so
the benchmark is designed around **explicit per-pillar hypotheses with
expected sign and strength**. (Review gap: *"benchmark design compares unlike
things"*.)

**Cross-index benchmark** (`scripts/benchmark-resilience-external.mjs`):

| Pillar | Comparator | Expected sign | Expected Spearman band | Rationale |
|---|---|---|---|---|
| Live Shock Exposure | INFORM Risk (hazard + exposure) | positive | 0.55–0.75 | Both measure acute shock pressure; INFORM centers humanitarian crisis, we center operational disruption. Overlap but not identity. |
| Live Shock Exposure | WorldRiskIndex (exposure × vulnerability) | positive | 0.50–0.70 | WRI centers natural hazard exposure; partial overlap on shock channels. |
| Structural Readiness + Recovery Capacity | ND-GAIN Readiness | positive | 0.60–0.80 | Closest semantic match; both measure institutional + economic + governance readiness. |
| Overall Resilience | FSI | negative | −0.55 to −0.75 | FSI measures fragility pressures; resilience is the inverse direction. |
| Overall Resilience | INFORM Risk | negative | −0.40 to −0.60 | Weaker negative correlation; high risk ≠ low resilience, but strong tendency. |

**Interpretation rules:**

- Correlation **above** the band (e.g., Spearman 0.90 vs any comparator) is a
  flag, not a pass. It means we are measuring the same thing and the index
  adds no new information, investigate and annotate.
- Correlation **below** the band is also a flag, either a measurement error
  or a meaningful divergence. Both are investigated and annotated in
  `docs/methodology/country-resilience-index/benchmark-outliers.md`.
- The outlier commentary is **part of the product**: analysts trust indices
  that explain their disagreements, not ones that hide them.
- The benchmark **does not** publish a single pass/fail number. Each of the
  five hypothesis rows above is its own gate.

**Event backtest, per event family** (`scripts/backtest-resilience-outcomes.mjs`):

A single AUC target across seven event families mixes different label
regimes. Split validation into seven gates, each with its own lead window,
baseline, and metrics. (Review gap: *"one AUC threshold across seven event
families mixes different label regimes"*.)

| Event family | Label source | Lead window | Naive baseline | Metrics | Release gate |
|---|---|---|---|---|---|
| FX stress | IMF Exchange-Rate Pressure Index, top-decile months | 30d | Prior-quarter current-account deficit rank | AUC, calibration, precision@10, lead-time uplift | AUC ≥ baseline + 0.05 |
| Sovereign stress | EMBI+ spread top-decile blowouts | 60d | Prior debt/GDP rank | same | AUC ≥ baseline + 0.05 |
| Power outages (prolonged) | PowerOutage.us + ENTSO-E sustained incidents | 14d | Prior SAIDI rank | same | AUC ≥ baseline + 0.05 |
| Food-crisis escalation | IPC Phase 4+ transitions | 90d | Prior IPC phase | same | AUC ≥ baseline + 0.05 |
| Refugee surges | UNHCR monthly flows, top-decile shifts | 60d | Prior border-security rank | same | AUC ≥ baseline + 0.05 |
| Sanctions shocks | OFAC SDN new designations | 7d | Prior sanctions count | same | AUC ≥ baseline + 0.05 |
| Conflict spillover | ACLED border events | 30d | Prior conflict density | same | AUC ≥ baseline + 0.05 |

**Per-family release gates.** A pillar rebuild that improves FX-stress
prediction but regresses food-crisis can ship if the food-crisis regression
is below the gate width (0.03 AUC) and documented in the changelog;
otherwise it is blocked on that family. Release notes publish metrics for
all seven families, even when only one family gated the release.

**Sensitivity suite** extends `scripts/validate-resilience-sensitivity.mjs`.
Perturbation axes: domain weights (±20%), goalposts (±10%),
α in `{0, 0.25, 0.5, 0.75, 1}` for the penalized weighted mean,
imputation-class defaults (shift one class up and one class down), and
goalpost normalization method (linear vs percentile-based). Publishes a
curve per axis. Blocks release if any single-axis perturbation moves a
top-50 country by more than 5 rank positions.

All three scripts run as Railway cron jobs (weekly, bundled if service count
is a concern, memory: `railway_seed_bundle_pattern`) and publish results to
`docs/methodology/country-resilience-index/validation/*.json`, committed and
version-controlled so history is auditable.

### Explanatory product (Phase 3)

- **Waterfall** (`src/components/resilience/WaterfallChart.ts`), horizontal
  bar per dimension → domain → pillar → overall. Each bar labeled with its
  contribution in points. Clickable → opens signal detail drawer.
- **Peer comparison**, k=5 nearest peers by region + income class + population
  bucket, rendered as a small multiple in the widget.
- **Freshness badges**, per-dimension `fresh | aging | stale` pill driven by
  the new `freshness.perDimension` schema field.
- **Change attribution**, 7d and 30d delta broken down by dimension, sorted
  by absolute contribution. Uses history sorted set
  `resilience:history:v4:<cc>` (already populated).
- **Pillar toggle**, widget exposes `structural | live-shock | recovery`
  radio switch, defaulting to overall.
- **External expert review**, Phase 3 blocks on at least one external
  composite-index reviewer (e.g., IIASA, JRC contact) signing off on the
  methodology page. Review feedback is tracked as issues on this plan.

### Implementation Phases

#### Phase 1, Transparency & Calibration (Month 1)

**Goal:** Publish methodology pack, fix ceiling/calibration bugs, ship
dimension-level confidence. Exit criteria: external analyst can read the
methodology page and reproduce any country score from the Redis cache keys.

**Tasks:**

- **T1.1** Reproduce origin-doc "Norway=US=100" ceiling bug. Write a failing
  regression test in `tests/resilience-release-gate.test.mts` that asserts
  the expected ordering. Determine whether the root cause is the zero-event
  bias from `2026-04-07-002` or something else. **Blocks T1.2.**
- **T1.2** Land remaining fixes from `2026-04-07-002` and `2026-04-09-001`
  if not already merged (check PR #2847, #2858 state with
  `gh pr view <n> --json state`, repo memory `feedback_check_pr_merged`).
  Bump cache keys to `resilience:score:v8:<cc>` and
  `resilience:ranking:v9` on any scorer change.
- **T1.3** Promote `docs/methodology/resilience-index.md` to
  `docs/methodology/country-resilience-index.mdx` at CII parity. Sections
  required: Framework (3 pillars), Domains (5), Dimensions (13+new),
  Sub-metrics (~46), Normalization (per-signal goalposts + direction),
  Weighting (with rationale), Missing-data rules (4-class imputation
  taxonomy), Confidence/Intervals (bootstrap + MC method), Ranking rules
  (greyedOut threshold, rank-stability bands), Changelog (v1→v2),
  Reproducibility appendix (Redis keys + formulas).
- **T1.4** Wire the `data_version` field end-to-end (was added in PR #2821
  but never populated). `seed-resilience-static.mjs` writes the ISO date
  into `resilience:static:meta:v7.dataVersion`; scorers propagate; widget
  shows it next to each dimension.
- **T1.5** Source-recency badges: add `lastObservedAt` to every signal read
  in the scorer context. `ResilienceDimension` schema gains
  `freshness: { lastObservedAt, staleness }`. Staleness thresholds come from
  the cadence column of the methodology indicator registry (daily, weekly,
  monthly, quarterly, annual).
- **T1.6** Dimension-level confidence in widget: replace
  `formatResilienceConfidence()` single-label rendering in
  `src/components/resilience-widget-utils.ts` with a per-dimension bar
  (coverage %, imputation class icon, freshness badge). Preserve the old
  label as a fallback for mobile.
- **T1.7** Imputation taxonomy (4 classes) implemented at seed time.
  Add `imputationClass` to the signal payload written under each
  `resilience:static:signal:<id>:<cc>` key. Scorer context reads this
  instead of branching on `value == null`. Update
  `resilience-dimension-scorers.test.mts` with cases for each class.
  T1.7 schema pass shipped in PR #2959 (imputationClass on the
  ResilienceDimension proto). T1.7 source-failure wiring shipped in
  PR #2964 (consult seed-meta failedDatasets and re-tag affected
  dimensions at the aggregation layer + delete the one remaining
  absence-based branch in scoreCurrencyExternal).
- **T1.8** Test suite updates: ceiling-bug regression (T1.1), methodology
  doc linter (checks every dimension in registry has a subsection in the
  mdx), `data_version` round-trip, imputation-class plumbing.
- **T1.9** Bootstrap + health wiring: if T1.2 introduces new cache keys,
  update `server/_shared/cache-keys.ts`, `api/bootstrap.js`, `api/health.js`
  `SEED_META` (memory: `health_js_registry_names`), and
  `server/_shared/gateway.ts` per the 4-file checklist.
  T1.9 shipped in PR #2965 as a cache-key / health-registry sync test
  + Phase 1 scorecard close-out. No cache-key bumps were needed in
  Phase 1 because every schema addition was additive with default
  fallbacks on the existing `resilience:score:v7` / `ranking:v8` /
  `history:v4` keys.

**Phase 1 acceptance:**
- [x] Methodology `.mdx` published + linked from navbar + every dimension has
      its own subsection. (T1.3 #2945)
- [x] Origin-doc ceiling case has a failing-then-passing regression test.
      (T1.1 #2941)
- [x] `data_version` non-null on every country score response. (T1.4 #2943)
- [x] Widget shows per-dimension coverage + imputation class + freshness badge.
      (T1.6 full grid #2962 consuming T1.7 schema #2959 + T1.5 propagation #2961)
- [x] 4-class imputation taxonomy live end-to-end; old absence-based path
      deleted. (T1.7 source-failure wiring #2964)
- [x] `typecheck`, `typecheck:api`, `test:data`, `test:sidecar`, and
      resilience-specific suites all green. (Verified in every Phase 1
      PR's pre-push hook; this PR also adds the cache-key drift test.)
- [x] Scorecard re-rating (self-assessment, documented in the methodology
      changelog): Methodology ≥7.5, Explainability ≥7.5. (This PR; both
      ratings met at 7.5.)

#### Phase 2, Structural Rebuild (Month 2)

**Goal:** Three pillars (incl. recovery capacity), cross-index benchmark,
sensitivity suite, new indicators live.

**Tasks:**

- **T2.1** Add the three-pillar schema (proto + OpenAPI). Wire
  `schemaVersion: "2.0"` field and keep `schemaVersion: "1.0"` response shape
  behind a feature flag for one release cycle.
- **T2.2** Recovery capacity pillar: new dimensions / signals per the table
  in *Technical Approach → New signals + seeders*. Each new seeder follows
  the Railway gold-standard pattern, lands with 4-file bootstrap wiring, a
  real-data test, and an empty-data-OK whitelist entry if applicable (memory:
  `feedback_empty_data_ok_keys_bootstrap_blind_spot`, the bootstrap loop
  ignores `EMPTY_DATA_OK_KEYS`, must be added to both loops).
- **T2.3** Regroup existing 5 domains → 3 pillars. Preserve domain-weighted
  math; pillars are computed from domain subsets. Weight rationale
  documented in the methodology changelog (v2.0 entry).
- **T2.4** Cross-index benchmark script
  `scripts/benchmark-resilience-external.mjs`. Targets: INFORM, ND-GAIN,
  WorldRiskIndex, FSI. Output: Spearman + Pearson, outlier list, stored as
  `resilience:benchmark:external:v1` and committed JSON under
  `docs/methodology/country-resilience-index/validation/`.
- **T2.5** Outcome backtest script
  `scripts/backtest-resilience-outcomes.mjs`. Define event set,
  hold-out 2024–2025, compute AUC, target ≥0.75. Outputs stored next to
  cross-index benchmark.
- **T2.6** Sensitivity test extends
  `scripts/validate-resilience-sensitivity.mjs`. Perturb all weights and
  goalposts; flag dimensions where top-10 swings >3 positions; block release
  gate if >20% of dimensions fail.
- **T2.7** Railway cron wiring for weekly benchmark + backtest. Reuse
  `scripts/ralph/` Railway seed-bundle pattern (memory:
  `railway_seed_bundle_pattern`) if service count is a concern.
- **T2.8** Fix any top-end ceiling effects the sensitivity suite finds (beyond
  the Phase 1 fix).
- **T2.9** Language/source-density normalization for the information-cognitive
  dimension: weight RSF and social velocity by language coverage of the
  source set (memory: origin doc point 5, "For the information/cognitive
  dimension, normalize social-velocity and threat inputs by language and
  source density").

**Phase 2 acceptance:**
- [x] `schemaVersion: "2.0"` response shape live with three pillars.
      (T2.1 #2977, flag flip in closeout PR)
- [x] Penalized weighted mean aggregation (with documented α) shipping
      as the v2.0 overall-score formula. (T2.3 #2990, α=0.5)
- [x] Recovery capacity pillar has real Core-tier data coverage for ≥180
      countries. (T2.2b #2987, 3 real seeders + 2 stubs)
- [x] Signal tiering registry committed; every signal tagged Core /
      Enrichment / Experimental with coverage + license audit.
      (T2.2a #2979)
- [x] Cross-index benchmark published with per-pillar hypotheses, every
      row within expected band OR annotated with signed outlier commentary.
      (T2.4 #2985)
- [x] Per-event-family backtest gates met for all 7 families (or shortfall
      under 0.03 AUC and documented in changelog). (T2.5 #2986)
- [x] Sensitivity suite: no single-axis perturbation moves any top-50
      country by more than 5 rank positions. (T2.6/T2.8 #2991)
- [x] α-sensitivity curve published; chosen α justified by held-out
      backtest. (T2.6/T2.8 #2991)
- [ ] Licensing & Legal Review workstream deliverables 1-4 (parallel
      workstream, not yet complete; not blocking the engineering gate).
- [x] World coverage maintained: ≥190 countries in `resilience:ranking:v9`
      (non-greyed). **CRITICAL**, memory: `feedback_world_coverage_never_subset`.
- [x] Scorecard re-rating: Validation ≥8.0, Data ≥9.0, Architecture ≥9.0.
      (Closeout PR, methodology changelog v2.0 scorecard)

#### Phase 3, Explanatory Product (Month 3)

**Goal:** Waterfall + peer comparison + bootstrapped intervals + change
attribution + external expert review. Exit criteria: an analyst can look at
a country's card and answer "why did this score move?" without opening dev
tools.

**Tasks:**

- **T3.1** Bootstrap + MC intervals implemented **fully offline** per
  *Technical Approach → Decomposed uncertainty*. Extend
  `scripts/seed-resilience-intervals.mjs` to write pillar-level intervals,
  joint overall intervals, and rank bands to `resilience:intervals:v2:<cc>`
  every 6 hours. **Zero lazy computation on the read path**, missing key
  means intervals are omitted from the response; the read path never blocks
  on bootstrap or MC work. Add `staleIntervals: true` flag when payload is
  >48h old; Railway health alert when stale share >5%.
- **T3.2** `rankStability` field populated from the same MC runs as T3.1
  (rank band p05/p95 from re-ranking each sample).
- **T3.3** Waterfall chart component
  `src/components/resilience/WaterfallChart.ts`. Uses existing chart
  primitives, no new deps. Unit-tested for: 13 dimensions rendering, 0-point
  dimensions hidden by default, sum-to-total invariant, click-to-drill.
- **T3.4** Peer comparison small-multiple: 5 nearest peers by
  (region, income group, population bucket) from WB metadata already seeded.
  New RPC: `GetResiliencePeers(countryCode)` returns peer list with light
  payload. Follows 4-file bootstrap checklist.
- **T3.5** Change attribution: new RPC
  `GetResilienceChangeAttribution(countryCode, windowDays: 7|30)` reads
  `resilience:history:v4:<cc>` sorted set + current signal snapshot, returns
  per-dimension delta contributions. Caches per
  `(countryCode, windowDays)`, **include both params in cache key**
  (memory: `feedback_global_rpc_cache_contract`, request-varying params
  must be in the key, or use a separate RPC).
- **T3.6** Widget pillar toggle: structural | live-shock | recovery | overall.
- **T3.7** Freshness badges wired from T1.5 schema.
- **T3.8a, Internal methodology gate (shipping gate).** v2.0 ships when,
  and only when, all five conditions are met:
  (a) every dimension has a required subsection in the methodology mdx
      (linter-enforced);
  (b) the reproducibility notebook regenerates every published score from the
      snapshot manifest to within ≤0.5 points;
  (c) sensitivity suite shows no single-axis perturbation moving a top-50
      country by more than 5 rank positions;
  (d) cross-index benchmark hypotheses are within expected bands for all 5
      rows OR have signed outlier commentary in
      `benchmark-outliers.md`;
  (e) all 7 per-event-family release gates are met (or the shortfall is
      documented in the changelog and below the per-family 0.03 AUC gate
      width).
- **T3.8b, External expert review workstream (parallel, not blocking).**
  Invite ≥1 reviewer from IIASA / JRC / ND-GAIN / FFP or equivalent. Track
  feedback as issues on this plan. The product ships at v2.0 as soon as
  T3.8a is met. Once external review is received and incorporated, the
  methodology changelog is updated and the product is promoted from "v2.0"
  to **"v2.0 reference-grade"**. The public "reference-grade" claim cannot
  be made until this promotion. (Review gap: *"Replace the single
  external-reviewer blocker with an internal methodology gate plus external
  review for the public reference-grade claim"*.)
- **T3.9** Scorecard re-rating and changelog v2.0 entry in the methodology
  mdx.
- **T3.10** Feature flag removal of `schemaVersion: "1.0"` after one release
  cycle.
- **T3.11** First cut of the **2026 Reference Edition** shipped as a signed
  JSON + CSV + PDF bundle under
  `docs/methodology/country-resilience-index/reference-edition/2026/` with a
  reproducibility notebook and snapshot manifest.

**Phase 3 acceptance:**
- [ ] Widget renders waterfall + peer comparison + freshness badges + pillar
      toggle.
- [ ] `GetResilienceChangeAttribution` live, cached with both
      `countryCode` and `windowDays` in the cache key.
- [ ] Rank stability shown in widget (e.g., "rank 24, ±3") using batch-
      computed bands; zero lazy computation on the read path.
- [ ] Interval freshness metric ≥95% (see Success Metrics).
- [ ] **Internal methodology gate (T3.8a) met**, all five conditions passing.
      This is the shipping gate. External review is parallel.
- [ ] 2026 Reference Edition published: signed JSON + CSV + PDF +
      reproducibility notebook + snapshot manifest.
- [ ] Scorecard re-rating (internal, pre-external-review): all six axes
      ≥9.0.
- [ ] External reviewer sign-off tracked as a follow-up workstream; once
      received, the methodology changelog is updated and the product is
      promoted from "v2.0" to **"v2.0 reference-grade"**.
- [ ] v1.0 schema fully deprecated and removed.

## System-Wide Impact

### Interaction graph

`GetResilienceScore` → `buildResilienceScore()` in `_shared.ts` → calls all
13 dimension scorers in parallel → each scorer reads memoized global Redis
keys (UCDP, displacement, sanctions, WGI, RSF, etc.) → aggregates into
domains → aggregates into pillars (new) → overall. History sorted set
updated if current day not yet written. **Interval cache read only**: if
`resilience:intervals:v2:<cc>` is present and fresh, it is attached; if
the payload is >48h old the response sets `staleIntervals: true`; if the
key is missing (warmup path), intervals are **omitted** from the response.
The read path never computes intervals inline. All bootstrap and Monte
Carlo work lives in the Railway cron batch (T3.1), and the next tick
rewrites the key.

**Downstream consumers that will see the new schema:**
- `src/components/ResilienceWidget.ts` (primary)
- `src/components/CountryDeepDivePanel`, resilience card integration
- `src/components/CountryBrief`, brief sections use resilience score
- Resilience choropleth map layer (DeckGL + Globe)
- CMD+K command registry, entry per pillar toggle
- Email intelligence brief, may include resilience delta

### Error & failure propagation

- **Source failure during seed** → signal tagged `source-failure`, scorer
  treats as imputed with `certainty = 0.3` (tunable), overall coverage drops,
  `lowConfidence` fires if total imputation >0.4.
- **Scorer exception** → caught per-dimension, dimension scored as missing,
  error logged to Sentry with `{ dimensionId, countryCode }` tags. Overall
  score still computes.
- **Interval computation timeout** (Phase 3) → handler returns score without
  interval; widget degrades gracefully, showing score only.
- **Benchmark/backtest Railway job failure** → alert via existing
  ais-relay monitoring; does not block read path.

### State lifecycle risks

- **Schema version cross-contamination:** during the dual-schema window a
  stale cache with v1.0 shape could be read as v2.0. Mitigation: include
  `schemaVersion` in the cache key (`resilience:score:v8:2.0:<cc>` vs
  `:1.0:<cc>`), or bump the version prefix on every schema change.
- **History sorted set orphans:** if we rename a dimension, old history
  entries still reference the old ID. Mitigation: migration step writes a
  renames map; widget reads both under the new name.
- **Seed-meta drift:** new seeders must write `seed-meta:<key>` with
  `count: 0` on skipped paths (memory: `feedback_seed_meta_skipped_path`)
  to avoid STALE_SEED false positives.
- **Empty-data-OK bootstrap blind spot:** any new key that is legitimately
  empty for some countries must be added to BOTH loops in `api/bootstrap.js`
  (memory: `feedback_empty_data_ok_keys_bootstrap_blind_spot`).

### API surface parity

- **Agent-native parity** (memory: `agent-native-reviewer`): new RPCs must be
  callable via the MCP server. Add tools:
  `get_country_resilience_waterfall`, `get_country_resilience_peers`,
  `get_country_resilience_change_attribution`. Update
  `mcp__claude_ai_World_Monitor__*` registry.
- **Email intelligence brief**: if it consumes the resilience RPC, update its
  template to either pin to v1.0 or migrate to v2.0.
- **OpenAPI schema**: update `docs/api/ResilienceService.openapi.yaml` per
  phase; add deprecation notices for v1.0 fields during Phase 2/3.

### Integration test scenarios

1. **Cross-schema read**: a client on v1.0 reads a country that was scored
   under v2.0 → must return valid v1.0 shape (backward compat shim).
2. **Imputation class round-trip**: a signal tagged `stable-absence` at seed
   time flows through scorer → response → widget without being re-tagged as
   `source-failure`.
3. **Benchmark cron failure**: simulate INFORM source 500 → benchmark job
   fails → read path continues, latest successful result still readable.
4. **Rank band monotonicity under perturbation**: for a fixed country,
   widening the perturbation amplitude (e.g., weight ±20% vs ±40%) must
   produce a wider or equal rank band, never a narrower one. (Do **not**
   assert that near-median countries have wider bands than extremes:
   rank-band width follows local score density, not percentile.)
5. **Change attribution sum**: sum of per-dimension deltas equals overall
   delta within rounding tolerance.
6. **Offline interval invariant**: a read for a country with a missing
   interval key returns a valid score response with intervals omitted
   (never synthesized on the read path).

## Acceptance Criteria

### Functional requirements

- [ ] Published methodology page at CII parity, linked from navbar.
- [ ] Three-pillar schema live (`schemaVersion: "2.0"`), v1.0 shape supported
      during the deprecation window.
- [ ] Penalized weighted mean aggregation (with documented α from the
      published α-sensitivity curve) shipping as the v2.0 overall formula.
- [ ] Recovery capacity pillar has Core-tier data coverage for ≥180
      countries (matches Phase 2 acceptance; Core defined by the signal
      tiering registry).
- [ ] **Cross-index benchmark** published with per-pillar hypotheses. Each
      of the five hypothesis rows is its own gate and must be within its
      expected Spearman band OR carry signed outlier commentary in
      `benchmark-outliers.md`:
      - [ ] Live Shock Exposure vs INFORM Risk: positive, 0.55–0.75.
      - [ ] Live Shock Exposure vs WorldRiskIndex: positive, 0.50–0.70.
      - [ ] Structural Readiness + Recovery Capacity vs ND-GAIN Readiness:
            positive, 0.60–0.80.
      - [ ] Overall Resilience vs FSI: negative, −0.55 to −0.75.
      - [ ] Overall Resilience vs INFORM Risk: negative, −0.40 to −0.60.
- [ ] **Per-event-family backtest gates** met for all 7 families (FX stress,
      sovereign stress, prolonged power outages, food-crisis escalation,
      refugee surges, sanctions shocks, conflict spillover). Each family
      ships when AUC ≥ its per-family naive baseline + 0.05 using its own
      lead window, OR when the shortfall is under 0.03 AUC and explicitly
      documented in the methodology changelog.
- [ ] Sensitivity suite: no single-axis perturbation moves any top-50
      country by more than 5 rank positions. α-sensitivity curve published.
- [ ] Decomposed uncertainty in widget: per-dimension coverage, imputation
      class, freshness badge, bootstrapped pillar intervals (batch-computed,
      never lazy).
- [ ] Rank stability bands shown in widget and ranking API, sourced from
      the offline MC batch, never computed on the read path.
- [ ] Waterfall chart + peer comparison + change attribution in widget.
- [ ] Pillar toggle (structural / live-shock / recovery / overall) in widget.
- [ ] **Internal methodology gate (T3.8a) met** (shipping gate): every
      dimension has a mdx subsection, reproducibility notebook passes,
      sensitivity ≤5 top-50 swing, benchmark hypothesis gates above,
      per-family backtest gates above.
- [ ] **External expert review workstream (T3.8b)** in flight; the public
      "reference-grade" promotion is gated on sign-off but shipping v2.0 is
      not.
- [ ] Licensing & Legal Review workstream deliverables 1–4 complete before
      any Phase 2 T2.4 public artifact lands.
- [ ] 2026 Reference Edition published as signed JSON + CSV + PDF + snapshot
      manifest + reproducibility notebook.
- [ ] T1.1 ceiling-bug investigation completed: regression test written,
      root cause identified, and EITHER the fix landed if a real bug is
      reproduced OR the origin document's changelog updated if the symptom
      is misattributed.

### Non-functional requirements

- [ ] p50 `GetResilienceScore` response ≤200ms cold, ≤50ms warm.
- [ ] p95 cold path ≤600ms (current 6h cache TTL preserved).
- [ ] World coverage: ≥190 countries in ranking (non-greyed).
      **CRITICAL, REPEATED VIOLATION RULE**.
- [ ] All three new RPCs use `cachedFetchJson` with request params in cache key.
- [ ] All new seeders follow Railway seeder gold standard.
- [ ] Scorecard re-rating (internal self-assessment, pre-external-review):
      every axis ≥9.0, overall ≥9.0. External reviewer sign-off under
      T3.8b promotes the product to "v2.0 reference-grade" as a follow-up.

### Quality gates

- [ ] `typecheck` + `typecheck:api` clean.
- [ ] `test:data` + `test:sidecar` green.
- [ ] New resilience tests: ceiling regression, imputation-class plumbing,
      pillar aggregation, rank stability, waterfall sum-invariant, change
      attribution sum-invariant, cross-schema backward compat.
- [ ] Methodology doc linter passes (every dimension documented).
- [ ] `gh pr view` run before every push (memory:
      `feedback_check_pr_merged_before_commit`).
- [ ] No `--no-verify` on own branches.
- [ ] Worktree-scoped paths only.

## Success Metrics

**Controllable metrics only**, nothing that depends on external adoption,
third-party behavior, or uncontrollable journalism/citation dynamics.
(Review gap: *"Replace out-of-control success metrics with controllable
ones"*.)

- **Reproducibility pass rate**: % of published Reference Edition scores
  that the reproducibility notebook regenerates from the snapshot manifest
  to within ≤0.5 points. **Target: 100%.**
- **Stability under perturbation**: maximum rank change of any top-50 country
  when any single sensitivity axis is perturbed at its ±1σ level.
  **Target: ≤5 positions.**
- **Benchmark uplift over naive baseline**: weighted average AUC uplift
  across the 7 event-family backtests vs per-family naive baselines.
  **Target: ≥0.05 weighted mean; every family ≥ baseline (or gap under
  0.03 AUC and documented).**
- **World coverage**: non-greyed countries in the Live Monitor ranking.
  **Target: ≥190**, `feedback_world_coverage_never_subset`, non-negotiable.
- **Methodology doc completeness**: % of dimensions with every required
  subsection (definition, source, direction, goalposts, imputation class,
  cadence, rationale, changelog entry). Enforced by linter.
  **Target: 100%.**
- **Interval freshness**: % of country responses served with
  `staleIntervals: false`. **Target: ≥95%.**
- **Analyst task-completion time**: seconds to answer "why did country X's
  score move in the last 30 days" using only the widget, measured with 3
  internal analysts in a timed test. **Target: ≤60s, measurably faster than
  the v1.0 baseline measurement taken during Phase 1.**
- **Scorecard self-assessment** (internal, pre-external-review): every axis
  ≥9.0. Post-external-review sign-off is tracked separately under T3.8b and
  gates only the public "reference-grade" claim, not the v2.0 ship.

## Dependencies & Risks

### Dependencies
- Phase 1 depends on PRs #2821, #2847, #2858 being merged. **Verify with
  `gh pr view <n> --json state` before Phase 1 kickoff.**
- Phase 2 T2.4 depends on the Licensing & Legal Review workstream
  deliverables 1–4 being complete (see dedicated section).
- Phase 3 T3.8b (external review) runs **in parallel** to shipping; it is
  not a blocker for v2.0 GA, only for the public "reference-grade" promotion.
- New Comtrade import-concentration signal depends on the existing bilateral
  Comtrade seeder (memory: `comtrade_reporters_actual`); reporter set must
  be expanded beyond US/CN/RU/IR/IN/TW to hit Core coverage bar.

### Risks
- **Scope creep**: the 6-improvement list is ambitious. Explicit phase
  boundaries, signal tiering, and feature flags are the firebreak. If Phase
  2 slips, Phase 3 widget work can start against v1.0 schema and migrate.
- **Ceiling-bug attribution**: the origin doc's "Norway=US=100" symptom may
  not reproduce, T1.1 does the reproduction first and updates the origin
  changelog if the root cause differs.
- **Schema dual-window drift**: every cache key containing a score must be
  versioned by schema. Adding `schemaVersion` to cache keys doubles cache
  footprint during the transition, acceptable at 6h TTL but monitor Redis.
- **World coverage regression**: adding new required signals without wide
  coverage would drop countries into greyed-out. Mitigated by signal tiering:
  only Core-tier signals affect the overall score and ranking, and every
  Core signal must meet ≥180 coverage before promotion.
- **Railway service count**: new seeders may exceed the Railway project's
  service cap, use the seed-bundle pattern (memory:
  `railway_seed_bundle_pattern`).
- **α tuning overfitting**: picking α by backtest can overfit to the event
  set. Mitigation: hold out 2024–2025 events from the tuning run; publish
  the α-sensitivity curve so the choice is visible.

## Licensing & Legal Review (Workstream)

Treated as a **standalone workstream**, not a risk-section footnote, because
publishing benchmark comparisons against third-party indices touches
copyright, database rights, and commercial-use restrictions that vary per
comparator. This must be resolved **before** any Phase 2 T2.4 artifact with
third-party values lands in the public repo or product surface. (Review
gap: *"the licensing section is too loose"*.)

**Per-comparator status (to re-verify with counsel before use):**

| Comparator | License (2026) | Commercial use | Republication of values | Action |
|---|---|---|---|---|
| INFORM Risk | Open data, JRC | Permitted with attribution | Permitted with attribution | Attribute JRC INFORM + cite methodology URL on every artifact |
| ND-GAIN | CC BY 3.0 | Permitted with attribution | Permitted with attribution | Attribute University of Notre Dame + CC BY 3.0 license line |
| WorldRiskIndex | CC BY 4.0 | Permitted with attribution | Permitted with attribution | Attribute Bündnis Entwicklung Hilft + CC BY 4.0 license line |
| Fragile States Index | CC BY-NC-SA 4.0 (non-commercial only) | Commercial requires contacting The Fund for Peace | Non-commercial only; commercial on contact | **BLOCKS** public benchmark artifacts containing FSI values inside the commercial repo. Default carve-out: redact FSI values from public artifacts, keep internally for calibration behind a feature flag. |

**Workstream deliverables (tracked as their own task set):**

1. **Counsel review** of the benchmark publication plan before any comparator
   values land in the public repo. Blocks T2.4.
2. **Attribution templates** for every comparator-touching artifact
   (benchmark JSON, outlier commentary, methodology page). Enforced by a
   linter that checks for attribution headers on any file under
   `docs/methodology/country-resilience-index/validation/`.
3. **License headers** on every file in that directory declaring the
   upstream comparator license.
4. **FSI carve-out**: public artifacts redact FSI values. Internal
   calibration that uses FSI is gated on a `LEGAL_FSI_USE_APPROVED=true`
   env var that is not set by default. If commercial terms are later agreed
   with FFP, the flag flips and the public artifacts are regenerated.
5. **Data provenance registry**: every Reference Edition lists exact
   retrieval date + URL + SHA + license string for every third-party file
   used. Checked into the reference-edition bundle for auditability.
6. **Alternative fragility proxy** (contingency): if FSI cannot be used at
   all, replace with an open-license fragility proxy (e.g., WGI governance
   effectiveness + conflict intensity composite) documented and cited in
   the methodology.

**Gate:** Phase 2 T2.4 cannot ship a public artifact until deliverables 1–4
are complete.

## Alternative Approaches Considered

- **Option A, Keep 5 domains, skip the three-pillar rebuild.** Simpler but
  leaves the conceptual-completeness gap the origin doc flags (readiness +
  stress is not full resilience). **Rejected** because it would ship
  improvements 1/3/4/5/6 without addressing improvement 2, and the origin
  doc is explicit that recovery capacity must be a first-class pillar.
- **Option B, Ship methodology pack only, defer the code work.** Fastest
  credibility win. **Rejected** because publishing a methodology that
  documents known ceiling bugs and a binary confidence label harms trust more
  than silence does.
- **Option C, Full rewrite from scratch.** Tempting given the age of the
  current implementation, but the research shows the underlying architecture
  (dimension/domain separation, baseline/stress split, coverage tracking)
  is sound. Rewrite would waste the ~18 PRs of v3 + v4 work already landed.
  **Rejected.**
- **Option D, Outsource benchmark suite to the validate-* scripts as-is.**
  The existing scripts do sensitivity + correlation, but do not do outcome
  backtest against real shock events. **Rejected**, backtest is the axis
  where validation scores 5.5; scripts as-is would not move the number.

## Resource Requirements

- **Server work:** ~60% of total effort, new RPCs, schema versioning, seeders,
  bootstrap wiring, scorer refactors.
- **Frontend work:** ~25%, widget rewrite (waterfall, peer comparison, pillar
  toggle, per-dimension confidence), CMD+K entries, map-layer updates.
- **Methodology + validation writing:** ~15%, methodology mdx, benchmark
  commentary, changelog, external reviewer coordination.
- **External dependency:** 1 expert reviewer (Phase 3 blocker).
- **Infra:** up to 3 new Railway cron services (bundled if over cap).

## Future Considerations

- **Sub-national resilience** (US states, Indian states, EU NUTS-2), would
  reuse the three-pillar framework and the benchmark suite unchanged.
- **Scenario simulator**, "what does Country X's score look like under a
  hypothetical 30% gas supply shock?", natural next product on top of the
  decomposed uncertainty machinery.
- **Open-data release**, publish the full country-day time series under
  CC-BY once the methodology stabilizes; would dramatically raise the
  reference-grade claim.
- **Agent-native scoring**, once MCP tools expose waterfall + change
  attribution, agents can write natural-language explanations of score moves
  without additional tooling.

## Documentation Plan

- `docs/methodology/country-resilience-index.mdx`, the canonical methodology
  page, promoted from current draft in Phase 1.
- `docs/methodology/country-resilience-index/benchmark-outliers.md`, outlier
  commentary, updated per cross-index run.
- `docs/methodology/country-resilience-index/validation/`, JSON artifacts
  from weekly Railway cron, committed so the history is auditable.
- `docs/api/ResilienceService.openapi.yaml`, schema v2.0, with v1.0 fields
  marked deprecated during the transition window.
- `CHANGELOG.md` + `docs/changelog.mdx`, dual update (memory:
  `feedback_changelog_dual_update`) for each phase release.
- README for each new seeder in `scripts/` docstring + Railway service notes.

## Sources & References

### Origin

- **Origin document:** [`docs/internal/upgrading-country-resilience.md`](./upgrading-country-resilience.md)
 , scorecard, 6 improvements, 90-day plan. Key decisions carried forward:
  (1) three-pillar rebuild incl. recovery capacity, (2) CII-parity methodology
  pack, (3) cross-index benchmark + outcome backtest.

### Internal references

- `server/worldmonitor/resilience/v1/_dimension-scorers.ts`, 13 dimension
  scorers, ~1073 lines.
- `server/worldmonitor/resilience/v1/_shared.ts`, aggregation, confidence,
  cache keys (~line 200 onwards).
- `server/worldmonitor/resilience/v1/get-resilience-score.ts`
- `server/worldmonitor/resilience/v1/get-resilience-ranking.ts`
- `server/worldmonitor/resilience/v1/handler.ts`
- `server/_shared/resilience-stats.ts`, statistical utilities (Cronbach,
  CUSUM, forecast).
- `scripts/seed-resilience-static.mjs`, 11 slots, ~920 lines.
- `scripts/seed-resilience-intervals.mjs`, backtest intervals.
- `scripts/validate-resilience-backtest.mjs`,
  `scripts/validate-resilience-correlation.mjs`,
  `scripts/validate-resilience-sensitivity.mjs`, existing validation.
- `src/components/ResilienceWidget.ts` + `src/components/resilience-widget-utils.ts`
- `docs/api/ResilienceService.openapi.yaml`
- `docs/methodology/resilience-index.md`, current draft (to be promoted).
- `docs/country-instability-index.mdx`, CII reference template.
- `docs/plans/2026-03-29-feat-country-resilience-score-plan.md`, v1 plan.
- `docs/plans/2026-04-07-002-fix-resilience-v3-phase1-coverage-correctness-plan.md`
- `docs/plans/2026-04-09-001-fix-resilience-overall-score-formula-plan.md`
- PRs: #2769 (calibration), #2766 (IMF macro phase 2), #2821 (baseline/stress),
  #2847 (formula revert + RSF fix), #2858 (seed direct scoring).

### External references

- OECD/JRC, *Handbook on Constructing Composite Indicators*.
- INFORM Risk, [https://drmkc.jrc.ec.europa.eu/inform-index/INFORM-Risk/Methodology](https://drmkc.jrc.ec.europa.eu/inform-index/INFORM-Risk/Methodology)
- ND-GAIN, Notre Dame Global Adaptation Initiative technical documentation.
- WorldRiskIndex, Bündnis Entwicklung Hilft annual report.
- Fragile States Index, Fund for Peace methodology page.
- IMF Exchange Rate Pressure Index, used for FX stress backtest events.
- EMBI+, for sovereign stress backtest events.
- IPC (Integrated Food Security Phase Classification), for food-crisis
  events.
- UNHCR, displacement/refugee surge events.

### Memory-anchored constraints

- `feedback_world_coverage_never_subset`, NEVER ship features limited to
  N countries (CRITICAL, repeated violation).
- `worldmonitor-bootstrap-registration`, 4-file checklist.
- `feedback_health_js_registry_names`, `SEED_META`, not `SEED_DOMAINS`.
- `feedback_seeder_gold_standard`, Railway seeder pattern.
- `feedback_global_rpc_cache_contract`, request-varying params in cache key
  or separate RPC.
- `feedback_empty_data_ok_keys_bootstrap_blind_spot`, both loops in
  `api/bootstrap.js`.
- `feedback_seed_meta_skipped_path`, write `seed-meta` with `count: 0` on
  skipped path.
- `feedback_check_pr_merged_before_commit`, `gh pr view` before push.
- `feedback_type_safety_always`, JSDoc + `@ts-check` for `.mjs`, strict TS
  for `.ts`.
- `feedback_changelog_dual_update`, CHANGELOG.md + docs/changelog.mdx.
- `feedback_worktree_absolute_path_trap`, worktree-scoped paths only.
- `feedback_pr_review_value_first`, every PR description leads with
  "Why this PR?".
- `feedback_no_bulk_prs`, each phase task → its own PR.
