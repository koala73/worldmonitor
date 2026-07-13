import type {
  ChinaMacroIndicator,
  ChinaMacroSourceDecision,
  ChinaReleaseEvent,
  GetChinaMacroSnapshotRequest,
  GetChinaMacroSnapshotResponse,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';
import { getCachedJsonBatch } from '../../../_shared/redis';
import { CHINA_MACRO_KEY, CHINA_RELEASE_CALENDAR_KEY } from '../../../_shared/cache-keys';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function adaptChinaMacroIndicator(value: unknown): ChinaMacroIndicator {
  const row = asRecord(value);
  const current = asNumber(row.value);
  const prior = asNumber(row.priorValue);
  return {
    id: asString(row.id),
    label: asString(row.label),
    category: asString(row.category),
    value: current ?? 0,
    hasValue: current !== null,
    priorValue: prior ?? 0,
    hasPriorValue: prior !== null,
    unit: asString(row.unit),
    observationDate: asString(row.observationDate),
    source: asString(row.source),
    sourceUrl: asString(row.sourceUrl),
    stale: row.stale === true,
    unavailableReason: asString(row.unavailableReason),
    contextOnly: row.contextOnly === true,
  };
}

function adaptDecision(value: unknown): ChinaMacroSourceDecision {
  const row = asRecord(value);
  return {
    source: asString(row.source),
    host: asString(row.host),
    status: asString(row.status),
    reason: asString(row.reason),
    checkedAt: asString(row.checkedAt),
    optional: row.optional === true,
    requestCount: Math.max(0, Math.trunc(asNumber(row.requestCount) ?? 0)),
  };
}

function adaptEvent(value: unknown): ChinaReleaseEvent {
  const row = asRecord(value);
  return {
    id: asString(row.id),
    event: asString(row.event),
    countryCode: asString(row.countryCode),
    releaseDate: asString(row.releaseDate),
    releaseTime: asString(row.releaseTime),
    timezone: asString(row.timezone),
    kind: asString(row.kind),
    status: asString(row.status),
    source: asString(row.source),
    sourceUrl: asString(row.sourceUrl),
  };
}

function fallback(): GetChinaMacroSnapshotResponse {
  return {
    countryCode: 'CN', generatedAt: '', status: 'unavailable', launchReady: false,
    contentObservationDate: '', latestObservationDate: '', indicators: [],
    sourceDecisions: [], releaseEvents: [], unavailable: true,
  };
}

export async function getChinaMacroSnapshot(
  _ctx: ServerContext,
  _req: GetChinaMacroSnapshotRequest,
): Promise<GetChinaMacroSnapshotResponse> {
  const cached = await getCachedJsonBatch([CHINA_MACRO_KEY, CHINA_RELEASE_CALENDAR_KEY], true);
  const macro = asRecord(cached.get(CHINA_MACRO_KEY));
  const calendar = asRecord(cached.get(CHINA_RELEASE_CALENDAR_KEY));
  const rawIndicators = Array.isArray(macro.indicators) ? macro.indicators : [];
  const rawEvents = Array.isArray(calendar.events) ? calendar.events : [];
  if (rawIndicators.length === 0 || rawEvents.length === 0) return fallback();
  const macroDecisions = Array.isArray(macro.sourceDecisions) ? macro.sourceDecisions : [];
  const calendarDecisions = Array.isArray(calendar.sourceDecisions) ? calendar.sourceDecisions : [];
  return {
    countryCode: asString(macro.countryCode) || 'CN',
    generatedAt: asString(macro.generatedAt),
    status: asString(macro.status) || 'degraded',
    launchReady: macro.launchReady === true,
    contentObservationDate: asString(macro.contentObservationDate),
    latestObservationDate: asString(macro.latestObservationDate),
    indicators: rawIndicators.map(adaptChinaMacroIndicator),
    sourceDecisions: [...macroDecisions, ...calendarDecisions].map(adaptDecision),
    releaseEvents: rawEvents.map(adaptEvent),
    unavailable: false,
  };
}
