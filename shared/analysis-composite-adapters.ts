/**
 * Composite-tool adapters: raw seeded cache payloads → shared-core inputs
 * (#5696 U3). Pure shape mapping only — no IO — so the MCP `_execute`
 * handlers stay thin and every mapping is unit-testable against
 * seed-shaped fixtures.
 *
 * Field names here are pinned to the ACTUAL producer outputs:
 * - seismology:earthquakes:v1  (scripts/seed-earthquakes.mjs)
 * - wildfire:fires:v1          (scripts/seed-fire-detections.mjs)
 * - conflict:ucdp-events:v1    (scripts/seed-ucdp-events.mjs)
 * - risk:scores:sebuf:v8       (get-risk-scores.ts — `region`/`combinedScore`)
 * - military:surges:v1         (scripts/_military-surges.mjs)
 * - cable-health-v1            (get-cable-health.ts `{ generatedAt, cables }`)
 * - infra:outages:v1           (scripts/seed-internet-outages.mjs)
 * - temporal:anomalies:v1      (list-temporal-anomalies.ts)
 * - thermal:escalation:v1      (scripts/lib/thermal-escalation.mjs —
 *   `THERMAL_STATUS_*` and `zScore`)
 * - supply_chain:shipping_stress:v1 (get-shipping-stress.ts —
 *   `stressScore`/`stressLevel`)
 *
 * Dependency-free apart from sibling shared modules.
 */

import type {
  AlertDigestInputs,
  AlertSeverity,
  AnomalyEntry,
  CableEntry,
  CiiEntry,
  OutageEntry,
  StressInput,
  SurgeEntry,
  ThermalEntry,
} from './analysis-alert-digest';
import { finiteNumber, nonEmptyString } from './analysis-adapter-guards';

const OUTAGE_SEVERITY_LEVELS: Readonly<Record<string, AlertSeverity>> = {
  OUTAGE_SEVERITY_TOTAL: 'critical',
  OUTAGE_SEVERITY_MAJOR: 'high',
  OUTAGE_SEVERITY_PARTIAL: 'medium',
};

const THERMAL_STATUS_LEVELS: Readonly<Record<string, AlertSeverity>> = {
  THERMAL_STATUS_PERSISTENT: 'critical',
  THERMAL_STATUS_SPIKE: 'high',
  THERMAL_STATUS_ELEVATED: 'medium',
  THERMAL_STATUS_NORMAL: 'low',
};

export interface ExposureEvent {
  id: string;
  name: string;
  type: string;
  lat: number;
  lon: number;
}

function coords(entry: unknown): { lat: number; lon: number } | null {
  const location = (entry as { location?: { latitude?: unknown; longitude?: unknown } })?.location;
  const lat = finiteNumber(location?.latitude);
  const lon = finiteNumber(location?.longitude);
  if (lat === null || lon === null) return null;
  return { lat, lon };
}

export function earthquakesToExposureEvents(payload: unknown, limit = 50): ExposureEvent[] {
  const quakes = (payload as { earthquakes?: unknown[] })?.earthquakes;
  if (!Array.isArray(quakes)) return [];
  const events: ExposureEvent[] = [];
  for (const q of quakes) {
    const c = coords(q);
    if (!c) continue;
    const record = q as { id?: unknown; place?: unknown; magnitude?: unknown };
    const magnitude = finiteNumber(record.magnitude);
    events.push({
      id: nonEmptyString(record.id) || `quake-${events.length}`,
      name: nonEmptyString(record.place) || `M${magnitude ?? '?'} earthquake`,
      type: 'earthquake',
      ...c,
    });
    if (events.length >= limit) break;
  }
  return events;
}

export function firesToExposureEvents(payload: unknown, limit = 50): ExposureEvent[] {
  const fires = (payload as { fireDetections?: unknown[] })?.fireDetections;
  if (!Array.isArray(fires)) return [];
  const ranked = fires
    .map((f) => ({ f: f as { id?: unknown; frp?: unknown; region?: unknown }, c: coords(f) }))
    .filter((x): x is { f: { id?: unknown; frp?: unknown; region?: unknown }; c: { lat: number; lon: number } } => x.c !== null)
    .sort((a, b) => (finiteNumber(b.f.frp) ?? 0) - (finiteNumber(a.f.frp) ?? 0))
    .slice(0, limit);
  return ranked.map(({ f, c }, i) => ({
    id: nonEmptyString(f.id) || `fire-${i}`,
    name: `Fire detection${nonEmptyString(f.region) ? ` — ${nonEmptyString(f.region)}` : ''}`,
    type: 'wildfire',
    ...c,
  }));
}

export function ucdpEventsToExposureEvents(payload: unknown, limit = 50): ExposureEvent[] {
  const raw = (payload as { events?: unknown[] })?.events;
  if (!Array.isArray(raw)) return [];
  const dated = raw
    .map((e) => ({ e: e as { id?: unknown; country?: unknown; dateStart?: unknown }, c: coords(e) }))
    .filter((x): x is { e: { id?: unknown; country?: unknown; dateStart?: unknown }; c: { lat: number; lon: number } } => x.c !== null)
    .sort((a, b) => Date.parse(nonEmptyString(b.e.dateStart)) - Date.parse(nonEmptyString(a.e.dateStart)))
    .slice(0, limit);
  return dated.map(({ e, c }, i) => ({
    id: e.id != null ? String(e.id) : `conflict-${i}`,
    name: `Conflict event${nonEmptyString(e.country) ? ` — ${nonEmptyString(e.country)}` : ''}`,
    type: 'conflict',
    ...c,
  }));
}

/**
 * Bands mirror the focal-point detector's urgency thresholds (70/50) plus the
 * dashboard's 25-point elevated floor — no new vocabulary.
 */
export function riskScoresToCiiInput(payload: unknown): CiiEntry[] {
  const scores = (payload as { ciiScores?: unknown[] })?.ciiScores;
  if (!Array.isArray(scores)) return [];
  const entries: CiiEntry[] = [];
  for (const s of scores) {
    const record = s as { region?: unknown; combinedScore?: unknown };
    const score = finiteNumber(record.combinedScore);
    const code = nonEmptyString(record.region);
    if (!code || score === null) continue;
    const level = score >= 70 ? 'critical' : score >= 50 ? 'high' : score >= 25 ? 'medium' : 'low';
    entries.push({ code, score, level });
  }
  return entries;
}

export function surgesToDigestInput(payload: unknown): SurgeEntry[] {
  const list = Array.isArray(payload)
    ? payload
    : (payload as { surges?: unknown[] })?.surges;
  if (!Array.isArray(list)) return [];
  return list.map((s) => {
    const record = s as SurgeEntry;
    return {
      theaterId: record.theaterId,
      surgeType: record.surgeType,
      surgeMultiple: record.surgeMultiple,
      strikeCapable: record.strikeCapable,
    };
  });
}

export function cableHealthToDigestInput(payload: unknown): CableEntry[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const wrapped = (payload as { cables?: unknown }).cables;
  const map = wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped)
    ? wrapped as Record<string, { status?: unknown }>
    : payload as Record<string, { status?: unknown }>;
  return Object.entries(map)
    .filter(([, v]) => v && typeof v === 'object' && 'status' in v)
    .map(([name, v]) => ({ name, status: v.status }));
}

export function outagesToDigestInput(payload: unknown): OutageEntry[] {
  const outages = (payload as { outages?: unknown[] })?.outages;
  if (!Array.isArray(outages)) return [];
  return outages.map((o) => {
    const record = o as OutageEntry;
    const rawSeverity = nonEmptyString(record.severity).toUpperCase();
    const severity = OUTAGE_SEVERITY_LEVELS[rawSeverity] ?? record.severity;
    return {
      country: record.country,
      severity,
      detectedAt: record.detectedAt,
      endedAt: record.endedAt,
    };
  });
}

export function anomaliesToDigestInput(payload: unknown): AnomalyEntry[] {
  const anomalies = (payload as { anomalies?: unknown[] })?.anomalies;
  if (!Array.isArray(anomalies)) return [];
  return anomalies.map((a) => {
    const record = a as AnomalyEntry;
    return {
      type: record.type,
      region: record.region,
      zScore: record.zScore,
      severity: record.severity,
    };
  });
}

export function thermalToDigestInput(payload: unknown): ThermalEntry[] {
  const clusters = (payload as { clusters?: unknown[] })?.clusters;
  if (!Array.isArray(clusters)) return [];
  return clusters.map((c, i) => {
    const record = c as {
      id?: unknown;
      name?: unknown;
      region?: unknown;
      status?: unknown;
      zScore?: unknown;
      anomalyScore?: unknown;
    };
    const status = nonEmptyString(record.status);
    const score = finiteNumber(record.zScore) ?? finiteNumber(record.anomalyScore);
    const level = THERMAL_STATUS_LEVELS[status]
      ?? (status.toLowerCase() === 'spike' || (score ?? 0) > 2 ? 'high' : 'low');
    return {
      id: nonEmptyString(record.id) || nonEmptyString(record.name) || nonEmptyString(record.region) || `cluster-${i}`,
      level,
      score,
    };
  });
}

export function stressToDigestInput(payload: unknown): StressInput | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as { stressScore?: unknown; stressLevel?: unknown };
  return { index: finiteNumber(record.stressScore), level: record.stressLevel };
}

export interface RawDigestPayloads {
  riskScores?: unknown;
  surges?: unknown;
  cableHealth?: unknown;
  outages?: unknown;
  temporal?: unknown;
  thermal?: unknown;
  stress?: unknown;
}

/** Null/undefined raw payloads propagate as null so the digest core marks the domain unavailable. */
export function buildDigestInputs(raw: RawDigestPayloads): AlertDigestInputs {
  return {
    cii: raw.riskScores == null ? null : riskScoresToCiiInput(raw.riskScores),
    militarySurges: raw.surges == null ? null : surgesToDigestInput(raw.surges),
    cables: raw.cableHealth == null ? null : cableHealthToDigestInput(raw.cableHealth),
    outages: raw.outages == null ? null : outagesToDigestInput(raw.outages),
    temporalAnomalies: raw.temporal == null ? null : anomaliesToDigestInput(raw.temporal),
    thermal: raw.thermal == null ? null : thermalToDigestInput(raw.thermal),
    shippingStress: raw.stress == null ? null : stressToDigestInput(raw.stress),
  };
}
