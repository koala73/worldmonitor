import feeds from '../../../../scripts/shared/regional-energy-feeds.json';
import type { RegionalEnergyFeed, RegionalEnergyObservation } from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

function observationTime(period: unknown): number {
  if (typeof period !== 'string') return NaN;
  if (/^\d{4}-\d{2}$/.test(period)) {
    const year = Number(period.slice(0, 4)), month = Number(period.slice(5, 7));
    return month >= 1 && month <= 12 ? Date.UTC(year, month, 0, 23, 59, 59, 999) : NaN;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(period)) {
    const time = Date.parse(`${period}T00:00:00Z`);
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === period ? time : NaN;
  }
  const time = Date.parse(period);
  return Number.isFinite(time) && new Date(time).toISOString() === period ? time : NaN;
}

function decodeFeed(feed: typeof feeds[number], raw: unknown, nowMs: number): RegionalEnergyFeed {
  const empty: RegionalEnergyFeed = {
    sourceId: feed.id, name: feed.name, sourceUrl: feed.sourceUrl, licence: feed.licence,
    status: 'unavailable', fetchedAt: 0, observedAt: 0, dataUrls: [], observations: [], error: '',
  };
  if (raw == null) return empty;
  const invalid = { ...empty, status: 'error', error: 'invalid_cache_record' };
  if (typeof raw !== 'object') return invalid;
  const record = raw as Record<string, unknown>;
  const fetchedAt = typeof record.fetchedAt === 'string' ? Date.parse(record.fetchedAt) : NaN;
  if (record.sourceId !== feed.id || !Number.isFinite(fetchedAt) || fetchedAt > nowMs + 3600000
    || !Array.isArray(record.observations) || !record.observations.length || record.observations.length > 2000
    || !Array.isArray(record.dataUrls) || !record.dataUrls.every(u => typeof u === 'string' && u.startsWith('https://'))) return invalid;
  const observations: RegionalEnergyObservation[] = [];
  const latest = new Map<string, { time: number; stale: boolean }>();
  for (const item of record.observations) {
    if (item == null || typeof item !== 'object') return invalid;
    const p = item as Record<string, unknown>;
    const time = observationTime(p.period);
    if (!Number.isFinite(time) || time > nowMs + 3600000 || typeof p.value !== 'number' || !Number.isFinite(p.value)
      || typeof p.metric !== 'string' || !p.metric || typeof p.unit !== 'string' || !p.unit || typeof p.area !== 'string') return invalid;
    const budget = feed.id === 'anp' && p.metric === 'fuel.retail_price' ? 21 * 1440
      : feed.id === 'eskom' && p.metric === 'outages.unplanned.average' ? 21 * 1440 : feed.maxContentAgeMin;
    const stale = nowMs - time > budget * 60000 || nowMs - fetchedAt > feed.intervalMin * 3 * 60000;
    const series = `${p.metric}|${p.area}`;
    if (!latest.has(series) || latest.get(series)!.time < time) latest.set(series, { time, stale });
    observations.push({ metric: p.metric, period: p.period as string, value: p.value, unit: p.unit, area: p.area, stale });
  }
  const staleCount = [...latest.values()].filter(p => p.stale).length;
  return {
    ...empty, status: staleCount === latest.size ? 'stale' : staleCount ? 'partial' : 'available',
    fetchedAt, observedAt: Math.max(...[...latest.values()].map(p => p.time)),
    dataUrls: record.dataUrls as string[], observations,
  };
}

export async function readRegionalEnergyFeeds(
  countryCode: string,
  read: (key: string) => Promise<unknown>,
  nowMs = Date.now(),
): Promise<RegionalEnergyFeed[]> {
  return Promise.all(feeds.filter(feed => feed.countryCode === countryCode).map(async feed => {
    try {
      return decodeFeed(feed, await read(`energy:regional:${feed.id}:v1`), nowMs);
    } catch {
      return { ...decodeFeed(feed, null, nowMs), status: 'error', error: 'cache_read_failed' };
    }
  }));
}
