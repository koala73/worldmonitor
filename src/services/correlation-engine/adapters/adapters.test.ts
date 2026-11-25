import { describe, expect, it, vi } from 'vitest';
// boundary-ignore: AppContext is an aggregate type that lives in app/ by design
import type { AppContext } from '@/app/app-context';
import type { SocialUnrestEvent } from '@/types';
import type { SignalEvidence } from '../types';

vi.mock('@/services/country-geometry', () => ({
  matchCountryNamesInText: () => [],
  getCountryNameByCode: (code: string) => ({ FR: 'France' })[code] ?? null,
}));
vi.mock('../country-normalization', () => ({
  normalizeToCountryCode: (country: string) => ({ France: 'FR', Nigeria: 'NG' })[country] ?? null,
}));

const { disasterAdapter } = await import('./disaster');
const { escalationAdapter } = await import('./escalation');
const { militaryAdapter } = await import('./military');

const NOW = Date.now();

function quake(magnitude: number, place: string): SignalEvidence {
  return {
    type: 'earthquake', source: 'usgs', severity: 50, lat: 35, lon: 139, timestamp: NOW,
    label: `M${magnitude.toFixed(1)} \u2014 ${place}`, rawData: { magnitude },
  };
}

function unrest(overrides: Partial<SocialUnrestEvent>): SocialUnrestEvent {
  return {
    id: 'fixture', title: 'Dockworkers march on parliament', eventType: 'protest', country: 'France',
    lat: 48.86, lon: 2.35, time: new Date(NOW - 60_000), severity: 'medium', sources: [], sourceType: 'acled',
    confidence: 'high', validated: true, ...overrides,
  } as SocialUnrestEvent;
}

function escalationContext(events: SocialUnrestEvent[]): AppContext {
  return { intelligenceCache: { protests: { events } } } as unknown as AppContext;
}

describe('local correlation card text', () => {
  it('pairs the strongest earthquake magnitude with its own place', () => {
    expect(disasterAdapter.generateTitle([quake(4.6, 'Honshu, Japan'), quake(6.8, 'Hokkaido, Japan')]))
      .toBe('Disaster cascade: M6.8 seismic \u2014 Hokkaido, Japan');
  });

  it('does not turn unverified media mentions into conflict signals', () => {
    const signals = escalationAdapter.collectSignals(escalationContext([
      unrest({}),
      unrest({ id: 'gdelt', title: 'Lagos', country: 'Nigeria', sourceType: 'gdelt', eventType: 'civil_unrest', confidence: 'low', validated: false }),
    ]));
    expect(signals.filter(s => s.type === 'conflict_event').map(s => s.country)).toEqual(['FR']);
  });

  it('labels unrest events with readable event types', () => {
    const [signal] = escalationAdapter.collectSignals(escalationContext([unrest({})]));
    expect(signal?.label).toBe('Protest: Dockworkers march on parliament');
  });

  it('places military flight clusters at their centroid', () => {
    const flight: SignalEvidence = { type: 'military_flight', source: 'opensky', severity: 40, country: 'USA', timestamp: NOW, label: 'RCH123', rawData: {} };
    expect(militaryAdapter.generateTitle([flight, flight], { location: { lat: 26.71, lon: -80.11 } }))
      .toBe('Military flight cluster \u2014 USA near 26.7\u00b0N, 80.1\u00b0W');
  });
});
