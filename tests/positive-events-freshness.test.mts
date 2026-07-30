/**
 * Regression for issue #3706: the positive-events handler used to serve
 * an in-process fallback for up to 12 hours with no freshness signal in
 * the response shape. Clients could not distinguish fresh from stale
 * data. The fix adds `fetchedAt` + `stale` to ListPositiveGeoEventsResponse.
 *
 * Covers all three return paths:
 *   1. Fresh Redis hit       → fetchedAt = source ts, stale = false
 *   2. In-process fallback   → fetchedAt = previous source ts, stale = true
 *   3. Empty (no source, no fallback) → fetchedAt = 0, stale = false
 *
 * Plus a regression test for the review-pass P1 fix: when Redis serves
 * borderline-aged data (source 20 h old, MAX_SOURCE_AGE_MS = 25 h), a
 * subsequent Redis failure within the 12 h FALLBACK_WINDOW_MS must
 * STILL serve the fallback. Previous draft stamped fallback.ts at
 * source-produced time, which collapsed the availability window to
 * zero for aged source data.
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import type {
  ServerContext,
  ListPositiveGeoEventsRequest,
} from '../src/generated/server/worldmonitor/positive_events/v1/service_server.ts';
import {
  listPositiveGeoEvents,
  __resetFallbackForTest,
} from '../server/worldmonitor/positive-events/v1/list-positive-geo-events.ts';

type FetchFn = typeof fetch;
const originalFetch: FetchFn | undefined = globalThis.fetch;
const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;

const CTX: ServerContext = {
  request: new Request('https://example.com/'),
  pathParams: {},
  headers: {},
};
const REQ: ListPositiveGeoEventsRequest = {};

const SAMPLE_EVENT = {
  latitude: 1,
  longitude: 2,
  name: 'sample',
  category: 'humanity-kindness',
  count: 3,
  timestamp: 1_700_000_000_000,
};

function stubRedisJson(payload: object | null): FetchFn {
  return async () =>
    new Response(
      JSON.stringify({
        result: payload === null ? null : JSON.stringify(payload),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
}

function setRedisEnv() {
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake-redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
}

function unsetRedisEnv() {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
}

after(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
  if (originalUrl == null) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
  if (originalToken == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
  __resetFallbackForTest();
});

describe('listPositiveGeoEvents — freshness metadata (#3706)', () => {
  beforeEach(() => {
    __resetFallbackForTest();
    setRedisEnv();
  });

  it('fresh Redis hit → fetchedAt = source ts, stale = false', async () => {
    const sourceTs = Date.now() - 10_000; // 10s ago
    globalThis.fetch = stubRedisJson({ events: [SAMPLE_EVENT], fetchedAt: sourceTs });

    const result = await listPositiveGeoEvents(CTX, REQ);
    assert.equal(result.events.length, 1);
    assert.equal(result.stale, false, 'fresh data must not be marked stale');
    assert.equal(result.fetchedAt, sourceTs, 'fetchedAt must reflect source timestamp');
  });

  it('Redis fails after a successful read → in-process fallback served with stale=true, source ts preserved', async () => {
    const sourceTs = Date.now() - 60_000; // 1 min ago
    // Prime the fallback with a successful read.
    globalThis.fetch = stubRedisJson({ events: [SAMPLE_EVENT], fetchedAt: sourceTs });
    await listPositiveGeoEvents(CTX, REQ);

    // Now Redis returns null — handler must fall through to module cache.
    globalThis.fetch = stubRedisJson(null);
    const result = await listPositiveGeoEvents(CTX, REQ);

    assert.equal(result.events.length, 1, 'should serve previously-cached event');
    assert.equal(result.stale, true, 'in-process fallback must be marked stale');
    assert.equal(result.fetchedAt, sourceTs, 'fetchedAt must report ORIGINAL source ts, not local read time');
  });

  it('no source + no fallback → events=[], fetchedAt=0, stale=false', async () => {
    // No Redis env, no fallback primed. The handler must report empty truthfully.
    unsetRedisEnv();
    const result = await listPositiveGeoEvents(CTX, REQ);
    assert.deepEqual(result, { events: [], fetchedAt: 0, stale: false });
  });
});

describe('listPositiveGeoEvents — borderline-age regression (#3706 review)', () => {
  beforeEach(() => {
    __resetFallbackForTest();
    setRedisEnv();
  });

  it('serves fallback after Redis blip even when last-good source was 20h old', async () => {
    // Source was produced 20 h ago. MAX_SOURCE_AGE_MS = 25 h, so it's still
    // an acceptable fresh read. A previous draft stamped fallback.ts at
    // source-produced time, which made the 12 h FALLBACK_WINDOW_MS check
    // (20h < 12h) fail and serve EMPTY on the next Redis blip — eliminating
    // the availability window entirely for borderline-aged source data.
    // This test pins the fix: fallback must serve for 12 h after LOCAL read
    // regardless of source age at read time.
    const twentyHoursAgo = Date.now() - 20 * 60 * 60 * 1000;
    globalThis.fetch = stubRedisJson({ events: [SAMPLE_EVENT], fetchedAt: twentyHoursAgo });
    const first = await listPositiveGeoEvents(CTX, REQ);
    assert.equal(first.events.length, 1, 'fresh read should accept 20h-old source');
    assert.equal(first.stale, false);

    // Redis now blips.
    globalThis.fetch = stubRedisJson(null);
    const second = await listPositiveGeoEvents(CTX, REQ);
    assert.equal(second.events.length, 1, 'fallback must still serve borderline-aged data');
    assert.equal(second.stale, true);
    assert.equal(second.fetchedAt, twentyHoursAgo, 'fetchedAt still reports original source ts');
  });
});
