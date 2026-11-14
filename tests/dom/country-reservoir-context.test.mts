import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { CountryDeepDivePanel } from '@/components/CountryDeepDivePanel';
import type { CountryEnergyProfileData } from '@/components/CountryBriefPanel';
import type { ReservoirLevel } from '@/services/climate';
import { initTestI18n } from './helpers/i18n.mts';

beforeAll(async () => { await initTestI18n(); });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-14T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  document.getElementById('deep-dive-close')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  document.getElementById('country-deep-dive-panel')?.remove();
});

const energy = { mixAvailable: true, mixYear: 2024, coalShare: 20, gasShare: 30, oilShare: 15, nuclearShare: 20, renewShare: 15, windShare: 2, solarShare: 3, hydroShare: 9.6, importShare: 0, importShareAvailable: false } as CountryEnergyProfileData;

function reservoir(overrides: Partial<ReservoirLevel>): ReservoirLevel {
  return {
    id: 'kremenchuk', name: 'Kremenchuk Reservoir', country: 'UA', riparians: [], river: 'Dnieper', lat: 49.2, lon: 32.6,
    tags: ['hydropower', 'conflict'], why: '', latest: { observedAt: new Date('2026-09-06T00:00:00Z'), levelM: 79.1, madM: 0.1, segments: 4, ageDays: 69 },
    prevDate: null, changePrevM: null, change30dM: null, change90dM: null, change365dM: -0.8, seasonalAnomalyM: -1.6, seasonalZ: -2.2,
    recordMinM: null, recordMaxM: null, recordStart: null, percentOfRange: null, recordLow: false, recordHigh: false, status: 'low', series: [],
    ...overrides,
  };
}

const context = () => document.querySelector('#deep-dive-content .cdp-reservoir-context');

describe('strategic reservoirs beside the energy mix', () => {
  it('shows each reservoir with its dated level beside the hydro share, and drops it for the next country', () => {
    const panel = new CountryDeepDivePanel();
    panel.show('Ukraine', 'UA', null, null);
    panel.updateEnergyProfile(energy);
    panel.updateReservoirContext('UA', [reservoir({}), reservoir({ id: 'dnipro', name: 'Dnipro Reservoir', tags: ['conflict'], latest: null, status: 'no_recent_data', seasonalZ: null, seasonalAnomalyM: null })]);
    const text = context()?.textContent ?? '';
    expect(text).toContain('Hydro 10% of primary energy');
    expect(text).toContain('Kremenchuk Reservoir');
    expect(text).toMatch(/measured (Sep 6|6 Sep) \(69 days ago\)/);
    expect(text).toContain('No usable pass yet');
    expect(text).toContain('not a live reading');
    expect(text.indexOf('Kremenchuk')).toBeLessThan(text.indexOf('Dnipro'));

    panel.updateEnergyProfile({ ...energy, hydroShare: 12 });
    expect(context()?.textContent).toContain('Hydro 12% of primary energy');

    panel.show('Italy', 'IT', null, null);
    panel.updateReservoirContext('UA', [reservoir({})]);
    panel.updateEnergyProfile(energy);
    expect(context()).toBeNull();
  });

  it('shows nothing for a country without strategic reservoirs', () => {
    const panel = new CountryDeepDivePanel();
    panel.show('Ukraine', 'UA', null, null);
    panel.updateEnergyProfile(energy);
    panel.updateReservoirContext('UA', []);
    expect(context()).toBeNull();
  });
});

describe('hosted reservoir reads', () => {
  it('reads the country-scoped reservoirs section and keeps each pass date', async () => {
    const { createHostCountryBriefSource } = await import('@/services/country-brief-source');
    const calls: unknown[] = [];
    const source = await createHostCountryBriefSource(async (_name, args) => {
      calls.push(args);
      return { section: 'reservoirs', state: 'ready', retrievedAt: new Date().toISOString(), value: {
        countryCode: 'UA', dataAvailable: true, fetchedAt: 1794700000000, methodology: '',
        reservoirs: [{ id: 'kremenchuk', name: 'Kremenchuk Reservoir', country: 'UA', lat: 49.2, lon: 32.6, latest: { date: '2026-09-06', levelM: 79.1, madM: 0.1, segmentCount: 4, ageDays: 69 }, status: 'low', series: [] }],
      } };
    });
    const response = await source.reservoirLevels('UA', new AbortController().signal);
    expect(calls).toEqual([{ section: 'reservoirs', arguments: { country_code: 'UA' } }]);
    expect(response.reservoirs.map(r => [r.id, r.latest?.date])).toEqual([['kremenchuk', '2026-09-06']]);
  });
});
