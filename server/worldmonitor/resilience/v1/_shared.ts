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
import {
  RESILIENCE_DIMENSION_DOMAINS,
  RESILIENCE_DIMENSION_ORDER,
  RESILIENCE_DIMENSION_TYPES,
  RESILIENCE_DIMENSION_WEIGHTS,
  RESILIENCE_DOMAIN_ORDER,
  RESILIENCE_RETIRED_DIMENSIONS,
  createMemoizedSeedReader,
  getResilienceDomainWeight,
  scoreAllDimensions,
  type ImputationClass,
  type ResilienceDimensionId,
  type ResilienceDomainId,
  type ResilienceSeedReader,
} from './_dimension-scorers';
import { buildPillarList } from './_pillar-membership';

// Phase 2 T2.1/T2.3: feature flag for the three-pillar response shape.
// Default is `true` → responses carry `schemaVersion: "2.0"` and a
// non-empty `pillars` array with real coverage-weighted scores from
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
// by `penalizedPillarScore` below. Default is `false` so activation is
// an explicit operator action; the sensitivity + current-vs-proposed
// comparison in `docs/snapshots/resilience-pillar-sensitivity-*.json`
// is the input for that decision. When flipped to `true`:
//   - `overallScore` = penalizedPillarScore(pillars), α=0.5 (pillar
//     weights 0.40 / 0.35 / 0.25 per the plan).
//   - Published numbers drop ~13 points on average across the
//     52-country sample; Spearman vs the 6-domain ranking is 0.9935.
//
// Read dynamically rather than captured at module load so tests can
// flip `process.env.RESILIENCE_PILLAR_COMBINE_ENABLED` per-case without
// re-importing the module. Under Node production the env does not
// change mid-process so the per-call read is a couple of instructions.
//
// Cache invalidation: the score cache prefix is bumped on every
// flag-visible behavior change (see RESILIENCE_SCORE_CACHE_PREFIX
// above). Do not flip this flag without also bumping the cache
// prefix or waiting for the 6h TTL to expire — otherwise legacy
// 6-domain scores will be served from cache after activation.
export function isPillarCombineEnabled(): boolean {
  return (process.env.RESILIENCE_PILLAR_COMBINE_ENABLED ?? 'false').toLowerCase() === 'true';
}

// PR 1 of the resilience repair plan (docs/plans/2026-04-22-001-fix-
// resilience-scorer-structural-bias-plan.md §3.1–§3.3): activation
// flag for the v2 energy construct. Default is `false` so activation
// is an explicit operator action.
//
// When off (default): `scoreEnergy` uses the legacy inputs
// (energyImportDependency, gasShare, coalShare, renewShare,
// electricityConsumption, gasStorageStress, energyPriceStress) and
// published rankings are unchanged.
//
// When on: `scoreEnergy` uses the v2 inputs under the Option B
// (power-system security) framing:
//   - importedFossilDependence = EG.ELC.FOSL.ZS × max(EG.IMP.CONS.ZS, 0) / 100   (weight 0.35)
//   - lowCarbonGenerationShare = EG.ELC.NUCL.ZS + EG.ELC.RNEW.ZS                 (weight 0.20)
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
// overall score, so flipping this flag requires either bumping
// RESILIENCE_SCORE_CACHE_PREFIX or waiting for the 6h TTL to clear.
// The current PR 1 plan stages the flag flip AFTER an acceptance-
// gate rerun that produces a fresh post-flip snapshot; the cache
// prefix bump lands in the commit that performs the acceptance run.
export function isEnergyV2Enabled(): boolean {
  return (process.env.RESILIENCE_ENERGY_V2_ENABLED ?? 'false').toLowerCase() === 'true';
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
export const RESILIENCE_SCORE_CACHE_PREFIX = 'resilience:score:v13:';
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
export const RESILIENCE_HISTORY_KEY_PREFIX = 'resilience:history:v8:';
// v12 bump in lockstep with RESILIENCE_SCORE_CACHE_PREFIX (v11 → v12)
// for PR 3A §net-imports denominator. As with the score prefix, the
// version bump is a belt — the suspenders are the `_formula` tag on
// the ranking payload itself, written via stampRankingCacheTag and
// read via rankingCacheTagMatches in the ranking handler, which force
// a recompute-and-publish on a cross-formula cache hit rather than
// serving the stale ranking for up to the 12h ranking TTL. v12→v13 bump
// in lockstep with RESILIENCE_SCORE_CACHE_PREFIX for plan 2026-04-25-004
// Phase 1 (Ship 1).
export const RESILIENCE_RANKING_CACHE_KEY = 'resilience:ranking:v13';
export const RESILIENCE_STATIC_INDEX_KEY = 'resilience:static:index:v1';
export const RESILIENCE_INTERVAL_KEY_PREFIX = 'resilience:intervals:v1:';
const RESILIENCE_STATIC_META_KEY = 'seed-meta:resilience:static';
const RANK_STABLE_MAX_INTERVAL_WIDTH = 8;

const LOW_CONFIDENCE_COVERAGE_THRESHOLD = 0.55;
const LOW_CONFIDENCE_IMPUTATION_SHARE_THRESHOLD = 0.40;

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

function scoreCacheKey(countryCode: string): string {
  return `${RESILIENCE_SCORE_CACHE_PREFIX}${countryCode}`;
}

function intervalCacheKey(countryCode: string): string {
  return `${RESILIENCE_INTERVAL_KEY_PREFIX}${countryCode}`;
}

async function readScoreInterval(countryCode: string): Promise<ScoreInterval | undefined> {
  const raw = await getCachedJson(intervalCacheKey(countryCode), true) as { p05?: number; p95?: number } | null;
  if (!raw || typeof raw.p05 !== 'number' || typeof raw.p95 !== 'number') return undefined;
  return { p05: raw.p05, p95: raw.p95 };
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

function buildDimensionList(
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

// Coverage-weighted mean with an optional per-dimension weight multiplier.
// Each dim's effective weight is `coverage * dimWeight`, so when all
// weights default to 1.0 this reduces to the original coverage-weighted
// mean. PR 2 §3.4 uses the weight channel to dial the two new recovery
// dims down to ~10% share (see RESILIENCE_DIMENSION_WEIGHTS in
// _dimension-scorers.ts for the rationale). Retired dims have
// coverage=0 so they're neutralized at the coverage end; the weight
// channel stays 1.0 for them in the canonical map.
function coverageWeightedMean(dimensions: ResilienceDimension[]): number {
  let totalWeight = 0;
  let weightedSum = 0;
  for (const d of dimensions) {
    const w = RESILIENCE_DIMENSION_WEIGHTS[d.id as ResilienceDimensionId] ?? 1.0;
    const effective = d.coverage * w;
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

function buildDomainList(dimensions: ResilienceDimension[]): ResilienceDomain[] {
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

// Sorted-set member format: `YYYY-MM-DD:SCORE[:FORMULA]`. The optional
// formula tag is either 'd6' or 'pc'. Legacy untagged members predate
// the pillar-combined activation and are implicitly 'd6' (the only
// formula in use before this PR). On activation, readHistory callers
// filter by `currentCacheFormula()` so a 30-day window of d6 points is
// not silently compared against a fresh pc point (which would
// manufacture a ranking-wide fake-negative change30d / false "falling"
// trend on day one).
function parseHistoryPoints(raw: unknown): ResilienceHistoryPoint[] {
  if (!Array.isArray(raw)) return [];
  const history: ResilienceHistoryPoint[] = [];

  for (let index = 0; index < raw.length; index += 2) {
    const member = String(raw[index] || '');
    const parts = member.split(':');
    if (parts.length < 2) continue;
    const date = parts[0]!;
    const score = Number(parts[1]);
    const rawFormula = parts[2];
    const formula: CacheFormulaTag = rawFormula === 'pc' ? 'pc' : 'd6';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(score)) continue;
    history.push({ date, score, formula });
  }

  return history.sort((left, right) => left.date.localeCompare(right.date));
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
  // INTENTIONALLY NOT weighted by RESILIENCE_DIMENSION_WEIGHTS. The
  // coverage signal answers a different question from the scoring
  // aggregation: "how much real data do we have on this country?"
  // vs "how much does each dim matter to the overall score?" A dim
  // with coverage=0.3 has sparse data regardless of how little it
  // contributes to the final number — and the user-facing
  // "Low confidence" label is about data availability, not score
  // composition. The asymmetry is deliberate and mirrored in
  // `computeOverallCoverage` below.
  const scoring = dimensions.filter(
    (dimension) => !RESILIENCE_RETIRED_DIMENSIONS.has(dimension.id as ResilienceDimensionId),
  );
  const averageCoverage = mean(scoring.map((dimension) => dimension.coverage)) ?? 0;
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
  const dateScore = Number(todayIsoDate().replace(/-/g, ''));
  // Member format `YYYY-MM-DD:SCORE:FORMULA` — see parseHistoryPoints
  // above for the reader. The formula tag is required because the v4→v5
  // history prefix bump happens at PR deploy, not at flag flip, so the
  // v5 series accumulates d6-tagged entries during the default-off
  // window; only the per-member tag lets the reader correctly filter
  // those out when the pillar-combined formula later activates.
  await runRedisPipeline([
    ['ZADD', historyKey(countryCode), dateScore, `${todayIsoDate()}:${round(overallScore)}:${formula}`],
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

  const scoreMap = await scoreAllDimensions(normalizedCountryCode, reader);
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
    lowConfidence: computeLowConfidence(dimensions, imputationShare),
    imputationShare,
    dataVersion,
    pillars,
    schemaVersion: '2.0',
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

export function stampRankingCacheTag<T extends object>(payload: T): T & { _formula: CacheFormulaTag } {
  return { ...payload, _formula: currentCacheFormula() };
}

export function rankingCacheTagMatches(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const tag = (payload as { _formula?: unknown })._formula;
  return tag === currentCacheFormula();
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
    .filter(Boolean);
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
  // INTENTIONALLY NOT weighted by RESILIENCE_DIMENSION_WEIGHTS —
  // same reason as `computeLowConfidence`: this is a data-availability
  // signal ("how much real data do we have?"), not a score-composition
  // signal ("how much does each dim matter?"). Applying the scoring
  // weights would let a dim at weight=0.5 hide half its sparsity
  // from the overallCoverage pill, which would confuse users reading
  // the coverage percentage as a data-quality indicator.
  const coverages = response.domains.flatMap((domain) =>
    domain.dimensions
      .filter((dimension) => !RESILIENCE_RETIRED_DIMENSIONS.has(dimension.id as ResilienceDimensionId))
      .map((dimension) => dimension.coverage),
  );
  if (coverages.length === 0) return 0;
  return coverages.reduce((sum, coverage) => sum + coverage, 0) / coverages.length;
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
    };
  }

  return {
    countryCode,
    overallScore: response.overallScore,
    level: response.level,
    lowConfidence: response.lowConfidence,
    overallCoverage: computeOverallCoverage(response),
    rankStable: isRankStable(interval),
  };
}

export function sortRankingItems(items: ResilienceRankingItem[]): ResilienceRankingItem[] {
  return [...items].sort((left, right) => {
    if (left.overallScore !== right.overallScore) return right.overallScore - left.overallScore;
    return left.countryCode.localeCompare(right.countryCode);
  });
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
): Promise<Map<string, GetResilienceScoreResponse>> {
  const uniqueCodes = [...new Set(countryCodes.map((countryCode) => normalizeCountryCode(countryCode)).filter(Boolean))];
  const warmed = new Map<string, GetResilienceScoreResponse>();
  if (uniqueCodes.length === 0) return warmed;

  // Share one memoized reader across all countries so global Redis keys (conflict events,
  // sanctions, unrest, etc.) are fetched only once instead of once per country.
  const sharedReader = createMemoizedSeedReader();
  const computed = await Promise.allSettled(
    uniqueCodes.map(async (cc) => ({ cc, score: await buildResilienceScore(cc, sharedReader) })),
  );

  const scores: Array<{ cc: string; score: GetResilienceScoreResponse }> = [];
  const computeFailures: Array<{ countryCode: string; reason: string }> = [];
  for (let i = 0; i < computed.length; i++) {
    const result = computed[i]!;
    if (result.status === 'fulfilled') {
      scores.push(result.value);
    } else {
      computeFailures.push({
        countryCode: uniqueCodes[i]!,
        reason: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }
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
  // window bounded by the slowest batch. Failed batches still pad with empty
  // entries to preserve per-command index alignment downstream.
  const batches: Array<Array<Array<string>>> = [];
  for (let i = 0; i < allSetCommands.length; i += SET_BATCH) {
    batches.push(allSetCommands.slice(i, i + SET_BATCH));
  }
  const batchOutcomes = await Promise.all(batches.map((batch) => runRedisPipeline(batch)));
  const persistResults: Array<{ result?: unknown }> = [];
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b]!;
    const batchResults = batchOutcomes[b]!;
    if (batchResults.length !== batch.length) {
      // runRedisPipeline returns [] on transport/HTTP failure. Pad with
      // empty entries so the per-command index alignment downstream stays
      // correct — those entries will fail the OK check and be excluded
      // from `warmed`, which is the safe behavior (no proof = no claim).
      for (let j = 0; j < batch.length; j++) persistResults.push({});
    } else {
      for (const result of batchResults) persistResults.push(result);
    }
  }

  let persistFailures = 0;
  for (let i = 0; i < scores.length; i++) {
    const { cc, score } = scores[i]!;
    if (persistResults[i]?.result === 'OK') {
      warmed.set(cc, score);
    } else {
      persistFailures++;
    }
  }
  if (persistFailures > 0) {
    console.warn(`[resilience] warm persisted ${warmed.size}/${scores.length} scores (${persistFailures} SETs did not return OK)`);
  }
  return warmed;
}
