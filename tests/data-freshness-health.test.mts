import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { dataFreshness } from '../src/services/data-freshness.ts';
import {
  HEALTH_CHECK_SOURCE_MAP,
  refreshDataFreshnessFromHealth,
} from '../src/services/health-freshness.ts';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

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

  it('keeps the frontend mapping pinned to registered api/health checks', () => {
    const healthSrc = readFileSync(resolve(repoRoot, 'api/health.js'), 'utf8');

    for (const checkName of Object.keys(HEALTH_CHECK_SOURCE_MAP)) {
      assert.match(
        healthSrc,
        new RegExp(`\\b${checkName}:\\s*(?:\\{|['"\`])`),
        `HEALTH_CHECK_SOURCE_MAP references ${checkName}, but api/health.js does not register that check`,
      );
    }
  });

  it('uses the worst health status when several checks map to one frontend source', async () => {
    const checkedAtMs = Date.now();
    const applied = await refreshDataFreshnessFromHealth({
      endpoint: '/api/health',
      urlResolver: (path) => path,
      fetchFn: async () => jsonResponse({
        checkedAt: new Date(checkedAtMs).toISOString(),
        checks: {
          climateAnomalies: {
            status: 'OK',
            records: 25,
            seedAgeMin: 10,
            maxStaleMin: 540,
          },
          climateDisasters: {
            status: 'STALE_SEED',
            records: 4,
            seedAgeMin: 900,
            maxStaleMin: 720,
          },
          climateAirQuality: {
            status: 'OK',
            records: 8,
            seedAgeMin: 20,
            maxStaleMin: 180,
          },
        },
      }),
    });

    assert.equal(applied, 1);

    const climate = dataFreshness.getSource('climate');
    assert.equal(climate?.status, 'stale');
    assert.equal(climate?.healthStatus, 'STALE_SEED');
    assert.equal(climate?.itemCount, 4);
  });

  it('treats redis outages as higher severity than ok checks', async () => {
    const checkedAtMs = Date.now();
    const applied = await refreshDataFreshnessFromHealth({
      endpoint: '/api/health',
      urlResolver: (path) => path,
      fetchFn: async () => jsonResponse({
        checkedAt: new Date(checkedAtMs).toISOString(),
        checks: {
          bisPolicy: {
            status: 'OK',
            records: 12,
            seedAgeMin: 0,
            maxStaleMin: 360,
          },
          bisDsr: {
            status: 'REDIS_DOWN',
            records: 0,
            seedAgeMin: 5,
            maxStaleMin: 360,
          },
        },
      }),
    });

    assert.equal(applied, 1);

    const bis = dataFreshness.getSource('bis');
    assert.equal(bis?.status, 'error');
    assert.equal(bis?.healthStatus, 'REDIS_DOWN');
    assert.equal(bis?.lastError, 'REDIS_DOWN');
  });
});
