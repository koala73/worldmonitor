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
  const stateColor = indicator.stale
    ? '#f39c12'
    : (
      indicator.unavailableReason
      || indicator.transportFailureReason
      || transportProblem
      || !available
      || indicator.direction === 'weakening'
      ? '#e74c3c'
      : indicator.direction === 'unchanged'
        ? 'var(--text-dim)'
        : '#27ae60'
    );
  const observed = indicator.observationPeriod || 'No observation period';
  const released = indicator.releaseTime || 'Release time unavailable';
  const revision = indicator.revisionState || 'Revision state unavailable';
  const source = indicator.source || 'Source unavailable';

  return `<div style="background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:6px;padding:14px 12px;display:flex;flex-direction:column;gap:4px;min-width:0">
    <div style="display:flex;justify-content:space-between;gap:6px;align-items:flex-start">
      <div style="font-size:10px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.07em">${escapeHtml(indicator.label)}</div>
      <span style="font-size:9px;color:${stateColor};font-weight:600">${escapeHtml(state.replace(/_/g, ' '))}</span>
    </div>
    <div style="font-size:28px;font-weight:700;color:var(--text);line-height:1.1;font-variant-numeric:tabular-nums">${value}</div>
    <div style="font-size:10px;color:var(--text-dim)">Period ${escapeHtml(observed)} · ${escapeHtml(indicator.periodKind || 'period unknown').replace(/_/g, ' ')}</div>
    <div style="font-size:10px;color:var(--text-dim)">Released ${escapeHtml(released)} · ${escapeHtml(revision).replace(/_/g, ' ')}</div>
    <div style="font-size:9px;color:var(--text-dim);overflow-wrap:anywhere">Source: ${escapeHtml(source)}</div>
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
