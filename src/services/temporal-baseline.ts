// Temporal Anomaly Detection Service
// Detects when current commercial signal activity deviates from historical baselines
// Backed by InfrastructureService RPCs (GetTemporalBaseline, RecordBaselineSnapshot)

// TODO: RPC client needs updating to point to the SalesIntel infrastructure service
// import { InfrastructureServiceClient } from '@/generated/client/worldmonitor/infrastructure/v1/service_client';

export type TemporalEventType =
  | 'hiring_velocity'
  | 'funding_events'
  | 'job_postings'
  | 'executive_changes'
  | 'tech_adoption'
  | 'press_mentions'
  | 'expansion_signals';

export interface TemporalAnomaly {
  type: TemporalEventType;
  scope: string;
  currentCount: number;
  expectedCount: number;
  zScore: number;
  message: string;
  severity: 'medium' | 'high' | 'critical';
}

// TODO: Replace with actual SalesIntel infrastructure service client once available
// const client = new InfrastructureServiceClient('', { fetch: (...args) => globalThis.fetch(...args) });
const client: {
  recordBaselineSnapshot(req: { updates: Array<{ type: TemporalEventType; scope: string; count: number }> }): Promise<void>;
  getTemporalBaseline(req: { type: TemporalEventType; scope: string; count: number }): Promise<{
    anomaly?: { zScore: number; multiplier: number } | null;
    baseline?: { mean: number } | null;
  }>;
} = null as any; // TODO: wire up real client

const TYPE_LABELS: Record<TemporalEventType, string> = {
  hiring_velocity: 'Hiring velocity',
  funding_events: 'Funding events',
  job_postings: 'Job postings',
  executive_changes: 'Executive changes',
  tech_adoption: 'Technology adoption signals',
  press_mentions: 'Press mentions',
  expansion_signals: 'Expansion signals',
};

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function formatAnomalyMessage(
  type: TemporalEventType,
  _scope: string,
  count: number,
  mean: number,
  multiplier: number,
): string {
  const now = new Date();
  const weekday = WEEKDAY_NAMES[now.getUTCDay()];
  const month = MONTH_NAMES[now.getUTCMonth() + 1];
  const mult = multiplier < 10 ? `${multiplier.toFixed(1)}x` : `${Math.round(multiplier)}x`;

  // Use phrasing appropriate to the signal type
  if (type === 'funding_events') {
    return `${TYPE_LABELS[type]} ${mult} above seasonal average — ${count} rounds vs baseline ${Math.round(mean)}`;
  }
  return `${TYPE_LABELS[type]} ${mult} normal for ${weekday} (${month}) — ${count} vs baseline ${Math.round(mean)}`;
}

function getSeverity(zScore: number): 'medium' | 'high' | 'critical' {
  if (zScore >= 3.0) return 'critical';
  if (zScore >= 2.0) return 'high';
  return 'medium';
}

// Fire-and-forget baseline update
export async function reportMetrics(
  updates: Array<{ type: TemporalEventType; scope: string; count: number }>
): Promise<void> {
  try {
    await client.recordBaselineSnapshot({ updates });
  } catch (e) {
    console.warn('[TemporalBaseline] Update failed:', e);
  }
}

// Check for anomaly (returns null if learning or normal)
export async function checkAnomaly(
  type: TemporalEventType,
  scope: string,
  count: number,
): Promise<TemporalAnomaly | null> {
  try {
    const data = await client.getTemporalBaseline({ type, scope, count });
    if (!data.anomaly) return null;

    return {
      type,
      scope,
      currentCount: count,
      expectedCount: Math.round(data.baseline?.mean ?? 0),
      zScore: data.anomaly.zScore,
      severity: getSeverity(data.anomaly.zScore),
      message: formatAnomalyMessage(type, scope, count, data.baseline?.mean ?? 0, data.anomaly.multiplier),
    };
  } catch (e) {
    console.warn('[TemporalBaseline] Check failed:', e);
    return null;
  }
}

// Batch: report metrics AND check for anomalies in one flow
export async function updateAndCheck(
  metrics: Array<{ type: TemporalEventType; scope: string; count: number }>
): Promise<TemporalAnomaly[]> {
  // Fire-and-forget the update
  reportMetrics(metrics).catch(() => {});

  // Check anomalies in parallel
  const results = await Promise.allSettled(
    metrics.map(m => checkAnomaly(m.type, m.scope, m.count))
  );

  return results
    .filter((r): r is PromiseFulfilledResult<TemporalAnomaly | null> => r.status === 'fulfilled')
    .map(r => r.value)
    .filter((a): a is TemporalAnomaly => a !== null)
    .sort((a, b) => b.zScore - a.zScore);
}
