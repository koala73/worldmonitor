import { InfrastructureServiceClient, type TemporalAnomaly as TemporalAnomalyProto } from '@/generated/client/worldmonitor/infrastructure/v1/service_client';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { getHydratedData } from '@/services/bootstrap';

export type TemporalEventType =
  | 'military_flights'
  | 'vessels'
  | 'protests'
  | 'news'
  | 'ais_gaps'
  | 'satellite_fires';

export interface TemporalAnomaly {
  type: TemporalEventType;
  region: string;
  currentCount: number;
  expectedCount: number;
  zScore: number;
  message: string;
  severity: 'medium' | 'high' | 'critical';
}

const client = new InfrastructureServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });

const TYPE_LABELS: Record<TemporalEventType, string> = {
  military_flights: 'Military flights',
  vessels: 'Naval vessels',
  protests: 'Protests',
  news: 'News velocity',
  ais_gaps: 'Dark ship activity',
  satellite_fires: 'Satellite fire detections',
};

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const SERVER_TYPES = new Set<TemporalEventType>(['news', 'satellite_fires']);

function formatAnomalyMessage(
  type: TemporalEventType,
  _region: string,
  count: number,
  mean: number,
  multiplier: number,
): string {
  const now = new Date();
  const weekday = WEEKDAY_NAMES[now.getUTCDay()];
  const month = MONTH_NAMES[now.getUTCMonth() + 1];
  const mult = multiplier < 10 ? `${multiplier.toFixed(1)}x` : `${Math.round(multiplier)}x`;
  return `${TYPE_LABELS[type]} ${mult} normal for ${weekday} (${month}) — ${count} vs baseline ${Math.round(mean)}`;
}

function getSeverity(zScore: number): 'medium' | 'high' | 'critical' {
  if (zScore >= 3.0) return 'critical';
  if (zScore >= 2.0) return 'high';
  return 'medium';
}

function mapServerAnomaly(a: TemporalAnomalyProto): TemporalAnomaly {
  return {
    type: a.type as TemporalEventType,
    region: a.region,
    currentCount: a.currentCount,
    expectedCount: a.expectedCount,
    zScore: a.zScore,
    severity: getSeverity(a.zScore),
    message: a.message,
  };
}

export function consumeServerAnomalies(): { anomalies: TemporalAnomaly[]; trackedTypes: string[] } {
  const raw = getHydratedData('temporalAnomalies') as {
    anomalies?: TemporalAnomalyProto[];
    trackedTypes?: string[];
    computedAt?: string;
  } | undefined;

  if (!raw?.anomalies) return { anomalies: [], trackedTypes: [] };
  return {
    anomalies: raw.anomalies.map(mapServerAnomaly),
    trackedTypes: raw.trackedTypes ?? [],
  };
}

export async function fetchLiveAnomalies(): Promise<{ anomalies: TemporalAnomaly[]; trackedTypes: string[] }> {
  try {
    const resp = await client.listTemporalAnomalies({});
    return {
      anomalies: (resp.anomalies ?? []).map(mapServerAnomaly),
      trackedTypes: resp.trackedTypes ?? [],
    };
  } catch (e) {
    console.warn('[TemporalBaseline] Live fetch failed:', e);
    return { anomalies: [], trackedTypes: [] };
  }
}

// Client-side baseline for types NOT handled server-side (military_flights, vessels, ais_gaps)
async function reportMetrics(
  updates: Array<{ type: TemporalEventType; region: string; count: number }>
): Promise<void> {
  try {
    await client.recordBaselineSnapshot({ updates });
  } catch (e) {
    console.warn('[TemporalBaseline] Update failed:', e);
  }
}

async function checkAnomaly(
  type: TemporalEventType,
  region: string,
  count: number,
): Promise<TemporalAnomaly | null> {
  try {
    const data = await client.getTemporalBaseline({ type, region, count });
    if (!data.anomaly) return null;

    return {
      type,
      region,
      currentCount: count,
      expectedCount: Math.round(data.baseline?.mean ?? 0),
      zScore: data.anomaly.zScore,
      severity: getSeverity(data.anomaly.zScore),
      message: formatAnomalyMessage(type, region, count, data.baseline?.mean ?? 0, data.anomaly.multiplier),
    };
  } catch (e) {
    console.warn('[TemporalBaseline] Check failed:', e);
    return null;
  }
}

export async function updateAndCheck(
  metrics: Array<{ type: TemporalEventType; region: string; count: number }>
): Promise<TemporalAnomaly[]> {
  const clientOnly = metrics.filter(m => !SERVER_TYPES.has(m.type));
  if (clientOnly.length === 0) return [];

  reportMetrics(clientOnly).catch(() => {});

  const results = await Promise.allSettled(
    clientOnly.map(m => checkAnomaly(m.type, m.region, m.count))
  );

  return results
    .filter((r): r is PromiseFulfilledResult<TemporalAnomaly | null> => r.status === 'fulfilled')
    .map(r => r.value)
    .filter((a): a is TemporalAnomaly => a !== null)
    .sort((a, b) => b.zScore - a.zScore);
}
