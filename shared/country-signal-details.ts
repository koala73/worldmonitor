export interface CountrySignalObservation {
  type: string;
  severity: 'low' | 'medium' | 'high';
  title: string;
  timestamp: Date;
}

export interface CountrySignalDetails {
  critical: number;
  high: number;
  medium: number;
  low: number;
  recentHigh: Array<{
    type: 'MILITARY' | 'PROTEST' | 'CYBER' | 'DISASTER' | 'OUTAGE' | 'OTHER';
    severity: 'critical' | 'high' | 'medium' | 'low';
    description: string;
    timestamp: Date;
  }>;
}

const DISPLAY_TYPES = new Map<string, CountrySignalDetails['recentHigh'][number]['type']>([
  ['military_flight', 'MILITARY'], ['military_vessel', 'MILITARY'], ['active_strike', 'MILITARY'],
  ['protest', 'PROTEST'], ['internet_outage', 'OUTAGE'], ['ais_disruption', 'OUTAGE'],
  ['satellite_fire', 'DISASTER'], ['radiation_anomaly', 'DISASTER'], ['temporal_anomaly', 'CYBER'],
]);

function severity(signal: CountrySignalObservation): CountrySignalDetails['recentHigh'][number]['severity'] {
  return signal.severity === 'high' && (signal.type === 'active_strike' || signal.type === 'radiation_anomaly') ? 'critical' : signal.severity;
}

export function projectCountrySignalDetails(signals: readonly CountrySignalObservation[]): CountrySignalDetails {
  const details: CountrySignalDetails = { critical: 0, high: 0, medium: 0, low: 0, recentHigh: [] };
  for (const signal of signals) details[severity(signal)]++;
  details.recentHigh = [...signals]
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
    .map(signal => ({ type: DISPLAY_TYPES.get(signal.type) ?? 'OTHER', severity: severity(signal), description: signal.title, timestamp: signal.timestamp }))
    .filter(signal => signal.severity === 'critical' || signal.severity === 'high')
    .slice(0, 3);
  return details;
}
