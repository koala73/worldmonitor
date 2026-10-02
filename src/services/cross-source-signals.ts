import { getHydratedData } from '@/services/bootstrap';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { createCircuitBreaker } from '@/utils/circuit-breaker';
import type {
  CrossSourceSignal,
  ListCrossSourceSignalsResponse,
} from '@/generated/client/worldmonitor/intelligence/v1/service_client';
import { IntelligenceServiceClient } from '@/services/generated-rpc-clients';

const client = new IntelligenceServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });
const breaker = createCircuitBreaker<ListCrossSourceSignalsResponse>({ name: 'Cross-Source Signals', cacheTtlMs: 15 * 60 * 1000, persistCache: true });

export type { ListCrossSourceSignalsResponse };

const EMPTY: ListCrossSourceSignalsResponse = { signals: [], evaluatedAt: 0, compositeCount: 0 };

// Keep these allowlists aligned with the RPC reader across the browser/server boundary.
const VALID_SIGNAL_TYPES = new Set<CrossSourceSignal['type']>([
  'CROSS_SOURCE_SIGNAL_TYPE_COMPOSITE_ESCALATION',
  'CROSS_SOURCE_SIGNAL_TYPE_THERMAL_SPIKE',
  'CROSS_SOURCE_SIGNAL_TYPE_GPS_JAMMING',
  'CROSS_SOURCE_SIGNAL_TYPE_MILITARY_FLIGHT_SURGE',
  'CROSS_SOURCE_SIGNAL_TYPE_UNREST_SURGE',
  'CROSS_SOURCE_SIGNAL_TYPE_OREF_ALERT_CLUSTER',
  'CROSS_SOURCE_SIGNAL_TYPE_VIX_SPIKE',
  'CROSS_SOURCE_SIGNAL_TYPE_COMMODITY_SHOCK',
  'CROSS_SOURCE_SIGNAL_TYPE_CYBER_ESCALATION',
  'CROSS_SOURCE_SIGNAL_TYPE_SHIPPING_DISRUPTION',
  'CROSS_SOURCE_SIGNAL_TYPE_SANCTIONS_SURGE',
  'CROSS_SOURCE_SIGNAL_TYPE_EARTHQUAKE_SIGNIFICANT',
  'CROSS_SOURCE_SIGNAL_TYPE_RADIATION_ANOMALY',
  'CROSS_SOURCE_SIGNAL_TYPE_INFRASTRUCTURE_OUTAGE',
  'CROSS_SOURCE_SIGNAL_TYPE_WILDFIRE_ESCALATION',
  'CROSS_SOURCE_SIGNAL_TYPE_DISPLACEMENT_SURGE',
  'CROSS_SOURCE_SIGNAL_TYPE_FORECAST_DETERIORATION',
  'CROSS_SOURCE_SIGNAL_TYPE_MARKET_STRESS',
  'CROSS_SOURCE_SIGNAL_TYPE_WEATHER_EXTREME',
  'CROSS_SOURCE_SIGNAL_TYPE_MEDIA_TONE_DETERIORATION',
  'CROSS_SOURCE_SIGNAL_TYPE_RISK_SCORE_SPIKE',
  'CROSS_SOURCE_SIGNAL_TYPE_PHYSICAL_PREMIUM_REGIME_TRANSITION',
  'CROSS_SOURCE_SIGNAL_TYPE_REGULATORY_ACTION',
]);

const VALID_SEVERITIES = new Set<CrossSourceSignal['severity']>([
  'CROSS_SOURCE_SIGNAL_SEVERITY_LOW',
  'CROSS_SOURCE_SIGNAL_SEVERITY_MEDIUM',
  'CROSS_SOURCE_SIGNAL_SEVERITY_HIGH',
  'CROSS_SOURCE_SIGNAL_SEVERITY_CRITICAL',
]);

function finiteOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isSignalRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalize bootstrap/Redis payloads the same way the RPC reader does:
 * skip null/primitive/array rows and coerce non-finite numerics to zero so
 * the panel never receives poison that blanks renderSignal.
 */
export function sanitizeCrossSourceSignalsPayload(payload: unknown): ListCrossSourceSignalsResponse | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const raw = payload as Record<string, unknown>;
  if (!Array.isArray(raw.signals)) return null;

  const signals = raw.signals.flatMap((signal, index): CrossSourceSignal[] => {
    if (!isSignalRecord(signal)) return [];
    return [{
      id: String(signal.id || `signal:${index}`),
      type: VALID_SIGNAL_TYPES.has(signal.type as CrossSourceSignal['type'])
        ? signal.type as CrossSourceSignal['type']
        : 'CROSS_SOURCE_SIGNAL_TYPE_UNSPECIFIED',
      theater: String(signal.theater || 'Global'),
      summary: String(signal.summary || ''),
      severity: VALID_SEVERITIES.has(signal.severity as CrossSourceSignal['severity'])
        ? signal.severity as CrossSourceSignal['severity']
        : 'CROSS_SOURCE_SIGNAL_SEVERITY_UNSPECIFIED',
      severityScore: finiteOrZero(signal.severityScore),
      detectedAt: finiteOrZero(signal.detectedAt),
      contributingTypes: Array.isArray(signal.contributingTypes) ? signal.contributingTypes.map(String) : [],
      signalCount: finiteOrZero(signal.signalCount),
    }];
  });

  return {
    signals,
    evaluatedAt: finiteOrZero(raw.evaluatedAt),
    compositeCount: finiteOrZero(raw.compositeCount),
  };
}

export async function fetchCrossSourceSignals(): Promise<ListCrossSourceSignalsResponse> {
  const hydrated = sanitizeCrossSourceSignalsPayload(getHydratedData('crossSourceSignals'));
  if (hydrated?.signals.length) {
    breaker.recordSuccess(hydrated);
    return hydrated;
  }

  return breaker.execute(async () => {
    return await client.listCrossSourceSignals({}, { signal: AbortSignal.timeout(15_000) });
  }, EMPTY, { shouldCache: (r) => r.signals.length > 0 });
}
