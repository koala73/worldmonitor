import type {
  GetResilienceScoreResponse,
  ResilienceDimension,
  ResilienceDomain,
  ResilienceRankingItem,
} from '../../../../src/generated/server/worldmonitor/resilience/v1/service_server';

import { cachedFetchJson, getCachedJson, runRedisPipeline } from '../../../_shared/redis';
import { cronbachAlpha, detectTrend, round } from '../../../_shared/resilience-stats';
import {
  RESILIENCE_DIMENSION_DOMAINS,
  RESILIENCE_DIMENSION_ORDER,
  RESILIENCE_DOMAIN_ORDER,
  createMemoizedSeedReader,
  getResilienceDomainWeight,
  scoreAllDimensions,
  type ResilienceDimensionId,
  type ResilienceDomainId,
  type ResilienceSeedReader,
} from './_dimension-scorers';

export const RESILIENCE_SCORE_CACHE_TTL_SECONDS = 6 * 60 * 60;
export const RESILIENCE_RANKING_CACHE_TTL_SECONDS = 6 * 60 * 60;
export const RESILIENCE_SCORE_CACHE_PREFIX = 'resilience:score:';
export const RESILIENCE_HISTORY_KEY_PREFIX = 'resilience:history:';
export const RESILIENCE_RANKING_CACHE_KEY = 'resilience:ranking';
export const RESILIENCE_STATIC_INDEX_KEY = 'resilience:static:index:v1';

const LOW_CONFIDENCE_COVERAGE_THRESHOLD = 0.60;
const LOW_CONFIDENCE_ALPHA_THRESHOLD = 0.55;

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
  scores: Record<ResilienceDimensionId, { score: number; coverage: number }>,
): ResilienceDimension[] {
  return RESILIENCE_DIMENSION_ORDER.map((dimensionId) => ({
    id: dimensionId,
    score: round(scores[dimensionId].score),
    coverage: round(scores[dimensionId].coverage),
  }));
}

function coverageWeightedMean(dimensions: ResilienceDimension[]): number {
  const totalCoverage = dimensions.reduce((sum, d) => sum + d.coverage, 0);
  if (!totalCoverage) return 0;
  return dimensions.reduce((sum, d) => sum + d.score * d.coverage, 0) / totalCoverage;
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

function buildCronbachMatrix(domains: ResilienceDomain[]): number[][] {
  const populated = domains.filter((domain) => domain.dimensions.length >= 2);
  if (populated.length < 2) return [];

  const width = Math.max(...populated.map((domain) => domain.dimensions.length));
  return populated.map((domain) => {
    const values = domain.dimensions.map((dimension) => dimension.score);
    const fill = mean(values) ?? domain.score;
    return Array.from({ length: width }, (_, index) => values[index] ?? fill);
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

function computeLowConfidence(dimensions: ResilienceDimension[], cronbach: number): boolean {
  const averageCoverage = mean(dimensions.map((dimension) => dimension.coverage)) ?? 0;
  if (averageCoverage < LOW_CONFIDENCE_COVERAGE_THRESHOLD) return true;
  return cronbach < LOW_CONFIDENCE_ALPHA_THRESHOLD;
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

export async function ensureResilienceScoreCached(countryCode: string, reader?: ResilienceSeedReader): Promise<GetResilienceScoreResponse> {
  const normalizedCountryCode = normalizeCountryCode(countryCode);
  if (!normalizedCountryCode) {
    return {
      countryCode: '',
      overallScore: 0,
      level: 'unknown',
      domains: [],
      cronbachAlpha: 0,
      trend: 'stable',
      change30d: 0,
      lowConfidence: true,
    };
  }

  return await cachedFetchJson<GetResilienceScoreResponse>(
    scoreCacheKey(normalizedCountryCode),
    RESILIENCE_SCORE_CACHE_TTL_SECONDS,
    async () => {
      const scoreMap = await scoreAllDimensions(normalizedCountryCode, reader);
      const dimensions = buildDimensionList(scoreMap);
      const domains = buildDomainList(dimensions);
      const overallScore = round(
        domains.reduce((sum, domain) => sum + domain.score * domain.weight, 0),
      );

      const cronbach = round(cronbachAlpha(buildCronbachMatrix(domains)), 3);
      const history = (await readHistory(normalizedCountryCode))
        .filter((point) => point.date !== todayIsoDate());
      const scoreSeries = [...history.map((point) => point.score), overallScore];
      const oldestScore = history[0]?.score;

      await appendHistory(normalizedCountryCode, overallScore);

      return {
        countryCode: normalizedCountryCode,
        overallScore,
        level: classifyResilienceLevel(overallScore),
        domains,
        cronbachAlpha: cronbach,
        trend: detectTrend(scoreSeries),
        change30d: oldestScore == null ? 0 : round(overallScore - oldestScore),
        lowConfidence: computeLowConfidence(dimensions, cronbach),
      };
    },
    300,
  ) ?? {
    countryCode: normalizedCountryCode,
    overallScore: 0,
    level: 'unknown',
    domains: [],
    cronbachAlpha: 0,
    trend: 'stable',
    change30d: 0,
    lowConfidence: true,
  };
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
      scores.set(countryCode, JSON.parse(raw) as GetResilienceScoreResponse);
    } catch {
      // Ignore malformed cache entries and let the caller decide whether to warm them.
    }
  }

  return scores;
}

export function buildRankingItem(
  countryCode: string,
  response?: GetResilienceScoreResponse | null,
): ResilienceRankingItem {
  if (!response) {
    return {
      countryCode,
      overallScore: -1,
      level: 'unknown',
      lowConfidence: true,
    };
  }

  return {
    countryCode,
    overallScore: response.overallScore,
    level: response.level,
    lowConfidence: response.lowConfidence,
  };
}

export function sortRankingItems(items: ResilienceRankingItem[]): ResilienceRankingItem[] {
  return [...items].sort((left, right) => {
    if (left.overallScore !== right.overallScore) return right.overallScore - left.overallScore;
    return left.countryCode.localeCompare(right.countryCode);
  });
}

export async function warmMissingResilienceScores(countryCodes: string[]): Promise<void> {
  const uniqueCodes = [...new Set(countryCodes.map((countryCode) => normalizeCountryCode(countryCode)).filter(Boolean))];
  // Share one memoized reader across all countries so global Redis keys (conflict events,
  // sanctions, unrest, etc.) are fetched only once instead of once per country.
  const sharedReader = createMemoizedSeedReader();
  await Promise.allSettled(uniqueCodes.map((countryCode) => ensureResilienceScoreCached(countryCode, sharedReader)));
}
