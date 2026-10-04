import { argBool, argNum, argStrList, capNested, selectDatasets } from './filters';
import { DEFAULT_LIST_LIMIT } from './constants';
import { projectNaturalEventsRetention } from '../_natural-events-dashboard.js';

export type NaturalDisastersPanelRead = { value: unknown; reuseUntil: number | null };

const SOURCES = {
  earthquakes: { label: 'earthquakes', list: 'earthquakes', lifetime: 30 * 60_000 },
  wildfires: { label: 'fires', list: 'fireDetections', lifetime: 7_200_000 },
  other: { label: 'events', list: 'events', lifetime: 540 * 60_000 },
} as const;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function clock(value: unknown, now: number): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= now ? value : null;
}
function failed(value: Record<string, unknown>): boolean {
  return ['unavailable', 'upstreamUnavailable', 'degraded', 'stale', 'rateLimited'].some(key => value[key] === true)
    || value.dataAvailable === false
    || ['error', 'errorCode', 'skipReason'].some(key => typeof value[key] === 'string' && value[key] !== '');
}
function validRows(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(record);
}

export function naturalDisastersReuseUntil(
  data: Record<string, unknown>, seeds: Record<string, unknown>, seismologyMeta: unknown,
  args: Record<string, unknown>, now: number,
): number | null {
  if (!record(seismologyMeta) || failed(seismologyMeta)
    || seismologyMeta.sourceState !== undefined && seismologyMeta.sourceState !== 'ok'
    || Array.isArray(seismologyMeta.failedSources) && seismologyMeta.failedSources.length > 0) return null;
  const metaClock = clock(seismologyMeta.fetchedAt, now);
  if (metaClock === null) return null;
  let deadline = metaClock + SOURCES.earthquakes.lifetime;
  const requested = argStrList(args.dataset);
  for (const dataset of requested.length ? requested : Object.keys(SOURCES)) {
    const source = SOURCES[dataset as keyof typeof SOURCES];
    if (!source) return null;
    const bucket = data[source.label];
    if (!record(bucket) || !validRows(bucket[source.list]) || failed(bucket)) return null;
    const seed = seeds[source.label];
    const clocks: number[] = [];
    if (seed !== null && seed !== undefined) {
      if (!record(seed) || !['OK', 'OK_ZERO'].includes(String(seed.state))
        || Array.isArray(seed.failedDatasets) && seed.failedDatasets.length > 0
        || typeof seed.errorReason === 'string' && seed.errorReason !== '') return null;
      const published = clock(seed.fetchedAt, now);
      if (published === null) return null;
      clocks.push(published);
    }
    if ('fetchedAt' in bucket) {
      const observed = clock(bucket.fetchedAt, now);
      if (observed === null) return null;
      clocks.push(observed);
    }
    if (!clocks.length) return null;
    deadline = Math.min(deadline, ...clocks.map(value => value + source.lifetime));
    if (dataset === 'wildfires') {
      if (['_firmsState', '_cwfisState', '_bcState'].some(key => key in bucket && bucket[key] !== 'ok')
        || bucket._firmsPartial === true
        || ['_firmsErrorCode', '_cwfisErrorCode', '_bcErrorCode'].some(key => bucket[key] !== undefined && bucket[key] !== null && bucket[key] !== '')
        || typeof bucket._firmsFailedCalls === 'number' && bucket._firmsFailedCalls > 0) return null;
    }
    if (dataset === 'other') {
      for (const key of ['westernPacific', 'hkoWarnings']) {
        const region = bucket[key];
        if (region !== undefined && (!record(region) || failed(region)
          || Array.isArray(region.sourceDecisions) && region.sourceDecisions.some(decision => !record(decision) || decision.status !== 'accepted'))) return null;
      }
      if ('eonetRetention' in bucket) {
        const retention = bucket.eonetRetention;
        if (!record(retention) || typeof retention.retainedUntil !== 'number' || !Number.isSafeInteger(retention.retainedUntil) || retention.retainedUntil <= 0
          || !Array.isArray(retention.eventIndexes)
          || retention.eventIndexes.some(index => !Number.isInteger(index) || index < 0 || index >= (bucket.events as unknown[]).length)
          || new Set(retention.eventIndexes).size !== retention.eventIndexes.length) return null;
        if (retention.eventIndexes.length) deadline = Math.min(deadline, retention.retainedUntil);
      }
    }
  }
  return deadline > now ? deadline : null;
}

export function filterNaturalDisastersPanelData(data: Record<string, unknown>, args: Record<string, unknown>): Record<string, unknown> {
  const magnitude = argNum(args.min_magnitude);
  const limit = argNum(args.limit) ?? DEFAULT_LIST_LIMIT;
  if (record(data.events) && Array.isArray(data.events.events)) data.events = projectNaturalEventsRetention(data.events);
  for (const source of Object.values(SOURCES)) {
    const bucket = data[source.label];
    if (!record(bucket) || !validRows(bucket[source.list])) continue;
    let rows = bucket[source.list] as Record<string, unknown>[];
    if (magnitude !== null && source.label !== 'fires') rows = rows.filter(row => (argNum(row.magnitude) ?? 0) >= magnitude);
    if (source.label === 'events' && argBool(args.active_only)) rows = rows.filter(row => row.closed === false);
    bucket[source.list] = rows;
    capNested(data, source.label, source.list, limit);
  }
  const labels = argStrList(args.dataset).map(value => SOURCES[value as keyof typeof SOURCES]?.label).filter((value): value is 'earthquakes' | 'fires' | 'events' => value !== undefined);
  return labels.length ? selectDatasets(data, labels) : data;
}
