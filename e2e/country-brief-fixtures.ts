import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { test as base, expect } from '@playwright/test';
import type { Locator, Page, TestInfo } from '@playwright/test';
import type { ListPredictionMarketsResponse } from '../src/generated/client/worldmonitor/prediction/v1/service_client';
import { seedAnonymousDashboard } from './bootstrap-request-budget-fixtures';

export const RPC_PATH = '/api/prediction/v1/list-prediction-markets';
export const MARKET_RESPONSE: ListPredictionMarketsResponse = {
  markets: [
    { id: 'qa-ua-poly', title: 'Ukraine QA ceasefire agreement?', yesPrice: 0.67,
      volume: 12000, url: 'https://polymarket.com/event/qa-ua-ceasefire', closesAt: 0,
      category: 'geopolitical', source: 'MARKET_SOURCE_POLYMARKET' },
    { id: 'qa-ua-kalshi', title: 'Ukraine QA reconstruction funding?', yesPrice: 0.38,
      volume: 8000, url: 'https://kalshi.com/markets/qa-ua-funding', closesAt: 0,
      category: 'geopolitical', source: 'MARKET_SOURCE_KALSHI' },
  ],
  fetchedAt: 0,
  dataAvailable: true,
};

export const HYDRATED_MARKET = {
  title: 'Ukraine QA bootstrap recovery?', yesPrice: 54, volume: 5000,
  url: 'https://polymarket.com/event/qa-ua-bootstrap', source: 'polymarket',
};

const fault = process.env.WM_COUNTRY_BRIEF_FAULT ?? '';
if (!['', 'drop-record', 'skip-hydration', 'drop-reload-country'].includes(fault)) {
  throw new Error(`Unknown WM_COUNTRY_BRIEF_FAULT: ${fault}`);
}

type RpcObservation = { method: string; category: string | null; pageSize: string | null; status: number };
type CountryBriefFixture = {
  imfScenario?: ImfPeriodScenario;
  response: ListPredictionMarketsResponse;
  status: number;
  hydrate: boolean;
  temporalCount?: number;
  requests: RpcObservation[];
  fault: string;
};

export type ImfPeriodScenario = 'mixed' | 'legacy' | 'partial' | 'sparse';
export function imfPeriodData(scenario: ImfPeriodScenario, code: string) {
  const macro: Record<string, unknown> = { inflationPct: 2.5, primaryBalancePct: -2.4, govExpenditurePct: 40, govRevenuePct: 0, year: 2099, latestYear: 2099, periods: { inflationPct: 2025, primaryBalancePct: 2024, govExpenditurePct: 2022, govRevenuePct: 2021 } };
  const growth: Record<string, unknown> = { realGdpGrowthPct: 1.5, gdpPerCapitaUsd: 60300, year: 2099, periods: { realGdpGrowthPct: 2026, gdpPerCapitaUsd: 2023 } };
  const labor: Record<string, unknown> = { unemploymentPct: 6.5, year: 2099, periods: { unemploymentPct: 2020 } };
  if (scenario === 'legacy') for (const entry of [macro, growth, labor]) delete entry.periods;
  if (scenario === 'partial') macro.periods = { inflationPct: null, govExpenditurePct: 2022, govRevenuePct: 2021 };
  if (scenario === 'sparse') { delete macro.inflationPct; delete macro.primaryBalancePct; delete growth.realGdpGrowthPct; delete labor.unemploymentPct; }
  return { imfMacro: { countries: { [code]: macro } }, ...(scenario === 'partial' ? {} : { imfGrowth: { countries: { [code]: growth } } }), imfLabor: { countries: { [code]: labor } }, imfExternal: { countries: {} } };
}

export async function captureImfPeriods(page: Page, card: Locator, scenario: ImfPeriodScenario, testInfo: TestInfo, surface: 'website' | 'native') {
  await expect(card.locator('.cdp-economic-source').filter({ hasText: 'IMF WEO' }).first()).toBeVisible();
  const years: Record<string, number> = { 'Real GDP Growth': 2026, 'GDP / Capita': 2023, 'CPI Inflation': 2025, 'Primary Balance': 2024, 'Public Spending': 2022, 'Gov Revenue': 2021, Unemployment: 2020 };
  const values: Record<string, string> = { 'Real GDP Growth': '+1.5%', 'GDP / Capita': '$60.3k', 'CPI Inflation': '+2.5%', 'Primary Balance': '-2.4% GDP', 'Public Spending': '40.0% GDP', 'Gov Revenue': '0.0% GDP', Unemployment: '6.5%' };
  const metricLabels: Record<ImfPeriodScenario, string[]> = {
    mixed: ['Real GDP Growth', 'CPI Inflation', 'Unemployment', ...(surface === 'native' ? ['Primary Balance'] : [])],
    legacy: ['Real GDP Growth', 'CPI Inflation', 'Unemployment', 'Primary Balance'],
    partial: ['CPI Inflation', 'Unemployment', 'Primary Balance', 'Public Spending'],
    sparse: ['GDP / Capita', 'Public Spending', 'Gov Revenue'],
  };
  const prefix = scenario === 'sparse' ? [] : ['Stock Index', 'Weekly Momentum', ...(surface === 'website' && scenario === 'mixed' ? ['Instability Regime'] : [])];
  await expect(card.locator('.cdp-economic-label')).toHaveText([...prefix, ...metricLabels[scenario]]);
  const rows = await card.locator('.cdp-economic-item').evaluateAll(items => items.map(item => ({ label: item.querySelector('.cdp-economic-label')?.textContent ?? '', value: item.querySelector('.cdp-economic-value')?.textContent, source: item.querySelector('.cdp-economic-source')?.textContent, width: item.getBoundingClientRect().width, overflow: item.scrollWidth > item.clientWidth + 1 })));
  for (const row of rows.filter(row => row.label in years)) {
    const missing = scenario === 'legacy' || scenario === 'partial' && ['CPI Inflation', 'Primary Balance'].includes(row.label);
    expect(row.source).toBe(`IMF WEO · ${missing ? 'Year not supplied' : `Year ${years[row.label]}`} · IMF release not supplied`);
    expect(row.value).toBe(values[row.label]);
    expect(row.overflow).toBe(false);
  }
  if (scenario === 'sparse') expect(rows.map(row => row.label)).toEqual(expect.arrayContaining(['GDP / Capita', 'Public Spending', 'Gov Revenue']));
  expect(rows.length).toBeLessThanOrEqual(6);
  const clipped = await card.locator('.cdp-economic-source').evaluateAll(lines => lines.some(line => line.scrollWidth > line.clientWidth + 1 || line.scrollHeight > line.clientHeight + 1));
  expect(clipped).toBe(false);
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: testInfo.outputPath('economic-section.png') });
  await page.screenshot({ path: testInfo.outputPath('economic-viewport.png') });
  await writeFile(testInfo.outputPath('economic-rows.json'), JSON.stringify({ scenario, observedAt: new Date().toISOString(), rows }, null, 2));
}

export const test = base.extend<{ countryBrief: CountryBriefFixture }>({
  countryBrief: async ({ page, baseURL }, use, testInfo) => {
    const fixture: CountryBriefFixture = {
      response: structuredClone(MARKET_RESPONSE), status: 200, hydrate: false, requests: [], fault,
    };
    const pageErrors: string[] = [];
    const transportFailures: { path: string; error: string | null }[] = [];
    const stubbedPaths = new Set<string>();
    const origin = new URL(baseURL!).origin;
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('requestfailed', request => transportFailures.push({
      path: new URL(request.url()).pathname, error: request.failure()?.errorText ?? null,
    }));
    await seedAnonymousDashboard(page, 'full');
    await page.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (fixture.imfScenario === 'mixed' && url.origin === origin && url.pathname === '/src/services/cached-risk-scores.ts') {
        const response = await route.fetch();
        const original = await response.text();
        const served = original.replace(/function getCachedCountryScore\(code\) \{[\s\S]*?\n\}/, 'function getCachedCountryScore(code) { return code === "CA" ? { code:"CA", name:"Canada", score:71, level:"high", trend:"stable", lastUpdated:new Date("2026-10-16T10:29:00Z"), components:{unrest:0,conflict:0,security:100,information:0} } : null; }');
        expect(served).not.toBe(original);
        await writeFile(testInfo.outputPath('controlled-score-getter.json'), JSON.stringify({ originalSha256: createHash('sha256').update(original).digest('hex'), servedSha256: createHash('sha256').update(served).digest('hex'), scope: 'Only cached CII getter is controlled; actual economic manager/controller/renderers unchanged.' }, null, 2));
        await route.fulfill({ response, body: served });
        return;
      }
        const temporalAnomalies = fixture.temporalCount === undefined ? undefined : {
          anomalies: Array.from({ length: fixture.temporalCount }, (_, i) => ({
            type: 'news', region: 'global', currentCount: 20, expectedCount: 2, zScore: 4,
            message: `Synthetic global observation ${i + 1}`,
          })), trackedTypes: ['news'], computedAt: new Date().toISOString(),
        };
      if (url.pathname === '/api/bootstrap') {
        if (fixture.imfScenario) {
          const data = imfPeriodData(fixture.imfScenario, 'CA');
          const keys = (url.searchParams.get('keys') ?? '').split(',');
          const riskScores = { ciiScores: [{ region: 'CA', combinedScore: 71, components: { ciiContribution: 0, geoConvergence: 0, militaryActivity: 100, newsActivity: 0 }, trend: 'TREND_DIRECTION_STABLE', computedAt: 1792150200000 }], degraded: false, stale: false };
          await route.fulfill({ json: { data: { ...Object.fromEntries(keys.filter(key => key in data).map(key => [key, data[key as keyof typeof data]])), riskScores }, missing: keys.filter(key => key.startsWith('imf') && !(key in data)) } });
          return;
        }
        const predictions = fixture.hydrate && fault !== 'skip-hydration'
          ? { geopolitical: [HYDRATED_MARKET], tech: [], finance: [], fetchedAt: Date.now() }
          : { geopolitical: [], tech: [], finance: [], fetchedAt: Date.now() };
        await route.fulfill({ json: { data: { predictions, temporalAnomalies }, missing: [] } });
      } else if (fixture.imfScenario && url.pathname.includes('/get-country-stock-index')) {
        await route.fulfill({ json: fixture.imfScenario === 'sparse' ? { available: false } : { available: true, code: 'CA', indexName: 'TSX Composite', price: '35518.6', weekChangePercent: '0.08', currency: 'CAD' } });
      } else if (url.pathname === '/api/infrastructure/v1/list-temporal-anomalies') {
        await route.fulfill({ json: temporalAnomalies ?? {} });
      } else if (url.pathname === RPC_PATH) {
        const category = url.searchParams.get('category');
        if (category?.startsWith('country:')) {
          fixture.requests.push({ method: request.method(), category,
            pageSize: url.searchParams.get('page_size'), status: fixture.status });
          const response = structuredClone(fixture.response);
          if (fault === 'drop-record') response.markets = response.markets.slice(1);
          await route.fulfill({ status: fixture.status, json: response });
        } else {
          await route.fulfill({ json: { markets: [], dataAvailable: true, fetchedAt: Date.now() } });
        }
      } else if (url.pathname.startsWith('/api/') || url.origin !== origin) {
        stubbedPaths.add(`${url.origin}${url.pathname}`);
        await route.fulfill({ status: fixture.imfScenario ? 503 : 200, json: {} });
      } else {
        await route.continue();
      }
    });
    let verificationError: unknown;
    try {
      await use(fixture);
      expect(pageErrors, 'Uncaught browser errors').toEqual([]);
      expect(transportFailures.filter(request => request.path === RPC_PATH), 'Prediction transport failures').toEqual([]);
    } catch (error) {
      verificationError = error;
      throw error;
    } finally {
      const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
      const evidencePath = testInfo.outputPath('country-brief-evidence.json');
      await writeFile(evidencePath, JSON.stringify({
        mode: 'deterministic-ui', scenario: testInfo.title, variant: 'full',
        testId: testInfo.testId, retry: testInfo.retry,
        browser: testInfo.project.name, viewport: testInfo.project.use.viewport,
        commit: git('rev-parse', 'HEAD'), worktree: git('rev-parse', '--show-toplevel'),
        trackedDiffSha256: createHash('sha256').update(git('diff', 'HEAD')).digest('hex'),
        dirtyPaths: git('status', '--short'), fault: fault || null,
        route: new URL(page.url()).pathname, country: new URL(page.url()).searchParams.get('country'),
        requests: fixture.requests, pageErrors, transportFailures, stubbedPaths: [...stubbedPaths].sort(),
        status: verificationError ? 'failed' : testInfo.status,
        errors: [...testInfo.errors.map(error => error.message),
          ...(verificationError ? [String(verificationError)] : [])],
        dependencies: ['Vite application assets', 'Playwright Chromium', 'controlled bootstrap and prediction RPC'],
        unverified: ['live providers', 'real handlers and cache', 'deployed assets and middleware',
          'auth and entitlements', 'production freshness', 'GPU map rendering'],
      }, null, 2));
      await testInfo.attach('country-brief-evidence', { path: evidencePath, contentType: 'application/json' });
    }
  },
});

export { expect };
