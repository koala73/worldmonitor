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

const { publishAll } = await import('./publish.js');

const coverage = {
  marketCode: 'ae',
  asOf: '2026-08-01T00:00:00.000Z',
  attemptedPages: 12,
  completedPages: 8,
  failedPages: 4,
  completionRatio: 0.6667,
  rejectedCount: 3,
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
    });
    expect(JSON.parse(coverageMeta[2]).coverage.retailers).toEqual(coverage.retailers);
  });

  it('keeps the last-good coverage key untouched when coverage rebuild fails, then recovers on the next run', async () => {
    mockBuildCoverageSnapshot.mockRejectedValueOnce(new Error('coverage query unavailable'));
    await publishAll();

    let writes = commands();
    expect(writes.some((command) => command[0] === 'DEL' && command[1] === 'consumer-prices:coverage:ae')).toBe(false);
    expect(writes.some((command) => command[0] === 'SET' && command[1] === 'consumer-prices:overview:ae')).toBe(true);
    expect(writes.some((command) => command[0] === 'SET' && command[1] === 'consumer-prices:coverage:ae')).toBe(false);

    mockFetch.mockClear();
    await publishAll();
    writes = commands();
    expect(writes.some((command) => command[0] === 'SET' && command[1] === 'consumer-prices:coverage:ae')).toBe(true);
  });
});

// #6059 — WorldMonitor health softens the deploy-before-cron gap to a bounded
// ROLLOUT_PENDING warn and revokes that softening permanently the instant this
// marker appears. Writing it too eagerly re-arms the false critical; writing it
// with a TTL lets an activated market read as pending-activation again.
describe('coverage schema activation marker', () => {
  const ACTIVATION_KEY = 'seed-activated:consumer-prices:coverage:v1:ae';
  const activationWrites = () =>
    commands().filter((command) => command[0] === 'SET' && command[1] === ACTIVATION_KEY);

  it('SETs a durable versioned marker after publishing real coverage', async () => {
    await publishAll();

    const writes = activationWrites();
    expect(writes).toHaveLength(1);
    const [, , value, ...rest] = writes[0];
    expect(rest).toEqual([]); // no EX — must outlive the 7d seed-meta TTL
    expect(JSON.parse(value)).toMatchObject({
      schemaVersion: 1,
      marketCode: 'ae',
      attemptedPages: 12,
    });
  });

  it('orders the marker after the coverage snapshot it attests to', async () => {
    await publishAll();

    const sequence = commands().map((command) => command[1]);
    expect(sequence.indexOf(ACTIVATION_KEY)).toBeGreaterThan(
      sequence.indexOf('consumer-prices:coverage:ae'),
    );
  });

  it('withholds the marker when the market has never attempted a page', async () => {
    mockBuildCoverageSnapshot.mockResolvedValue({ ...coverage, attemptedPages: 0, completedPages: 0, completionRatio: null });
    await publishAll();

    expect(activationWrites()).toHaveLength(0);
    expect(commands().some((command) => command[1] === 'consumer-prices:coverage:ae')).toBe(true);
  });

  it('withholds the marker when the coverage snapshot could not be built', async () => {
    mockBuildCoverageSnapshot.mockRejectedValueOnce(new Error('coverage query unavailable'));
    await publishAll();

    expect(activationWrites()).toHaveLength(0);
  });

  it('attributes a marker-write failure to the marker, not to the coverage publish', async () => {
    // `publishAll() resolves` and `overview still published` are NOT evidence for
    // the inner try/catch: overview publishes from its own independent try, and
    // without the inner catch the error is simply swallowed by the enclosing
    // coverage catch, so publishAll() resolves either way. Verified by deleting
    // the inner catch — every assertion of that shape stayed green. The only
    // observable the inner catch actually produces is WHICH failure gets logged:
    // with it, `coverage-activation:ae failed`; without it, the coverage snapshot
    // is falsely blamed via `coverage:ae failed` and pagesFailed is incremented
    // for a coverage write that in fact succeeded.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch.mockImplementation(async (_url: string, init: { body: string }) => {
      const command = JSON.parse(init.body);
      if (command[1] === ACTIVATION_KEY) return { ok: false, status: 500 };
      return { ok: true, status: 200 };
    });

    await expect(publishAll()).resolves.toBeUndefined();

    const logged = errSpy.mock.calls.map((call) => call.join(' '));
    expect(logged.some((line) => line.includes('coverage-activation:ae failed'))).toBe(true);
    expect(
      logged.some((line) => /coverage:ae failed/.test(line)),
      'the coverage snapshot published fine — blaming it would send an operator to the wrong subsystem',
    ).toBe(false);
    expect(commands().some((command) => command[1] === 'consumer-prices:overview:ae')).toBe(true);
    errSpy.mockRestore();
  });

  it('withholds the marker when the coverage snapshot itself fails to persist', async () => {
    // Distinct from the build-failure case above: here buildCoverageSnapshot
    // succeeds but the Redis SET of the coverage key throws. The marker must not
    // claim activation for a snapshot that never landed.
    mockFetch.mockImplementation(async (_url: string, init: { body: string }) => {
      const command = JSON.parse(init.body);
      if (command[1] === 'consumer-prices:coverage:ae') return { ok: false, status: 500 };
      return { ok: true, status: 200 };
    });

    await publishAll();

    expect(activationWrites()).toHaveLength(0);
  });
});
