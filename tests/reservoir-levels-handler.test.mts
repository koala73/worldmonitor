import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { __testing__ as health } from '../api/health.js';
import {
  listReservoirLevels,
  normalizeReservoir,
  normalizeReservoirLevelsSeed,
} from '../server/worldmonitor/climate/v1/list-reservoir-levels.ts';
import { readFileSync } from 'node:fs';
import { toReservoirLevelsSnapshot } from '../src/services/climate/reservoir-levels.ts';

const SEED = {
  fetchedAt: 1_794_000_000_000,
  source: { name: 'NASA ICESat-2 ATL13 (NSIDC), processed via SlideRule Earth', product: 'ATL13', url: 'https://nsidc.org/data/atl13', processing: 'https://slideruleearth.io' },
  methodology: 'lidar level',
  reservoirs: [
    {
      id: 'mead', name: 'Lake Mead', country: 'US', riparians: ['US', 'MX'], river: 'Colorado', lat: 36.13, lon: -114.45,
      tags: ['hydropower'], why: 'shortage tiers',
      latest: { date: '2026-09-01', levelM: 321.4, madM: 0.03, segmentCount: 120, ageDays: 71 },
      prevDate: '2026-08-20', changePrevM: -0.2, change30dM: -0.5, change90dM: null, change365dM: 1.2,
      seasonalAnomalyM: 2.1, seasonalZ: 1.3, recordMinM: 315.1, recordMaxM: 330.2, recordStart: '2018-10-15',
      percentOfRange: 41.7, recordLow: false, recordHigh: false, status: 'normal',
      series: [['2026-08-20', 321.6], ['2026-09-01', 321.4], ['bad'], [7, 'x']], okPassCount: 140,
    },
    {
      id: 'kakhovka', name: 'Kakhovka reservoir (destroyed)', country: 'UA', riparians: ['UA'], river: 'Dnipro', lat: 47.4, lon: 34.2,
      tags: ['conflict'], why: 'drained', latest: { date: '2023-09-01', levelM: 3, madM: 0.1, segmentCount: 30, ageDays: 1167 },
      prevDate: '2023-07-20', changePrevM: -0.2, change30dM: null, change90dM: null, change365dM: null,
      seasonalAnomalyM: null, seasonalZ: null, recordMinM: 3, recordMaxM: 16.8, recordStart: '2018-11-01', percentOfRange: 0,
      recordLow: true, recordHigh: false, status: 'no_recent_data', series: [], okPassCount: 90,
    },
    { id: '', lat: 1, lon: 1 },
    { id: 'nolatlon' },
  ],
};

describe('list-reservoir-levels normalization', () => {
  it('keeps valid reservoirs, drops malformed ones and maps series tuples', () => {
    const out = normalizeReservoirLevelsSeed(SEED);
    assert.equal(out.dataAvailable, true);
    assert.equal(out.fetchedAt, SEED.fetchedAt);
    assert.deepEqual(out.reservoirs.map((r) => r.id), ['mead', 'kakhovka']);
    const mead = out.reservoirs[0];
    assert.deepEqual(mead.series, [{ date: '2026-08-20', levelM: 321.6 }, { date: '2026-09-01', levelM: 321.4 }]);
    assert.equal(mead.change90dM, undefined, 'null metrics stay absent, not zero');
    assert.equal(mead.change365dM, 1.2);
    assert.deepEqual(mead.latest, { date: '2026-09-01', levelM: 321.4, madM: 0.03, segmentCount: 120, ageDays: 71 });
    assert.equal(out.source?.name, SEED.source.name);
    const k = out.reservoirs[1];
    assert.equal(k.status, 'no_recent_data');
    assert.equal(k.recordLow, true);
    assert.equal(k.percentOfRange, 0);
  });

  it('reports an unavailable snapshot, not an empty watchlist, for missing or empty data', () => {
    for (const v of [null, undefined, {}, { reservoirs: [] }, { reservoirs: [{ id: 'x' }] }, 'junk']) {
      assert.deepEqual(normalizeReservoirLevelsSeed(v), { reservoirs: [], fetchedAt: 0, dataAvailable: false, methodology: '' });
    }
  });

  it('defaults an unknown status to insufficient_history and drops a latest pass without a level', () => {
    const r = normalizeReservoir({ id: 'x', lat: 1, lon: 2, status: '', latest: { date: '2026-01-01' } });
    assert.equal(r?.status, 'insufficient_history');
    assert.equal(r?.latest, undefined);
  });

  it('client snapshot is null when unavailable and keeps nulls for absent metrics', () => {
    assert.equal(toReservoirLevelsSnapshot(normalizeReservoirLevelsSeed(null)), null);
    const snap = toReservoirLevelsSnapshot(normalizeReservoirLevelsSeed(SEED));
    assert.ok(snap);
    assert.equal(snap.reservoirs[0].change90dM, null);
    assert.equal(snap.reservoirs[0].latest?.observedAt.toISOString(), '2026-09-01T00:00:00.000Z');
    assert.equal(snap.reservoirs[1].latest?.ageDays, 1167);
  });
});

describe('list-reservoir-levels handler', () => {
  const originalFetch = globalThis.fetch;
  const saved = { url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN };
  beforeEach(() => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://reservoir-redis.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.UPSTASH_REDIS_REST_URL = saved.url;
    process.env.UPSTASH_REDIS_REST_TOKEN = saved.token;
  });

  it('reads the seeded key and unwraps the envelope', async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (url: string) => {
      seen.push(String(url));
      return Response.json({ result: JSON.stringify({ _seed: { fetchedAt: SEED.fetchedAt, recordCount: 2, sourceVersion: 'v', schemaVersion: 1, state: 'OK' }, data: SEED }) });
    }) as typeof fetch;
    const req = new Request('https://www.worldmonitor.app/api/climate/v1/list-reservoir-levels');
    const out = await listReservoirLevels({ request: req, pathParams: {}, headers: {} } as never, {});
    assert.ok(seen.some((u) => u.includes(encodeURIComponent('climate:reservoir-levels:v1'))));
    assert.equal(out.dataAvailable, true);
    assert.equal(out.reservoirs.length, 2);
  });

  it('answers the unavailable fallback when Redis fails', async () => {
    globalThis.fetch = (async () => new Response('err', { status: 500 })) as typeof fetch;
    const req = new Request('https://www.worldmonitor.app/api/climate/v1/list-reservoir-levels');
    const out = await listReservoirLevels({ request: req, pathParams: {}, headers: {} } as never, {});
    assert.equal(out.dataAvailable, false);
    assert.deepEqual(out.reservoirs, []);
  });
});

describe('reservoir levels registration', () => {
  it('is a standalone health key with a 3x-daily seed budget', () => {
    assert.equal(health.STANDALONE_KEYS.reservoirLevels, 'climate:reservoir-levels:v1');
    const { key, maxStaleMin, firstPublicationMaxWaitMin, activationKey } = health.SEED_META.reservoirLevels;
    assert.deepEqual({ key, maxStaleMin, firstPublicationMaxWaitMin, activationKey }, {
      key: 'seed-meta:climate:reservoir-levels', maxStaleMin: 4320,
      firstPublicationMaxWaitMin: 1440, activationKey: 'seed-activated:climate:reservoir-levels',
    });
    assert.equal(health.BOOTSTRAP_KEYS.reservoirLevels, undefined);
  });

  it('uses the daily gateway cache tier like its climate siblings', () => {
    const gateway = readFileSync(new URL('../server/gateway.ts', import.meta.url), 'utf8');
    assert.match(gateway, /'\/api\/climate\/v1\/list-reservoir-levels': 'daily',/);
  });
});
