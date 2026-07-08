import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { dataFreshness } from '../src/services/data-freshness.ts';
import {
  __resetHealthFreshnessForTests,
  HEALTH_CHECK_SOURCE_MAP,
  refreshDataFreshnessFromHealth,
} from '../src/services/health-freshness.ts';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
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

  it('marks mapped sources unhealthy when /api/health reports top-level redis outage without checks', async () => {
    const mappedSources = new Set(Object.values(HEALTH_CHECK_SOURCE_MAP).flat());
    const checkedAtMs = Date.now();
    const applied = await refreshDataFreshnessFromHealth({
      endpoint: '/api/health',
      urlResolver: (path) => path,
      // REDIS_DOWN returns HTTP 503 (api/health.js). The consumer must parse the
      // body before bailing on !resp.ok, or this outage branch never runs and
      // mapped sources keep stale freshness. Mocking 503 (not 200) makes this a
      // real guard for that regression.
      fetchFn: async () => jsonResponse({
        status: 'REDIS_DOWN',
        checkedAt: new Date(checkedAtMs).toISOString(),
      }, 503),
    });

    assert.equal(applied, mappedSources.size);
    assert.ok(applied > 10);

    for (const sourceId of ['gdelt', 'weather', 'bis'] as const) {
      const source = dataFreshness.getSource(sourceId);
      assert.equal(source?.status, 'error');
      assert.equal(source?.healthStatus, 'REDIS_DOWN');
      assert.equal(source?.lastError, 'REDIS_DOWN');
      assert.equal(source?.itemCount, 0);
    }
  });

  it('does not classify partial coverage as fresh even when recently seeded', async () => {
    const checkedAtMs = Date.now();
    const applied = await refreshDataFreshnessFromHealth({
      endpoint: '/api/health',
      urlResolver: (path) => path,
      fetchFn: async () => jsonResponse({
        checkedAt: new Date(checkedAtMs).toISOString(),
        checks: {
          gdeltIntel: {
            status: 'COVERAGE_PARTIAL',
            records: 12,
            seedAgeMin: 1,
            maxStaleMin: 420,
          },
        },
      }),
    });

    assert.equal(applied, 1);

    const gdelt = dataFreshness.getSource('gdelt');
    assert.equal(gdelt?.status, 'stale');
    assert.equal(gdelt?.healthStatus, 'COVERAGE_PARTIAL');
    assert.equal(gdelt?.lastError, null);
  });

  it('does not classify stale seeds as fresh even when recently seeded', async () => {
    const checkedAtMs = Date.now();
    const applied = await refreshDataFreshnessFromHealth({
      endpoint: '/api/health',
      urlResolver: (path) => path,
      fetchFn: async () => jsonResponse({
        checkedAt: new Date(checkedAtMs).toISOString(),
        checks: {
          gdeltIntel: {
            status: 'STALE_SEED',
            records: 12,
            seedAgeMin: 1,
            maxStaleMin: 420,
          },
        },
      }),
    });

    assert.equal(applied, 1);

    const gdelt = dataFreshness.getSource('gdelt');
    assert.equal(gdelt?.status, 'stale');
    assert.equal(gdelt?.healthStatus, 'STALE_SEED');
    assert.equal(gdelt?.lastError, null);
  });

  it('uses stale content age instead of seed age for STALE_CONTENT checks', async () => {
    const checkedAtMs = Date.now();
    const applied = await refreshDataFreshnessFromHealth({
      endpoint: '/api/health',
      urlResolver: (path) => path,
      fetchFn: async () => jsonResponse({
        checkedAt: new Date(checkedAtMs).toISOString(),
        checks: {
          blsSeries: {
            status: 'STALE_CONTENT',
            records: 9,
            seedAgeMin: 1,
            maxStaleMin: 360,
            contentAgeMin: 90,
            maxContentAgeMin: 60,
          },
        },
      }),
    });

    assert.equal(applied, 1);

    const bls = dataFreshness.getSource('bls');
    assert.equal(bls?.status, 'stale');
    assert.notEqual(bls?.status, 'fresh');
    assert.equal(bls?.healthStatus, 'STALE_CONTENT');
    assert.equal(bls?.lastError, null);
    assert.equal(bls?.maxStaleMin, 60);
    assert.equal(bls?.lastUpdate?.toISOString(), new Date(checkedAtMs - 90 * 60_000).toISOString());
  });

  // Detailed /api/health was operator-key-gated by #4715; the anonymous
  // dashboard must read the keyless compact variant or every visitor 401s
  // once a minute and the seed-health pipeline goes silently dead (#4902).
  it('defaults to the keyless compact endpoint', async () => {
    __resetHealthFreshnessForTests();
    const seenUrls: string[] = [];
    await refreshDataFreshnessFromHealth({
      urlResolver: (path) => path,
      fetchFn: async (url) => {
        seenUrls.push(String(url));
        return jsonResponse({ status: 'HEALTHY', checkedAt: new Date().toISOString() });
      },
    });
    assert.deepEqual(seenUrls, ['/api/health?compact=1']);
  });

  // Cloudflare's zone Browser-Cache-TTL override rewrites the origin's
  // max-age=0 to 30min on this path (#4910). A browser-cached body older than
  // the 15-min FRESH_THRESHOLD would flip every synthesized-OK source to
  // stale in oscillating waves, so the poller must revalidate every tick —
  // the CDN's 60s edge cache still absorbs the origin cost.
  it('forces browser revalidation on every poll (cache: no-cache)', async () => {
    __resetHealthFreshnessForTests();
    let seenInit: RequestInit | undefined;
    await refreshDataFreshnessFromHealth({
      urlResolver: (path) => path,
      fetchFn: async (_url, init) => {
        seenInit = init;
        return jsonResponse({ status: 'HEALTHY', checkedAt: new Date().toISOString() });
      },
    });
    assert.equal(seenInit?.cache, 'no-cache');
  });

  it('hydrates from a compact payload: problems degrade, absent mapped checks read healthy', async () => {
    __resetHealthFreshnessForTests();
    const mappedSources = new Set(Object.values(HEALTH_CHECK_SOURCE_MAP).flat());
    const checkedAtMs = Date.now();
    const applied = await refreshDataFreshnessFromHealth({
      urlResolver: (path) => path,
      fetchFn: async () => jsonResponse({
        status: 'DEGRADED',
        summary: { total: 196, ok: 195, warn: 0, onDemandWarn: 0, staleContent: 0, crit: 1 },
        checkedAt: new Date(checkedAtMs).toISOString(),
        problems: {
          gdeltIntel: { status: 'STALE_SEED', records: 6, seedAgeMin: 900, maxStaleMin: 720 },
        },
      }),
    });

    // Every mapped source gets an update: the problem entry for gdelt, a
    // synthesized server-vouched OK for the rest.
    assert.equal(applied, mappedSources.size);

    const gdelt = dataFreshness.getSource('gdelt');
    assert.equal(gdelt?.status, 'stale');
    assert.equal(gdelt?.healthStatus, 'STALE_SEED');
    assert.equal(gdelt?.itemCount, 6);

    // weather maps from weatherAlerts, which is absent from `problems` — the
    // server evaluated it and found it within budget. It must read fresh as of
    // checkedAt, NOT no_data (a bare OK with no age would leave lastUpdate
    // null and calculateStatus reports no_data).
    const weather = dataFreshness.getSource('weather');
    assert.equal(weather?.status, 'fresh');
    assert.equal(weather?.healthStatus, 'OK');
    assert.equal(weather?.lastUpdate?.toISOString(), new Date(checkedAtMs).toISOString());
  });

  it('marks all mapped sources healthy on a compact payload with no problems key', async () => {
    __resetHealthFreshnessForTests();
    const mappedSources = new Set(Object.values(HEALTH_CHECK_SOURCE_MAP).flat());
    const checkedAtMs = Date.now();
    const applied = await refreshDataFreshnessFromHealth({
      urlResolver: (path) => path,
      fetchFn: async () => jsonResponse({
        status: 'HEALTHY',
        summary: { total: 196, ok: 196, warn: 0, onDemandWarn: 0, staleContent: 0, crit: 0 },
        checkedAt: new Date(checkedAtMs).toISOString(),
      }),
    });

    assert.equal(applied, mappedSources.size);

    // cyber_threats carried SEED_ERROR from an earlier ingest above — a
    // healthy compact snapshot must clear it.
    const cyber = dataFreshness.getSource('cyber_threats');
    assert.equal(cyber?.status, 'fresh');
    assert.equal(cyber?.healthStatus, 'OK');
    assert.equal(cyber?.lastError, null);
  });

  it('suppresses refetch for a window after an auth-gated 401 instead of erroring every tick', async () => {
    __resetHealthFreshnessForTests();
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      return jsonResponse({ error: 'API key required' }, 401);
    };

    await assert.rejects(
      refreshDataFreshnessFromHealth({ urlResolver: (p) => p, fetchFn }),
      /401/,
    );
    assert.equal(calls, 1);

    // Within the suppression window: no request, no throw — the scheduler
    // keeps ticking every 60s and must not re-error each tick (#4902).
    const applied = await refreshDataFreshnessFromHealth({ urlResolver: (p) => p, fetchFn });
    assert.equal(applied, 0);
    assert.equal(calls, 1, 'suppression window must not issue another request');

    // After the window (reset here), the probe runs — and errors — again, so
    // a persistent re-gate stays visible at 1 event per window per tab.
    __resetHealthFreshnessForTests();
    await assert.rejects(
      refreshDataFreshnessFromHealth({ urlResolver: (p) => p, fetchFn }),
      /401/,
    );
    assert.equal(calls, 2);

    __resetHealthFreshnessForTests();
  });

  it('polls health freshness from the app scheduler instead of StrategicRiskPanel', () => {
    const appSrc = readFileSync(resolve(repoRoot, 'src/App.ts'), 'utf8');
    const panelSrc = readFileSync(resolve(repoRoot, 'src/components/StrategicRiskPanel.ts'), 'utf8');

    assert.doesNotMatch(
      panelSrc,
      /refreshDataFreshnessFromHealth|refreshHealthFreshness|lastHealthFreshnessRefreshAt/,
      'StrategicRiskPanel must not own /api/health freshness polling',
    );
    assert.match(
      appSrc,
      /scheduleAfterFirstPaint\(\(\)\s*=>\s*\{[\s\S]*?scheduleRefresh\(\s*['"]health-freshness['"][\s\S]*?refreshDataFreshnessFromHealth\(\)[\s\S]*?REFRESH_INTERVALS\.healthFreshness[\s\S]*?runImmediately:\s*true/,
      'App scheduler should hydrate health freshness at post-paint idle (never in the LCP window — #4907) and then on an interval, independent of panel visibility',
    );
  });
});
