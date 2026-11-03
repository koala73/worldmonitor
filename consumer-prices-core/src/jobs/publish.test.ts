import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

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
  failureReasons: { 'missing-price': 2, 'provider-error': 1, 'source-http-error': 1 },
  status: 'partial',
  minimumCompletionRatio: 0.5,
  retailers: [{ slug: 'retailer-a', name: 'Retailer A', coverageStatus: 'partial', rejectedCount: 3 }],
  upstreamUnavailable: false,
};

function commands() {
  // Project the actual atomic write into the two persisted values checked below.
  return mockFetch.mock.calls.flatMap(([, init]) => {
    const command = JSON.parse(init.body as string);
    if (command[0] === 'GET') return [];
    if (command[0] !== 'EVAL') return [command];
    return [['SET', command[3], command[5]], ['SET', command[4], command[7]]];
  });
}

beforeEach(() => {
  mockFetch.mockReset().mockResolvedValue({ ok: true, status: 200, json: async () => ({ result: 1 }) });
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
      failureReasons: { 'missing-price': 2, 'provider-error': 1, 'source-http-error': 1 },
    });
    expect(JSON.parse(coverageMeta[2]).coverage.retailers).toEqual(coverage.retailers);
  });

  it('pairs a recovered category count with retained metadata when scraper freshness is over budget', async () => {
    const retained = { fetchedAt: 1793244912466, recordCount: 0, coverage: { status: 'partial', retailers: [] } };
    mockBuildFreshnessSnapshot.mockResolvedValue({ retailers: [{ freshnessMin: 200 }] });
    mockBuildCategoriesSnapshot.mockResolvedValue({ categories: [{ slug: 'bread' }] });
    mockFetch.mockImplementation(async (_url, init) => {
      const command = JSON.parse(init.body);
      return Response.json({ result: command[0] === 'GET' ? JSON.stringify(retained) : 1 });
    });

    await publishAll();

    const writes = commands();
    for (const range of ['7d', '30d', '90d']) {
      const key = `consumer-prices:categories:ae:${range}`;
      const payload = writes.find((command) => command[1] === key);
      const meta = writes.find((command) => command[1] === `seed-meta:${key}`);
      expect(JSON.parse(payload[2]).data.categories).toHaveLength(1);
      expect(JSON.parse(meta[2])).toEqual({ ...retained, recordCount: 1 });
    }
  });

  it('publishes each mover range with its own payload and seed metadata', async () => {
    mockBuildMoversSnapshot.mockImplementation(async (marketCode, days) => ({
      marketCode, range: `${days}d`, risers: [{ productId: `up-${days}` }], fallers: [],
    }));
    await publishAll();
    const writes = commands();
    for (const days of [7, 30, 90]) {
      const payload = writes.find((command) => command[1] === `consumer-prices:movers:ae:${days}d`);
      expect(JSON.parse(payload[2]).data).toMatchObject({ range: `${days}d`, risers: [{ productId: `up-${days}` }] });
      const meta = writes.find((command) => command[1] === `seed-meta:consumer-prices:movers:ae:${days}d`);
      expect(JSON.parse(meta[2]).recordCount).toBe(1);
    }
  });

  it('skips the movers write without failing the run when every candidate is gated', async () => {
    // seed-consumer-prices-publish, 2026-09-04: market `in` returned one 30d
    // candidate, it was gated, and the throw exited the whole cron 1 while
    // every other market published fine. A null snapshot is a data-quality
    // skip, so the run stays green AND the last-good key is never overwritten
    // -- publishing zero movers would stamp the envelope OK via recordCount's
    // floor of 1 and read as a fresh, quiet market.
    mockBuildMoversSnapshot.mockReset().mockResolvedValue(null);

    await expect(publishAll()).resolves.toBeUndefined();

    const writes = commands();
    const moversWrite = writes.some(
      (command) => command[0] === 'SET' && String(command[1]).startsWith('consumer-prices:movers:'),
    );
    const moversMeta = writes.some(
      (command) => command[0] === 'SET' && String(command[1]).startsWith('seed-meta:consumer-prices:movers:'),
    );
    expect(moversWrite).toBe(false);
    expect(moversMeta).toBe(false);
    // the rest of the market still publishes
    expect(writes.some((command) => command[0] === 'SET' && command[1] === 'consumer-prices:overview:ae')).toBe(true);
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

const redisCli = process.env.REDIS_CLI_BIN || 'redis-cli';
const redisServer = process.env.REDIS_SERVER_BIN || 'redis-server';
const hasRedis = spawnSync(redisCli, ['--version']).status === 0 && spawnSync(redisServer, ['--version']).status === 0;

it.skipIf(!hasRedis && !process.env.CI)('reconciles recovered and empty category counts without renewing retained clocks or expiry (real Redis)', async () => {
  expect(hasRedis, 'CI requires redis-server and redis-cli for publisher expiry/concurrency proof').toBe(true);
  const dir = mkdtempSync('/tmp/consumer-publish-');
  const socket = join(dir, 'redis.sock');
  const started = spawnSync(redisServer, ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no',
    '--daemonize', 'yes', '--pidfile', join(dir, 'pid'), '--logfile', join(dir, 'log')], { encoding: 'utf8' });
  expect(started.status, started.stderr).toBe(0);
  const command = (...args: unknown[]) => JSON.parse(execFileSync(redisCli,
    ['-s', socket, '--json', ...args.map(String)], { encoding: 'utf8' }));
  const key = 'consumer-prices:categories:ae:30d';
  const metaKey = `seed-meta:${key}`;
  try {
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      try { ready = command('PING') === 'PONG'; } catch { /* socket not ready */ }
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(ready).toBe(true);
    mockFetch.mockImplementation(async (_url, init) => Response.json({ result: command(...JSON.parse(init.body)) }));
    await publishAll(); // Fresh scraper, failed aggregate: a real empty snapshot.
    expect(JSON.parse(command('GET', metaKey)).recordCount).toBe(0);

    const retained = { fetchedAt: 1793244912466, recordCount: 0,
      coverage: { status: 'partial', failedPages: 1, retailers: [], failureReasons: { 'source-http-error': 1 } } };
    command('SET', metaKey, JSON.stringify(retained), 'EX', 300);
    const expiry = command('PEXPIRETIME', metaKey);
    mockBuildFreshnessSnapshot.mockResolvedValue({ marketCode: 'ae', retailers: [{ freshnessMin: 200 }] });
    mockBuildCategoriesSnapshot.mockResolvedValue({ marketCode: 'ae', categories: [{ slug: 'bread' }] });
    await publishAll(); // Later aggregate recovers after the freshness gate closes.
    const recovered = JSON.parse(command('GET', metaKey));
    expect(JSON.parse(command('GET', key)).data.categories).toHaveLength(1);
    expect(recovered).toEqual({ ...retained, recordCount: 1 });
    expect(command('PEXPIRETIME', metaKey)).toBe(expiry);

    mockBuildCategoriesSnapshot.mockResolvedValue({ categories: [] });
    await publishAll(); // A later empty replacement must not retain a positive count either.
    expect(JSON.parse(command('GET', metaKey))).toEqual(retained);
    expect(command('PEXPIRETIME', metaKey)).toBe(expiry);

    command('DEL', metaKey);
    await publishAll();
    expect(command('GET', metaKey)).toBeNull(); // No invented clock on a first stale publication.
    command('SET', metaKey, 'invalid-json', 'EX', 60);
    await publishAll();
    expect(command('GET', metaKey)).toBe('invalid-json');

    // Another publisher wins between GET and EVAL. The losing writer must not
    // replace either half or revive the older clock.
    const winner = { fetchedAt: 1793251925853, recordCount: 2 };
    command('SET', metaKey, JSON.stringify(retained), 'EX', 300);
    let replaced = false;
    mockFetch.mockImplementation(async (_url, init) => {
      const args = JSON.parse(init.body);
      const result = command(...args);
      if (!replaced && args[0] === 'GET' && args[1] === metaKey) {
        replaced = true;
        command('SET', key, JSON.stringify({ data: { categories: [{ slug: 'winner' }, { slug: 'other' }] } }));
        command('SET', metaKey, JSON.stringify(winner), 'EX', 100);
      }
      return Response.json({ result });
    });
    await expect(publishAll()).rejects.toThrow('1 snapshot publication failed');
    expect(JSON.parse(command('GET', metaKey))).toEqual(winner);
    expect(JSON.parse(command('GET', key)).data.categories).toHaveLength(2);
  } finally {
    try { command('SHUTDOWN', 'NOSAVE'); } catch { /* shutdown closes the socket */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

it('fails publication on an HTTP 200 Redis command error', async () => {
  mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ error: 'ERR command failed' }) });
  await expect(publishAll()).rejects.toThrow('1 snapshot publication failed');
});
