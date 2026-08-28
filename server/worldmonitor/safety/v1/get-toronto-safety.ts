import {
  ApiError,
  type GetTorontoSafetyRequest,
  type GetTorontoSafetyResponse,
  type ServerContext,
  type TorontoAnnualAggregate,
  type TorontoReportedOccurrence,
} from '../../../../src/generated/server/worldmonitor/safety/v1/service_server';
import {
  TORONTO_SAFETY_SEMANTICS,
  torontoSafetySourceById,
} from '../../../../shared/toronto-safety.js';
import { readCachedJson, type CacheReadResult } from '../../../_shared/redis';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const VALID_DATASETS: ReadonlySet<string> = new Set([
  TORONTO_SAFETY_SEMANTICS.reportedOccurrence,
  TORONTO_SAFETY_SEMANTICS.annualAggregate,
]);

interface TpsSnapshot {
  semantic?: string;
  source?: string;
  fetchedAt?: string;
  editingInfo?: { dataLastEditDate?: number };
  newestContentAt?: number;
  newestContentYear?: number;
  records?: Array<Record<string, unknown>>;
}

interface TpsMeta {
  fetchedAt?: number;
  sourceState?: string;
  dataLastEditDate?: number;
  newestContentAt?: number;
  newestContentYear?: number;
}

type CacheReader = (key: string, raw?: boolean) => Promise<CacheReadResult>;

function ciIncludes(value: unknown, query: string): boolean {
  return !query || String(value ?? '').toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

function boundedLimit(value: number): number {
  return Number.isInteger(value) && value > 0 ? Math.min(value, MAX_LIMIT) : DEFAULT_LIMIT;
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function projectOccurrence(row: Record<string, unknown>): TorontoReportedOccurrence {
  return {
    id: text(row.id),
    objectId: numberOrZero(row.objectId),
    eventUniqueId: text(row.eventUniqueId),
    reportDate: text(row.reportDate),
    occurrenceDate: text(row.occDate),
    division: text(row.division),
    locationType: text(row.locationType),
    premisesType: text(row.premisesType),
    offence: text(row.offence),
    csiCategory: text(row.csiCategory),
    neighbourhood: text(row.neighbourhood158),
    longitude: numberOrZero(row.lon),
    latitude: numberOrZero(row.lat),
    approximate: row.approximate === true,
  };
}

function projectAggregate(row: Record<string, unknown>): TorontoAnnualAggregate {
  return {
    id: text(row.id),
    objectId: numberOrZero(row.objectId),
    eventYear: numberOrZero(row.eventYear),
    divisionOriginal: text(row.divisionOriginal),
    divisionFinal: text(row.divisionFinal),
    neighbourhood: text(row.neighbourhood158),
    eventCount: numberOrZero(row.eventCount),
    incidentPoint: false,
  };
}

export async function queryTorontoSafety(
  request: GetTorontoSafetyRequest,
  readCache: CacheReader = readCachedJson,
): Promise<GetTorontoSafetyResponse> {
  const semantic = request.dataset || TORONTO_SAFETY_SEMANTICS.reportedOccurrence;
  if (!VALID_DATASETS.has(semantic)) {
    throw new ApiError(400, 'dataset must be reported_occurrence or annual_aggregate', '');
  }

  const sourceId = semantic === TORONTO_SAFETY_SEMANTICS.reportedOccurrence ? 'tps-mci' : 'tps-calls-attended';
  const descriptor = torontoSafetySourceById(sourceId);
  if (!descriptor || descriptor.productionWriter !== 'on-demand') throw new Error(`missing Toronto safety source: ${sourceId}`);

  const [snapshotRead, metaRead] = await Promise.all([
    readCache(descriptor.canonicalKey, true),
    readCache(descriptor.seedMetaKey, true),
  ]);
  const snapshot = snapshotRead.status === 'hit' ? snapshotRead.value as TpsSnapshot : null;
  const meta = metaRead.status === 'hit' ? metaRead.value as TpsMeta : null;
  const validSnapshot = snapshot?.semantic === semantic
    && snapshot.source === sourceId
    && Array.isArray(snapshot.records);
  const records = validSnapshot ? snapshot.records! : [];
  const division = request.division || '';
  const neighbourhood = request.neighbourhood || '';
  const offence = request.offence || '';
  const year = request.year || 0;
  const limit = boundedLimit(request.limit);

  const filtered = records.filter((row) => {
    if (!ciIncludes(row.neighbourhood158, neighbourhood)) return false;
    if (semantic === TORONTO_SAFETY_SEMANTICS.reportedOccurrence) {
      const reportYear = text(row.reportDate).slice(0, 4);
      return ciIncludes(row.division, division)
        && ciIncludes(row.offence, offence)
        && (year === 0 || reportYear === String(year));
    }
    return (ciIncludes(row.divisionFinal, division) || ciIncludes(row.divisionOriginal, division))
      && !offence
      && (year === 0 || numberOrZero(row.eventYear) === year);
  });
  const selected = filtered.slice(0, limit);
  const unavailable = snapshotRead.status !== 'hit' || !validSnapshot;
  const degraded = metaRead.status !== 'hit' || meta?.sourceState !== 'ok';
  const fetchedAt = numberOrZero(meta?.fetchedAt) || Date.parse(snapshot?.fetchedAt || '') || 0;

  return {
    semantic,
    source: sourceId,
    sourceLabel: descriptor.label,
    attribution: descriptor.attribution,
    disclaimer: descriptor.disclaimer,
    sourceUrl: descriptor.sourceUrl,
    fetchedAt,
    sourceEditedAt: numberOrZero(meta?.dataLastEditDate) || numberOrZero(snapshot?.editingInfo?.dataLastEditDate),
    newestContentAt: numberOrZero(meta?.newestContentAt) || numberOrZero(snapshot?.newestContentAt),
    newestContentYear: numberOrZero(meta?.newestContentYear) || numberOrZero(snapshot?.newestContentYear),
    degraded,
    unavailable,
    matched: filtered.length,
    truncated: filtered.length > selected.length,
    occurrences: semantic === TORONTO_SAFETY_SEMANTICS.reportedOccurrence ? selected.map(projectOccurrence) : [],
    aggregates: semantic === TORONTO_SAFETY_SEMANTICS.annualAggregate ? selected.map(projectAggregate) : [],
  };
}

export async function getTorontoSafety(
  _ctx: ServerContext,
  request: GetTorontoSafetyRequest,
): Promise<GetTorontoSafetyResponse> {
  return queryTorontoSafety(request);
}
