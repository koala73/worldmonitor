// GET /api/economic/v1/get-no2-activity reads the global Sentinel-5P NO2
// dataset at the Redis boundary through the shared contract validator and
// serves it filtered by country, region id and kind. The handler is driven
// through a fake Upstash REST endpoint so the envelope unwrap, the validator
// and the projection are all exercised, not only the filter.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { __testing__ as healthTesting } from '../api/health.js';
import { NO2_ACTIVITY_KEY, NO2_REGIONS } from '../scripts/shared/no2-activity.mjs';
import {
  NO2_ACTIVITY_MAX_STALE_MINUTES,
  NO2_ACTIVITY_REASON,
  getNo2Activity,
} from '../server/worldmonitor/economic/v1/get-no2-activity.ts';
import { no2ActivityDataset } from './helpers/no2-activity-fixture.mjs';

const originalFetch = globalThis.fetch;
const originalEnv = {
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
};

const DAY_MS = 86_400_000;
const CTX = {} as never;

function freshDataset(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return no2ActivityDataset({
    generatedAt: new Date(now - 3_600_000).toISOString(),
    windowEnd: new Date(now - 4 * DAY_MS).toISOString().slice(0, 10),
    ...overrides,
  });
}

let requestedKeys: string[] = [];

function serveRedis(value: unknown) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requestedKeys.push(decodeURIComponent(url.slice(url.lastIndexOf('/') + 1)));
    return Response.json({ result: value === null ? null : JSON.stringify(value) });
  }) as typeof fetch;
}

beforeEach(() => {
  requestedKeys = [];
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalEnv.url === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalEnv.url;
  if (originalEnv.token === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalEnv.token;
});

describe('getNo2Activity', () => {
  it('pins its staleness budget to the health probe for the same key', () => {
    assert.equal(NO2_ACTIVITY_MAX_STALE_MINUTES, healthTesting.SEED_META.no2Activity.maxStaleMin);
  });

  it('serves every registered region with method, attribution and freshness', async () => {
    const dataset = freshDataset({ changes: { 'country-cn': 14.2, 'yangtze-river-delta': -12.5, 'country-fr': 'pending', 'country-de': null } });
    serveRedis({ _seed: { fetchedAt: Date.now() }, data: dataset });
    const response = await getNo2Activity(CTX, { countryCode: '', regionId: '', kind: 'NO2_REGION_KIND_UNSPECIFIED' });

    assert.deepEqual(requestedKeys, [NO2_ACTIVITY_KEY]);
    assert.equal(response.unavailableReason, NO2_ACTIVITY_REASON.served);
    assert.equal(response.upstreamUnavailable, false);
    assert.equal(response.stale, false);
    assert.equal(response.generatedAt, dataset.generatedAt);
    assert.equal(response.attribution, 'Contains modified Copernicus Sentinel data 2023-2026');
    assert.equal(response.methodVersion, 'no2-activity/v1');
    assert.equal(response.regions.length, NO2_REGIONS.length);
    assert.deepEqual(response.regions.map((region) => region.id), NO2_REGIONS.map((region) => region.id));

    const china = response.regions.find((region) => region.id === 'country-cn');
    assert.ok(china);
    assert.equal(china.kind, 'NO2_REGION_KIND_COUNTRY');
    assert.equal(china.countryCode, 'CN');
    assert.equal(china.label, 'China');
    assert.deepEqual(china.bbox, [73.63, 18.29, 134.77, 53.55]);
    assert.equal(china.changePercent, 14.2);
    assert.equal(china.direction, 'NO2_DIRECTION_STRENGTHENING');
    assert.equal(china.exclusion, 'NO2_REGION_EXCLUSION_UNSPECIFIED');
    assert.equal(china.current?.validDays, 40);
    assert.equal(china.current?.windowEnd, dataset.regions['country-cn'].current.windowEnd);
    const windowYear = Number(dataset.regions['country-cn'].current.windowEnd.slice(0, 4));
    assert.deepEqual(china.baselineYears, [windowYear - 1, windowYear - 2, windowYear - 3]);
    assert.equal(china.baselineMeanNo2MolM2, 1.1e-4);
    assert.equal('maskedDays' in JSON.parse(JSON.stringify(china.current)), false);

    const delta = response.regions.find((region) => region.id === 'yangtze-river-delta');
    assert.equal(delta?.kind, 'NO2_REGION_KIND_CLUSTER');
    assert.equal(delta?.direction, 'NO2_DIRECTION_WEAKENING');
    assert.equal(delta?.changePercent, -12.5);

    const inside = response.regions.find((region) => region.id === 'country-ae');
    assert.equal(inside?.changePercent, 2);
    assert.equal(inside?.direction, 'NO2_DIRECTION_UNCHANGED');

    const pending = response.regions.find((region) => region.id === 'country-fr');
    assert.ok(pending);
    assert.equal(pending.exclusion, 'NO2_REGION_EXCLUSION_BASELINE_BACKFILL_PENDING');
    assert.equal(pending.direction, 'NO2_DIRECTION_UNSPECIFIED');
    assert.deepEqual(pending.baselineYears, []);
    const serialized = JSON.parse(JSON.stringify(pending));
    assert.equal('changePercent' in serialized, false);
    assert.equal('baselineMeanNo2MolM2' in serialized, false);

    const cloudy = response.regions.find((region) => region.id === 'country-de');
    assert.equal(cloudy?.exclusion, 'NO2_REGION_EXCLUSION_INSUFFICIENT_VALID_DAYS');
    assert.equal(cloudy?.current?.validDays, 0);
    assert.equal('meanNo2MolM2' in JSON.parse(JSON.stringify(cloudy?.current)), false);

    const crossBorder = response.regions.find((region) => region.id === 'gulf-states');
    assert.equal(crossBorder?.countryCode, '');
  });

  it('lists only baseline years that entered the mean, never candidate windows', async () => {
    const dataset = freshDataset();
    const record = dataset.regions['country-cn'];
    record.baseline.years[1].validDays = 3;
    record.series.backfilledYears = record.series.backfilledYears.filter((year) => year !== record.baseline.years[2].year);
    serveRedis(dataset);
    const response = await getNo2Activity(CTX, { countryCode: 'CN', regionId: 'country-cn', kind: 'NO2_REGION_KIND_UNSPECIFIED' });
    assert.deepEqual(response.regions[0]?.baselineYears, [record.baseline.years[0].year]);
  });

  it('reads a bare dataset the same as an enveloped one', async () => {
    serveRedis(freshDataset());
    const response = await getNo2Activity(CTX, { countryCode: '', regionId: '', kind: 'NO2_REGION_KIND_UNSPECIFIED' });
    assert.equal(response.regions.length, NO2_REGIONS.length);
  });

  it('filters by country code case-insensitively, keeping the country and its clusters', async () => {
    serveRedis(freshDataset());
    const response = await getNo2Activity(CTX, { countryCode: 'cn', regionId: '', kind: 'NO2_REGION_KIND_UNSPECIFIED' });
    const expected = NO2_REGIONS.filter((region) => region.countryCode === 'CN').map((region) => region.id);
    assert.equal(expected.length, 5);
    assert.deepEqual(response.regions.map((region) => region.id), expected);
    assert.equal(response.unavailableReason, NO2_ACTIVITY_REASON.served);
    assert.equal(response.attribution, 'Contains modified Copernicus Sentinel data 2023-2026');
  });

  it('combines country and kind filters with AND', async () => {
    serveRedis(freshDataset());
    const countries = await getNo2Activity(CTX, { countryCode: 'CN', regionId: '', kind: 'NO2_REGION_KIND_COUNTRY' });
    assert.deepEqual(countries.regions.map((region) => region.id), ['country-cn']);
    const clusters = await getNo2Activity(CTX, { countryCode: 'CN', regionId: '', kind: 'NO2_REGION_KIND_CLUSTER' });
    assert.deepEqual(clusters.regions.map((region) => region.kind), ['NO2_REGION_KIND_CLUSTER', 'NO2_REGION_KIND_CLUSTER', 'NO2_REGION_KIND_CLUSTER', 'NO2_REGION_KIND_CLUSTER']);
    assert.ok(clusters.regions.every((region) => region.countryCode === 'CN'));
  });

  it('filters by kind alone', async () => {
    serveRedis(freshDataset());
    const clusters = await getNo2Activity(CTX, { countryCode: '', regionId: '', kind: 'NO2_REGION_KIND_CLUSTER' });
    assert.equal(clusters.regions.length, NO2_REGIONS.filter((region) => region.kind === 'cluster').length);
    const countries = await getNo2Activity(CTX, { countryCode: '', regionId: '', kind: 'NO2_REGION_KIND_COUNTRY' });
    assert.equal(countries.regions.length, NO2_REGIONS.filter((region) => region.kind === 'country').length);
  });

  it('filters by region id', async () => {
    serveRedis(freshDataset());
    const response = await getNo2Activity(CTX, { countryCode: '', regionId: 'ruhr-rhine', kind: 'NO2_REGION_KIND_UNSPECIFIED' });
    assert.deepEqual(response.regions.map((region) => region.id), ['ruhr-rhine']);
    assert.equal(response.regions[0]?.countryCode, 'DE');
  });

  it('answers not_covered without a cache read when the filters name no registered region', async () => {
    serveRedis(freshDataset());
    for (const req of [
      { countryCode: 'XX', regionId: '', kind: 'NO2_REGION_KIND_UNSPECIFIED' },
      { countryCode: '', regionId: 'nowhere', kind: 'NO2_REGION_KIND_UNSPECIFIED' },
      { countryCode: 'DE', regionId: 'country-fr', kind: 'NO2_REGION_KIND_UNSPECIFIED' },
      { countryCode: 'CN', regionId: 'country-cn', kind: 'NO2_REGION_KIND_CLUSTER' },
    ] as const) {
      const response = await getNo2Activity(CTX, req);
      assert.equal(response.unavailableReason, NO2_ACTIVITY_REASON.notCovered, JSON.stringify(req));
      assert.equal(response.upstreamUnavailable, false);
      assert.deepEqual(response.regions, []);
      assert.equal(response.generatedAt, '');
      assert.equal(response.attribution, '');
    }
    assert.deepEqual(requestedKeys, []);
  });

  it('rejects malformed filters as invalid_request without a cache read', async () => {
    serveRedis(freshDataset());
    for (const req of [
      { countryCode: 'C', regionId: '', kind: 'NO2_REGION_KIND_UNSPECIFIED' },
      { countryCode: '', regionId: 'Yangtze River', kind: 'NO2_REGION_KIND_UNSPECIFIED' },
      { countryCode: '', regionId: '', kind: 'NO2_REGION_KIND_BOGUS' },
    ] as never[]) {
      const response = await getNo2Activity(CTX, req);
      assert.equal(response.unavailableReason, NO2_ACTIVITY_REASON.invalidRequest, JSON.stringify(req));
      assert.equal(response.upstreamUnavailable, false);
    }
    assert.deepEqual(requestedKeys, []);
  });

  it('names a missing seed as a fault', async () => {
    serveRedis(null);
    const response = await getNo2Activity(CTX, { countryCode: '', regionId: '', kind: 'NO2_REGION_KIND_UNSPECIFIED' });
    assert.equal(response.unavailableReason, NO2_ACTIVITY_REASON.seedMissing);
    assert.equal(response.upstreamUnavailable, true);
    assert.deepEqual(response.regions, []);
  });

  it('refuses a dataset that fails the shared contract', async () => {
    const dataset = freshDataset();
    dataset.regions['country-cn'].direction = 'weakening';
    serveRedis(dataset);
    const response = await getNo2Activity(CTX, { countryCode: 'CN', regionId: '', kind: 'NO2_REGION_KIND_UNSPECIFIED' });
    assert.equal(response.unavailableReason, NO2_ACTIVITY_REASON.invalidDataset);
    assert.equal(response.upstreamUnavailable, true);
    assert.deepEqual(response.regions, []);
  });

  it('names a failed cache read as a fault', async () => {
    globalThis.fetch = (async () => new Response('upstream down', { status: 503 })) as typeof fetch;
    const response = await getNo2Activity(CTX, { countryCode: '', regionId: '', kind: 'NO2_REGION_KIND_UNSPECIFIED' });
    assert.equal(response.unavailableReason, NO2_ACTIVITY_REASON.cacheUnavailable);
    assert.equal(response.upstreamUnavailable, true);
  });

  it('flags a dataset older than the staleness budget', async () => {
    const generatedAt = new Date(Date.now() - (NO2_ACTIVITY_MAX_STALE_MINUTES + 30) * 60_000);
    serveRedis(no2ActivityDataset({
      generatedAt: generatedAt.toISOString(),
      windowEnd: new Date(generatedAt.getTime() - 4 * DAY_MS).toISOString().slice(0, 10),
    }));
    const response = await getNo2Activity(CTX, { countryCode: '', regionId: '', kind: 'NO2_REGION_KIND_UNSPECIFIED' });
    assert.equal(response.stale, true);
    assert.equal(response.unavailableReason, NO2_ACTIVITY_REASON.served);
    assert.equal(response.regions.length, NO2_REGIONS.length);
  });
});
