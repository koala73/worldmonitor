import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { dataFreshness } from '../src/services/data-freshness.ts';
import { refreshDataFreshnessFromHealth } from '../src/services/health-freshness.ts';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

describe('health freshness ingestion', () => {
  it('hydrates dataFreshness from /api/health cadence metadata', async () => {
    const checkedAtMs = Date.now();
    const applied = await refreshDataFreshnessFromHealth({
      endpoint: '/api/health',
      urlResolver: (path) => path,
      fetchFn: async () => jsonResponse({
        checkedAt: new Date(checkedAtMs).toISOString(),
        checks: {
          gdeltIntel: {
            status: 'OK',
            records: 14,
            seedAgeMin: 30,
            maxStaleMin: 420,
          },
          weatherAlerts: {
            status: 'STALE_SEED',
            records: 2,
            seedAgeMin: 60,
            maxStaleMin: 45,
          },
          cyberThreats: {
            status: 'SEED_ERROR',
            records: 0,
            maxStaleMin: 240,
          },
        },
      }),
    });

    assert.equal(applied, 3);

    const gdelt = dataFreshness.getSource('gdelt');
    assert.equal(gdelt?.status, 'fresh');
    assert.equal(gdelt?.itemCount, 14);
    assert.equal(gdelt?.maxStaleMin, 420);
    assert.equal(gdelt?.lastUpdate?.toISOString(), new Date(checkedAtMs - 30 * 60_000).toISOString());

    const weather = dataFreshness.getSource('weather');
    assert.equal(weather?.status, 'stale');
    assert.equal(weather?.healthStatus, 'STALE_SEED');

    const cyber = dataFreshness.getSource('cyber_threats');
    assert.equal(cyber?.status, 'error');
    assert.equal(cyber?.lastError, 'SEED_ERROR');
  });
});
