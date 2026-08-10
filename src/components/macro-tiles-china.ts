import type {
  ChinaMacroIndicator,
  GetChinaMacroSnapshotResponse,
} from '@/generated/client/worldmonitor/economic/v1/service_client';
import { escapeHtml } from '@/utils/sanitize';
import {
  CHINA_MACRO_REQUIRED_SERIES,
  CHINA_MACRO_SCHEMA_VERSION,
} from '../../shared/china-macro-contract.js';
import {
  normalizeChinaMacroObservations,
  normalizeChinaMacroPreflight,
  normalizeChinaMacroSourceDecision,
  normalizeChinaReleaseEvent,
  recomputeChinaMacroPillars,
  validateChinaMacroAvailabilityBindings,
} from '../../shared/china-macro-normalization';

function chinaValueFmt(indicator: ChinaMacroIndicator, value: number): string {
  if (indicator.unit === '%') return `${value.toFixed(1)}%`;
  if (indicator.unit === 'index') return value.toFixed(2);
  if (indicator.unit.includes('per')) return value.toFixed(4);
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}${indicator.unit ? ` ${indicator.unit}` : ''}`;
}

const CHINA_STATE_LABELS: Record<string, string> = {
  LIVE: 'Live',
  STALE: 'Stale',
  UNAVAILABLE: 'Unavailable',
  strengthening: 'Strengthening',
  weakening: 'Weakening',
  unchanged: 'Unchanged',
  ROBOTS_DISALLOW: 'Source blocked',
  TLS_CERTIFICATE_ERROR: 'Source unavailable',
  HTTP_429: 'Rate limited',
  HTTP_503: 'Source unavailable',
  SCHEMA_DRIFT: 'Schema mismatch',
  STALE_OBSERVATION: 'Observation stale',
  TRANSPORT_STALE: 'Transport stale',
  TRANSPORT_RECOVERING: 'Transport recovering',
  TRANSPORT_MISSING: 'Transport unavailable',
};

function chinaStateLabel(state: string): string {
  return CHINA_STATE_LABELS[state]
    ?? state.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function chinaStateTone(
  state: string,
  available: boolean,
  stale: boolean,
): 'positive' | 'warning' | 'negative' | 'neutral' {
  if (stale || state === 'STALE_OBSERVATION' || state === 'TRANSPORT_STALE') return 'warning';
  if (!available || state === 'UNAVAILABLE' || state === 'ROBOTS_DISALLOW' || state === 'TLS_CERTIFICATE_ERROR') return 'negative';
  if (state === 'weakening' || state === 'HTTP_429' || state === 'HTTP_503' || state === 'SCHEMA_DRIFT') return 'negative';
  if (state === 'TRANSPORT_RECOVERING' || state === 'TRANSPORT_MISSING') return 'warning';
  if (state === 'unchanged') return 'neutral';
  return 'positive';
}

export function chinaTileHtml(indicator: ChinaMacroIndicator): string {
  const available = indicator.hasValue && Number.isFinite(indicator.value);
  const value = available ? escapeHtml(chinaValueFmt(indicator, indicator.value)) : 'N/A';
  const transportProblem = indicator.transportStatus
    && indicator.transportStatus !== 'fresh'
    ? `TRANSPORT_${indicator.transportStatus.toUpperCase()}`
    : '';
  const direction = indicator.direction && indicator.direction !== 'unavailable'
    ? indicator.direction
    : '';
  const state = indicator.stale
    ? 'STALE'
    : (
      indicator.unavailableReason
      || indicator.transportFailureReason
      || transportProblem
      || direction
      || (available ? 'LIVE' : 'UNAVAILABLE')
    );
  const observed = indicator.observationPeriod || 'No observation period';
  const released = indicator.releaseTime || 'Release time unavailable';
  const revision = indicator.revisionState || 'Revision state unavailable';
  const source = indicator.source || 'Source unavailable';
  const stateLabel = chinaStateLabel(state);
  const stateTone = chinaStateTone(state, available, indicator.stale);
  const valueClass = available ? '' : ' macro-summary-value--unavailable';

  return `<div class="macro-summary-card">
    <div class="macro-summary-head">
      <span class="indicator-name">${escapeHtml(indicator.label)}</span>
      <span class="macro-summary-state macro-summary-state--${stateTone}" data-state="${escapeHtml(state)}">${escapeHtml(stateLabel)}</span>
    </div>
    <div class="macro-summary-value${valueClass}">${value}</div>
    <div class="macro-summary-meta">
      <span>Period ${escapeHtml(observed)} · ${escapeHtml(indicator.periodKind || 'period unknown').replace(/_/g, ' ')}</span>
      <span>Released ${escapeHtml(released)} · ${escapeHtml(revision).replace(/_/g, ' ')}</span>
    </div>
    <div class="macro-summary-source">Source: ${escapeHtml(source)}</div>
  </div>`;
}

export function normalizeHydratedChina(
  macro: unknown,
  calendar: unknown,
  now = Date.now(),
): GetChinaMacroSnapshotResponse | null {
  if (!macro || typeof macro !== 'object') return null;
  const raw = macro as Record<string, unknown>;
  if (raw.schemaVersion !== CHINA_MACRO_SCHEMA_VERSION || raw.countryCode !== 'CN') return null;
  const rawObservations = Array.isArray(raw.observations) ? raw.observations : [];
  const generatedAt = String(raw.generatedAt ?? '');
  const indicators = normalizeChinaMacroObservations(rawObservations, now, generatedAt);
  if (indicators === null) return null;
  const macroDecisions = normalizeChinaMacroPreflight(
    Array.isArray(raw.sourceDecisions) ? raw.sourceDecisions : [],
    generatedAt,
    now,
  );
  if (macroDecisions === null) return null;
  if (!validateChinaMacroAvailabilityBindings(rawObservations, macroDecisions)) return null;
  const calendarRecord = calendar && typeof calendar === 'object'
    ? calendar as Record<string, unknown>
    : {};
  const releaseEvents = Array.isArray(calendarRecord.events)
    ? calendarRecord.events.map(normalizeChinaReleaseEvent)
    : [];

  const launchReady = raw.launchReady === true && CHINA_MACRO_REQUIRED_SERIES.every((seriesId) => (
    indicators.some((indicator) => (
      indicator.id === seriesId
      && indicator.hasValue
      && !indicator.stale
      && !indicator.unavailableReason
      && indicator.transportStatus === 'fresh'
    ))
  ));
  const degraded = indicators.some((indicator) => (
    !indicator.hasValue
    || indicator.stale
    || indicator.unavailableReason !== ''
    || indicator.transportStatus !== 'fresh'
  ))
    || macroDecisions.some((decision) => decision.status !== 'accepted')
    || releaseEvents.length === 0;
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
      ...(Array.isArray(calendarRecord.sourceDecisions)
        ? calendarRecord.sourceDecisions.map(normalizeChinaMacroSourceDecision)
        : []),
    ],
    releaseEvents,
    unavailable: false,
    schemaVersion: CHINA_MACRO_SCHEMA_VERSION,
    pillars: recomputeChinaMacroPillars(indicators),
  };
}

export function isChinaLaunchReady(snapshot: GetChinaMacroSnapshotResponse | null): boolean {
  if (snapshot?.launchReady !== true || snapshot.unavailable) return false;
  return snapshot.schemaVersion === CHINA_MACRO_SCHEMA_VERSION
    && CHINA_MACRO_REQUIRED_SERIES.every((seriesId) => snapshot.indicators.some((indicator) => (
      indicator.id === seriesId
      && indicator.hasValue
      && Number.isFinite(indicator.value)
      && !indicator.stale
      && !indicator.unavailableReason
      && indicator.transportStatus === 'fresh'
    )));
}

export function hasChinaMacroData(snapshot: GetChinaMacroSnapshotResponse | null): boolean {
  return snapshot !== null
    && snapshot.unavailable !== true
    && snapshot.schemaVersion === CHINA_MACRO_SCHEMA_VERSION
    && snapshot.indicators.length > 0;
}
