import { insightsSnapshotRejection, INSIGHTS_MAX_AGE_MS } from '../../shared/insights-snapshot.js';
import { normalizeAdvisorySnapshot, normalizeGdeltTopicSnapshot } from '../../shared/intelligence-snapshots.js';
// @ts-expect-error — existing Edge-safe JavaScript module has no declaration.
import { assessContentAge } from '../_content-age.js';

export type NewsIntelligencePanelRead = { value: unknown; reuseUntil: number | null };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function clock(value: unknown, now: number): number | null {
  const stamp = typeof value === 'string' ? Date.parse(value) : value;
  return typeof stamp === 'number' && Number.isSafeInteger(stamp) && stamp > 0 && stamp <= now ? stamp : null;
}
function failed(value: Record<string, unknown>): boolean {
  return Boolean(value.error) || ['unavailable', 'upstreamUnavailable', 'degraded', 'stale', 'rateLimited', 'fallback'].some(key => value[key] === true)
    || value.dataAvailable === false
    || ['error', 'errorCode', 'skipReason'].some(key => typeof value[key] === 'string' && value[key] !== '')
    || value.sourceState !== undefined && value.sourceState !== 'ok'
    || Array.isArray(value.failedSources) && value.failedSources.length > 0;
}

export function validNewsIntelligenceOriginal(data: unknown, now: number): data is Record<string, unknown> {
  if (!record(data)) return false;
  const insights = data.insights;
  const gdelt = data['gdelt-intel'];
  const signals = data['cross-source-signals'];
  const advisories = data['advisories-bootstrap'];
  if (![insights, gdelt, signals, advisories].every(value => record(value) && !failed(value))) return false;
  if (!record(insights) || insights.status !== 'ok' || insightsSnapshotRejection(insights, now) !== null
    || !(insights.topStories as unknown[]).every(story => record(story) && typeof story.primaryTitle === 'string' && story.primaryTitle.trim() !== '' && typeof story.primarySource === 'string' && story.primarySource.trim() !== '')) return false;
  const normalizedGdelt = normalizeGdeltTopicSnapshot(gdelt);
  if (!normalizedGdelt || !record(gdelt)
    || normalizedGdelt.topics.some((topic: { articles: unknown[] }, index: number) => topic.articles.length !== (gdelt.topics as { articles: unknown[] }[])[index]!.articles.length)) return false;
  if (!record(signals) || !Array.isArray(signals.signals) || !signals.signals.every(record) || clock(signals.evaluatedAt, now) === null) return false;
  const normalizedAdvisories = normalizeAdvisorySnapshot(advisories);
  return !!normalizedAdvisories && record(advisories) && normalizedAdvisories.advisories.length > 0
    && normalizedAdvisories.advisories.length === (advisories.advisories as unknown[]).length
    && clock(advisories.fetchedAt, now) !== null;
}

export function newsIntelligenceFreshness(data: Record<string, unknown>, metas: unknown[], now: number): { stale: boolean; freshnessUnknown: boolean } {
  const rejection = insightsSnapshotRejection(data.insights, now);
  let stale = rejection === 'stale-snapshot';
  let freshnessUnknown = rejection !== null && rejection !== 'stale-snapshot';
  const content = assessContentAge(metas[1], now);
  if (!content || !Number.isFinite(content.maxContentAgeMin) || content.maxContentAgeMin <= 0 || clock(content.newestItemAt, now) === null) freshnessUnknown = true;
  else stale ||= content.contentStale;
  for (const meta of metas) if (!record(meta) || clock(meta.fetchedAt, now) === null) freshnessUnknown = true;
  for (const [label, field] of [['cross-source-signals', 'evaluatedAt'], ['advisories-bootstrap', 'fetchedAt']] as const) {
    const bucket = data[label];
    if (!record(bucket) || clock(bucket[field], now) === null) freshnessUnknown = true;
  }
  return { stale, freshnessUnknown };
}

export function newsIntelligenceReuseUntil(data: Record<string, unknown>, seeds: unknown[], metas: unknown[], now: number): number | null {
  if (!validNewsIntelligenceOriginal(data, now)) return null;
  if (seeds.some(seed => seed !== null && seed !== undefined && (!record(seed)
    || !['OK', 'OK_ZERO'].includes(String(seed.state)) || failed(seed)
    || typeof seed.errorReason === 'string' && seed.errorReason !== ''
    || Array.isArray(seed.failedDatasets) && seed.failedDatasets.length > 0
    || clock(seed.fetchedAt, now) === null))) return null;
  const ages = [30, 45, 60];
  const deadlines: number[] = [];
  for (const [index, age] of ages.entries()) {
    const meta = metas[index];
    if (!record(meta) || failed(meta)) return null;
    const fetched = clock(meta.fetchedAt, now);
    if (fetched === null) return null;
    const bucket = data[['insights', 'gdelt-intel', 'cross-source-signals'][index]!] as Record<string, unknown>;
    const rows = bucket[['topStories', 'topics', 'signals'][index]!] as unknown[];
    if (meta.recordCount !== undefined && (typeof meta.recordCount !== 'number' || !Number.isSafeInteger(meta.recordCount) || meta.recordCount !== rows.length)) return null;
    deadlines.push(fetched + age * 60_000);
    const seed = seeds[index];
    if (record(seed)) deadlines.push(clock(seed.fetchedAt, now)! + age * 60_000);
  }
  const content = assessContentAge(metas[1], now);
  if (!content || content.contentStale || !Number.isFinite(content.maxContentAgeMin) || content.maxContentAgeMin <= 0
    || clock(content.newestItemAt, now) === null) return null;
  deadlines.push(content.newestItemAt! + (content.maxContentAgeMin + 0.5) * 60_000);
  deadlines.push(clock((data['cross-source-signals'] as Record<string, unknown>).evaluatedAt, now)! + 60 * 60_000);
  deadlines.push(Date.parse((data.insights as Record<string, unknown>).generatedAt as string) + INSIGHTS_MAX_AGE_MS);
  const deadline = Math.min(...deadlines);
  return deadline > now ? deadline : null;
}

export function validNewsIntelligenceCache(value: unknown, now: number, expires: number): value is { value: unknown; reuseUntil: number } {
  if (!record(value) || Object.keys(value).sort().join(',') !== 'reuseUntil,value'
    || typeof value.reuseUntil !== 'number' || !Number.isSafeInteger(value.reuseUntil)
    || value.reuseUntil <= now || value.reuseUntil > expires || !record(value.value)) return false;
  const envelope = value.value;
  return typeof envelope.cached_at === 'string' && clock(envelope.cached_at, now) !== null && envelope.stale === false
    && envelope.freshnessUnknown !== true && envelope.activationUnknown !== true
    && (!Array.isArray(envelope.unreadable) || envelope.unreadable.length === 0)
    && validNewsIntelligenceOriginal(envelope.data, now);
}
