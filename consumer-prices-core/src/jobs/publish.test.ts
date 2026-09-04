import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockBuildCoverageSnapshot = vi.fn();
const mockBuildFreshnessSnapshot = vi.fn();
const mockBuildOverviewSnapshot = vi.fn();
const mockBuildMoversSnapshot = vi.fn();
const mockBuildCategoriesSnapshot = vi.fn();
const mockFetch = vi.fn();

vi.mock('../config/loader.js', () => ({
  loadAllRetailerConfigs: () => [{ slug: 'retailer-a', marketCode: 'ae', enabled: true }],
  loadAllBasketConfigs: () => [],
}));
vi.mock('../db/client.js', () => ({ closePool: vi.fn() }));
vi.mock('../snapshots/coverage.js', () => ({ buildCoverageSnapshot: mockBuildCoverageSnapshot }));
vi.mock('../snapshots/worldmonitor.js', () => ({
  buildFreshnessSnapshot: mockBuildFreshnessSnapshot,
  buildOverviewSnapshot: mockBuildOverviewSnapshot,
  buildMoversSnapshot: mockBuildMoversSnapshot,
  buildCategoriesSnapshot: mockBuildCategoriesSnapshot,
  buildBasketSeriesSnapshot: vi.fn(),
  buildRetailerSpreadSnapshot: vi.fn(),
}));

const { publishAll, runPublishCli } = await import('./publish.js');

const coverage = {
  marketCode: 'ae',
  asOf: '2026-08-01T00:00:00.000Z',
  attemptedPages: 12,
  completedPages: 8,
  failedPages: 4,
  completionRatio: 0.6667,
  rejectedCount: 3,
  failureReasons: { 'missing-price': 2, 'provider-error': 1 },
  status: 'partial',
  minimumCompletionRatio: 0.5,
  retailers: [{ slug: 'retailer-a', name: 'Retailer A', coverageStatus: 'partial', rejectedCount: 3 }],
  upstreamUnavailable: false,
};

function commands() {
  return mockFetch.mock.calls.map(([, init]) => JSON.parse(init.body as string));
}

beforeEach(() => {
  mockFetch.mockReset().mockResolvedValue({ ok: true, status: 200 });
  mockBuildCoverageSnapshot.mockReset().mockResolvedValue(coverage);
  mockBuildFreshnessSnapshot.mockReset().mockResolvedValue({ marketCode: 'ae', retailers: [{ freshnessMin: 10 }] });
  mockBuildOverviewSnapshot.mockReset().mockResolvedValue({ marketCode: 'ae' });
  mockBuildMoversSnapshot.mockReset().mockResolvedValue({ risers: [], fallers: [] });
  mockBuildCategoriesSnapshot.mockReset().mockResolvedValue({ categories: [] });
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.test');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'token');
  globalThis.fetch = mockFetch as typeof fetch;
});

describe('consumer-price coverage publication', () => {
  it('publishes coverage and carries market/rejection/retailer diagnostics into seed meta', async () => {
    await publishAll();

    const writes = commands();
    const coveragePayload = writes.find((command) => command[0] === 'SET' && command[1] === 'consumer-prices:coverage:ae');
    const coverageMeta = writes.find((command) => command[0] === 'SET' && command[1] === 'seed-meta:consumer-prices:coverage:ae');
    expect(coveragePayload).toBeDefined();
    expect(coverageMeta).toBeDefined();
    expect(JSON.parse(coveragePayload[2]).data.status).toBe('partial');
    expect(JSON.parse(coverageMeta[2]).coverage).toMatchObject({
      status: 'partial',
      completedPages: 8,
      failedPages: 4,
      completionRatio: 0.6667,
      rejectedCount: 3,
      failureReasons: { 'missing-price': 2, 'provider-error': 1 },
    });
    expect(JSON.parse(coverageMeta[2]).coverage.retailers).toEqual(coverage.retailers);
  });

  it('keeps the last-good coverage key untouched when coverage rebuild fails, then recovers on the next run', async () => {
    mockBuildCoverageSnapshot.mockRejectedValueOnce(new Error('coverage query unavailable'));
    await expect(publishAll()).rejects.toThrow('1 snapshot publication failed');

    let writes = commands();
    expect(writes.some((command) => command[0] === 'DEL' && command[1] === 'consumer-prices:coverage:ae')).toBe(false);
    expect(writes.some((command) => command[0] === 'SET' && command[1] === 'consumer-prices:overview:ae')).toBe(true);
    expect(writes.some((command) => command[0] === 'SET' && command[1] === 'consumer-prices:coverage:ae')).toBe(false);

    mockFetch.mockClear();
    await publishAll();
    writes = commands();
    expect(writes.some((command) => command[0] === 'SET' && command[1] === 'consumer-prices:coverage:ae')).toBe(true);
  });

  it('fails the CLI after a caught snapshot write error without printing its success marker', async () => {
    mockFetch.mockRejectedValueOnce(new Error('redis unavailable'));
    const previousExitCode = process.exitCode;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.exitCode = undefined;

    try {
      await expect(runPublishCli()).rejects.toThrow('1 snapshot publication failed');
      expect(process.exitCode).toBe(1);
      expect(log.mock.calls.some(([message]) => String(message).includes('=== Done'))).toBe(false);
      expect(error).toHaveBeenCalled();
    } finally {
      process.exitCode = previousExitCode;
      log.mockRestore();
      error.mockRestore();
    }
  });
});
