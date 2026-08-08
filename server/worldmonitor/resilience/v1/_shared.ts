import type {
  GetResilienceScoreResponse,
  ResilienceDimension,
  ResilienceDomain,
  ResilienceRankingItem,
  ScoreInterval,
} from '../../../../src/generated/server/worldmonitor/resilience/v1/service_server';


export type { ScoreInterval };

import { cachedFetchJson, getCachedJson, runRedisPipeline, setCachedJson } from '../../../_shared/redis';
import { unwrapEnvelope } from '../../../_shared/seed-envelope';
import { detectTrend, round } from '../../../_shared/resilience-stats';
import { isInRankableUniverse } from './_rankable-universe';
import {
  RESILIENCE_DIMENSION_DOMAINS,
  RESILIENCE_DIMENSION_ORDER,
  RESILIENCE_DIMENSION_TYPES,
  RESILIENCE_DIMENSION_WEIGHTS,
  RESILIENCE_DOMAIN_ORDER,
  RESILIENCE_IMF_LABOR_KEY,
  isExcludedFromConfidenceMean,
  createMemoizedSeedReader,
  getResilienceDomainWeight,
  readCountryPopulationMillionsForGate,
  scoreAllDimensions,
  type ImputationClass,
  type ResilienceDimensionId,
  type ResilienceDomainId,
  type ResilienceSeedReader,
} from './_dimension-scorers';
import { buildPillarList } from './_pillar-membership';

// Phase 2 T2.1/T2.3: feature flag for the three-pillar response shape.
// Default is `true` → responses carry `schemaVersion: "2.0"` and a
// non-empty `pillars` array with real domain-weighted, coverage-scaled scores from
// `_pillar-membership.ts#buildPillarList`. When `false`, responses fall
// back to the Phase 1 shape (`schemaVersion: "1.0"`, `pillars: []`) —
// retained as an emergency opt-out for one release cycle.
//
// `baselineScore`, `stressScore`, `stressFactor`, etc. remain populated
// in both modes for widget + map layer + Country Brief consumers.
export const RESILIENCE_SCHEMA_V2_ENABLED =
  (process.env.RESILIENCE_SCHEMA_V2_ENABLED ?? 'true').toLowerCase() === 'true';

// Phase 2 T2.3 activation: feature flag that switches `overallScore`
// from the 6-domain weighted aggregate (legacy compensatory form) to
// the 3-pillar combined form with the min-pillar penalty term defined
// by `penalizedPillarScore` below. The published and production methodology
// is pillar-combined, so unset defaults to `true`; explicit `false` retains
// the legacy 6-domain form as an emergency rollback. When enabled:
//   - `overallScore` = penalizedPillarScore(pillars), α=0.5 (pillar
//     weights 0.40 / 0.35 / 0.25 per the plan).
//   - Published numbers drop ~13 points on average across the
//     52-country sample; Spearman vs the 6-domain ranking is 0.9863.
//
// Read dynamically rather than captured at module load so tests can
// flip `process.env.RESILIENCE_PILLAR_COMBINE_ENABLED` per-case without
// re-importing the module. Under Node production the env does not
// change mid-process so the per-call read is a couple of instructions.
//
// Exact normalized `false` is the only disabling value; unset and values such
// as `0`, `no`, and `off` keep the pillar-combined formula enabled. Cache
// admission compares each payload's `_formula` tag, so a flag flip cannot
// reuse scores from the other formula. Bump RESILIENCE_SCORE_CACHE_PREFIX only
// when scorer behavior changes without changing that formula tag.
export function isPillarCombineEnabled(): boolean {
  return process.env.RESILIENCE_PILLAR_COMBINE_ENABLED?.trim().toLowerCase() !== 'false';
}

// PR 1 of the resilience repair plan (docs/plans/2026-04-22-001-fix-
// resilience-scorer-structural-bias-plan.md §3.1–§3.3): activation
// flag for the v2 energy construct. Default is `false` because the
// repo cannot prove production Railway seed state at build time.
// Activation remains an explicit operator action after
// seed-bundle-resilience-energy-v2 is provisioned and /api/health is
// green for seed-meta:resilience:{fossil-electricity-share,low-carbon-
// generation,power-losses}. The public runtime manifest exposes only
// the derived construct version (`legacy` or `v2`), never this raw env
// flag name or internal cache keys.
//
// When off (default): `scoreEnergy` uses the legacy inputs
// (energyImportDependency, gasShare, coalShare, renewShare,
// electricityConsumption, gasStorageStress, energyPriceStress) and
// published rankings are unchanged.
//
// When on: `scoreEnergy` uses the v2 inputs under the Option B
// (power-system security) framing:
//   - importedFossilDependence = EG.ELC.FOSL.ZS × max(EG.IMP.CONS.ZS, 0) / 100   (weight 0.35)
//   - lowCarbonGenerationShare = OWID Grapher share-electricity-low-carbon      (weight 0.20)
//   - powerLossesPct           = EG.ELC.LOSS.ZS                                  (weight 0.20)
//   - euGasStorageStress       = legacy gasStorageStress scoped to EU            (weight 0.10)
//   - energyPriceStress        = legacy energyPriceStress                        (weight 0.15)
// reserveMarginPct is DEFERRED per plan §3.1 until an IEA electricity-
// balance seeder lands; its 0.10 weight is temporarily absorbed into
// powerLossesPct (0.20 = 0.10 + 0.10). When the seeder ships, split
// the 0.10 back out.
// Retired under v2: electricityConsumption, gasShare, coalShare,
// renewShare, and the legacy energyImportDependency scorer input
// (still seeded; just not used by scoreEnergy v2 because it's been
// absorbed into importedFossilDependence).
//
// Read dynamically rather than captured at module load so tests can
// flip `process.env.RESILIENCE_ENERGY_V2_ENABLED` per-case without
// re-importing the module.
//
// Cache invalidation: energy dimension scores are embedded in the
// overall score, so flipping this flag requires a score-cache prefix
// bump in the same release. The flag-flip runbook keeps that bump,
// acceptance-gate rerun, and post-flip snapshot together so rollback
// can simply restore the env flag to false.
export function isEnergyV2Enabled(): boolean {
  return (process.env.RESILIENCE_ENERGY_V2_ENABLED ?? 'false').toLowerCase() === 'true';
}

export function isFinancialSystemExposureEnabled(): boolean {
  return (process.env.RESILIENCE_FIN_SYS_EXPOSURE_ENABLED ?? 'false').toLowerCase() === 'true';
}

export const RESILIENCE_SCORE_CACHE_TTL_SECONDS = 6 * 60 * 60;
// Ranking TTL must exceed the cron interval (6h) by enough to tolerate one
// missed/slow cron tick. With TTL==cron_interval, writing near the end of a
// run and firing the next cron near the start of the next interval left a
// gap of multiple hours once the key expired between refreshes. 12h gives a
// full cron-cycle of headroom — ensureRankingPresent() still refreshes on
// every cron, so under normal operation the key stays well above TTL=0.
export const RESILIENCE_RANKING_CACHE_TTL_SECONDS = 12 * 60 * 60;
// Bumped from v9 to v10 in the pillar-combined activation PR. Provides
// a clean slate at PR deploy so no pre-PR cache entries (whose payloads
// lack the `_formula` tag) can leak through on activation day. NOTE:
// the version bump alone is NOT sufficient to isolate formulas — the
// flag defaults to off, so v10 is populated with 6-domain entries long
// before anyone flips RESILIENCE_PILLAR_COMBINE_ENABLED=true. The real
// cross-formula guard is the in-payload `_formula` marker written by
// `buildResilienceScore`, read by `ensureResilienceScoreCached` and
// `getCachedResilienceScores` to reject stale-formula hits at serve
// time. See the `CacheFormulaTag` comment block.
// v12 bump for PR 3A §net-imports denominator (plan
// `docs/plans/2026-04-24-002-fix-resilience-cohort-ranking-structural-
// audit-plan.md`). The SWF seeder's rawMonths denominator changed
// from grossImports to grossImports × (1 − reexportShareOfImports)
// for countries in the re-export share manifest; totalEffectiveMonths
// values thus shift for those countries. The `_formula` tag (d6/pc)
// does NOT detect intra-'d6' seed-payload changes, so without a
// prefix bump v11 entries would serve stale pre-fix scores for the
// full 6h TTL post-deploy. v12 forces a clean slate — matches the
// established v9→v10 and v10→v11 patterns for formula-affecting
// deploys. v12→v13 bump in plan 2026-04-25-004 Phase 1 (Ship 1) for the
// `tradeSanctions` → `tradePolicy` rename + dropped OFAC component +
// reweighted trade-policy formula. Without the bump, v12 entries would
// serve pre-rename economic-domain scores for the full 6h TTL post-deploy.
// v13→v14 bump in plan 2026-04-25-004 Phase 2 (Ship 2) for the new
// `financialSystemExposure` dim — adds a 20th dimension contributing to
// the economic domain, so v13 entries (which lack the new dim's score)
// would surface incomplete payloads on cache hit.
// v15→v16 bump for plan 2026-04-26-002 §U4+U5+U6 (combined PR 3+4+5):
// imputed dims now contribute 0.5× nominal weight to the
// coverage-weighted mean (U4); IMPUTE entries fall back to "unknown"
// (50/0.3) instead of "stable-absence" (85/0.6) for non-comprehensive
// sources (U5); event-counted dims (socialCohesion unrest, borderSecurity
// UCDP) normalize per-million-population (U6). Every country's score
// shifts; mixing v15 + v16 cached scores in the same response would
// create internally-inconsistent rankings.
// v16→v17 bump for plan 2026-04-26-002 §U7 (PR 6): `headlineEligible`
// flips from PR 2's "true everywhere" to actual eligibility logic
// (coverage >= 0.65 AND (population >= 200k OR coverage >= 0.85) AND
// !lowConfidence). Cached v16 score entries carry headlineEligible:true
// for every country (the PR 2 default), which would let ineligible
// countries through the headline ranking filter for the full 6h TTL
// post-deploy. Bump forces a clean recompute aligned with the new gate.
// v17→v18 bump for plan 2026-04-26-002 §U8.1 (net-imports denominator
// extended from sovereignFiscalBuffer to liquidReserveAdequacy). The
// `_formula` tag is binary 'd6'|'pc' and does NOT detect intra-'d6'
// scorer-formula changes — without this bump, cached v17 AE/PA scores
// (gross-imports-denominated) would continue to serve for the full 6h
// TTL post-deploy, defeating the construct fix this PR delivers. Same
// pattern as the v11→v12 bump that PR 3A used for the SWF-side fix.
// v18→v19 bump for issue #3971: cyberDigital now caps the per-snapshot
// severity-weighted cyber threat count before normalization. The `_formula`
// tag does not distinguish intra-formula scorer changes, so cached v18
// scores would otherwise serve pre-cap cyberDigital values until TTL.
// v19→v20 bump for country-resilience audit P1-3: freshness/staleness
// now derates confidence coverage and therefore can change lowConfidence
// plus headlineEligible. Scores are unchanged, but cached v19 score
// payloads already carry the old confidence/eligibility booleans.
// v20→v21 bump for the P1-1 CRI contract fix: pillar member domains now
// use domain.weight * average dimension coverage inside the active `pc`
// formula. The `_formula` tag remains `pc`, so the prefix bump is required
// to reject old same-tag pillar scores deterministically at deploy. v20 is
// reserved for the parallel staleness-derate rollout, so this branch sequences
// the next same-tag `pc` formula change into v21.
// v21→v22 bump for country-resilience audit round 2 P2-N2/P2-N3:
// currencyExternal now scores inflation stability around a low-positive target
// band instead of treating deflation/0% inflation as perfect, and blend math
// rejects NaN scores rather than consuming their weights.
// v22→v23 bump batches three same-tag `pc` scorer changes: import-HHI stale /
// missing source years now derate certainty coverage (#4088), infrastructure
// treats an observed outage feed with zero outages as observed-quiet (score 100)
// matching cyberDigital (P3-8), and WTO tradePolicy restriction/barrier rows now
// score one-row-per-reporter severity instead of stale count anchors (P2-1).
// Same `pc` formula tag, but recovery, infrastructure, tradePolicy, pillar, and
// overall scores can move.
// v23→v24 bump for country-resilience audit round 5 R5-2 / PR #4101:
// governance WGI indicator slots now preserve each WGI series as its own
// signal instead of relying on drift-prone slot semantics. The formula tag is
// still `pc`, but governance, state-continuity, pillar, and overall payloads can
// move, so cached score entries must not survive the methodology change.
// v24→v25 bump for issue #4009: cyberDigital now groups cyber threats by
// stable firstSeenAt discovery day and decays old one-day bursts while
// allowing sustained multi-day pressure to reach the cap. Same `pc` formula
// tag, but infrastructure, pillar, and overall payloads can move.
export const RESILIENCE_SCORE_CACHE_PREFIX = 'resilience:score:v25:';
// Bumped from v4 to v5 in the pillar-combined activation PR. Provides
// a clean slate at PR deploy so pre-PR history points (which were
// written without a formula tag) do not mix with tagged points. NOTE:
// the version bump alone is NOT sufficient because the flag defaults
// to off, so v5 accumulates d6-tagged entries during the default-off
// window. The real cross-formula guard is the `:d6` / `:pc` suffix on
// each sorted-set member written by `appendHistory` and filtered by
// `buildResilienceScore` before change30d / trend are computed. Legacy
// untagged members (from older deploys that happen to survive on v4
// readers) decode as `d6` — matching the only formula that existed
// before this PR — so the filter stays correct in either direction.
// v7 bump in lockstep with RESILIENCE_SCORE_CACHE_PREFIX v11→v12 for
// PR 3A §net-imports denominator. Pre-bump history points were written
// against gross-imports-denominated scores; mixing them with net-imports
// points inside a rolling 30-day window would manufacture false
// "falling" trends for re-export hubs on day one of deploy (history's
// moving average mixes v11 scores from day -29 with v12 scores from
// day 0, exactly the scenario the cache-prefix-bump-propagation-scope
// skill warns against). Rotation forces a clean 30-day window.
// v7→v8 bump in lockstep with RESILIENCE_SCORE_CACHE_PREFIX v12→v13 for
// plan 2026-04-25-004 Phase 1 (Ship 1) — same reasoning: pre-rename
// economic-domain history points must not mix with post-rename points
// inside the rolling 30-day window or the trend signal goes haywire.
// v8→v9 bump in lockstep with RESILIENCE_SCORE_CACHE_PREFIX v13→v14 for
// plan 2026-04-25-004 Phase 2 (Ship 2) — same reasoning. Adding a new
// dim shifts every country's overall-score baseline; mixing pre/post
// points in the 30-day rolling window manufactures false trends.
// v9→v10 bump in lockstep with RESILIENCE_SCORE_CACHE_PREFIX v14→v15 for
// plan 2026-04-26-001 §U4 (small-state bias fixes A+B+C). Mixing pre-fix
// v9 history points with post-fix v15 score points inside the 30-day
// rolling window would produce false-trend signals across the deploy
// (memory: cache-prefix-bump-propagation-scope).
// v10→v11 bump in lockstep with RESILIENCE_SCORE_CACHE_PREFIX v15→v16
// for plan 2026-04-26-002 §U4+U5+U6 (combined PR 3+4+5). Mixing pre-fix
// v10 history points with post-fix v16 score points inside the 30-day
// rolling window would produce false-trend signals — the score-formula
// shift this PR introduces is one of the largest in the index's history.
// v11→v12 bump in lockstep with RESILIENCE_SCORE_CACHE_PREFIX v16→v17
// for plan 2026-04-26-002 §U7 (PR 6). Per the cache-prefix-bump-
// propagation-scope skill: history points written under v11 reflect
// the PR-2 "all-true headlineEligible" world; mixing them with v17
// score points across the rolling 30-day window risks no behavior
// shift on history (history doesn't carry the field), but rotating
// in lockstep keeps the bump pattern consistent and the audit trail
// clean.
// v12→v13 bump in lockstep with RESILIENCE_SCORE_CACHE_PREFIX v17→v18
// for plan 2026-04-26-002 §U8.1 (liquidReserveAdequacy net-imports).
// Pre-bump history points for AE and PA were written against the
// gross-imports-denominated reserves-in-months value; mixing them
// inside the rolling 30-day window with post-fix net-imports points
// would manufacture a false "improving" trend on day one of deploy
// (history's moving average mixes v12 scores from day -29 with v13
// scores from day 0). Same skill (cache-prefix-bump-propagation-scope)
// that motivated the v6→v7 bump for the SWF-side fix in PR 3A.
// v13→v14 bump in lockstep with RESILIENCE_SCORE_CACHE_PREFIX v18→v19
// for issue #3971. Mixing uncapped cyberDigital history points with
// capped points inside the rolling 30-day trend window would manufacture
// false changes for countries hit by a single-day cyber-feed burst.
// v15→v16 bump in lockstep with RESILIENCE_SCORE_CACHE_PREFIX v20→v21 for
// the P1-1 `pc` aggregation fix. Mixing coverage-only pillar history with
// domain-weighted pillar history would manufacture false 30-day changes.
// v16→v17 bump in lockstep with RESILIENCE_SCORE_CACHE_PREFIX v21→v22 for
// the inflation-stability scorer change; otherwise old and new currency
// external baselines would mix inside the rolling 30-day trend window.
// v17→v18 bump in lockstep with RESILIENCE_SCORE_CACHE_PREFIX v22→v23 for
// the batched import-HHI certainty derate, P3-8 outage semantics, and WTO
// severity scoring changes; otherwise pre-change and post-change scores would
// mix inside the rolling 30-day trend window and manufacture deploy-day trends.
// v18→v19 bump in lockstep with RESILIENCE_SCORE_CACHE_PREFIX v23→v24 for
// the WGI governance indicator-slot semantics change. History points written
// from pre-change governance/state-continuity scores must not mix with v24
// scores inside the rolling 30-day trend window.
// v19→v20 bump in lockstep with RESILIENCE_SCORE_CACHE_PREFIX v24→v25 for
// issue #4009 so pre-smoothing cyberDigital history points do not mix with
// discovery-decayed points inside the rolling 30-day trend window.
export const RESILIENCE_HISTORY_KEY_PREFIX = 'resilience:history:v20:';
// v12 bump in lockstep with RESILIENCE_SCORE_CACHE_PREFIX (v11 → v12)
// for PR 3A §net-imports denominator. As with the score prefix, the
// version bump is a belt — the suspenders are cache-only metadata on
// the ranking payload itself, written via stampRankingCacheTag and
// read via rankingCacheTagMatches in the ranking handler. `_formula`
// forces a recompute-and-publish on a cross-formula cache hit; the
// interval-methodology tag forces the same for rankStable values baked
// from stale interval-generation semantics. v12→v13 bump
// in lockstep with RESILIENCE_SCORE_CACHE_PREFIX for plan 2026-04-25-004
// Phase 1 (Ship 1). v13→v14 bump in lockstep with RESILIENCE_SCORE_CACHE_PREFIX
// for plan 2026-04-25-004 Phase 2 (Ship 2).
// v15→v16 bump in lockstep with RESILIENCE_SCORE_CACHE_PREFIX for
// plan 2026-04-26-002 §U4+U5+U6 (combined PR 3+4+5).
// v16→v17 bump in lockstep with RESILIENCE_SCORE_CACHE_PREFIX for
// plan 2026-04-26-002 §U7 (PR 6). v16 cached rankings include items
// flagged headlineEligible:true unconditionally (PR 2 default); they
// would serve as the front-of-house ranking for the full 6h TTL even
// after the gate logic flips. Bump forces a clean recompute against
// the v17 score entries, which now carry the real headlineEligible.
// v17→v18 bump in lockstep with RESILIENCE_SCORE_CACHE_PREFIX for plan
// 2026-04-26-002 §U8.1. Without it, the v17 ranking payload (with
// pre-fix AE liquidReserveAdequacy) would continue to serve for the
// full 12h ranking TTL post-deploy. v18 forces a clean recompute
// against post-fix v18 score entries.
// v18→v19 bump in lockstep with RESILIENCE_SCORE_CACHE_PREFIX for issue
// #3971 so the public ranking recomputes against capped cyberDigital
// score entries instead of serving the pre-cap aggregate for 12h.
// v19→v20 bump in lockstep with RESILIENCE_SCORE_CACHE_PREFIX for P1-3
// so ranking items recompute against staleness-derated confidence
// coverage instead of serving old overallCoverage/headlineEligible.
// v20→v21 bump in lockstep with RESILIENCE_SCORE_CACHE_PREFIX for the P1-1
// `pc` aggregation fix. v20 is reserved for the parallel staleness-derate
// rollout, so this branch sequences the next same-tag `pc` ranking into v21.
// v21→v22 bump in lockstep with RESILIENCE_SCORE_CACHE_PREFIX for the
// inflation-stability scorer change so the public ranking recomputes against
// v22 score entries instead of serving pre-fix aggregates for 12h.
// v22→v23 bump in lockstep with RESILIENCE_SCORE_CACHE_PREFIX for the batched
// import-HHI certainty derate, P3-8 outage semantics, and WTO severity scoring
// changes so the public ranking recomputes against v23 score entries instead
// of serving pre-fix aggregates for 12h.
// v23→v24 bump in lockstep with RESILIENCE_SCORE_CACHE_PREFIX for the PR #4101
// WGI governance indicator-slot semantics change so the public ranking
// recomputes against v24 score entries instead of serving pre-change aggregates
// for 12h.
// v24→v25 bump in lockstep with RESILIENCE_SCORE_CACHE_PREFIX for issue #4009
// so the public ranking recomputes against discovery-decayed cyberDigital score
// entries instead of serving pre-change aggregates for 12h.
export const RESILIENCE_RANKING_CACHE_KEY = 'resilience:ranking:v25';
export const RESILIENCE_STATIC_INDEX_KEY = 'resilience:static:index:v1';
// v2→v3: issue #3967. v2 intervals were still generated by jittering
// six-domain weights after the pillar-combined score formula activated,
// so scoreInterval/rankStable could mix pc scores with d6-shaped bands.
// v3 payloads carry a `_formula` tag and readers reject untagged or
// stale-formula entries, mirroring score/ranking cache isolation.
// v4→v5: P1-1 changes the same-tag `pc` pillar scores that intervals
// perturb around, so old interval bands must not be reused.
// v5→v6: P2-N2 changes currencyExternal score inputs under the same formula
// tag, so old sensitivity bands must not be served with v22 scores.
// v6→v7: the v23 batch changes same-tag `pc` baselines through import-HHI
// certainty coverage, P3-8 outage semantics, and WTO severity scoring, so old
// rank-stability bands must not be served with v23 scores.
// v7→v8: PR #4101 changes same-tag `pc` baselines through governance WGI
// indicator-slot semantics, so old rank-stability bands must not be served
// with v24 scores.
// v8→v9: issue #4009 changes same-tag `pc` cyberDigital baselines through
// discovery-day smoothing, so old rank-stability bands must not be served with
// v25 scores.
export const RESILIENCE_INTERVAL_KEY_PREFIX = 'resilience:intervals:v9:';
export const RESILIENCE_INTERVAL_METHODOLOGY = 'weight-perturbation-sensitivity-v3';
export const RESILIENCE_STATIC_META_KEY = 'seed-meta:resilience:static';
export const RESILIENCE_RANKING_META_KEY = 'seed-meta:resilience:ranking';
export const RESILIENCE_INTERVALS_META_KEY = 'seed-meta:resilience:intervals';
export const RESILIENCE_RANKING_META_TTL_SECONDS = 7 * 24 * 60 * 60;
const RANK_STABLE_MAX_INTERVAL_WIDTH = 8;

const LOW_CONFIDENCE_COVERAGE_THRESHOLD = 0.55;
const LOW_CONFIDENCE_IMPUTATION_SHARE_THRESHOLD = 0.40;
const STALENESS_CONFIDENCE_COVERAGE_FACTOR: Record<string, number> = {
  '': 1.0,
  fresh: 1.0,
  aging: 0.7,
  stale: 0.4,
};

// Cache formula tag. Stored inside score + ranking JSON payloads and as
// a suffix in history sorted-set member strings so the reader can reject
// or filter cross-formula entries at serve time. This is the actual
// isolation mechanism; the v9→v10 score/ranking and v4→v5 history key
// version bumps only provide a clean-slate at PR deploy and do NOT by
// themselves protect against the default-off-then-activate path —
// default-off writes land in the new v10/v5 namespace tagged as 'd6',
// and only the in-payload tag check forces a rebuild / filter on flip.
type CacheFormulaTag = 'd6' | 'pc';

function currentCacheFormula(): CacheFormulaTag {
  // Mirrors the gating in buildResilienceScore's overallScore branch so
  // the tag we stamp on write equals the formula actually used. If
  // schemaV2 is off or the pillar combine flag is off, writes tag 'd6'
  // and reads require 'd6' — matching the 6-domain aggregate code path.
  return isPillarCombineEnabled() && RESILIENCE_SCHEMA_V2_ENABLED ? 'pc' : 'd6';
}

interface ResilienceHistoryPoint {
  date: string;
  score: number;
  formula: CacheFormulaTag;
}

export interface ResilienceIntervalPayload {
  p05?: unknown;
  p95?: unknown;
  _formula?: unknown;
  draws?: unknown;
  computedAt?: unknown;
  methodology?: unknown;
}

interface ResilienceStaticIndex {
  countries?: string[];
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function normalizeCountryCode(countryCode: string): string {
  const normalized = String(countryCode || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(normalized) ? normalized : '';
}

export function scoreCacheKey(countryCode: string): string {
  return `${RESILIENCE_SCORE_CACHE_PREFIX}${countryCode}`;
}

function intervalCacheKey(countryCode: string): string {
  return `${RESILIENCE_INTERVAL_KEY_PREFIX}${countryCode}`;
}

async function readScoreInterval(countryCode: string): Promise<ScoreInterval | undefined> {
  const raw = await getCachedJson(intervalCacheKey(countryCode), true) as ResilienceIntervalPayload | null;
  return toCurrentScoreInterval(raw);
}

function historyKey(countryCode: string): string {
  return `${RESILIENCE_HISTORY_KEY_PREFIX}${countryCode}`;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

// Level thresholds are methodology-aware. The pillar-combined formula
// compresses the scale (~11-point mean drop across the 52-country live
// sample), so the legacy 70/40 thresholds misclassify top-tier countries
// as "medium" purely because the scale got compressed rather than
// because anything changed about the country (FI 75.64 → 68.60 and NZ
// 76.26 → 67.93 in the live sample both straddle the legacy 70 floor).
// The pillar-combined thresholds 60/30 are re-anchored against the live
// sample so the qualitative label stays stable for every country whose
// old label was correct; the 52-country sensitivity capture confirms
// all 7 high-band anchors stay ≥60 and all fragile-state anchors stay
// ≤30. Kept narrow: only the two thresholds move; the three-label
// taxonomy (high/medium/low) and downstream UI consumers are
// unchanged.
const LEVEL_THRESHOLDS_BY_FORMULA = {
  'domain-weighted-6d':          { high: 70, medium: 40 },
  'pillar-combined-penalized-v1': { high: 60, medium: 30 },
} as const;

function classifyResilienceLevel(score: number): string {
  const formula = isPillarCombineEnabled() && RESILIENCE_SCHEMA_V2_ENABLED
    ? 'pillar-combined-penalized-v1'
    : 'domain-weighted-6d';
  const { high, medium } = LEVEL_THRESHOLDS_BY_FORMULA[formula];
  if (score >= high) return 'high';
  if (score >= medium) return 'medium';
  return 'low';
}

export function buildDimensionList(
  scores: Record<
    ResilienceDimensionId,
    {
      score: number;
      coverage: number;
      observedWeight: number;
      imputedWeight: number;
      imputationClass: ImputationClass | null;
      freshness: { lastObservedAtMs: number; staleness: '' | 'fresh' | 'aging' | 'stale' };
    }
  >,
): ResilienceDimension[] {
  return RESILIENCE_DIMENSION_ORDER.map((dimensionId) => ({
    id: dimensionId,
    score: round(scores[dimensionId].score),
    coverage: round(scores[dimensionId].coverage),
    observedWeight: round(scores[dimensionId].observedWeight, 4),
    imputedWeight: round(scores[dimensionId].imputedWeight, 4),
    // T1.7 schema pass: empty string = dimension has any observed data.
    imputationClass: scores[dimensionId].imputationClass ?? '',
    // T1.5 propagation pass: proto `int64 last_observed_at_ms` comes through
    // as `string` on the generated TS interface; stringify the number here
    // so the response conforms to the generated type.
    freshness: {
      lastObservedAtMs: String(scores[dimensionId].freshness.lastObservedAtMs),
      staleness: scores[dimensionId].freshness.staleness,
    },
  }));
}

// Plan 2026-04-26-002 §U4 (combined PR 3+4+5) — fully-imputed dims
// (no observed data, scorer set imputationClass and observedWeight=0)
// contribute at IMPUTED_DIM_WEIGHT_FACTOR (0.5) of their nominal weight.
// Rationale: an imputed signal is a structural assumption, not measured
// evidence; counting it at full weight equates "we don't know" with "we
// measured." A coverage-weighted mean over mostly-imputed dims should
// not reach the same overall score as a coverage-weighted mean over
// mostly-observed dims at the same per-dim score. This is the empirical
// lever that finally pulls median(microstate-territories) below
// median(G7) — territories like Tuvalu/Palau hit ~95% of dims via IMPUTE
// (no IPC, no IMF SDDS, no BIS, etc.) and previously rode imputed 85s
// to false-high overall scores. Observed dims keep coverage × weight
// unchanged so countries like Iceland (peaceful + fully-monitored) do
// not regress.
const IMPUTED_DIM_WEIGHT_FACTOR = 0.5;

// Coverage-weighted mean with an optional per-dimension weight multiplier.
// Each dim's effective weight is `coverage * dimWeight * imputationFactor`,
// where imputationFactor = IMPUTED_DIM_WEIGHT_FACTOR (0.5) when the dim
// is fully imputed (imputationClass set, indicating no observed data),
// 1.0 otherwise. When all weights default to 1.0 and no dims are imputed
// this reduces to the original coverage-weighted mean. PR 2 §3.4 uses
// the weight channel to dial the two new recovery dims down to ~10%
// share (see RESILIENCE_DIMENSION_WEIGHTS in _dimension-scorers.ts).
// Retired dims have coverage=0 so they're neutralized at the coverage
// end; the weight channel stays 1.0 for them in the canonical map.
function coverageWeightedMean(dimensions: ResilienceDimension[]): number {
  let totalWeight = 0;
  let weightedSum = 0;
  for (const d of dimensions) {
    const w = RESILIENCE_DIMENSION_WEIGHTS[d.id as ResilienceDimensionId] ?? 1.0;
    // imputationClass is '' (empty string) when the dim has observed data
    // and a class label ('stable-absence' | 'unmonitored' | 'source-failure'
    // | 'not-applicable') when fully imputed. See buildDimensionList:323
    // and the scorer-side comment in _dimension-scorers.ts confirming the
    // class is only set when observedWeight === 0.
    const imputationFactor = d.imputationClass ? IMPUTED_DIM_WEIGHT_FACTOR : 1.0;
    const effective = d.coverage * w * imputationFactor;
    totalWeight += effective;
    weightedSum += d.score * effective;
  }
  if (!totalWeight) return 0;
  return weightedSum / totalWeight;
}

export const PENALTY_ALPHA = 0.50;

export function penalizedPillarScore(pillars: { score: number; weight: number }[]): number {
  if (pillars.length === 0) return 0;
  const weighted = pillars.reduce((sum, p) => sum + p.score * p.weight, 0);
  const minScore = Math.min(...pillars.map((p) => p.score));
  const penalty = 1 - PENALTY_ALPHA * (1 - minScore / 100);
  return Math.round(weighted * penalty * 100) / 100;
}

export function buildDomainList(dimensions: ResilienceDimension[]): ResilienceDomain[] {
  const grouped = new Map<ResilienceDomainId, ResilienceDimension[]>();
  for (const domainId of RESILIENCE_DOMAIN_ORDER) grouped.set(domainId, []);

  for (const dimension of dimensions) {
    const domainId = RESILIENCE_DIMENSION_DOMAINS[dimension.id as ResilienceDimensionId];
    grouped.get(domainId)?.push(dimension);
  }

  return RESILIENCE_DOMAIN_ORDER.map((domainId) => {
    const domainDimensions = grouped.get(domainId) ?? [];
    // Coverage-weighted mean: dimensions with low coverage (sparse data) contribute
    // proportionally less. Without this, a 0-coverage dimension (score=0) drags the
    // domain average down for countries that simply lack data in one sub-area.
    const domainScore = coverageWeightedMean(domainDimensions);
    return {
      id: domainId,
      score: round(domainScore),
      weight: getResilienceDomainWeight(domainId),
      dimensions: domainDimensions,
    };
  });
}

const HISTORY_SCORE_FRACTION_DIVISOR = 1_000;
const HISTORY_SCORE_FRACTION_SCALE = 100;
const HISTORY_SCORE_FRACTION_OFFSET = 1;

function dateScoreForHistory(date: string): number {
  return Number(date.replace(/-/g, ''));
}

function encodeHistoryScore(date: string, score: number): number {
  const scoreInteger = Math.round(round(score) * HISTORY_SCORE_FRACTION_SCALE);
  return dateScoreForHistory(date) + (scoreInteger + HISTORY_SCORE_FRACTION_OFFSET) / HISTORY_SCORE_FRACTION_DIVISOR / HISTORY_SCORE_FRACTION_SCALE;
}

function decodeHistoryScore(date: string, rawSortedSetScore: unknown): number {
  const sortedSetScore = Number(rawSortedSetScore);
  const dateScore = dateScoreForHistory(date);
  if (!Number.isFinite(sortedSetScore)) return 0;
  return round(
    (((sortedSetScore - dateScore) * HISTORY_SCORE_FRACTION_DIVISOR * HISTORY_SCORE_FRACTION_SCALE) - HISTORY_SCORE_FRACTION_OFFSET)
      / HISTORY_SCORE_FRACTION_SCALE,
  );
}

// Sorted-set member formats:
//   - Current: `YYYY-MM-DD:FORMULA`, with the score encoded into the ZSET
//     score as `YYYYMMDD + ((score*100)+1)/100000`. The member is stable per
//     day+formula, so same-day rebuilds update the existing point instead of
//     shrinking the effective rolling window with duplicate same-day members.
//   - Legacy: `YYYY-MM-DD:SCORE[:FORMULA]`. Untagged members predate the
//     pillar-combined activation and are implicitly 'd6' (the only formula in
//     use before this PR).
//
// On activation, readHistory callers filter by `currentCacheFormula()` so a
// 30-day window of d6 points is not silently compared against a fresh pc point
// (which would manufacture a ranking-wide fake-negative change30d / false
// "falling" trend on day one).
function parseHistoryPoints(raw: unknown): ResilienceHistoryPoint[] {
  if (!Array.isArray(raw)) return [];
  const historyByDateFormula = new Map<string, { point: ResilienceHistoryPoint; stableMember: boolean }>();

  for (let index = 0; index < raw.length; index += 2) {
    const member = String(raw[index] || '');
    const parts = member.split(':');
    if (parts.length < 2) continue;
    const date = parts[0]!;
    const secondPart = parts[1]!;
    const stableMember = secondPart === 'd6' || secondPart === 'pc';
    const score = stableMember ? decodeHistoryScore(date, raw[index + 1]) : Number(secondPart);
    const rawFormula = stableMember ? secondPart : parts[2];
    const formula: CacheFormulaTag = rawFormula === 'pc' ? 'pc' : 'd6';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(score)) continue;
    const key = `${date}:${formula}`;
    const previous = historyByDateFormula.get(key);
    if (!previous || stableMember || !previous.stableMember) {
      historyByDateFormula.set(key, { point: { date, score, formula }, stableMember });
    }
  }

  return [...historyByDateFormula.values()]
    .map((entry) => entry.point)
    .sort((left, right) => left.date.localeCompare(right.date));
}

// Plan 2026-04-26-002 §U7 (PR 6) — headline-eligible gate. Per origin
// Q2 + Q5: a country is eligible for the headline ranking iff
//   coverage >= 0.65 AND
//   (population >= 200k OR coverage >= 0.85) AND
//   NOT lowConfidence
// Population is in millions; 200k = 0.2M. The coverage>=0.85 branch is
// the data-quality compensator: a tiny state with high data quality
// (Iceland, Liechtenstein, Monaco) can still earn headline status
// even though its population is below the 200k threshold.
//
// `populationMillions` is `null` when the country has no IMF labor
// entry. Per the conservative-default rule, unknown population fails
// the population branch — eligibility then depends entirely on the
// coverage>=0.85 branch. This avoids inflating eligibility by
// assuming a default population.
export const HEADLINE_ELIGIBLE_MIN_COVERAGE = 0.65;
export const HEADLINE_ELIGIBLE_MIN_POPULATION_MILLIONS = 0.2;
export const HEADLINE_ELIGIBLE_HIGH_COVERAGE = 0.85;

export function computeHeadlineEligible(args: {
  overallCoverage: number;
  populationMillions: number | null;
  lowConfidence: boolean;
}): boolean {
  if (args.lowConfidence) return false;
  if (args.overallCoverage < HEADLINE_ELIGIBLE_MIN_COVERAGE) return false;
  const popOk = args.populationMillions != null
    && args.populationMillions >= HEADLINE_ELIGIBLE_MIN_POPULATION_MILLIONS;
  const highCoverageOk = args.overallCoverage >= HEADLINE_ELIGIBLE_HIGH_COVERAGE;
  return popOk || highCoverageOk;
}

export function computeLowConfidence(dimensions: ResilienceDimension[], imputationShare: number): boolean {
  // Exclude RETIRED dimensions (fuelStockDays, post-PR-3) from the
  // confidence reading. They contribute zero weight to domain scoring
  // via coverageWeightedMean, so including them in a flat coverage mean
  // would drag the user-facing confidence signal down for every country
  // purely because of a deliberate construct retirement.
  //
  // IMPORTANT: we do NOT filter by `coverage === 0` because a genuinely
  // sparse-data country can legitimately produce coverage=0 on non-
  // retired dims via weightedBlend fall-through, and those coverage=0
  // entries SHOULD drag the confidence down — that is precisely the
  // sparse-data signal lowConfidence exists to surface.
  //
  // Staleness now derates the coverage signal for observed-but-old data:
  // a stale snapshot is still a measured score, but it should not look
  // as confidence-worthy as a fresh observed snapshot. Missing freshness
  // proof (`lastObservedAtMs=0`) is left to the existing sparse-data and
  // source-failure paths so this slice only changes stale observed data.
  //
  // INTENTIONALLY NOT weighted by RESILIENCE_DIMENSION_WEIGHTS. The
  // coverage signal answers a different question from the scoring
  // aggregation: "how much real data do we have on this country?"
  // vs "how much does each dim matter to the overall score?" A dim
  // with coverage=0.3 has sparse data regardless of how little it
  // contributes to the final number — and the user-facing
  // "Low confidence" label is about data availability, not score
  // composition. The asymmetry is deliberate and mirrored in
  // `computeOverallCoverage` below.
  // Plan 2026-04-26-001 §U3: filter via the single-source helper so the
  // RETIRED + NOT_APPLICABLE_WHEN_ZERO_COVERAGE decision lives in one
  // place across both readers (this one and computeOverallCoverage).
  const scoring = dimensions.filter((dimension) => !isExcludedFromConfidenceMean(dimension));
  const averageCoverage = mean(scoring.map((dimension) => confidenceCoverage(dimension))) ?? 0;
  return averageCoverage < LOW_CONFIDENCE_COVERAGE_THRESHOLD || imputationShare > LOW_CONFIDENCE_IMPUTATION_SHARE_THRESHOLD;
}

async function readHistory(countryCode: string): Promise<ResilienceHistoryPoint[]> {
  const result = await runRedisPipeline([
    ['ZRANGE', historyKey(countryCode), 0, -1, 'WITHSCORES'],
  ]);
  return parseHistoryPoints(result[0]?.result);
}

async function appendHistory(
  countryCode: string,
  overallScore: number,
  formula: CacheFormulaTag,
): Promise<void> {
  const today = todayIsoDate();
  const dateScore = dateScoreForHistory(today);
  // Current member format `YYYY-MM-DD:FORMULA` — see parseHistoryPoints above
  // for the backwards-compatible reader. The formula tag is required because
  // the history prefix bump happens at PR deploy, not at flag flip, so the
  // series can accumulate d6-tagged entries during the default-off window; only
  // the per-member tag lets the reader correctly filter those out when the
  // pillar-combined formula later activates. Remove legacy same-day members
  // first so old `YYYY-MM-DD:SCORE:FORMULA` duplicates stop consuming the
  // 30-member rolling window after the next write.
  await runRedisPipeline([
    ['ZREMRANGEBYSCORE', historyKey(countryCode), dateScore, dateScore],
    ['ZADD', historyKey(countryCode), encodeHistoryScore(today, overallScore), `${today}:${formula}`],
    ['ZREMRANGEBYRANK', historyKey(countryCode), 0, -31],
  ]);
}

// Pure compute: no caching, no Redis side-effects (except appendHistory, which
// is part of the score semantics). Kept separate from `ensureResilienceScoreCached`
// so the ranking warm path can persist with explicit write-verification via a
// pipeline (see `warmMissingResilienceScores`) rather than trusting
// `cachedFetchJson`'s log-and-swallow write semantics.
async function buildResilienceScore(
  normalizedCountryCode: string,
  reader?: ResilienceSeedReader,
): Promise<GetResilienceScoreResponse> {
  const staticMeta = await getCachedJson(RESILIENCE_STATIC_META_KEY, true) as { fetchedAt?: number } | null;
  const dataVersion = staticMeta?.fetchedAt
    ? new Date(staticMeta.fetchedAt).toISOString().slice(0, 10)
    : todayIsoDate();

  // Plan §U7 (PR 6) — memoize the seed reader once at the top of the
  // build so the IMF labor seed read for the headline-eligible gate
  // (below) shares the cache with the dimension scorers' reads.
  const seedReader = reader ?? createMemoizedSeedReader();
  const scoreMap = await scoreAllDimensions(normalizedCountryCode, seedReader);
  const dimensions = buildDimensionList(scoreMap);
  const domains = buildDomainList(dimensions);
  const pillars = buildPillarList(domains, true);

  const baselineDims: ResilienceDimension[] = [];
  const stressDims: ResilienceDimension[] = [];
  for (const dim of dimensions) {
    const dimType = RESILIENCE_DIMENSION_TYPES[dim.id as ResilienceDimensionId];
    if (dimType === 'baseline' || dimType === 'mixed') baselineDims.push(dim);
    if (dimType === 'stress' || dimType === 'mixed') stressDims.push(dim);
  }
  const baselineScore = round(coverageWeightedMean(baselineDims));
  const stressScore = round(coverageWeightedMean(stressDims));
  const stressFactor = round(Math.max(0, Math.min(1 - stressScore / 100, 0.5)), 4);
  // Phase 2 T2.3 activation: `overallScore` is either the legacy
  // 6-domain weighted aggregate (compensatory, `Σ domain.score *
  // domain.weight`) or the pillar-combined penalized form (non-
  // compensatory, `penalizedPillarScore(pillars)`), controlled by
  // `RESILIENCE_PILLAR_COMBINE_ENABLED` + `RESILIENCE_SCHEMA_V2_ENABLED`.
  // We only activate the pillar combine when v2 is on because the
  // pillar list is empty under v1 and `penalizedPillarScore([])` returns
  // 0 — that would silently zero every country's score if the flags
  // were out of sync.
  const domainAggregate = round(domains.reduce((sum, d) => sum + d.score * d.weight, 0));
  const pillarEligible = isPillarCombineEnabled() && RESILIENCE_SCHEMA_V2_ENABLED && pillars.length > 0;
  const overallScore = pillarEligible
    ? round(penalizedPillarScore(pillars.map((p) => ({ score: p.score, weight: p.weight }))))
    : domainAggregate;
  // Tag MUST match the branch that actually computed overallScore so
  // the reader's stale-formula check in ensureResilienceScoreCached
  // correctly rejects cross-formula cache entries when the env flag
  // flips later. currentCacheFormula() reads the same two flags, so
  // the derivation is intentionally redundant-by-agreement.
  const formula: CacheFormulaTag = pillarEligible ? 'pc' : 'd6';

  const totalImputed = dimensions.reduce((sum, d) => sum + (d.imputedWeight ?? 0), 0);
  const totalObserved = dimensions.reduce((sum, d) => sum + (d.observedWeight ?? 0), 0);
  const imputationShare = (totalImputed + totalObserved) > 0
    ? round(totalImputed / (totalImputed + totalObserved), 4)
    : 0;

  // Filter history to the CURRENT formula only. Points tagged with the
  // other formula are excluded from change30d / trend so the first
  // post-flip score is not diffed against a 30-day window of the other
  // formula's values (which would emit a fake-negative change30d and
  // a false "falling" trend across the ranking on activation day).
  const history = (await readHistory(normalizedCountryCode))
    .filter((point) => point.formula === formula)
    .filter((point) => point.date !== todayIsoDate());
  const scoreSeries = [...history.map((point) => point.score), overallScore];
  const oldestScore = history[0]?.score;

  await appendHistory(normalizedCountryCode, overallScore, formula);

  const lowConfidence = computeLowConfidence(dimensions, imputationShare);
  // Plan 2026-04-26-002 §U7 (PR 6) — headline-eligible gate flips from
  // PR 2's "true everywhere" to actual eligibility logic. Three
  // conjuncts (per origin Q2 + Q5):
  //   1. coverage >= 0.65 (≥ 65% of dims have observed data)
  //   2. population >= 200k OR coverage >= 0.85 (real-state size OR
  //      data quality high enough to compensate for tiny pop)
  //   3. NOT lowConfidence (which already gates ≥ 50% imputation share)
  // Population is read fresh from IMF labor; the helper returns the
  // REAL population (no §U6 0.5M floor) so a tiny state with known
  // sub-200k pop is correctly excluded via conjunct 2 — falling
  // through to the floor would inflate the gate's permissiveness.
  // Unknown population is treated as `null` → conjunct 2 evaluates
  // to "coverage >= 0.85" alone, which is the conservative behavior:
  // an unknown-pop country only earns headline status via high data
  // quality, not via assumption.
  const imfLaborRaw = await seedReader(RESILIENCE_IMF_LABOR_KEY);
  const overallCoverageForGate = computeOverallCoverage({ domains } as GetResilienceScoreResponse);
  const populationMillionsForGate = readCountryPopulationMillionsForGate(imfLaborRaw, normalizedCountryCode);
  const headlineEligible = computeHeadlineEligible({
    overallCoverage: overallCoverageForGate,
    populationMillions: populationMillionsForGate,
    lowConfidence,
  });

  return {
    countryCode: normalizedCountryCode,
    overallScore,
    baselineScore,
    stressScore,
    stressFactor,
    level: classifyResilienceLevel(overallScore),
    domains,
    trend: detectTrend(scoreSeries),
    change30d: oldestScore == null ? 0 : round(overallScore - oldestScore),
    lowConfidence,
    imputationShare,
    dataVersion,
    pillars,
    schemaVersion: '2.0',
    headlineEligible,
  };
}

// The shape we actually store in Redis. Extends the public response type
// with a `_formula` marker so the reader can reject cross-formula cache
// entries when `RESILIENCE_PILLAR_COMBINE_ENABLED` flips later. The
// marker is stripped before the payload crosses back to callers.
type CachedScorePayload = GetResilienceScoreResponse & { _formula?: CacheFormulaTag };

function stripCacheMeta(payload: CachedScorePayload): GetResilienceScoreResponse {
  const { _formula: _drop, ...rest } = payload;
  void _drop;
  // Plan 2026-04-26-002 §U3+§U7 — `headlineEligible` backfill semantic
  // changes per cache prefix:
  //
  //   v16 (PR 2): every score build emitted true unconditionally.
  //   Missing-from-cache meant "pre-field v16 entry" → backfill `true`
  //   matched the PR-2 contract.
  //
  //   v17 (PR 6 / §U7): every legitimate score writer stamps the field
  //   explicitly via computeHeadlineEligible. Missing-from-cache is
  //   anomalous (partially-migrated, manual seed, future writer bug),
  //   so the conservative default is `false` per Greptile P2 review of
  //   PR #3469. Anything not explicitly stamped is not trusted to pass
  //   the gate; the next cron tick will overwrite with real eligibility.
  //
  // TypeScript types are erased at runtime so without this backfill the
  // wire response would carry `undefined` and break downstream
  // `=== true / === false` discriminators.
  if (rest.headlineEligible === undefined) {
    return { ...rest, headlineEligible: false };
  }
  return rest;
}

// Exposed helpers so the ranking handler can apply the same
// stale-formula invalidation to its own cache key. Kept in this module
// alongside the score versions so the tag convention has one source of
// truth; a diverging derivation elsewhere would re-introduce the cross-
// formula drift this whole pattern is meant to prevent.
export function getCurrentCacheFormula(): CacheFormulaTag {
  return currentCacheFormula();
}

export function stampRankingCacheTag<T extends object>(
  payload: T,
): T & { _formula: CacheFormulaTag; _intervalMethodology: typeof RESILIENCE_INTERVAL_METHODOLOGY } {
  return {
    ...payload,
    _formula: currentCacheFormula(),
    _intervalMethodology: RESILIENCE_INTERVAL_METHODOLOGY,
  };
}

export function rankingCacheTagMatches(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const tag = (payload as { _formula?: unknown })._formula;
  const intervalMethodology = (payload as { _intervalMethodology?: unknown })._intervalMethodology;
  return tag === currentCacheFormula() && intervalMethodology === RESILIENCE_INTERVAL_METHODOLOGY;
}

export function isCurrentResilienceIntervalPayload(
  value: unknown,
): value is ResilienceIntervalPayload & {
  p05: number;
  p95: number;
  _formula: string;
  methodology: typeof RESILIENCE_INTERVAL_METHODOLOGY;
} {
  if (!value || typeof value !== 'object') return false;
  const payload = value as ResilienceIntervalPayload;
  return (
    typeof payload.p05 === 'number' &&
    Number.isFinite(payload.p05) &&
    typeof payload.p95 === 'number' &&
    Number.isFinite(payload.p95) &&
    payload.p05 >= 0 &&
    payload.p05 <= 100 &&
    payload.p95 >= 0 &&
    payload.p95 <= 100 &&
    payload.p05 <= payload.p95 &&
    payload._formula === currentCacheFormula() &&
    payload.methodology === RESILIENCE_INTERVAL_METHODOLOGY
  );
}

export function toCurrentScoreInterval(value: unknown): ScoreInterval | undefined {
  if (!isCurrentResilienceIntervalPayload(value)) return undefined;
  return { p05: value.p05, p95: value.p95 };
}

export async function ensureResilienceScoreCached(countryCode: string, reader?: ResilienceSeedReader): Promise<GetResilienceScoreResponse> {
  const normalizedCountryCode = normalizeCountryCode(countryCode);
  if (!normalizedCountryCode) {
    return {
      countryCode: '',
      overallScore: 0,
      baselineScore: 0,
      stressScore: 0,
      stressFactor: 0.5,
      level: 'unknown',
      domains: [],
      trend: 'stable',
      change30d: 0,
      lowConfidence: true,
      imputationShare: 0,
      dataVersion: '',
      // Phase 2 T2.1: fallback path always ships the v1 shape so the
      // generated TS types stay satisfied without dragging the empty
      // helper into a code path that has no domains to walk.
      pillars: [],
      schemaVersion: '1.0',
      // Plan §U3: invalid country code → not headline-eligible (the
      // PR 6 logic requires a real country first; the pre-PR-6 default
      // of `true` does not apply to the empty-country fallback).
      headlineEligible: false,
    };
  }

  const current = currentCacheFormula();
  const cacheKey = scoreCacheKey(normalizedCountryCode);

  let cached = await cachedFetchJson<CachedScorePayload>(
    cacheKey,
    RESILIENCE_SCORE_CACHE_TTL_SECONDS,
    async () => {
      const built = await buildResilienceScore(normalizedCountryCode, reader);
      // Tag with the formula buildResilienceScore actually used so
      // downstream readers can reject cross-formula entries.
      return { ...built, _formula: current };
    },
    300,
  );

  // Stale-formula guard. On activation day (flag flip), cached entries
  // from the previous formula are still in Redis under the same key
  // (v10 bump happens at PR deploy, not at flip time). The `_formula`
  // tag we wrote on the cached payload lets us detect and overwrite
  // the stale entry at read time. Without this, a 6-hour post-flip
  // window would keep serving legacy scores. Legacy untagged entries
  // (pre-PR writes that happen to survive the v9→v10 bump via
  // external writers) are treated as stale-formula and rebuilt.
  if (cached && cached._formula !== current) {
    const rebuilt = await buildResilienceScore(normalizedCountryCode, reader);
    cached = { ...rebuilt, _formula: current };
    await setCachedJson(cacheKey, cached, RESILIENCE_SCORE_CACHE_TTL_SECONDS);
  }

  let payload: GetResilienceScoreResponse = cached
    ? stripCacheMeta(cached)
    : {
        countryCode: normalizedCountryCode,
        overallScore: 0,
        baselineScore: 0,
        stressScore: 0,
        stressFactor: 0.5,
        level: 'unknown',
        domains: [],
        trend: 'stable',
        change30d: 0,
        lowConfidence: true,
        imputationShare: 0,
        dataVersion: '',
        pillars: [],
        schemaVersion: '1.0',
        // Plan §U3: missing-cache fallback → not headline-eligible. A
        // country without a successful score build can't make the
        // PR 6 coverage gate either, so the conservative default is
        // false even during the PR-2 "true-by-default" window.
        headlineEligible: false,
      };

  const scoreInterval = await readScoreInterval(normalizedCountryCode);
  if (scoreInterval) {
    payload = { ...payload, scoreInterval };
  }

  // P1 fix: the cache always stores the v2 superset (pillars + schemaVersion='2.0').
  // When the flag is off, strip pillars and downgrade schemaVersion so consumers
  // see the v1 shape. Flag flips take effect immediately, no 6h TTL wait.
  if (!RESILIENCE_SCHEMA_V2_ENABLED) {
    payload.pillars = [];
    payload.schemaVersion = '1.0';
  }

  return payload;
}

export async function listScorableCountries(): Promise<string[]> {
  const manifest = await getCachedJson(RESILIENCE_STATIC_INDEX_KEY, true) as ResilienceStaticIndex | null;
  return (manifest?.countries ?? [])
    .map((countryCode) => normalizeCountryCode(String(countryCode || '')))
    .filter(Boolean)
    // Plan 2026-04-26-002 §U2 (PR 1, review fixup): defense-in-depth
    // universe filter at the handler-side read, so the rankable-universe
    // contract is enforced regardless of the static index's seed
    // version. Without this, a stale ~222-country manifest from a
    // pre-PR-1 seed would still drive the ranking endpoint to serve
    // all 222 countries even after PR 1 merges. The filter is
    // idempotent: a fresh manifest from `seed-resilience-static.mjs`
    // (post-bump to source-version v8) is already filtered, so this
    // line is a no-op then.
    .filter(isInRankableUniverse);
}

export async function getCachedResilienceScores(countryCodes: string[]): Promise<Map<string, GetResilienceScoreResponse>> {
  const normalized = countryCodes
    .map((countryCode) => normalizeCountryCode(countryCode))
    .filter(Boolean);
  if (normalized.length === 0) return new Map();

  const results = await runRedisPipeline(normalized.map((countryCode) => ['GET', scoreCacheKey(countryCode)]));
  const scores = new Map<string, GetResilienceScoreResponse>();
  const current = currentCacheFormula();

  for (let index = 0; index < normalized.length; index += 1) {
    const countryCode = normalized[index]!;
    const raw = results[index]?.result;
    if (typeof raw !== 'string') continue;
    try {
      // Envelope-aware: resilience score keys are written by seed-resilience-scores
      // in contract mode (PR 2). unwrapEnvelope is a no-op on legacy bare-shape.
      const parsed = unwrapEnvelope(JSON.parse(raw)).data as CachedScorePayload;
      if (!parsed) continue;
      // Stale-formula skip: this bulk read feeds the ranking handler,
      // which mirrors the single-country cache miss path. Leaving the
      // country out of `scores` causes the ranking handler's
      // warmMissingResilienceScores step to rebuild it with the current
      // formula, producing a coherent same-formula ranking. Without
      // this filter, a flip would serve a mixed-formula ranking for
      // up to the 6h score TTL.
      //
      // IMPORTANT: the condition intentionally matches `undefined` too
      // (not `parsed._formula && parsed._formula !== current`). Legacy
      // untagged entries carry no `_formula` — they were written by a
      // pre-PR code path or by an external writer that has not been
      // updated — and must be treated as stale so the ranking warm
      // path rebuilds them with the current tag. The `&&` short-circuit
      // would admit them and re-introduce the cross-formula drift the
      // whole cache-tag strategy is meant to prevent.
      if (parsed._formula !== current) continue;
      const publicPayload = stripCacheMeta(parsed);
      // P1 fix: cached payload is always v2 superset. Gate on serve.
      if (!RESILIENCE_SCHEMA_V2_ENABLED) {
        publicPayload.pillars = [];
        publicPayload.schemaVersion = '1.0';
      }
      scores.set(countryCode, publicPayload);
    } catch {
      // Ignore malformed cache entries and let the caller decide whether to warm them.
    }
  }

  return scores;
}

export const GREY_OUT_COVERAGE_THRESHOLD = 0.40;

export function computeOverallCoverage(response: GetResilienceScoreResponse): number {
  // Exclude RETIRED dimensions (fuelStockDays, post-PR-3) — their
  // coverage=0 is structural, not a sparsity signal, and should not
  // drag down the ranking widget's overallCoverage pill. Non-retired
  // coverage=0 dims (genuine weightedBlend fall-through) stay in the
  // average because they reflect real data sparsity for that country.
  // See `computeLowConfidence` for the matching rationale.
  //
  // Staleness derating mirrors `computeLowConfidence`: stale observed
  // snapshots lower the user-facing data-quality coverage pill without
  // changing the raw per-dimension coverage field or the score formula.
  //
  // INTENTIONALLY NOT weighted by RESILIENCE_DIMENSION_WEIGHTS —
  // same reason as `computeLowConfidence`: this is a data-availability
  // signal ("how much real data do we have?"), not a score-composition
  // signal ("how much does each dim matter?"). Applying the scoring
  // weights would let a dim at weight=0.5 hide half its sparsity
  // from the overallCoverage pill, which would confuse users reading
  // the coverage percentage as a data-quality indicator.
  const coverages = response.domains.flatMap((domain) =>
    domain.dimensions
      .filter((dimension) => !isExcludedFromConfidenceMean(dimension))
      .map((dimension) => confidenceCoverage(dimension)),
  );
  if (coverages.length === 0) return 0;
  return coverages.reduce((sum, coverage) => sum + coverage, 0) / coverages.length;
}

function confidenceCoverage(dimension: ResilienceDimension): number {
  const lastObservedAtMs = Number(dimension.freshness?.lastObservedAtMs ?? 0);
  if (!Number.isFinite(lastObservedAtMs) || lastObservedAtMs <= 0) {
    return dimension.coverage;
  }
  const staleness = dimension.freshness?.staleness ?? '';
  const factor = STALENESS_CONFIDENCE_COVERAGE_FACTOR[staleness] ?? 1.0;
  return dimension.coverage * factor;
}

function isRankStable(interval: ScoreInterval | null | undefined): boolean {
  if (!interval) return false;
  const width = interval.p95 - interval.p05;
  return Number.isFinite(width) && width >= 0 && width <= RANK_STABLE_MAX_INTERVAL_WIDTH;
}

export function buildRankingItem(
  countryCode: string,
  response?: GetResilienceScoreResponse | null,
  interval?: ScoreInterval | null,
): ResilienceRankingItem {
  if (!response) {
    return {
      countryCode,
      overallScore: -1,
      level: 'unknown',
      lowConfidence: true,
      overallCoverage: 0,
      rankStable: false,
      // Plan §U3: missing-score fallback → not headline-eligible.
      headlineEligible: false,
    };
  }

  return {
    countryCode,
    overallScore: response.overallScore,
    level: response.level,
    lowConfidence: response.lowConfidence,
    overallCoverage: computeOverallCoverage(response),
    rankStable: isRankStable(interval),
    // Plan 2026-04-26-002 §U3 (PR 2) — pass through the field from the
    // source-of-truth score response. PR 6 / §U7 swaps response.
    // headlineEligible to actual eligibility logic; ranking item passes
    // it through unchanged.
    headlineEligible: response.headlineEligible,
  };
}

export function sortRankingItems(items: ResilienceRankingItem[]): ResilienceRankingItem[] {
  return [...items].sort((left, right) => {
    if (left.overallScore !== right.overallScore) return right.overallScore - left.overallScore;
    return left.countryCode.localeCompare(right.countryCode);
  });
}

export interface ResilienceWarmFailure {
  countryCode: string;
  stage: 'compute' | 'persist';
  reason: string;
  retried: boolean;
}

export interface WarmedResilienceScores extends Map<string, GetResilienceScoreResponse> {
  failures: ResilienceWarmFailure[];
  failedCountryCodes: Set<string>;
}

function createWarmedResilienceScores(): WarmedResilienceScores {
  const warmed = new Map<string, GetResilienceScoreResponse>() as WarmedResilienceScores;
  warmed.failures = [];
  warmed.failedCountryCodes = new Set<string>();
  return warmed;
}

function recordWarmFailure(
  warmed: WarmedResilienceScores,
  failure: ResilienceWarmFailure,
): void {
  warmed.failures.push(failure);
  warmed.failedCountryCodes.add(failure.countryCode);
}

// Warms the resilience score cache for the given countries and returns a map
// of country-code → score for ONLY the scores whose writes actually landed in
// Redis. Two subtle requirements:
//
//   1. Avoid the Upstash REST write→re-read visibility lag. A /pipeline GET of
//      freshly-SET keys in the same Vercel invocation can return null even
//      when every SET succeeded — the pre-existing post-warm re-read tripped
//      this and silently dropped the ranking publish. See
//      `feedback_upstash_write_reread_race_in_handler.md`.
//   2. Still detect actual write failures. `cachedFetchJson`'s underlying
//      `setCachedJson` only logs and swallows on error, which would make a
//      transient /set failure look like a successful warm and publish a
//      ranking aggregate over missing per-country keys.
//
// The pipeline SET response is the authoritative persistence signal: it's
// synchronous with the write, so "result: OK" per command means the key is
// actually stored. We compute scores in memory (no caching), persist in one
// pipeline, and only include countries whose SET returned OK in the returned
// map. Callers should merge the map directly into their local `cachedScores`
// — no post-warm Redis re-read.
export async function warmMissingResilienceScores(
  countryCodes: string[],
  scoreBuilder: (
    countryCode: string,
    reader: ResilienceSeedReader,
  ) => Promise<GetResilienceScoreResponse> = buildResilienceScore,
): Promise<WarmedResilienceScores> {
  const uniqueCodes = [...new Set(countryCodes.map((countryCode) => normalizeCountryCode(countryCode)).filter(Boolean))];
  const warmed = createWarmedResilienceScores();
  if (uniqueCodes.length === 0) return warmed;

  // Share one memoized reader across all countries so global Redis keys (conflict events,
  // sanctions, unrest, etc.) are fetched only once instead of once per country.
  const sharedReader = createMemoizedSeedReader();
  const computed = await Promise.allSettled(
    uniqueCodes.map(async (cc) => ({ cc, score: await scoreBuilder(cc, sharedReader) })),
  );

  const scores: Array<{ cc: string; score: GetResilienceScoreResponse }> = [];
  for (let i = 0; i < computed.length; i++) {
    const result = computed[i]!;
    if (result.status === 'fulfilled') {
      scores.push(result.value);
    } else {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      recordWarmFailure(warmed, {
        countryCode: uniqueCodes[i]!,
        stage: 'compute',
        reason,
        retried: false,
      });
    }
  }
  const computeFailures = warmed.failures.filter((failure) => failure.stage === 'compute');
  if (computeFailures.length > 0) {
    const sample = computeFailures.slice(0, 10).map((f) => `${f.countryCode}(${f.reason})`).join(', ');
    console.warn(`[resilience] warm compute failed for ${computeFailures.length}/${uniqueCodes.length} countries: ${sample}${computeFailures.length > 10 ? '...' : ''}`);
  }
  if (scores.length === 0) return warmed;

  // Default `raw=false` so runRedisPipeline applies the env-based key prefix
  // (`preview:<sha>:` on preview/dev, empty in production). The normal score
  // reads (`getCachedResilienceScores`, `ensureResilienceScoreCached`) look in
  // the prefixed namespace via setCachedJson/cachedFetchJson; writing raw here
  // would (a) make preview warms invisible to subsequent preview reads and
  // (b) leak preview writes into the production-visible unprefixed namespace.
  //
  // Chunk size: a single 222-SET pipeline pushes ~600KB of body and routinely
  // exceeds REDIS_PIPELINE_TIMEOUT_MS (5s) on Vercel Edge → the runRedisPipeline
  // call returns `[]`, the persistence guard correctly returns an empty map,
  // and ranking publish gets dropped even though Upstash usually finishes the
  // writes a moment later. Splitting into ~30-command batches keeps each
  // pipeline body small enough to land well under the timeout while still
  // making one round-trip per batch.
  const SET_BATCH = 30;
  const current = currentCacheFormula();
  const allSetCommands = scores.map(({ cc, score }) => [
    'SET',
    scoreCacheKey(cc),
    // Stamp the formula tag on the written payload so the bulk-read
    // path in getCachedResilienceScores can filter stale entries after
    // a flag flip. Without this tag, warmed-then-flipped entries would
    // be served as-is until the 6h TTL expired.
    JSON.stringify({ ...score, _formula: current } satisfies CachedScorePayload),
    'EX',
    String(RESILIENCE_SCORE_CACHE_TTL_SECONDS),
  ]);
  // Fire all batches concurrently. Serial awaits would add 7 extra Upstash
  // round-trips for a 222-country warm (~100-500ms each on Edge). Each batch
  // is independent, so Promise.all collapses them into a single wall-clock
  // window bounded by the slowest batch. Failed batches are retried once and
  // merged per command so an initial OK is not lost if the retry transport
  // fails.
  const batches: Array<Array<Array<string>>> = [];
  for (let i = 0; i < allSetCommands.length; i += SET_BATCH) {
    batches.push(allSetCommands.slice(i, i + SET_BATCH));
  }

  const batchPersisted = (batch: Array<Array<string>>, results: Array<{ result?: unknown }>): boolean =>
    results.length === batch.length && results.every((result) => result?.result === 'OK');

  const batchOutcomes = await Promise.all(batches.map((batch) => runRedisPipeline(batch)));
  const retryBatchIndexes: number[] = [];
  for (let b = 0; b < batches.length; b++) {
    if (!batchPersisted(batches[b]!, batchOutcomes[b]!)) retryBatchIndexes.push(b);
  }
  const retryOutcomesByBatch = new Map<number, Array<{ result?: unknown }>>();
  if (retryBatchIndexes.length > 0) {
    const retryOutcomes = await Promise.all(retryBatchIndexes.map((batchIndex) => runRedisPipeline(batches[batchIndex]!)));
    for (let i = 0; i < retryBatchIndexes.length; i++) {
      retryOutcomesByBatch.set(retryBatchIndexes[i]!, retryOutcomes[i]!);
    }
  }

  const resultReason = (result: { result?: unknown } | undefined, fallback: string): string =>
    result ? `SET returned ${JSON.stringify(result.result ?? null)}` : fallback;
  const retriedBatchIndexes = new Set(retryBatchIndexes);
  const persistResults: Array<{ result?: unknown; reason?: string; retried: boolean }> = [];
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b]!;
    const batchResults = batchOutcomes[b]!;
    const batchRetried = retriedBatchIndexes.has(b);
    const retryResults = retryOutcomesByBatch.get(b);
    for (let j = 0; j < batch.length; j++) {
      const initialResult = batchResults.length === batch.length ? batchResults[j] : undefined;
      const retryResult = retryResults?.length === batch.length ? retryResults[j] : undefined;
      const persisted = initialResult?.result === 'OK' || retryResult?.result === 'OK';
      persistResults.push({
        result: persisted ? 'OK' : undefined,
        reason: persisted
          ? undefined
          : resultReason(retryResult, resultReason(initialResult, 'pipeline transport failure')),
        retried: batchRetried && initialResult?.result !== 'OK',
      });
    }
  }

  let persistFailures = 0;
  for (let i = 0; i < scores.length; i++) {
    const { cc, score } = scores[i]!;
    if (persistResults[i]?.result === 'OK') {
      warmed.set(cc, score);
    } else {
      persistFailures++;
      recordWarmFailure(warmed, {
        countryCode: cc,
        stage: 'persist',
        reason: persistResults[i]?.reason ?? 'SET did not return OK',
        retried: persistResults[i]?.retried ?? false,
      });
    }
  }
  if (persistFailures > 0) {
    console.warn(`[resilience] warm persisted ${warmed.size}/${scores.length} scores after retry (${persistFailures} SETs did not return OK)`);
  }
  return warmed;
}
