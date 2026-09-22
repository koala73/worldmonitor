import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('@/services/cached-risk-scores', () => ({ getCachedCountryScores: () => [], isElevatedCiiScore: () => false }));
vi.mock('@/services/country-instability', () => ({ isInLearningMode: () => true }));
vi.mock('@/services/sanctions-pressure', () => ({ getLatestSanctionsPressure: () => null }));
vi.mock('@/services/radiation', () => ({ getLatestRadiationWatch: () => null }));

const countries = readFileSync('public/data/countries.geojson', 'utf8');

function convergence(cellId: string, lat: number, lon: number) {
  return { cellId, lat, lon, score: 95, types: ['protest' as const], totalEvents: 4 };
}

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

async function loadGeometry() {
  vi.stubGlobal('fetch', vi.fn(async (url) => String(url) === '/data/countries.geojson'
    ? new Response(countries) : new Response('', { status: 404 })));
  const geometry = await import('@/services/country-geometry');
  await geometry.preloadCountryGeometry();
}

describe('geographic signal attribution', () => {
  it('resolves known names before preload and keeps unknown names unattributed', async () => {
    const { signalAggregator } = await import('@/services/signal-aggregator');
    const ingest = (country: string) => signalAggregator.ingestOutages([{
      id: country, country, lat: 0, lon: 0, title: 'Outage', pubDate: new Date(),
      severity: 'major', link: '', description: '', categories: [],
    }]);
    for (const country of ['Neverland', 'constructor']) {
      ingest(country);
      expect(signalAggregator.getCountryClusters().map(c => c.country)).toEqual(['XX']);
    }
    ingest(' il ');
    expect(signalAggregator.getCountryClusters().map(c => c.country)).toEqual(['IL']);
    ingest('Israel');
    expect(signalAggregator.getCountryClusters().map(c => c.country)).toEqual(['IL']);
    ingest('UK');
    expect(signalAggregator.getCountryClusters().map(c => c.country)).toEqual(['GB']);
    await loadGeometry();
    expect(signalAggregator.getCountryClusters().map(c => c.country)).toEqual(['GB']);
    ingest('Israel');
    expect(signalAggregator.getCountryClusters().map(c => c.country)).toEqual(['IL']);
    ingest('Neverland');
    expect(signalAggregator.getCountryClusters().map(c => c.country)).toEqual(['XX']);
  });
});

it('preserves unknown sanctions and fire countries while using resolved fire names', async () => {
  const { signalAggregator } = await import('@/services/signal-aggregator');
  signalAggregator.ingestSanctionsPressure([{ countryCode: '', countryName: 'Neverland', entryCount: 30,
    newEntryCount: 1, vesselCount: 0, aircraftCount: 0 }]);
  expect(signalAggregator.getCountryClusters().map(c => c.country)).toEqual(['XX']);
  signalAggregator.ingestSanctionsPressure([{ countryCode: 'UKR', countryName: 'Ukraine', entryCount: 30,
    newEntryCount: 1, vesselCount: 0, aircraftCount: 0 }]);
  expect(signalAggregator.getCountryClusters().map(c => c.country)).toEqual(['UA']);
  signalAggregator.ingestSanctionsPressure([{ countryCode: 'IL', countryName: 'Ukraine', entryCount: 30,
    newEntryCount: 1, vesselCount: 0, aircraftCount: 0 }]);
  expect(signalAggregator.getCountryClusters().map(c => c.country)).toEqual(['IL']);
  signalAggregator.clear();
  const fire = { lat: 0, lon: 0, brightness: 370, frp: 10, acq_date: new Date().toISOString() };
  signalAggregator.ingestSatelliteFires([{ ...fire, region: 'Neverland' }]);
  expect(signalAggregator.getCountryClusters().map(c => c.country)).toEqual(['XX']);
  await loadGeometry();
  signalAggregator.ingestSatelliteFires([{ ...fire, region: 'Israel' }]);
  expect(signalAggregator.getCountryClusters().map(c => c.country)).toEqual(['IL']);
});

describe('unified alert lifecycle', () => {
  for (const loaded of [false, true]) {
    it(`keeps Berlin and Paris separate with geometry loaded=${loaded}`, async () => {
      if (loaded) await loadGeometry();
      const service = await import('@/services/cross-module-integration');
      const berlin = service.createConvergenceAlert(convergence('berlin', 52.52, 13.405));
      const paris = service.createConvergenceAlert(convergence('paris', 48.857, 2.352));
      expect(berlin.countries).toEqual(loaded ? ['DE'] : []);
      expect(paris.countries).toEqual(loaded ? ['FR'] : []);
      expect(service.getAlerts()).toHaveLength(2);
      service.createConvergenceAlert(convergence('near-berlin', 52.53, 13.42));
      expect(service.getAlerts()).toHaveLength(2);
    });
  }

  it('prunes mixed-order expired alerts from both rows and counts, preserving refreshed entries', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-15T00:00:00Z'));
    const service = await import('@/services/cross-module-integration');
    service.createConvergenceAlert(convergence('old-berlin', 52.52, 13.405));
    service.createConvergenceAlert(convergence('refresh-paris', 48.857, 2.352));
    vi.advanceTimersByTime(25 * 60 * 60 * 1000);
    service.createConvergenceAlert(convergence('fresh-tokyo', 35.68, 139.69));
    service.createConvergenceAlert(convergence('refresh-paris', 48.857, 2.352));
    service.calculateStrategicRiskOverview([]);
    expect(service.getAlerts().map(a => a.id).sort()).toEqual(['conv-fresh-tokyo', 'conv-refresh-paris']);
    expect(service.getRecentAlerts()).toHaveLength(2);
    expect(service.getAlertCount()).toEqual({ critical: 2, high: 0, medium: 0, low: 0 });
  });
});
