import { createCircuitBreaker, getCSSColor } from '@/utils';
import type { ClimateAnomaly } from '@/types';

interface ClimateResponse {
  success: boolean;
  anomalies: ClimateAnomaly[];
  timestamp: string;
}

export interface ClimateFetchResult {
  ok: boolean;
  anomalies: ClimateAnomaly[];
  timestamp: string;
}

const breaker = createCircuitBreaker<ClimateResponse>({ name: 'Climate Anomalies' });

export async function fetchClimateAnomalies(): Promise<ClimateFetchResult> {
  const result = await breaker.execute(async () => {
    const response = await fetch('/api/climate-anomalies', {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }, { success: false, anomalies: [], timestamp: '' });

  const anomalies = result.anomalies.filter((a: ClimateAnomaly) => a.severity !== 'normal');
  return {
    ok: result.success === true,
    anomalies: result.success === true ? anomalies : [],
    timestamp: result.timestamp,
  };
}

export function getSeverityColor(anomaly: ClimateAnomaly): string {
  if (anomaly.severity === 'extreme') {
    return anomaly.type === 'cold' ? getCSSColor('--semantic-low') : getCSSColor('--semantic-critical');
  }
  if (anomaly.severity === 'moderate') {
    return anomaly.type === 'cold' ? getCSSColor('--semantic-info') : getCSSColor('--semantic-high');
  }
  return getCSSColor('--text-dim');
}

export function getSeverityIcon(anomaly: ClimateAnomaly): string {
  switch (anomaly.type) {
    case 'warm': return '🌡️';
    case 'cold': return '❄️';
    case 'wet': return '🌧️';
    case 'dry': return '☀️';
    case 'mixed': return '⚡';
    default: return '🌡️';
  }
}

export function formatDelta(value: number, unit: string): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}${unit}`;
}
