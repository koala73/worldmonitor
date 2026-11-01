import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type {
  GetCountryPortActivityRequest,
  ServerContext,
} from '../src/generated/server/worldmonitor/intelligence/v1/service_server.ts';
import {
  getCountryPortActivity,
  isCurrentPortActivityPayload,
  isServablePortActivityPayload,
  PORTWATCH_PORT_ACTIVITY_MAX_CACHE_AGE_MS,
  PORTWATCH_PORT_ACTIVITY_MAX_SERVE_AGE_MS,
} from '../server/worldmonitor/intelligence/v1/get-country-port-activity.ts';
import { PORTWATCH_MAX_CACHE_AGE_MS } from '../scripts/_portwatch-content-freshness.mjs';

const DAY = 86_400_000;
const NOW = Date.parse('2026-07-29T12:00:00.000Z');
const CTX: ServerContext = {
  request: new Request('https://example.test/'),
  pathParams: {},
  headers: {},
};
const REQ: GetCountryPortActivityRequest = { countryCode: 'US' };

describe('country port-activity consumer freshness', () => {
  it('uses the same strict seven-day current boundary as the seeder', () => {
    assert.equal(PORTWATCH_PORT_ACTIVITY_MAX_CACHE_AGE_MS, PORTWATCH_MAX_CACHE_AGE_MS);
    assert.equal(PORTWATCH_PORT_ACTIVITY_MAX_CACHE_AGE_MS, 7 * DAY);
    assert.equal(isCurrentPortActivityPayload({
      cacheWrittenAt: NOW - PORTWATCH_PORT_ACTIVITY_MAX_CACHE_AGE_MS + 1,
    }, NOW), true);
    assert.equal(isCurrentPortActivityPayload({
      cacheWrittenAt: NOW - PORTWATCH_PORT_ACTIVITY_MAX_CACHE_AGE_MS,
    }, NOW), false);
    assert.equal(isCurrentPortActivityPayload({}, NOW), false);
  });

  it('serves last data for up to 30 days, never longer', () => {
    assert.equal(PORTWATCH_PORT_ACTIVITY_MAX_SERVE_AGE_MS, 30 * DAY);
    const ports = [{ portId: 'US-1' }];
    assert.equal(isServablePortActivityPayload({ cacheWrittenAt: NOW - 8 * DAY, ports }, NOW), true);
    assert.equal(isServablePortActivityPayload({
      cacheWrittenAt: NOW - PORTWATCH_PORT_ACTIVITY_MAX_SERVE_AGE_MS + 1, ports,
    }, NOW), true);
    assert.equal(isServablePortActivityPayload({
      cacheWrittenAt: NOW - PORTWATCH_PORT_ACTIVITY_MAX_SERVE_AGE_MS, ports,
    }, NOW), false);
    // A write stamped in the future is not evidence of anything.
    assert.equal(isServablePortActivityPayload({ cacheWrittenAt: NOW + DAY, ports }, NOW), false);
    // Scheduler-only state for a never-cached country carries no data.
    assert.equal(isServablePortActivityPayload({
      iso2: 'US', refreshAttemptedAt: NOW, refreshFailure: { code: 'invalid_query' },
    }, NOW), false);
    assert.equal(isServablePortActivityPayload({ cacheWrittenAt: NOW - DAY }, NOW), false);
  });

  describe('handler read path', () => {
    const originalFetch = globalThis.fetch;
    const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
    const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;

    before(() => {
      process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
      process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    });

    after(() => {
      globalThis.fetch = originalFetch;
      if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
      else process.env.UPSTASH_REDIS_REST_URL = originalUrl;
      if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
      else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
    });

    function serve(ageMs: number, extra: Record<string, unknown> = {}) {
      globalThis.fetch = async (input) => {
        const key = decodeURIComponent(new URL(String(input)).pathname.replace('/get/', ''));
        const value = key.endsWith('_countries')
          ? ['US']
          : {
              iso2: 'US',
              cacheWrittenAt: Date.now() - ageMs,
              fetchedAt: '2026-07-20T00:00:00.000Z',
              ports: [{ portId: 'US-1', portName: 'Houston', tankerCalls30d: 12 }],
              ...extra,
            };
        return new Response(JSON.stringify({ result: JSON.stringify(value) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };
    }

    it('serves a current payload as not stale', async () => {
      serve(DAY);
      const response = await getCountryPortActivity(CTX, REQ);
      assert.equal(response.available, true);
      assert.equal(response.stale, false);
      assert.equal(response.ports[0]?.portName, 'Houston');
    });

    // 2026-11-01: ten countries crossed seven days while ArcGIS rejected their
    // refreshes, and their panels went blank although their last data was in
    // Redis. Older data, labelled, is more useful than none.
    it('serves an expired payload still named by the canonical list, marked stale', async () => {
      serve(8 * DAY, { refreshFailure: { code: 'invalid_query', consecutiveFailures: 3 } });
      const response = await getCountryPortActivity(CTX, REQ);
      assert.equal(response.available, true);
      assert.equal(response.stale, true);
      assert.equal(response.fetchedAt, '2026-07-20T00:00:00.000Z');
      assert.equal(response.ports[0]?.tankerCalls30d, 12);
    });

    it('does not serve a payload 30 days old or more', async () => {
      serve(30 * DAY);
      const response = await getCountryPortActivity(CTX, REQ);
      assert.deepEqual(response, {
        available: false,
        ports: [],
        fetchedAt: '',
        stale: false,
      });
    });
  });
});
