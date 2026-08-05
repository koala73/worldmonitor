import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type {
  GetCountryPortActivityRequest,
  ServerContext,
} from '../src/generated/server/worldmonitor/intelligence/v1/service_server.ts';
import {
  getCountryPortActivity,
  isCurrentPortActivityPayload,
  PORTWATCH_PORT_ACTIVITY_MAX_CACHE_AGE_MS,
} from '../server/worldmonitor/intelligence/v1/get-country-port-activity.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-07-29T12:00:00.000Z');
const CTX: ServerContext = {
  request: new Request('https://example.test/'),
  pathParams: {},
  headers: {},
};
const REQ: GetCountryPortActivityRequest = { countryCode: 'US' };

describe('country port-activity consumer freshness', () => {
  it('uses the same strict seven-day boundary as the seeder', () => {
    assert.equal(PORTWATCH_PORT_ACTIVITY_MAX_CACHE_AGE_MS, 7 * DAY);
    assert.equal(isCurrentPortActivityPayload({
      cacheWrittenAt: NOW - PORTWATCH_PORT_ACTIVITY_MAX_CACHE_AGE_MS + 1,
    }, NOW), true);
    assert.equal(isCurrentPortActivityPayload({
      cacheWrittenAt: NOW - PORTWATCH_PORT_ACTIVITY_MAX_CACHE_AGE_MS,
    }, NOW), false);
    assert.equal(isCurrentPortActivityPayload({}, NOW), false);
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

    it('does not serve an expired state payload still named by the canonical list', async () => {
      globalThis.fetch = async (input) => {
        const key = decodeURIComponent(new URL(String(input)).pathname.replace('/get/', ''));
        const value = key.endsWith('_countries')
          ? ['US']
          : {
              iso2: 'US',
              cacheWrittenAt: Date.now() - 8 * DAY,
              fetchedAt: '2026-07-20T00:00:00.000Z',
              ports: [{ portId: 'US-1', portName: 'Expired port' }],
            };
        return new Response(JSON.stringify({ result: JSON.stringify(value) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };

      const response = await getCountryPortActivity(CTX, REQ);

      assert.deepEqual(response, {
        available: false,
        ports: [],
        fetchedAt: '',
      });
    });
  });
});
