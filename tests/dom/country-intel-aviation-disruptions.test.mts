import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '@/app/app-context';
import type { AirportDelayAlert } from '@/services/aviation';
import { initTestI18n } from './helpers/i18n.mts';

const aviation = vi.hoisted(() => ({ fetchFlightDelays: vi.fn() }));
vi.mock('@/services/aviation', () => ({ fetchFlightDelays: aviation.fetchFlightDelays }));
vi.mock('@/app/lazy-services', () => ({
  getSignalAggregator: async () => ({ getCountryClusters: () => [] }),
}));
import { CountryIntelManager } from '@/app/country-intel';
import { formatAirportDisruptionLine } from '@/services/country-aviation-context';

function alert(overrides: Partial<AirportDelayAlert>): AirportDelayAlert {
  return {
    id: 'x', iata: 'JED', icao: 'OEJN', name: 'King Abdulaziz', city: 'Jeddah', country: 'Saudi Arabia',
    lat: 21.6796, lon: 39.1565, region: 'mena', delayType: 'closure', severity: 'severe',
    avgDelayMinutes: 0, reason: 'AD CLSD DUE TO MIL ACT', source: 'notam', updatedAt: new Date(),
    ...overrides,
  } as AirportDelayAlert;
}
const JED_CLOSED = alert({});
const RUH_MINOR = alert({ id: 'y', iata: 'RUH', icao: 'OERK', name: 'King Khalid International', lat: 24.9576, lon: 46.6988, delayType: 'general', severity: 'minor', reason: 'Minor delays' });
const CDG_CLOSED = alert({ id: 'z', iata: 'CDG', icao: 'LFPG', name: 'Paris Charles de Gaulle', city: 'Paris', country: 'France', lat: 49.0097, lon: 2.5479 });

function manager(flightDelays?: AirportDelayAlert[]) {
  return new CountryIntelManager({ latestClusters: [], intelligenceCache: { flightDelays } } as unknown as AppContext);
}

beforeAll(async () => {
  await initTestI18n();
});

describe('Country Brief airport disruptions', () => {
  beforeEach(() => { aviation.fetchFlightDelays.mockReset(); });

  it('counts a NOTAM closure while the Aviation layer is off', async () => {
    // The layer being off leaves intelligenceCache.flightDelays unset.
    aviation.fetchFlightDelays.mockResolvedValue([JED_CLOSED, RUH_MINOR, CDG_CLOSED]);
    const signals = await manager().getCountrySignals('SA', 'Saudi Arabia');
    expect(signals.aviationDisruptions).toBe(1);
    expect(aviation.fetchFlightDelays).toHaveBeenCalled();
  });

  it('uses the map cache when the Aviation layer already loaded it', async () => {
    const signals = await manager([JED_CLOSED]).getCountrySignals('SA', 'Saudi Arabia');
    expect(signals.aviationDisruptions).toBe(1);
    expect(aviation.fetchFlightDelays).not.toHaveBeenCalled();
  });

  it('reports zero, not a failure, when the aviation snapshot cannot load', async () => {
    aviation.fetchFlightDelays.mockRejectedValue(new Error('Synthetic aviation outage'));
    expect((await manager().getCountrySignals('SA', 'Saudi Arabia')).aviationDisruptions).toBe(0);
  });

  it('names the closed airport and its NOTAM reason in the brief context', async () => {
    aviation.fetchFlightDelays.mockResolvedValue([RUH_MINOR, JED_CLOSED, CDG_CLOSED]);
    const intel = manager();
    const disruptions = await Reflect.get(intel, 'countryAviationDisruptions').call(intel, 'SA', 'Saudi Arabia');
    const signals = await intel.getCountrySignals('SA', 'Saudi Arabia');
    const prompt = Reflect.get(intel, 'buildBriefContextSnapshot').call(
      intel, 'Saudi Arabia', 'SA', null, signals, { airportDisruptions: formatAirportDisruptionLine(disruptions) },
    );
    expect(prompt).toContain('Airport disruptions: JED King Abdulaziz: closed (AD CLSD DUE TO MIL ACT)');
    expect(prompt).not.toContain('RUH');
    expect(prompt).not.toContain('CDG');
  });
});

describe('formatAirportDisruptionLine', () => {
  it('lists closures first, caps the list, and keeps upstream text on one short line', () => {
    const many = Array.from({ length: 7 }, (_, i) => alert({ id: `m${i}`, iata: `M${i}`, delayType: 'general', severity: 'major', reason: `line one\nline two ${'x'.repeat(200)}` }));
    const line = formatAirportDisruptionLine([...many, JED_CLOSED]);
    expect(line.startsWith('Airport disruptions: JED King Abdulaziz: closed')).toBe(true);
    expect(line).toContain('; +3 more');
    expect(line).not.toContain('\n');
    expect(line).toContain('major disruption (line one line two');
    expect(line).toContain('…');
  });

  it('is empty when nothing is disrupted', () => {
    expect(formatAirportDisruptionLine([])).toBe('');
  });
});
