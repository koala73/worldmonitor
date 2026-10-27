import { beforeAll, describe, expect, it, vi } from 'vitest';
import { CountryBriefController } from '@/components/CountryBriefController';
import { CountryDeepDivePanel } from '@/components/CountryDeepDivePanel';
import type { CountryBriefSource } from '@/services/country-brief-source';
import type { GetNo2ActivityResponse, No2ActivityRegion } from '@/generated/client/worldmonitor/economic/v1/service_client';
import { initTestI18n } from './helpers/i18n.mts';

beforeAll(async () => { await initTestI18n(); });

function region(overrides: Partial<No2ActivityRegion> = {}): No2ActivityRegion {
  return {
    id: 'country-de', kind: 'NO2_REGION_KIND_COUNTRY', label: 'Germany', countryCode: 'DE', bbox: [5.87, 47.27, 15.04, 55.06],
    current: { windowStart: '2026-08-29', windowEnd: '2026-10-23', validDays: 31, meanNo2MolM2: 1.2e-4 },
    baselineYears: [2025, 2024, 2023], baselineMeanNo2MolM2: 1.1e-4, changePercent: 12.4,
    direction: 'NO2_DIRECTION_STRENGTHENING', exclusion: 'NO2_REGION_EXCLUSION_UNSPECIFIED', ...overrides,
  };
}

function wire(regions: No2ActivityRegion[], overrides: Partial<GetNo2ActivityResponse> = {}): GetNo2ActivityResponse {
  return {
    regions, generatedAt: '2026-10-26T06:10:00.000Z', stale: false, methodVersion: 'no2-activity/v1',
    attribution: 'Contains modified Copernicus Sentinel data 2023-2026',
    unavailableReason: 'NO2_ACTIVITY_UNAVAILABLE_REASON_UNSPECIFIED', upstreamUnavailable: false, ...overrides,
  };
}

function fixture(response: GetNo2ActivityResponse | Error) {
  const body = document.createElement('div');
  const card = document.createElement('section');
  card.append(body);
  const panel = Object.create(CountryDeepDivePanel.prototype) as CountryDeepDivePanel;
  Reflect.set(panel, 'no2ActivityBody', body);
  Reflect.set(panel, 'currentCode', 'DE');
  Reflect.set(panel, 'abortController', new AbortController());
  Reflect.set(panel, 'sections', [{ id: 'activity', title: 'Industrial Activity (NO2)', body, card }]);
  const failures: unknown[] = [];
  Reflect.set(panel, 'setSectionFailure', (...args: unknown[]) => { if (args[0] === 'activity') failures.push(args); });
  const never = () => new Promise(() => {});
  const getNo2Activity = vi.fn(async () => { if (response instanceof Error) throw response; return response; });
  const source = {
    mode: 'website', canRequestPremium: () => false, fetch: never,
    market: { getCountryStockIndex: never },
    intelligence: { getCountryFacts: never, getCountryEnergyProfile: never, getCountryPortActivity: never },
    prediction: { listPredictionMarkets: never },
    economic: { getNo2Activity },
  } as unknown as CountryBriefSource;
  const controller = new CountryBriefController(source, panel);
  return { body, controller, getNo2Activity, failures };
}

async function hydrate(state: ReturnType<typeof fixture>) {
  vi.spyOn(await import('@/services/imf-country-data'), 'getImfCountryBundle').mockImplementation(() => new Promise(() => {}));
  vi.spyOn(await import('@/services/prediction'), 'fetchCountryMarkets').mockImplementation(() => new Promise(() => {}));
  state.controller.hydrate('DE', 'Germany');
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

describe('country brief NO2 activity line', () => {
  it('asks the route for the country region only and renders direction, change, baseline and window', async () => {
    const state = fixture(wire([region()]));
    await hydrate(state);
    expect(state.getNo2Activity).toHaveBeenCalledWith({ countryCode: 'DE', regionId: '', kind: 'NO2_REGION_KIND_COUNTRY' }, expect.anything());
    const line = state.body.querySelector<HTMLElement>('.cdp-no2-activity');
    expect(line?.dataset.no2State).toBe('strengthening');
    expect(line?.textContent).toBe('Strengthening +12.4% vs the same window in 2025, 2024, 2023');
    expect(state.body.querySelector('.cdp-measure-note')?.textContent).toBe('2026-08-29 to 2026-10-23, 31 valid days');
    expect(state.body.querySelector('.cdp-economic-source')?.textContent).toBe('Contains modified Copernicus Sentinel data 2023-2026');
    expect(state.body.querySelector('.cdp-no2-stale')).toBeNull();
    expect(state.failures).toEqual([]);
  });

  it('flags a reading from a stale dataset and keeps the credit', async () => {
    const state = fixture(wire([region()], { stale: true }));
    await hydrate(state);
    expect(state.body.querySelector('.cdp-no2-stale')?.textContent).toBe('Stale: the dataset is older than its 72-hour refresh budget, so this reading may be out of date.');
    expect(state.body.querySelector('.cdp-economic-source')?.textContent).toBe('Contains modified Copernicus Sentinel data 2023-2026');
  });

  it('renders the pending baseline as its own state, with no change figure', async () => {
    const state = fixture(wire([region({ baselineYears: [], changePercent: undefined, baselineMeanNo2MolM2: undefined, direction: 'NO2_DIRECTION_UNSPECIFIED', exclusion: 'NO2_REGION_EXCLUSION_BASELINE_BACKFILL_PENDING' })]));
    await hydrate(state);
    const line = state.body.querySelector<HTMLElement>('.cdp-no2-activity');
    expect(line?.dataset.no2State).toBe('pending');
    expect(line?.textContent).toBe('Baseline pending: prior-year windows are still being fetched, so there is no reading yet.');
    expect(line?.textContent).not.toMatch(/%/);
  });

  it('names the exclusion when the window refused a reading', async () => {
    const state = fixture(wire([region({ changePercent: undefined, direction: 'NO2_DIRECTION_UNSPECIFIED', exclusion: 'NO2_REGION_EXCLUSION_INSUFFICIENT_VALID_DAYS', current: { windowStart: '2026-08-29', windowEnd: '2026-10-23', validDays: 6 } })]));
    await hydrate(state);
    const line = state.body.querySelector<HTMLElement>('.cdp-no2-activity');
    expect(line?.dataset.no2State).toBe('excluded');
    expect(line?.textContent).toBe('No reading this window: Insufficient valid days.');
    expect(state.body.querySelector('.cdp-measure-note')?.textContent).toBe('2026-08-29 to 2026-10-23, 6 valid days');
  });

  it('shows not covered for a country outside the registry and a failure for a fault', async () => {
    const notCovered = fixture(wire([], { attribution: '', generatedAt: '', unavailableReason: 'NO2_ACTIVITY_UNAVAILABLE_REASON_NOT_COVERED' }));
    await hydrate(notCovered);
    expect(notCovered.body.textContent).toBe('No NO2 activity region is registered for this country.');
    expect(notCovered.failures).toEqual([]);

    const fault = fixture(wire([], { attribution: '', unavailableReason: 'NO2_ACTIVITY_UNAVAILABLE_REASON_SEED_MISSING', upstreamUnavailable: true }));
    await hydrate(fault);
    expect(fault.failures).toEqual([['activity', 'unavailable', 'This section could not be loaded. Retry to refresh it.']]);
  });
});
