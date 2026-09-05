import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { test as base, expect } from '@playwright/test';
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
  response: ListPredictionMarketsResponse;
  status: number;
  hydrate: boolean;
  requests: RpcObservation[];
  fault: string;
};

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
    await seedAnonymousDashboard(page, 'full', {
      localStorage: { 'wm-community-dismissed-v2': '1' },
    });
    await page.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === '/api/bootstrap') {
        const predictions = fixture.hydrate && fault !== 'skip-hydration'
          ? { geopolitical: [HYDRATED_MARKET], tech: [], finance: [], fetchedAt: Date.now() }
          : { geopolitical: [], tech: [], finance: [], fetchedAt: Date.now() };
        await route.fulfill({ json: { data: { predictions }, missing: [] } });
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
        await route.fulfill({ json: {} });
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
