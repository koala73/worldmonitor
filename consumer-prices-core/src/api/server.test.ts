import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockHealthQuery = vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] });
const mockBuildOverviewSnapshot = vi.fn().mockResolvedValue({ marketCode: 'ae', coveragePct: 100 });

vi.mock('../db/client.js', () => ({
  getPool: () => ({ query: mockHealthQuery }),
}));

vi.mock('../snapshots/worldmonitor.js', () => ({
  buildBasketSeriesSnapshot: vi.fn(),
  buildCategoriesSnapshot: vi.fn(),
  buildFreshnessSnapshot: vi.fn(),
  buildMoversSnapshot: vi.fn(),
  buildOverviewSnapshot: mockBuildOverviewSnapshot,
  buildRetailerSpreadSnapshot: vi.fn(),
}));

const { createServer, isHealthCheckPath } = await import('./server.js');

beforeEach(() => {
  mockBuildOverviewSnapshot.mockClear();
  mockHealthQuery.mockClear();
});

describe('consumer-prices-core Fastify server', () => {
  it('fails closed when the snapshot API key is missing', () => {
    const original = process.env.WORLDMONITOR_SNAPSHOT_API_KEY;
    delete process.env.WORLDMONITOR_SNAPSHOT_API_KEY;

    try {
      expect(() => createServer({ logger: false })).toThrow(/WORLDMONITOR_SNAPSHOT_API_KEY is required/);
      expect(() => createServer({ apiKey: '', logger: false })).toThrow(/WORLDMONITOR_SNAPSHOT_API_KEY is required/);
      expect(() => createServer({ apiKey: '   ', logger: false })).toThrow(/WORLDMONITOR_SNAPSHOT_API_KEY is required/);
    } finally {
      if (original === undefined) delete process.env.WORLDMONITOR_SNAPSHOT_API_KEY;
      else process.env.WORLDMONITOR_SNAPSHOT_API_KEY = original;
    }
  });

  it('recognizes the health check path before auth enforcement', () => {
    expect(isHealthCheckPath('/health')).toBe(true);
    expect(isHealthCheckPath('/health?ready=1')).toBe(true);
    expect(isHealthCheckPath('/wm/consumer-prices/v1/overview')).toBe(false);
  });

  it('allows health checks without an API key header', async () => {
    const server = createServer({ apiKey: 'secret', logger: false });

    try {
      const response = await server.inject({ method: 'GET', url: '/health' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'ok', checks: { postgres: 'ok' } });
    } finally {
      await server.close();
    }
  });

  it('allows snapshot routes with the matching API key', async () => {
    const server = createServer({ apiKey: 'secret', logger: false });

    try {
      const response = await server.inject({
        method: 'GET',
        url: '/wm/consumer-prices/v1/overview?market=ae',
        headers: { 'x-api-key': 'secret' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ marketCode: 'ae', coveragePct: 100 });
      expect(mockBuildOverviewSnapshot).toHaveBeenCalledWith('ae');
    } finally {
      await server.close();
    }
  });

  it('rejects snapshot routes before handlers run when the API key is absent or wrong', async () => {
    const server = createServer({ apiKey: 'secret', logger: false });

    try {
      const missing = await server.inject({ method: 'GET', url: '/wm/consumer-prices/v1/overview' });
      expect(missing.statusCode).toBe(401);
      expect(missing.json()).toEqual({ error: 'unauthorized' });

      const wrong = await server.inject({
        method: 'GET',
        url: '/wm/consumer-prices/v1/overview',
        headers: { 'x-api-key': 'wrong' },
      });
      expect(wrong.statusCode).toBe(401);
      expect(wrong.json()).toEqual({ error: 'unauthorized' });
      expect(mockBuildOverviewSnapshot).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
