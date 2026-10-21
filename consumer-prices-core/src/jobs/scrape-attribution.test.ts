import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ValidatorResult } from '../adapters/validator.js';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  loadRetailerConfig: vi.fn(),
  loadAllRetailerConfigs: vi.fn().mockReturnValue([]),
  discoverTargets: vi.fn(),
  fetchTarget: vi.fn(),
  parseListing: vi.fn(),
  insertObservation: vi.fn(),
  upsertRetailerProduct: vi.fn(),
  upsertCanonicalProduct: vi.fn(),
  upsertProductMatch: vi.fn(),
  demoteAutoProductMatchToCandidate: vi.fn(),
  getBasketItemId: vi.fn(),
  getPinnedUrlsForRetailer: vi.fn(),
  getDisabledPinsForRecovery: vi.fn(),
  handlePinError: vi.fn(),
  withTransaction: vi.fn(),
  transactionExecute: vi.fn(),
}));

vi.mock('../db/client.js', () => ({
  query: mocks.query,
  closePool: vi.fn(),
  withTransaction: mocks.withTransaction,
}));
vi.mock('../db/queries/observations.js', () => ({ insertObservation: mocks.insertObservation }));
vi.mock('../db/queries/products.js', () => ({
  upsertRetailerProduct: mocks.upsertRetailerProduct,
  upsertCanonicalProduct: mocks.upsertCanonicalProduct,
}));
vi.mock('../db/queries/matches.js', () => ({
  demoteAutoProductMatchToCandidate: mocks.demoteAutoProductMatchToCandidate,
  getBasketItemId: mocks.getBasketItemId,
  getPinnedUrlsForRetailer: mocks.getPinnedUrlsForRetailer,
  getDisabledPinsForRecovery: mocks.getDisabledPinsForRecovery,
  upsertProductMatch: mocks.upsertProductMatch,
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
  handlePinError: mocks.handlePinError,
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

const lowScoreValidator: ValidatorResult = {
  ok: true,
  score: 0.7,
  reasons: [],
  signals: {
    tokenOverlap: 1,
    negativeTokenHit: null,
    nonFoodIndicatorHit: null,
    sizeWindow: 'unverified' as const,
    extractedBaseQty: null,
    extractedBaseUnit: null,
  },
};

const highScoreValidator: ValidatorResult = {
  ...lowScoreValidator,
  score: 0.95,
  signals: { ...lowScoreValidator.signals, sizeWindow: 'pass' },
};

const directPinTarget = {
  ...target,
  metadata: {
    direct: true,
    pinnedProductId: 'product-1',
    matchId: 'match-1',
  },
};

const lowScoreProduct = {
  retailerSku: 'sku-1',
  sourceUrl: 'https://retailer.test/bread',
  rawTitle: 'White Bread Pack',
  rawSizeText: '24 pack',
  imageUrl: null,
  categoryText: 'bread',
  price: 4.5,
  listPrice: null,
  promoPrice: null,
  inStock: true,
  promoText: null,
  rawPayload: { direct: true, validator: lowScoreValidator },
};

function mockLowScoreDirectPinHit() {
  mocks.discoverTargets.mockResolvedValueOnce([directPinTarget]);
  mocks.fetchTarget.mockResolvedValueOnce({});
  mocks.parseListing.mockResolvedValueOnce([lowScoreProduct]);
}

beforeEach(() => {
  mocks.query.mockReset().mockResolvedValue({ rows: [{ id: 'retailer-run-1' }], rowCount: 1 });
  mocks.loadRetailerConfig.mockReset().mockReturnValue(config);
  mocks.loadAllRetailerConfigs.mockReset().mockReturnValue([]);
  mocks.discoverTargets.mockReset().mockResolvedValue([target]);
  mocks.fetchTarget.mockReset();
  mocks.parseListing.mockReset().mockResolvedValue([]);
  mocks.insertObservation.mockReset().mockResolvedValue(undefined);
  mocks.upsertRetailerProduct.mockReset().mockResolvedValue('product-1');
  mocks.upsertCanonicalProduct.mockReset().mockResolvedValue('canonical-1');
  mocks.upsertProductMatch.mockReset().mockResolvedValue(undefined);
  mocks.demoteAutoProductMatchToCandidate.mockReset().mockResolvedValue(true);
  mocks.getBasketItemId.mockReset().mockResolvedValue('basket-item-1');
  mocks.getPinnedUrlsForRetailer.mockReset().mockResolvedValue(new Map());
  mocks.getDisabledPinsForRecovery.mockReset().mockResolvedValue([]);
  mocks.handlePinError.mockReset().mockResolvedValue(undefined);
  mocks.transactionExecute.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  mocks.withTransaction.mockReset().mockImplementation(async (work) => work(mocks.transactionExecute));
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

describe('scrapeRetailer direct-pin admission', () => {
  it('demotes a low-score direct auto pin before recording its observation', async () => {
    mockLowScoreDirectPinHit();

    await scrapeRetailer('retailer-a');

    expect(mocks.demoteAutoProductMatchToCandidate).toHaveBeenCalledWith(
      {
        matchId: 'match-1',
        matchScore: 0.7,
        evidence: { validator: { reasons: [], signals: lowScoreValidator.signals } },
      },
      mocks.transactionExecute,
    );
    expect(mocks.insertObservation).toHaveBeenCalledWith(expect.any(Object), mocks.transactionExecute);
    expect(mocks.insertObservation).toHaveBeenCalledOnce();
    expect(mocks.demoteAutoProductMatchToCandidate.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.insertObservation.mock.invocationCallOrder[0]);
  });

  it('fails closed when the direct-pin demotion write fails', async () => {
    const healthyTarget = { ...target, id: 'milk-whole' };
    const healthyProduct = {
      ...lowScoreProduct,
      retailerSku: 'sku-2',
      sourceUrl: 'https://retailer.test/milk',
      rawTitle: 'Whole Milk 1L',
      rawSizeText: '1 L',
      categoryText: 'dairy',
      rawPayload: { direct: false },
    };
    mocks.discoverTargets.mockResolvedValueOnce([directPinTarget, healthyTarget]);
    mocks.fetchTarget.mockResolvedValue({});
    mocks.parseListing
      .mockResolvedValueOnce([lowScoreProduct])
      .mockResolvedValueOnce([healthyProduct]);
    mocks.demoteAutoProductMatchToCandidate.mockRejectedValueOnce(new Error('database unavailable'));

    await scrapeRetailer('retailer-a');

    expect(mocks.insertObservation).toHaveBeenCalledOnce();
    expect(mocks.handlePinError).not.toHaveBeenCalled();
    const updateCall = mocks.query.mock.calls.find(([sql]) => String(sql).includes('failure_reasons=$7'));
    expect(updateCall?.[1]).toEqual([
      'retailer-run-1',
      'failed',
      2,
      1,
      1,
      0,
      JSON.stringify({ 'match-admission-persist-failed': 1 }),
    ]);
    const healthCall = mocks.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO data_source_health'));
    expect(healthCall?.[1]?.[1]).toBeNull();
  });

  it('records the observation when the match is not machine-owned auto', async () => {
    mockLowScoreDirectPinHit();
    mocks.demoteAutoProductMatchToCandidate.mockResolvedValueOnce(false);

    await scrapeRetailer('retailer-a');

    expect(mocks.demoteAutoProductMatchToCandidate).toHaveBeenCalledOnce();
    expect(mocks.insertObservation).toHaveBeenCalledOnce();
  });

  it('records a high-score direct pin without attempting demotion', async () => {
    mocks.discoverTargets.mockResolvedValueOnce([directPinTarget]);
    mocks.fetchTarget.mockResolvedValueOnce({});
    mocks.parseListing.mockResolvedValueOnce([{
      ...lowScoreProduct,
      rawPayload: { direct: true, validator: highScoreValidator },
    }]);

    await scrapeRetailer('retailer-a');

    expect(mocks.demoteAutoProductMatchToCandidate).not.toHaveBeenCalled();
    expect(mocks.insertObservation).toHaveBeenCalledOnce();
  });
});

describe('scrapeRetailer discovery admission', () => {
  function mockDiscovery(validator = lowScoreValidator) {
    mocks.discoverTargets.mockResolvedValueOnce([target]);
    mocks.fetchTarget.mockResolvedValueOnce({});
    mocks.parseListing.mockResolvedValueOnce([{
      ...lowScoreProduct,
      rawPayload: {
        direct: false,
        basketSlug: 'essentials-ae',
        canonicalName: 'White Bread',
        validator,
      },
    }]);
  }

  it('persists a candidate match before recording its observation', async () => {
    mockDiscovery();

    await scrapeRetailer('retailer-a');

    expect(mocks.upsertProductMatch).toHaveBeenCalledWith(
      {
        retailerProductId: 'product-1',
        canonicalProductId: 'canonical-1',
        basketItemId: 'basket-item-1',
        matchScore: 0.7,
        matchStatus: 'candidate',
        evidence: { validator: { reasons: [], signals: lowScoreValidator.signals } },
      },
      mocks.transactionExecute,
    );
    expect(mocks.insertObservation).toHaveBeenCalledWith(expect.any(Object), mocks.transactionExecute);
    expect(mocks.upsertProductMatch.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.insertObservation.mock.invocationCallOrder[0]);
  });

  it('does not record an observation when candidate admission cannot be persisted', async () => {
    mockDiscovery();
    mocks.upsertProductMatch.mockRejectedValueOnce(new Error('match update failed'));

    await scrapeRetailer('retailer-a');

    expect(mocks.insertObservation).not.toHaveBeenCalled();
    const updateCall = mocks.query.mock.calls.find(([sql]) => String(sql).includes('failure_reasons=$7'));
    expect(updateCall?.[1]).toEqual([
      'retailer-run-1',
      'failed',
      1,
      0,
      1,
      0,
      JSON.stringify({ 'match-admission-persist-failed': 1 }),
    ]);
  });

  it('persists an auto match and observation in one transaction', async () => {
    mockDiscovery(highScoreValidator);

    await scrapeRetailer('retailer-a');

    expect(mocks.withTransaction).toHaveBeenCalledOnce();
    expect(mocks.upsertProductMatch).toHaveBeenCalledWith(
      expect.objectContaining({ matchScore: 0.95, matchStatus: 'auto' }),
      mocks.transactionExecute,
    );
    expect(mocks.insertObservation).toHaveBeenCalledWith(expect.any(Object), mocks.transactionExecute);
    expect(mocks.upsertProductMatch.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.insertObservation.mock.invocationCallOrder[0]);
  });

  it('fails the matched-observation transaction when its observation write fails', async () => {
    mockDiscovery(highScoreValidator);
    mocks.insertObservation.mockRejectedValueOnce(new Error('observation write failed'));

    await scrapeRetailer('retailer-a');

    expect(mocks.withTransaction).toHaveBeenCalledOnce();
    expect(mocks.upsertProductMatch).toHaveBeenCalledOnce();
    const updateCall = mocks.query.mock.calls.find(([sql]) => String(sql).includes('failure_reasons=$7'));
    expect(updateCall?.[1]?.[1]).toBe('failed');
  });
});
