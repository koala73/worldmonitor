import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '@/app/app-context';
import type { CountrySignalCluster } from '@/services/signal-aggregator';
import { initTestI18n } from './helpers/i18n.mts';

const snapshot = vi.hoisted(() => ({ read: vi.fn(), available: true }));
vi.mock('@/services/temporal-baseline', () => ({ hasTemporalBaselineSnapshot: () => snapshot.available }));
vi.mock('@/app/lazy-services', () => ({
  getSignalAggregator: async () => ({ getCountryClusters: snapshot.read }),
}));
import { CountryIntelManager } from '@/app/country-intel';

function cluster(country: string, temporalCount: number): CountrySignalCluster {
  return {
    country, countryName: country,
    signals: Array.from({ length: temporalCount }, () => ({
      type: 'temporal_anomaly' as const, country, countryName: country,
      lat: 0, lon: 0, severity: 'medium' as const, title: 'Synthetic observation', timestamp: new Date(),
    })),
    signalTypes: new Set(['temporal_anomaly']), totalCount: temporalCount,
    highSeverityCount: 0, convergenceScore: 0,
  };
}
function manager() {
  return new CountryIntelManager({ latestClusters: [], intelligenceCache: {} } as unknown as AppContext);
}

beforeAll(async () => {
  await initTestI18n();
});

describe('Country Brief temporal observation scope', () => {
  beforeEach(() => { snapshot.read.mockReset(); snapshot.available = true; });

  it('never substitutes global observations for an empty country count', async () => {
    const intel = manager();
    for (const count of [1, 12, 0]) {
      snapshot.read.mockReturnValue([cluster('XX', count), cluster('US', 2)]);
      const signals = await intel.getCountrySignals('FR', 'France');
      expect(signals.temporalAnomalies).toBe(0);
      expect(signals.globalTemporalAnomalies).toBe(count);
      const prompt = Reflect.get(intel, 'buildBriefContextSnapshot').call(intel, 'France', 'FR', null, signals, {});
      expect(prompt).toContain('temporal_anomalies=0,');
      expect(prompt).toContain(`Global context: temporal_anomalies=${count};`);
      expect(prompt).toContain('not attributed to France');
    }
  });

  it('keeps a failed temporal feed unavailable even when the aggregator loads', async () => {
    snapshot.read.mockReturnValue([]);
    snapshot.available = false;
    const signals = await manager().getCountrySignals('FR', 'France');
    expect(signals.temporalAnomalies).toBeNull();
    expect(signals.globalTemporalAnomalies).toBeNull();
  });

  it('preserves actual country observations independently of global counts', async () => {
    const intel = manager();
    for (const count of [0, 5, 20]) {
      snapshot.read.mockReturnValue([cluster('FR', 2), cluster('XX', count)]);
      expect((await intel.getCountrySignals('FR', 'France')).temporalAnomalies).toBe(2);
    }
  });

  it('distinguishes a failed cluster read from zero observed signals', async () => {
    const intel = manager();
    snapshot.read.mockImplementation(() => { throw new Error('Synthetic snapshot failure'); });
    const signals = await intel.getCountrySignals('FR', 'France');
    expect(signals.temporalAnomalies).toBeNull();
    expect(signals.globalTemporalAnomalies).toBeNull();
    const prompt = Reflect.get(intel, 'buildBriefContextSnapshot').call(intel, 'France', 'FR', null, signals, {});
    expect(prompt).toContain('temporal_anomalies=unavailable,');
    snapshot.read.mockReturnValue([]);
    expect((await intel.getCountrySignals('FR', 'France')).temporalAnomalies).toBe(0);
  });
});

it('renders unavailable temporal evidence in both country views without counting global context', async () => {
  const { CountryBriefPage } = await import('@/components/CountryBriefPage');
  const { CountryDeepDivePanel } = await import('@/components/CountryDeepDivePanel');
  snapshot.read.mockReturnValue([]);
  const signals = { ...await manager().getCountrySignals('FR', 'France'), temporalAnomalies: null, globalTemporalAnomalies: 9 };
  const page = new CountryBriefPage();
  const html = Reflect.get(page, 'signalChips').call(page, signals);
  const content = document.createElement('div');
  content.innerHTML = html;
  expect(content.textContent).toContain('Temporal observations unavailable');
  expect(content.textContent).not.toContain('9');
  const panel = new CountryDeepDivePanel();
  const body = document.createElement('div');
  Reflect.set(panel, 'signalsBody', body);
  Reflect.get(panel, 'renderInitialSignals').call(panel, signals);
  expect(body.textContent).toContain('Temporal observations unavailable');
  expect(body.querySelector('.cdp-signal-chips')?.textContent).not.toContain('9');
  document.body.replaceChildren();
});

it('refreshes deep-dive signal chips and breakdown when updateScore receives new signals', async () => {
  const { CountryDeepDivePanel } = await import('@/components/CountryDeepDivePanel');
  const panel = new CountryDeepDivePanel();
  const body = document.createElement('div');
  Reflect.set(panel, 'signalsBody', body);
  const pending = { ...await manager().getCountrySignals('FR', 'France'), temporalAnomalies: null, globalTemporalAnomalies: null };
  Reflect.get(panel, 'renderInitialSignals').call(panel, pending);
  expect(body.querySelector('.cdp-signal-chips')?.textContent).toContain('Temporal observations unavailable');
  const refreshed = {
    ...pending,
    temporalAnomalies: 3,
    globalTemporalAnomalies: 0,
    earthquakes: 1,
    satelliteFires: 2,
  };
  panel.updateScore(null, refreshed);
  const chips = body.querySelector('.cdp-signal-chips')?.textContent ?? '';
  expect(chips).toContain('3');
  expect(chips).not.toContain('Temporal observations unavailable');
  // low bucket = earthquakes + temporal + satellite fires
  expect(body.querySelector('.cdp-signal-breakdown')?.textContent).toContain('6');
  document.body.replaceChildren();
});
