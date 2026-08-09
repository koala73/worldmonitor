import type {
  GetChinaMacroSnapshotRequest,
  GetChinaMacroSnapshotResponse,
  ServerContext,
} from '../../../../src/generated/server/worldmonitor/economic/v1/service_server';
import { getCachedJsonBatch } from '../../../_shared/redis';
import { CHINA_MACRO_KEY, CHINA_RELEASE_CALENDAR_KEY } from '../../../_shared/cache-keys';
import {
  CHINA_MACRO_REQUIRED_SERIES,
  CHINA_MACRO_SCHEMA_VERSION,
} from '../../../../shared/china-macro-contract.js';
import {
  normalizeChinaMacroObservations,
  normalizeChinaMacroPreflight,
  normalizeChinaMacroSourceDecision,
  normalizeChinaReleaseEvent,
  recomputeChinaMacroPillars,
  validateChinaMacroAvailabilityBindings,
} from '../../../../shared/china-macro-normalization';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function fallback(): GetChinaMacroSnapshotResponse {
  return {
    countryCode: 'CN', generatedAt: '', status: 'unavailable', launchReady: false,
    contentObservationDate: '', latestObservationDate: '', indicators: [],
    sourceDecisions: [], releaseEvents: [], unavailable: true,
    schemaVersion: CHINA_MACRO_SCHEMA_VERSION,
    pillars: [],
  };
}

export async function getChinaMacroSnapshot(
  _ctx: ServerContext,
  _req: GetChinaMacroSnapshotRequest,
): Promise<GetChinaMacroSnapshotResponse> {
  const cached = await getCachedJsonBatch([CHINA_MACRO_KEY, CHINA_RELEASE_CALENDAR_KEY], true);
  const macro = asRecord(cached.get(CHINA_MACRO_KEY));
  const calendar = asRecord(cached.get(CHINA_RELEASE_CALENDAR_KEY));
  const rawIndicators = Array.isArray(macro.observations) ? macro.observations : [];
  const rawEvents = Array.isArray(calendar.events) ? calendar.events : [];
  if (
    macro.schemaVersion !== CHINA_MACRO_SCHEMA_VERSION
    || macro.countryCode !== 'CN'
    || rawIndicators.length === 0
  ) return fallback();
  const generatedAt = asString(macro.generatedAt);
  const indicators = normalizeChinaMacroObservations(rawIndicators, Date.now(), generatedAt);
  if (indicators === null) return fallback();
  const macroDecisions = normalizeChinaMacroPreflight(
    Array.isArray(macro.sourceDecisions) ? macro.sourceDecisions : [],
    generatedAt,
  );
  if (macroDecisions === null) return fallback();
  if (!validateChinaMacroAvailabilityBindings(rawIndicators, macroDecisions)) return fallback();
  const launchReady = macro.launchReady === true && CHINA_MACRO_REQUIRED_SERIES.every((seriesId) => (
    indicators.some((indicator) => (
      indicator.id === seriesId
      && indicator.hasValue
      && !indicator.stale
      && !indicator.unavailableReason
      && indicator.transportStatus === 'fresh'
    ))
  ));
  const calendarDecisions = Array.isArray(calendar.sourceDecisions) ? calendar.sourceDecisions : [];
  const degraded = indicators.some((indicator) => (
    !indicator.hasValue
    || indicator.stale
    || indicator.unavailableReason !== ''
    || indicator.transportStatus !== 'fresh'
  ))
    || macroDecisions.some((decision) => decision.status !== 'accepted')
    || rawEvents.length === 0;
  const requiredPeriods = CHINA_MACRO_REQUIRED_SERIES.map((seriesId) => (
    indicators.find((indicator) => indicator.id === seriesId)?.observationPeriod ?? ''
  )).filter(Boolean).sort();
  return {
    countryCode: 'CN',
    generatedAt,
    status: launchReady && !degraded ? 'ready' : 'degraded',
    launchReady,
    contentObservationDate: requiredPeriods[0] ?? '',
    latestObservationDate: requiredPeriods[requiredPeriods.length - 1] ?? '',
    indicators,
    sourceDecisions: [
      ...macroDecisions,
      ...calendarDecisions.map(normalizeChinaMacroSourceDecision),
    ],
    releaseEvents: rawEvents.map(normalizeChinaReleaseEvent),
    unavailable: false,
    schemaVersion: CHINA_MACRO_SCHEMA_VERSION,
    pillars: recomputeChinaMacroPillars(indicators),
  };
}
