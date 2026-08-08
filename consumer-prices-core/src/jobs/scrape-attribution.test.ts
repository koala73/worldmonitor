import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  loadRetailerConfig: vi.fn(),
  loadAllRetailerConfigs: vi.fn().mockReturnValue([]),
  discoverTargets: vi.fn(),
  fetchTarget: vi.fn(),
  parseListing: vi.fn(),
  getPinnedUrlsForRetailer: vi.fn(),
  getDisabledPinsForRecovery: vi.fn(),
}));

vi.mock('../db/client.js', () => ({
  query: mocks.query,
  closePool: vi.fn(),
}));
vi.mock('../db/queries/observations.js', () => ({ insertObservation: vi.fn() }));
vi.mock('../db/queries/products.js', () => ({
  upsertRetailerProduct: vi.fn(),
  upsertCanonicalProduct: vi.fn(),
}));
vi.mock('../db/queries/matches.js', () => ({
  getBasketItemId: vi.fn(),
  getPinnedUrlsForRetailer: mocks.getPinnedUrlsForRetailer,
  getDisabledPinsForRecovery: mocks.getDisabledPinsForRecovery,
  upsertProductMatch: vi.fn(),
}));
vi.mock('../normalizers/size.js', () => ({
  parseSize: vi.fn(),
  unitPrice: vi.fn(),
}));
vi.mock('../config/loader.js', () => ({
  loadRetailerConfig: mocks.loadRetailerConfig,
  loadAllRetailerConfigs: mocks.loadAllRetailerConfigs,
}));
vi.mock('../acquisition/registry.js', () => ({
  initProviders: vi.fn(),
  teardownAll: vi.fn(),
}));
vi.mock('../acquisition/exa.js', () => ({ ExaProvider: class {} }));
vi.mock('../acquisition/firecrawl.js', () => ({ FirecrawlProvider: class {} }));
vi.mock('../adapters/generic.js', () => ({ GenericPlaywrightAdapter: class {} }));
vi.mock('../adapters/exa-search.js', () => ({ ExaSearchAdapter: class {} }));
vi.mock('../adapters/validator.js', () => ({ AUTO_MATCH_THRESHOLD: 0.9 }));
vi.mock('./scrape-pin-recovery.js', () => ({
  handleStaleOnInStock: vi.fn(),
  handleStaleOnOutOfStock: vi.fn(),
  handlePinError: vi.fn(),
}));
vi.mock('../adapters/search.js', () => {
  class MockSearchTargetError extends Error {
    readonly rejectedCount: number;
    readonly failures: Array<{ provider: string; reason: string; detail?: string }>;

    constructor(
      message: string,
      rejectedCount: number,
      failures: Array<{ provider: string; reason: string; detail?: string }>,
    ) {
      super(message);
      this.name = 'SearchTargetError';
      this.rejectedCount = rejectedCount;
      this.failures = failures;
    }
  }

  class MockSearchAdapter {
    discoverTargets = mocks.discoverTargets;
    fetchTarget = mocks.fetchTarget;
    parseListing = mocks.parseListing;
  }

  return { SearchAdapter: MockSearchAdapter, SearchTargetError: MockSearchTargetError };
});

vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
  process.exitCode = typeof code === 'number' ? code : 0;
  return undefined as never;
});

const { scrapeRetailer } = await import('./scrape.js');
const { SearchTargetError } = await import('../adapters/search.js');

const config = {
  slug: 'retailer-a',
  name: 'Retailer A',
  marketCode: 'ae',
  countryCode: 'AE',
  currencyCode: 'AED',
  adapter: 'search',
  baseUrl: 'https://retailer.test',
  enabled: true,
  discovery: { mode: 'search', seeds: [], maxPages: 1 },
  searchConfig: { extractionFallback: 'none' },
  rateLimit: { delayBetweenRequestsMs: 0 },
};

const target = {
  id: 'bread-white',
  url: 'https://retailer.test/bread',
  category: 'bread',
  metadata: { direct: false },
};

beforeEach(() => {
  mocks.query.mockReset().mockResolvedValue({ rows: [{ id: 'retailer-run-1' }], rowCount: 1 });
  mocks.loadRetailerConfig.mockReset().mockReturnValue(config);
  mocks.loadAllRetailerConfigs.mockReset().mockReturnValue([]);
  mocks.discoverTargets.mockReset().mockResolvedValue([target]);
  mocks.fetchTarget.mockReset();
  mocks.parseListing.mockReset().mockResolvedValue([]);
  mocks.getPinnedUrlsForRetailer.mockReset().mockResolvedValue(new Map());
  mocks.getDisabledPinsForRecovery.mockReset().mockResolvedValue([]);
  vi.stubEnv('EXA_API_KEY', 'exa-test');
  vi.stubEnv('FIRECRAWL_API_KEY', 'firecrawl-test');
});

describe('scrapeRetailer failure attribution', () => {
  it('persists SearchTargetError reasons and a matching error count', async () => {
    mocks.fetchTarget.mockRejectedValueOnce(
      new SearchTargetError('all candidates failed', 0, [{ provider: 'firecrawl', reason: 'missing-price' }]),
    );

    await scrapeRetailer('retailer-a');

    const updateCall = mocks.query.mock.calls.find(([sql]) => String(sql).includes('failure_reasons=$7'));
    expect(updateCall).toBeDefined();
    expect(updateCall?.[1]).toEqual([
      'retailer-run-1',
      'failed',
      1,
      0,
      1,
      0,
      JSON.stringify({ 'missing-price': 1 }),
    ]);
  });

  it('attributes an unexpected scrape error as unknown-error', async () => {
    mocks.fetchTarget.mockRejectedValueOnce(new Error('adapter exploded'));

    await scrapeRetailer('retailer-a');

    const updateCall = mocks.query.mock.calls.find(([sql]) => String(sql).includes('failure_reasons=$7'));
    expect(updateCall?.[1]).toEqual([
      'retailer-run-1',
      'failed',
      1,
      0,
      1,
      0,
      JSON.stringify({ 'unknown-error': 1 }),
    ]);
  });
});
