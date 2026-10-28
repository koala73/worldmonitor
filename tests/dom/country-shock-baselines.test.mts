import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { CountryDeepDivePanel } from '@/components/CountryDeepDivePanel';
import { initTestI18n } from './helpers/i18n.mts';
import type { CountryBriefSource } from '@/services/country-brief-source';
import type { ComputeEnergyShockScenarioResponse } from '@/generated/client/worldmonitor/intelligence/v1/service_client';

const attemptedFetches = vi.hoisted(() => {
  const attempted: string[] = [];
  globalThis.fetch = async input => {
    attempted.push(String(input));
    throw new Error('Shock baseline fixtures forbid network reads');
  };
  return attempted;
});

// Japan, Hormuz, 100%: production inputs replayed on 2026-10-28.
function japan(overrides: Partial<ComputeEnergyShockScenarioResponse> = {}): ComputeEnergyShockScenarioResponse {
  return {
    countryCode: 'JP', chokepointId: 'hormuz_strait', disruptionPct: 100,
    gulfCrudeShare: 0.927, crudeLossKbd: 2208.1, effectiveCoverDays: 192,
    products: [{ product: 'Gasoline', outputLossKbd: 971.6, demandKbd: 790.8, deficitPct: 100 }],
    assessment: 'Japan can bridge a 100% Strait of Hormuz disruption for ~192 days at the pre-crisis supply mix.',
    dataAvailable: true, jodiOilCoverage: true, comtradeCoverage: true, ieaStocksCoverage: true, portwatchCoverage: true,
    coverageLevel: 'full', limitations: [], degraded: false, chokepointConfidence: 'high', liveFlowRatio: 0.606,
    preCrisisBaseline: { basis: 'comtrade_monthly', fromMonth: '2025-02', toMonth: '2026-01', monthsCovered: 12, gulfCrudeShare: 0.927, crudeLossKbd: 2208.1 },
    currentFlows: { basis: 'comtrade_monthly', fromMonth: '2026-06', toMonth: '2026-08', monthsCovered: 3, gulfCrudeShare: 0.605, crudeLossKbd: 1441.2 },
    ...overrides,
  } as ComputeEnergyShockScenarioResponse;
}

let panel: CountryDeepDivePanel;
beforeAll(initTestI18n);
afterEach(() => { panel?.hide(); document.body.replaceChildren(); });
afterAll(() => { expect(attemptedFetches).toEqual([]); });

function render(result: ComputeEnergyShockScenarioResponse): HTMLElement {
  panel = new CountryDeepDivePanel(null, { canRequestPremium: () => true } as unknown as CountryBriefSource);
  const el = (Reflect.get(panel, 'renderShockResult') as (r: ComputeEnergyShockScenarioResponse) => HTMLElement).call(panel, result);
  document.body.append(el);
  return el;
}

it('labels the pre-crisis baseline that drives the table and shows current flows beside it', () => {
  const el = render(japan());
  const rows = [...el.querySelectorAll('.cdp-shock-baseline')].map(r => r.textContent);
  expect(rows).toEqual([
    'Pre-crisis (Feb 2025–Jan 2026): 92.7% Gulf crude, 2,208 kbd lost',
    'Current flows (Jun 2026–Aug 2026): 60.5% Gulf crude, up to 1,441 kbd lost (no bypass recovery)',
  ]);
  expect(el.querySelector('.cdp-shock-baseline-note')?.textContent).toBe('Product deficits and cover below use the pre-crisis mix.');
});

it('shows the loss before and after Hormuz bypass rerouting when the bypass is modeled', () => {
  const el = render(japan({
    crudeLossKbd: 979.5,
    preCrisisBaseline: { basis: 'comtrade_monthly', fromMonth: '2025-02', toMonth: '2026-01', monthsCovered: 12, gulfCrudeShare: 0.927, crudeLossKbd: 2209.5, crudeLossAfterBypassKbd: 979.5 },
  }));
  const rows = [...el.querySelectorAll('.cdp-shock-baseline')].map(r => r.textContent);
  expect(rows[0]).toBe('Pre-crisis (Feb 2025–Jan 2026): 92.7% Gulf crude, 2,210 kbd lost before bypass, 980 kbd after');
  expect(rows[1]).toBe('Current flows (Jun 2026–Aug 2026): 60.5% Gulf crude, up to 1,441 kbd lost (no bypass recovery)');
  expect(el.querySelector('.cdp-shock-baseline-note')?.textContent).toBe('Product deficits and cover below use the pre-crisis mix after bypass rerouting (Yanbu, Fujairah, Ceyhan).');
});

it('names the annual fallback and an unavailable current figure (China)', () => {
  const el = render(japan({
    countryCode: 'CN', gulfCrudeShare: 0.378, crudeLossKbd: 3385.3,
    preCrisisBaseline: { basis: 'comtrade_annual', fromMonth: '2024-01', toMonth: '2024-12', monthsCovered: 12, gulfCrudeShare: 0.378, crudeLossKbd: 3385.3 },
    currentFlows: undefined,
  }));
  const rows = [...el.querySelectorAll('.cdp-shock-baseline')].map(r => r.textContent);
  expect(rows).toEqual([
    'Pre-crisis (2024 annual): 37.8% Gulf crude, 3,385 kbd lost',
    'Current flows: not available',
  ]);
});

it('gives the server\'s reason when current flows are unavailable, without blaming the importer', () => {
  const el = render(japan({
    currentFlows: undefined,
    limitations: ['Current flows unavailable for JP: the monthly UN Comtrade crude-origin series is not available.'],
  }));
  const rows = [...el.querySelectorAll('.cdp-shock-baseline')].map(r => r.textContent);
  expect(rows[1]).toBe('Current flows: not available (the monthly UN Comtrade crude-origin series is not available)');
});

it('shows measured shares when the oil loss is not modeled in oil-only mode (no JODI crude imports)', () => {
  const el = render(japan({
    countryCode: 'IN', dataAvailable: false, jodiOilCoverage: false, crudeLossKbd: 0, products: [], effectiveCoverDays: 0,
    assessment: 'Insufficient import data for India to model Strait of Hormuz exposure.',
    limitations: ['JODI crude import observation unavailable for IN; oil loss, product deficits and effective cover are not modeled (reported as 0).'],
    preCrisisBaseline: { basis: 'comtrade_monthly', fromMonth: '2025-02', toMonth: '2026-01', monthsCovered: 12, gulfCrudeShare: 0.482, crudeLossKbd: 0 },
    currentFlows: { basis: 'comtrade_monthly', fromMonth: '2026-05', toMonth: '2026-07', monthsCovered: 3, gulfCrudeShare: 0.261, crudeLossKbd: 0 },
  }));
  const rows = [...el.querySelectorAll('.cdp-shock-baseline')].map(r => r.textContent);
  expect(rows).toEqual([
    'Pre-crisis (Feb 2025–Jan 2026): 48.2% Gulf crude, loss not modeled',
    'Current flows (May 2026–Jul 2026): 26.1% Gulf crude, loss not modeled',
  ]);
  expect(el.textContent).toContain('Insufficient import data for India');
});

it('in both mode, gas data does not make an unmodeled oil loss read as 0 kbd lost', () => {
  const el = render(japan({
    dataAvailable: true, jodiOilCoverage: true, crudeLossKbd: 0, products: [], effectiveCoverDays: 0,
    limitations: ['JODI crude import observation unavailable for JP; oil loss, product deficits and effective cover are not modeled (reported as 0).'],
    gasSensitivity: {
      lngShareOfImports: 1, lngImportsTj: 274197, lngDisruptionTj: 82259.1, totalDemandTj: 299947, deficitPct: 27.4,
      dataAvailable: true, assessment: 'JP gas sensitivity assumes 30% of recorded LNG imports use the Strait of Hormuz.',
      dataSource: 'jodi_monthly', dataMonth: '2026-07', modelBasis: 'assumed_route_sensitivity',
    },
    preCrisisBaseline: { basis: 'comtrade_monthly', fromMonth: '2025-02', toMonth: '2026-01', monthsCovered: 12, gulfCrudeShare: 0.927, crudeLossKbd: 0 },
  }));
  const rows = [...el.querySelectorAll('.cdp-shock-baseline')].map(r => r.textContent);
  expect(rows[0]).toBe('Pre-crisis (Feb 2025–Jan 2026): 92.7% Gulf crude, loss not modeled');
});

it('a current figure without a pre-crisis baseline still renders, and the pre-crisis row says it is unavailable', () => {
  const el = render(japan({
    dataAvailable: false, comtradeCoverage: false, crudeLossKbd: 0, products: [], effectiveCoverDays: 0,
    preCrisisBaseline: undefined,
  }));
  const rows = [...el.querySelectorAll('.cdp-shock-baseline')].map(r => r.textContent);
  expect(rows).toEqual([
    'Pre-crisis: not available',
    'Current flows (Jun 2026–Aug 2026): 60.5% Gulf crude, loss not modeled',
  ]);
});

it('labels a route-adjusted share as exposure on that route (Suez)', () => {
  const el = render(japan({ chokepointId: 'suez' }));
  const rows = [...el.querySelectorAll('.cdp-shock-baseline')].map(r => r.textContent);
  expect(rows[0]).toBe('Pre-crisis (Feb 2025–Jan 2026): 92.7% Gulf crude on this route, 2,208 kbd lost');
});

it('shows shares without a loss when the oil loss is not modeled', () => {
  const el = render(japan({
    dataAvailable: false, jodiOilCoverage: false, crudeLossKbd: 0, products: [], effectiveCoverDays: 0,
    gasSensitivity: {
      lngShareOfImports: 1, lngImportsTj: 111255.8, lngDisruptionTj: 33376.7, totalDemandTj: 185285.1, deficitPct: 18,
      dataAvailable: true, assessment: 'IN gas sensitivity assumes 30% of recorded LNG imports use the Strait of Hormuz.',
      dataSource: 'jodi_monthly', dataMonth: '2026-03', modelBasis: 'assumed_route_sensitivity',
    },
    preCrisisBaseline: { basis: 'comtrade_monthly', fromMonth: '2025-02', toMonth: '2026-01', monthsCovered: 12, gulfCrudeShare: 0.482, crudeLossKbd: 0 },
    currentFlows: { basis: 'comtrade_monthly', fromMonth: '2026-05', toMonth: '2026-07', monthsCovered: 3, gulfCrudeShare: 0.261, crudeLossKbd: 0 },
  }));
  const rows = [...el.querySelectorAll('.cdp-shock-baseline')].map(r => r.textContent);
  expect(rows).toEqual([
    'Pre-crisis (Feb 2025–Jan 2026): 48.2% Gulf crude, loss not modeled',
    'Current flows (May 2026–Jul 2026): 26.1% Gulf crude, loss not modeled',
  ]);
  expect(el.querySelector('.cdp-shock-baseline-note')).toBeNull();
});

it('renders no baseline block for gas-only results', () => {
  const el = render(japan({ preCrisisBaseline: undefined, currentFlows: undefined }));
  expect(el.querySelector('.cdp-shock-baselines')).toBeNull();
});

it('shows non-IEA reserve cover as an estimate, never as IEA cover (India)', () => {
  const el = render(japan({
    countryCode: 'IN', ieaStocksCoverage: false, effectiveCoverDays: 11,
    reserveEstimate: { scope: 'ISPRL strategic reserve', asOf: '2026-03-23', credibility: 'high', lowMb: 21.4, centralMb: 24, highMb: 39, coverDaysLow: 10, coverDaysHigh: 18 },
  }));
  const row = el.querySelector('.cdp-shock-reserve-estimate')?.textContent;
  expect(row).toBe('Estimated strategic reserve cover (not IEA data): ~11 days under this scenario (range 10–18; ISPRL strategic reserve, 24 M bbl, as of 2026-03-23)');
  expect(el.textContent).not.toContain('IEA cover: ~');
});

it('flags a low-credibility reserve estimate (China) and says when cover is not modeled', () => {
  const china = render(japan({
    countryCode: 'CN', ieaStocksCoverage: false, effectiveCoverDays: 586,
    reserveEstimate: { scope: 'government plus state-directed commercial crude stocks', asOf: '2025-12', credibility: 'low', lowMb: 360, centralMb: 1200, highMb: 1400, coverDaysLow: 161, coverDaysHigh: 687 },
  }));
  expect(china.querySelector('.cdp-shock-reserve-estimate')?.textContent).toContain('low credibility');
  const notModeled = render(japan({
    countryCode: 'IN', ieaStocksCoverage: false, dataAvailable: false, jodiOilCoverage: false, effectiveCoverDays: 0, products: [],
    gasSensitivity: {
      lngShareOfImports: 1, lngImportsTj: 111255.8, lngDisruptionTj: 33376.7, totalDemandTj: 185285.1, deficitPct: 18,
      dataAvailable: true, assessment: 'IN gas sensitivity.', dataSource: 'jodi_monthly', dataMonth: '2026-03', modelBasis: 'assumed_route_sensitivity',
    },
    limitations: ['JODI crude import observation unavailable for IN; oil loss, product deficits and effective cover are not modeled (reported as 0).'],
    reserveEstimate: { scope: 'ISPRL strategic reserve', asOf: '2026-03-23', credibility: 'high', lowMb: 21.4, centralMb: 24, highMb: 39 },
  }));
  expect(notModeled.querySelector('.cdp-shock-reserve-estimate')?.textContent).toBe('Estimated strategic reserve (not IEA data): 24 M bbl, as of 2026-03-23; cover not modeled for this scenario');
});

it('shows the reserve estimate, without cover days, when an oil-only result has no usable crude imports (India)', () => {
  const el = render(japan({
    countryCode: 'IN', ieaStocksCoverage: false, dataAvailable: false, jodiOilCoverage: false, coverageLevel: 'unsupported',
    crudeLossKbd: 0, effectiveCoverDays: 0, products: [], gasSensitivity: undefined,
    assessment: 'Insufficient import data for India to model Strait of Hormuz exposure.',
    limitations: ['JODI crude import observation unavailable for IN; oil loss, product deficits and effective cover are not modeled (reported as 0).'],
    reserveEstimate: { scope: 'ISPRL strategic reserve', asOf: '2026-03-23', credibility: 'high', lowMb: 21.4, centralMb: 24, highMb: 39 },
  }));
  expect(el.querySelector('.cdp-shock-reserve-estimate')?.textContent).toBe('Estimated strategic reserve (not IEA data): 24 M bbl, as of 2026-03-23; cover not modeled for this scenario');
  expect(el.textContent).toContain('Insufficient import data for India');
});

const EXPORTER_ROW = 'Net oil exporter — strategic reserve cover not applicable';
function netExporter(overrides: Partial<ComputeEnergyShockScenarioResponse>): ComputeEnergyShockScenarioResponse {
  return japan({
    comtradeCoverage: false, gulfCrudeShare: 0, crudeLossKbd: 0, products: [], effectiveCoverDays: -1,
    coverageLevel: 'partial', preCrisisBaseline: undefined, currentFlows: undefined, ...overrides,
  });
}

it('an IEA net exporter without an origin share reads as a net exporter, not "not modeled" (Mexico)', () => {
  const el = render(netExporter({
    countryCode: 'MX', jodiOilCoverage: false,
    assessment: 'Mexico is a net oil exporter, so no import-cover duration applies; Strait of Hormuz disruption mainly affects export revenue and can still reach refiners that import Gulf crude or products.',
    limitations: ['effectiveCoverDays -1 marks a net oil exporter (IEA); no import-cover duration applies.'],
  }));
  expect(el.textContent).toContain(EXPORTER_ROW);
  expect(el.textContent).not.toContain('IEA cover');
});

it('a net exporter without an IEA record still reads as a net exporter (Saudi Arabia, from JODI)', () => {
  const el = render(netExporter({
    countryCode: 'SA', ieaStocksCoverage: false,
    assessment: 'Saudi Arabia is a net oil exporter, so no import-cover duration applies; Strait of Hormuz disruption mainly affects export revenue and can still reach refiners that import Gulf crude or products.',
    limitations: ['effectiveCoverDays -1 marks a net oil exporter: net crude exporter from JODI 2026-08, production 9,800 kb/d against refinery intake 2,700, exports 6,900 against imports 0; no import-cover duration applies.'],
  }));
  expect(el.textContent).toContain(EXPORTER_ROW);
  expect(el.querySelector('.cdp-shock-reserve-estimate')).toBeNull();
});
