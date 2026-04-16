import type {
  GetResilienceScoreResponse,
  ResilienceDimension,
  ResilienceDomain,
  ResilienceRankingItem,
  ScoreInterval,
} from '../../../../src/generated/server/worldmonitor/resilience/v1/service_server';


export type { ScoreInterval };

import { cachedFetchJson, getCachedJson, runRedisPipeline } from '../../../_shared/redis';
import { unwrapEnvelope } from '../../../_shared/seed-envelope';
import { detectTrend, round } from '../../../_shared/resilience-stats';
import {
  RESILIENCE_DIMENSION_DOMAINS,
  RESILIENCE_DIMENSION_ORDER,
  RESILIENCE_DIMENSION_TYPES,
  RESILIENCE_DOMAIN_ORDER,
  createMemoizedSeedReader,
  getResilienceDomainWeight,
  scoreAllDimensions,
  type ImputationClass,
  type ResilienceDimensionId,
  type ResilienceDomainId,
  type ResilienceSeedReader,
} from './_dimension-scorers';
import { buildPillarList } from './_pillar-membership';

// Phase 2 T2.1: feature flag for the three-pillar response shape.
// When `true`, responses carry `schemaVersion: "2.0"` and a non-empty
// `pillars` array (shaped but with score=0/coverage=0 until PR 4 wires
// the real aggregation). When `false` (default), responses preserve the
// Phase 1 shape: `schemaVersion: "1.0"` and `pillars: []`.
//
// The `overallScore`, `baselineScore`, `stressScore`, etc. top-level
// fields remain populated in BOTH modes for one release cycle to
// preserve backward compat for widget + map layer + Country Brief
// consumers per the plan ("Schema changes (OpenAPI + proto)" section).
export const RESILIENCE_SCHEMA_V2_ENABLED =
  (process.env.RESILIENCE_SCHEMA_V2_ENABLED ?? 'true').toLowerCase() === 'true';

export const RESILIENCE_SCORE_CACHE_TTL_SECONDS = 6 * 60 * 60;
// Ranking TTL must exceed the cron interval (6h) by enough to tolerate one
// missed/slow cron tick. With TTL==cron_interval, writing near the end of a
// run and firing the next cron near the start of the next interval left a
// gap of multiple hours once the key expired between refreshes. 12h gives a
// full cron-cycle of headroom — ensureRankingPresent() still refreshes on
// every cron, so under normal operation the key stays well above TTL=0.
export const RESILIENCE_RANKING_CACHE_TTL_SECONDS = 12 * 60 * 60;
export const RESILIENCE_SCORE_CACHE_PREFIX = 'resilience:score:v9:';
export const RESILIENCE_HISTORY_KEY_PREFIX = 'resilience:history:v4:';
export const RESILIENCE_RANKING_CACHE_KEY = 'resilience:ranking:v9';
export const RESILIENCE_STATIC_INDEX_KEY = 'resilience:static:index:v1';
export const RESILIENCE_INTERVAL_KEY_PREFIX = 'resilience:intervals:v1:';
const RESILIENCE_STATIC_META_KEY = 'seed-meta:resilience:static';
const RANK_STABLE_MAX_INTERVAL_WIDTH = 8;

const LOW_CONFIDENCE_COVERAGE_THRESHOLD = 0.55;
const LOW_CONFIDENCE_IMPUTATION_SHARE_THRESHOLD = 0.40;

interface ResilienceHistoryPoint {
  date: string;
  score: number;
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

function classifyResilienceLevel(score: number): string {
  if (score >= 70) return 'high';
  if (score >= 40) return 'medium';
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

function coverageWeightedMean(dimensions: ResilienceDimension[]): number {
  const totalCoverage = dimensions.reduce((sum, d) => sum + d.coverage, 0);
  if (!totalCoverage) return 0;
  return dimensions.reduce((sum, d) => sum + d.score * d.coverage, 0) / totalCoverage;
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

function parseHistoryPoints(raw: unknown): ResilienceHistoryPoint[] {
  if (!Array.isArray(raw)) return [];
  const history: ResilienceHistoryPoint[] = [];

  for (let index = 0; index < raw.length; index += 2) {
    const member = String(raw[index] || '');
    const separatorIndex = member.indexOf(':');
    if (separatorIndex < 0) continue;
    const date = member.slice(0, separatorIndex);
    const score = Number(member.slice(separatorIndex + 1));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(score)) continue;
    history.push({ date, score });
  }

  return history.sort((left, right) => left.date.localeCompare(right.date));
}

function computeLowConfidence(dimensions: ResilienceDimension[], imputationShare: number): boolean {
  const averageCoverage = mean(dimensions.map((dimension) => dimension.coverage)) ?? 0;
  return averageCoverage < LOW_CONFIDENCE_COVERAGE_THRESHOLD || imputationShare > LOW_CONFIDENCE_IMPUTATION_SHARE_THRESHOLD;
}

async function readHistory(countryCode: string): Promise<ResilienceHistoryPoint[]> {
  const result = await runRedisPipeline([
    ['ZRANGE', historyKey(countryCode), 0, -1, 'WITHSCORES'],
  ]);
  return parseHistoryPoints(result[0]?.result);
}

async function appendHistory(countryCode: string, overallScore: number): Promise<void> {
  const dateScore = Number(todayIsoDate().replace(/-/g, ''));
  await runRedisPipeline([
    ['ZADD', historyKey(countryCode), dateScore, `${todayIsoDate()}:${round(overallScore)}`],
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
  const overallScore = round(domains.reduce((sum, d) => sum + d.score * d.weight, 0));

  const totalImputed = dimensions.reduce((sum, d) => sum + (d.imputedWeight ?? 0), 0);
  const totalObserved = dimensions.reduce((sum, d) => sum + (d.observedWeight ?? 0), 0);
  const imputationShare = (totalImputed + totalObserved) > 0
    ? round(totalImputed / (totalImputed + totalObserved), 4)
    : 0;

  const history = (await readHistory(normalizedCountryCode))
    .filter((point) => point.date !== todayIsoDate());
  const scoreSeries = [...history.map((point) => point.score), overallScore];
  const oldestScore = history[0]?.score;

  await appendHistory(normalizedCountryCode, overallScore);

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

  let cached = await cachedFetchJson<GetResilienceScoreResponse>(
    scoreCacheKey(normalizedCountryCode),
    RESILIENCE_SCORE_CACHE_TTL_SECONDS,
    () => buildResilienceScore(normalizedCountryCode, reader),
    300,
  ) ?? {
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
    // Phase 2 T2.1: cachedFetchJson-null fallback. Stays on the v1 shape
    // because there are no domains to wrap into pillars here.
    pillars: [],
    schemaVersion: '1.0',
  };

  const scoreInterval = await readScoreInterval(normalizedCountryCode);
  if (scoreInterval) {
    cached = { ...cached, scoreInterval };
  }

  // P1 fix: the cache always stores the v2 superset (pillars + schemaVersion='2.0').
  // When the flag is off, strip pillars and downgrade schemaVersion so consumers
  // see the v1 shape. Flag flips take effect immediately, no 6h TTL wait.
  if (!RESILIENCE_SCHEMA_V2_ENABLED) {
    cached.pillars = [];
    cached.schemaVersion = '1.0';
  }

  return cached;
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

  for (let index = 0; index < normalized.length; index += 1) {
    const countryCode = normalized[index]!;
    const raw = results[index]?.result;
    if (typeof raw !== 'string') continue;
    try {
      // Envelope-aware: resilience score keys are written by seed-resilience-scores
      // in contract mode (PR 2). unwrapEnvelope is a no-op on legacy bare-shape.
      const parsed = unwrapEnvelope(JSON.parse(raw)).data as GetResilienceScoreResponse;
      if (!parsed) continue;
      // P1 fix: cached payload is always v2 superset. Gate on serve.
      if (!RESILIENCE_SCHEMA_V2_ENABLED) {
        parsed.pillars = [];
        parsed.schemaVersion = '1.0';
      }
      scores.set(countryCode, parsed);
    } catch {
      // Ignore malformed cache entries and let the caller decide whether to warm them.
    }
  }

  return scores;
}

export const GREY_OUT_COVERAGE_THRESHOLD = 0.40;

function computeOverallCoverage(response: GetResilienceScoreResponse): number {
  const coverages = response.domains.flatMap((domain) => domain.dimensions.map((dimension) => dimension.coverage));
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
  const allSetCommands = scores.map(({ cc, score }) => [
    'SET',
    scoreCacheKey(cc),
    JSON.stringify(score),
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
