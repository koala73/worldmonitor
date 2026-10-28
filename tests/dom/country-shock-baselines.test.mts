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
    'Current flows (Jun 2026–Aug 2026): 60.5% Gulf crude, 1,441 kbd lost',
  ]);
  expect(el.querySelector('.cdp-shock-baseline-note')?.textContent).toBe('Product deficits and cover below use the pre-crisis mix.');
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
