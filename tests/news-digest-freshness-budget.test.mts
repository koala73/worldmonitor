import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createDomainGateway } from '../server/gateway.ts';
import { REFRESH_INTERVALS } from '../src/config/variants/base.ts';
import { createRedisFetch } from './helpers/fake-upstash-redis.mts';

const originalFetch = globalThis.fetch;
const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

before(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  const { fetchImpl } = createRedisFetch({});
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (new URL(url).host === 'redis.example') return fetchImpl(input, init);
    return originalFetch(input, init);
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
  if (originalRedisUrl == null) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalRedisUrl;
  if (originalRedisToken == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalRedisToken;
});

// Each layer between a feed and the dashboard adds its TTL to how late a story
// can appear. The digest is rebuilt into Redis every 15 minutes; a CDN that
// keeps serving one body for an hour (#1057's s-maxage=3600) makes the CDN,
// not Redis, the freshness floor. Measured 2026-10-18: median publish-to-first-
// digest lag 43 min before any CDN or poll delay.
const DIGEST_REDIS_TTL_S = 900;
const PATH = '/api/news/v1/list-feed-digest';

function directive(header: string | null, name: string): number {
  const match = header?.match(new RegExp(`${name}=(\\d+)`));
  assert.ok(match, `${name} missing from ${header}`);
  return Number(match[1]);
}

describe('news digest freshness budget', () => {
  it('lets no shared cache serve a digest body longer than Redis keeps it', async () => {
    const handler = createDomainGateway([{
      method: 'GET',
      path: PATH,
      handler: async () => new Response(JSON.stringify({ categories: {} }), { status: 200 }),
    }]);
    const response = await handler(new Request(`https://www.worldmonitor.app${PATH}?variant=full&lang=en&public=1`, {
      headers: { Origin: 'https://www.worldmonitor.app' },
    }));
    assert.equal(response.status, 200);
    const cdn = response.headers.get('CDN-Cache-Control');
    assert.ok(directive(cdn, 's-maxage') <= DIGEST_REDIS_TTL_S, `Vercel CDN: ${cdn}`);
    const browserAndCf = response.headers.get('Cache-Control');
    assert.ok(directive(browserAndCf, 's-maxage') <= DIGEST_REDIS_TTL_S, `Cloudflare: ${browserAndCf}`);
  });

  it('polls the digest at least every 10 minutes', () => {
    assert.ok(REFRESH_INTERVALS.feeds <= 10 * 60_000, `feeds poll ${REFRESH_INTERVALS.feeds} ms`);
  });
});
