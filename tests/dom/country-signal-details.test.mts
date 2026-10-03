import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '@/app/app-context';
import type { CountrySignalCluster, GeoSignal } from '@/services/signal-aggregator';
import { projectCountrySignalDetails } from '../../shared/country-signal-details';

const snapshot = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/app/lazy-services', () => ({ getSignalAggregator: async () => ({ getCountryClusters: snapshot.read }) }));
import { CountryIntelManager } from '@/app/country-intel';

function observation(type: GeoSignal['type'], severity: GeoSignal['severity'], minute: number): GeoSignal {
  return { type, severity, country: 'FR', countryName: 'France', lat: 48.85, lon: 2.35, title: `${type} ${minute}`, timestamp: new Date(Date.UTC(2026, 9, 3, 12, minute)) };
}

function cluster(country: string, signals: GeoSignal[]): CountrySignalCluster {
  return { country, countryName: country, signals, signalTypes: new Set(signals.map(signal => signal.type)), totalCount: signals.length, highSeverityCount: 0, convergenceScore: 0 };
}

describe('shared country signal details', () => {
  beforeEach(() => { snapshot.read.mockReset(); });

  it('counts observed empty clusters as zero', () => {
    expect(projectCountrySignalDetails([])).toEqual({ critical: 0, high: 0, medium: 0, low: 0, recentHigh: [] });
  });

  it.each(['active_strike', 'radiation_anomaly'] as const)('promotes high %s to critical without promoting other severities', type => {
    const result = projectCountrySignalDetails([observation(type, 'high', 3), observation(type, 'medium', 2), observation(type, 'low', 1)]);
    expect(result).toMatchObject({ critical: 1, high: 0, medium: 1, low: 1 });
    expect(result.recentHigh).toHaveLength(1);
    expect(result.recentHigh[0]?.severity).toBe('critical');
  });

  it.each([
    ['military_flight', 'MILITARY'], ['military_vessel', 'MILITARY'], ['active_strike', 'MILITARY'],
    ['protest', 'PROTEST'], ['internet_outage', 'OUTAGE'], ['ais_disruption', 'OUTAGE'],
    ['satellite_fire', 'DISASTER'], ['radiation_anomaly', 'DISASTER'], ['temporal_anomaly', 'CYBER'], ['sanctions_pressure', 'OTHER'],
  ] as const)('maps %s to the website display type %s', (type, display) => {
    expect(projectCountrySignalDetails([observation(type, 'high', 1)]).recentHigh[0]?.type).toBe(display);
  });

  it('returns three newest high or critical items while retaining all severity counts and original timestamps', () => {
    const events = [observation('protest', 'high', 1), observation('radiation_anomaly', 'high', 3), observation('internet_outage', 'medium', 5), observation('temporal_anomaly', 'high', 4), observation('military_flight', 'high', 2), observation('protest', 'low', 6)];
    const original = [...events];
    const result = projectCountrySignalDetails(events);
    expect(result).toMatchObject({ critical: 1, high: 3, medium: 1, low: 1 });
    expect(result.recentHigh.map(signal => signal.description)).toEqual(['temporal_anomaly 4', 'radiation_anomaly 3', 'military_flight 2']);
    expect(result.recentHigh[0]?.timestamp).toBe(events[3]?.timestamp);
    expect(events).toEqual(original);
  });

  it('keeps observation order for equal timestamps', () => {
    const first = observation('protest', 'high', 1);
    const second = observation('military_flight', 'high', 1);
    expect(projectCountrySignalDetails([first, second]).recentHigh.map(signal => signal.description)).toEqual([first.title, second.title]);
  });

  it.each(['future_type', 'toString', 'constructor', '__proto__'])('keeps unknown type %s as OTHER', type => {
    expect(projectCountrySignalDetails([{ ...observation('protest', 'high', 1), type }]).recentHigh[0]?.type).toBe('OTHER');
  });

  it('uses only the website country cluster, preserving the aggregator cap and window owner', async () => {
    const signals = [observation('temporal_anomaly', 'high', 2), observation('active_strike', 'high', 1)];
    snapshot.read.mockReturnValue([cluster('XX', [observation('protest', 'high', 6)]), cluster('US', [observation('protest', 'high', 5)]), cluster('FR', signals)]);
    const manager = new CountryIntelManager({ latestClusters: [], intelligenceCache: {} } as unknown as AppContext);
    const project = Reflect.get(manager, 'buildSignalDetails').bind(manager);
    expect(await project('FR')).toEqual(projectCountrySignalDetails(signals));
    expect(await project('DE')).toEqual(projectCountrySignalDetails([]));
    expect(snapshot.read).toHaveBeenCalledTimes(2);
  });

  it('does not turn a failed website cluster read into observed empty coverage', async () => {
    snapshot.read.mockImplementation(() => { throw new Error('Controlled cluster outage'); });
    const manager = new CountryIntelManager({ latestClusters: [], intelligenceCache: {} } as unknown as AppContext);
    await expect(Reflect.get(manager, 'buildSignalDetails').call(manager, 'FR')).rejects.toThrow('Controlled cluster outage');
  });
});
