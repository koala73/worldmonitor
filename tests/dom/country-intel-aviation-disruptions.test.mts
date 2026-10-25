import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '@/app/app-context';
import type { AirportDelayAlert } from '@/services/aviation';
import { initTestI18n } from './helpers/i18n.mts';

const aviation = vi.hoisted(() => ({ fetchFlightDelays: vi.fn() }));
vi.mock('@/services/aviation', () => ({ fetchFlightDelays: aviation.fetchFlightDelays }));
vi.mock('@/app/lazy-services', () => ({
  getSignalAggregator: async () => ({ getCountryClusters: () => [] }),
}));
import { CountryIntelManager } from '@/app/country-intel';

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

describe('Country Brief airport disruption signal', () => {
  beforeEach(() => { aviation.fetchFlightDelays.mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

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

  it('does not hold the brief open on a hung aviation request', async () => {
    vi.useFakeTimers();
    aviation.fetchFlightDelays.mockReturnValue(new Promise(() => {}));
    const pending = manager().getCountrySignals('SA', 'Saudi Arabia');
    await vi.advanceTimersByTimeAsync(2500);
    expect((await pending).aviationDisruptions).toBe(0);
  });
});
