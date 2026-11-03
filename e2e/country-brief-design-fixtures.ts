import { normalizeComtradeProducts, HS4_CODES, HS4_LABELS } from '../scripts/shared/comtrade.mjs';
import type { Page } from '@playwright/test';
import us from './fixtures/country-brief-us.json' with { type: 'json' };

export async function installCountryBriefDesignData(page: Page) {
  await page.addInitScript(() => localStorage.setItem('wm-pro-key', 'e2e-country-brief-design'));
  let releaseFactors: () => void = () => {};
  const factorsReady = new Promise<void>(resolve => { releaseFactors = resolve; });
  const countriesRequested: string[] = [];
  await page.route('**/api/scorecard/v1/get-five-factor-scorecard*', async route => {
    const code = new URL(route.request().url()).searchParams.get('countryCode') ?? '';
    countriesRequested.push(code);
    await factorsReady;
    await route.fulfill({ json: code === 'US' ? us.scorecard : { unavailable: true, unavailableReason: 'snapshot-unavailable' } });
  });
  await page.route('**/api/intelligence/v1/get-country-intel-brief*', route => route.fulfill({ json:
    new URL(route.request().url()).searchParams.get('country_code') === 'US' ? us.brief : { brief: '' },
  }));
  await page.route('**/api/intelligence/v1/get-country-facts*', route => route.fulfill({ json:
    new URL(route.request().url()).searchParams.get('country_code') !== 'US' ? {} : {
    countryCode: 'US', countryName: 'United States', capital: 'Washington, D.C.', population: '340100000',
    areaSqKm: 9826675, languages: ['English'], currencies: ['US dollar'], headOfState: '', headOfStateTitle: '',
    wikipediaSummary: '', wikipediaThumbnailUrl: '',
  } }));
  await page.route('**/api/economic/v1/get-national-debt*', route => route.fulfill({ json: {
    entries: [{ iso3: 'USA', debtToGdp: 128.6, debtUsd: 43446021592.1e12, annualGrowth: 2.2, source: 'IMF WEO 2027' }], unavailable: false,
  } }));
  await page.route('**/api/trade/v1/get-tariff-trends*', route => route.fulfill({ json:
    new URL(route.request().url()).searchParams.get('reporting_country') !== '840' ? { datapoints: [] } : {
    effectiveTariffRate: { tariffRate: 8.83 }, datapoints: [{ year: 2024, tariffRate: 8.83 }, { year: 2025, tariffRate: 8.83 }],
  } }));
  await page.route('**/api/bootstrap?*', async route => {
    if (!new URL(route.request().url()).searchParams.get('keys')?.includes('bisDsr')) return route.fallback();
    await route.fulfill({ json: { data: {
      bisPropertyResidential: { entries: [{ countryCode: 'US', indexValue: 156.4, yoyChange: -2.1, qoqChange: null, period: '2026-Q1' }] },
      bisPropertyCommercial: { entries: [{ countryCode: 'US', indexValue: 186.6, yoyChange: 6.6, qoqChange: null, period: '2026-Q1' }] },
      bisDsr: { entries: [{ countryCode: 'US', dsrPct: 8, change: 1.3, period: '2026-Q1' }] },
    } } });
  });
  return { releaseFactors, countriesRequested };
}

export async function installDecisionBriefData(page: Page) {
  const design = await installCountryBriefDesignData(page);
  design.releaseFactors();
  const state = { mode: 'ready' as 'ready' | 'missing' | 'mismatch' | 'denied' | 'error', requests: [] as string[] };
  await page.route('**/api/intelligence/v1/compute-energy-shock*', async route => {
    const url = new URL(route.request().url());
    state.requests.push(url.search);
    if (state.mode === 'denied' || state.mode === 'error') {
      return route.fulfill({ status: state.mode === 'denied' ? 403 : 503, json: { error: state.mode } });
    }
    const code = url.searchParams.get('country_code')!;
    const pct = Number(url.searchParams.get('disruption_pct'));
    const lng = code === 'DE' ? 41318 : 100000;
    const demand = code === 'DE' ? 467224 : 500000;
    const loss = Math.round(lng * 0.3 * pct / 100 * 10) / 10;
    if (url.searchParams.get('fuel_mode') === 'oil') {
      return route.fulfill({ json: { countryCode: code, chokepointId: url.searchParams.get('chokepoint_id'), disruptionPct: pct, dataAvailable: true, jodiOilCoverage: true, crudeLossKbd: pct * 2, gulfCrudeShare: 0.3, products: [], limitations: [] } });
    }
    await route.fulfill({ json: {
      countryCode: code, chokepointId: url.searchParams.get('chokepoint_id'), disruptionPct: pct,
      dataAvailable: state.mode !== 'missing', products: [], limitations: [], coverageLevel: 'partial',
      gasSensitivity: state.mode === 'missing' ? undefined : {
        dataAvailable: true, lngImportsTj: code === 'DE' ? 41318 : 100000, totalDemandTj: code === 'DE' ? 467224 : 500000,
        lngDisruptionTj: loss, deficitPct: Math.round(loss / demand * 1000) / 10,
        dataMonth: state.mode === 'mismatch' && pct === 100 ? '2026-06' : '2026-05', dataSource: 'JODI', modelBasis: 'assumed_route_sensitivity',
        assessment: '30% assumed route exposure. Monthly sensitivity, not measured supplier exposure.',
        storage: { gasTwh: 30, fillPct: 50, date: '2025-01-02', scope: 'national', trend: '' },
      },
    } });
  });
  return state;
}

export async function installCommodityBriefData(page: Page) {
  await installDecisionBriefData(page);
  const state = { fail: false };
  await page.route('**/api/supply-chain/v1/get-country-products*', route => {
    if (state.fail) return route.fulfill({ status: 503, json: { error: 'controlled unavailable' } });
    const iso2 = new URL(route.request().url()).searchParams.get('iso2') ?? 'JP';
    // HS 2804 carries the U5 evidence depth: threshold partner basis, net weight
    // and quantity, world-export scale, and a reviewed transit-hub origin (NL).
    const products = normalizeComtradeProducts([
      { hs4: '2804', description: 'Hydrogen and rare gases', totalValue: 1000, year: 2024,
        partnerBasis: 'share_threshold', omittedPartnerCount: 39, omittedPartnerShare: 0.031, topExporters: [
          { partnerCode: 634, partnerIso2: 'QA', share: 0.408, value: 408, netWeightKg: 1_204_000, netWeightEstimated: false, quantity: 8600, quantityUnitCode: 12,
            scale: { worldExportsUsd: 2_100_000_000, worldExportsKg: 2_400_000, rank: 1, year: 2024, reporterCount: 118, unrankedReporterCount: 22 } },
          { partnerCode: 842, partnerIso2: '', share: 0.392, value: 392, netWeightKg: 839, netWeightEstimated: true,
            scale: { worldExportsUsd: 1_450_000_000, rank: 2, year: 2024, reporterCount: 118, unrankedReporterCount: 22 } },
          // A hub origin with neither weight nor scale: the "not reported" states.
          { partnerCode: 528, partnerIso2: 'NL', share: 0.1, value: 100 },
          { partnerCode: 999, partnerIso2: 'ZZ', share: 0.1, value: 100 },
        ] },
      { hs4: '1001', description: 'Wheat', totalValue: 1000, year: 2023, topExporters: [{ partnerCode: 36, partnerIso2: 'AU', share: 1, value: 1000 }] },
    ]).map(p => ({ ...p, description: HS4_LABELS[p.hs4] ?? p.description }));
    return route.fulfill({ json: { iso2, fetchedAt: '2026-09-09T00:00:00Z', products, evidence: { state: 'partial', source: 'UN Comtrade bilateral HS4 (controlled legacy fixture)', requestedHs4s: [], missingHs4s: HS4_CODES.filter(code => !products.some(p => p.hs4 === code)), lastAttemptAt: '', lastAttemptState: 'unknown', recoveredHs4s: [], worldExportsFetchedAt: '2026-09-08T00:00:00Z' } } });
  });
  // The brief asks for world production once per mineral commodity, with no iso2.
  await page.route('**/api/supply-chain/v1/get-mineral-production*', route => {
    const commodity = new URL(route.request().url()).searchParams.get('commodity');
    return route.fulfill({ json: {
      commodities: commodity !== 'helium' ? [] : [{
        commodityId: 'helium', commodity: 'Helium', year: 2024, unit: 'million cubic metres', sources: ['usgs-mcs'],
        mine: { year: 2024, unit: 'million cubic metres', hhi: 3200, withheldCount: 0, countries: [
          { iso2: 'US', country: 'United States', output: 74, share: 46.2, withheld: false, estimated: false, residual: false },
          { iso2: 'QA', country: 'Qatar', output: 50, share: 31.2, withheld: false, estimated: false, residual: false },
        ] },
      }],
      countries: [], fetchedAt: '2026-09-01T00:00:00Z', upstreamUnavailable: false, dataYear: 2024,
    } });
  });
  await page.route('**/api/supply-chain/v1/get-country-vulnerabilities*', route => route.fulfill({ json: {
    iso2: new URL(route.request().url()).searchParams.get('iso2') ?? 'JP', country: '', vulnerabilities: [], generatedAt: '', methodologyVersion: '', upstreamUnavailable: true,
  } }));
  return state;
}
