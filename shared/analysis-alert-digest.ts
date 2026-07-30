/**
 * Cross-domain alert digest core — "what tripped a threshold today?" plus a
 * weekly-trends view, shared between the MCP tool (api/mcp) and any future
 * dashboard rollup (#5696).
 *
 * Each domain trips on ITS OWN existing severity vocabulary (CII level bands,
 * cable-health proto status, seeder-emitted surge alerts, temporal-anomaly
 * z-score bands) — this module deliberately invents no new thresholds. The
 * caller adapts raw cache payloads into the normalized inputs below; a null
 * input marks the domain "unavailable" rather than quietly passing.
 *
 * Dependency-free: importable from Vite client code, Vercel Edge bundles,
 * server handlers, and tsx tests alike.
 */

export type AlertSeverity = 'low' | 'medium' | 'high' | 'critical';

export const SEVERITY_RANK: Record<AlertSeverity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export interface CiiEntry {
  code?: unknown;
  score?: unknown;
  level?: unknown;
}

export interface SurgeEntry {
  theaterId?: unknown;
  surgeType?: unknown;
  surgeMultiple?: unknown;
  strikeCapable?: unknown;
}

export interface CableEntry {
  name?: unknown;
  status?: unknown;
}

export interface OutageEntry {
  country?: unknown;
  severity?: unknown;
  detectedAt?: unknown;
  endedAt?: unknown;
}

export interface AnomalyEntry {
  type?: unknown;
  region?: unknown;
  zScore?: unknown;
  severity?: unknown;
}

export interface ThermalEntry {
  id?: unknown;
  level?: unknown;
  score?: unknown;
}

export interface StressInput {
  index?: unknown;
  level?: unknown;
}

export interface AlertDigestInputs {
  cii?: CiiEntry[] | null;
  militarySurges?: SurgeEntry[] | null;
  cables?: CableEntry[] | null;
  outages?: OutageEntry[] | null;
  temporalAnomalies?: AnomalyEntry[] | null;
  thermal?: ThermalEntry[] | null;
  shippingStress?: StressInput | null;
}

export interface TrippedAlert {
  domain: string;
  id: string;
  label: string;
  severity: AlertSeverity;
  metric: string;
  value: number | string | null;
}

export interface AlertDigest {
  generatedAt: string;
  tripped: TrippedAlert[];
  quiet: string[];
  unavailable: string[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function normalizeSeverity(v: unknown, fallback: AlertSeverity): AlertSeverity {
  const s = str(v).toLowerCase();
  if (s === 'low' || s === 'medium' || s === 'high' || s === 'critical') return s;
  if (s === 'minor' || s === 'info') return 'low';
  if (s === 'moderate') return 'medium';
  if (s === 'major' || s === 'elevated') return 'high';
  if (s === 'severe') return 'critical';
  return fallback;
}

export function buildAlertDigest(inputs: AlertDigestInputs, now: number): AlertDigest {
  const tripped: TrippedAlert[] = [];
  const quiet: string[] = [];
  const unavailable: string[] = [];

  const evaluate = <T>(
    domain: string,
    input: T[] | null | undefined,
    collect: (entries: T[]) => void,
  ): void => {
    if (!Array.isArray(input)) {
      unavailable.push(domain);
      return;
    }
    const before = tripped.length;
    collect(input);
    if (tripped.length === before) quiet.push(domain);
  };

  // CII: the risk scorer already bands countries; high/critical levels trip.
  evaluate('cii', inputs.cii, (entries) => {
    for (const e of entries) {
      const level = str(e.level).toLowerCase();
      if (level !== 'high' && level !== 'critical') continue;
      const code = str(e.code) || 'unknown';
      tripped.push({
        domain: 'cii',
        id: code,
        label: `Country instability ${level}: ${code}`,
        severity: level as AlertSeverity,
        metric: 'cii_score',
        value: num(e.score),
      });
    }
  });

  // Military surges: the seeder only emits alerts already past its baseline
  // threshold, so presence in the list IS the trip; strike capability
  // escalates the band.
  evaluate('military_surge', inputs.militarySurges, (entries) => {
    for (const e of entries) {
      const theater = str(e.theaterId) || 'unknown-theater';
      const type = str(e.surgeType) || 'activity';
      tripped.push({
        domain: 'military_surge',
        id: `${type}-${theater}`,
        label: `${type} surge in ${theater}`,
        severity: e.strikeCapable === true ? 'critical' : 'high',
        metric: 'surge_multiple',
        value: num(e.surgeMultiple),
      });
    }
  });

  // Cable health: proto status vocabulary from get-cable-health.
  evaluate('cable_health', inputs.cables, (entries) => {
    for (const e of entries) {
      const status = str(e.status);
      if (status !== 'CABLE_HEALTH_STATUS_FAULT' && status !== 'CABLE_HEALTH_STATUS_DEGRADED') continue;
      const name = str(e.name) || 'unknown-cable';
      const fault = status === 'CABLE_HEALTH_STATUS_FAULT';
      tripped.push({
        domain: 'cable_health',
        id: name,
        label: `Cable ${fault ? 'fault' : 'degraded'}: ${name}`,
        severity: fault ? 'high' : 'medium',
        metric: 'cable_status',
        value: status,
      });
    }
  });

  // Outages: only ongoing ones (no end, or end in the future) trip.
  evaluate('outages', inputs.outages, (entries) => {
    for (const e of entries) {
      const endedAt = num(e.endedAt);
      if (endedAt !== null && endedAt > 0 && endedAt <= now) continue;
      const country = str(e.country) || 'unknown';
      tripped.push({
        domain: 'outages',
        id: country,
        label: `Internet outage: ${country}`,
        severity: normalizeSeverity(e.severity, 'medium'),
        metric: 'outage',
        value: str(e.severity) || null,
      });
    }
  });

  // Temporal anomalies: producer already floors at medium (z >= 1.5).
  evaluate('temporal_anomaly', inputs.temporalAnomalies, (entries) => {
    for (const e of entries) {
      const type = str(e.type) || 'unknown';
      const region = str(e.region) || 'global';
      tripped.push({
        domain: 'temporal_anomaly',
        id: `${type}:${region}`,
        label: `${type} anomaly in ${region}`,
        severity: normalizeSeverity(e.severity, 'medium'),
        metric: 'z_score',
        value: num(e.zScore),
      });
    }
  });

  // Thermal escalation: trips on the producer's high/critical levels only.
  evaluate('thermal', inputs.thermal, (entries) => {
    for (const e of entries) {
      const level = str(e.level).toLowerCase();
      if (level !== 'high' && level !== 'critical') continue;
      const id = str(e.id) || 'unknown-zone';
      tripped.push({
        domain: 'thermal',
        id,
        label: `Thermal escalation ${level}: ${id}`,
        severity: level as AlertSeverity,
        metric: 'thermal_score',
        value: num(e.score),
      });
    }
  });

  // Shipping stress: scalar input; trips only when the producer labels the
  // level elevated/high/critical — no invented numeric threshold.
  {
    const stress = inputs.shippingStress;
    if (!stress || typeof stress !== 'object') {
      unavailable.push('shipping_stress');
    } else {
      const level = normalizeSeverity(stress.level, 'low');
      if ((str(stress.level) !== '' && level === 'high') || level === 'critical') {
        tripped.push({
          domain: 'shipping_stress',
          id: 'global',
          label: `Shipping stress ${level}`,
          severity: level,
          metric: 'stress_index',
          value: num(stress.index),
        });
      } else {
        quiet.push('shipping_stress');
      }
    }
  }

  tripped.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);

  return {
    generatedAt: new Date(now).toISOString(),
    tripped,
    quiet,
    unavailable,
  };
}

export interface TrendSeries {
  domain: string;
  points: Array<{ t: number; value: number }>;
}

export interface DomainTrend {
  domain: string;
  latest: number;
  baselineMean: number;
  direction: 'rising' | 'falling' | 'flat';
  /** Coefficient of variation over the window (0 for a constant series). */
  volatility: number;
  /** Latest value exceeds early-window mean + 2σ. */
  anomalous: boolean;
  points: number;
}

export function buildWeeklyTrends(series: TrendSeries[], _now: number): DomainTrend[] {
  const trends: DomainTrend[] = [];

  for (const s of series) {
    const values = (s.points ?? [])
      .filter((p) => typeof p?.value === 'number' && Number.isFinite(p.value))
      .sort((a, b) => a.t - b.t)
      .map((p) => p.value);
    if (values.length < 3) continue;

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    const stddev = Math.sqrt(variance);

    const half = Math.floor(values.length / 2);
    const earlyValues = values.slice(0, half);
    const lateValues = values.slice(half);
    const earlyMean = earlyValues.reduce((a, b) => a + b, 0) / earlyValues.length;
    const lateMean = lateValues.reduce((a, b) => a + b, 0) / lateValues.length;

    // Direction: late-half mean vs early-half mean, with a 10%-of-window-mean
    // dead band so noise reads as flat.
    const band = Math.abs(mean) * 0.1;
    let direction: DomainTrend['direction'] = 'flat';
    if (lateMean - earlyMean > band) direction = 'rising';
    else if (earlyMean - lateMean > band) direction = 'falling';

    const earlyVariance = earlyValues.reduce((a, b) => a + (b - earlyMean) ** 2, 0) / earlyValues.length;
    const earlyStddev = Math.sqrt(earlyVariance);
    const latest = values[values.length - 1] ?? 0;

    trends.push({
      domain: s.domain,
      latest,
      baselineMean: mean,
      direction,
      volatility: mean === 0 ? 0 : stddev / Math.abs(mean),
      anomalous: latest > earlyMean + 2 * earlyStddev,
      points: values.length,
    });
  }

  return trends;
}
