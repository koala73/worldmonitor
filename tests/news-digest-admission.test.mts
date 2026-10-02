import assert from 'node:assert/strict';
import { after, it } from 'node:test';
import { createDomainGateway, serverOptions } from '../server/gateway';
import { createNewsServiceRoutes } from '../src/generated/server/worldmonitor/news/v1/service_server';
import { issueSessionToken } from '../api/_session.js';
import { __resetRateLimitForTest } from '../server/_shared/rate-limit';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  __resetRateLimitForTest();
});
it('rejects a digest request before feed work when its Redis admission fails', async () => {
  process.env.WM_SESSION_SECRET = 'fixture-news-digest-secret-at-least-32-chars';
  process.env.UPSTASH_REDIS_REST_URL = 'https://digest-redis.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
  delete process.env.LOCAL_API_MODE;
  __resetRateLimitForTest();
  const token = (await issueSessionToken()).token;
  globalThis.fetch = async () => new Response('', { status: 503 });
  let builds = 0;
  const gateway = createDomainGateway(createNewsServiceRoutes({ listFeedDigest: async () => {
    builds++;
    return { categories: {}, feedStatuses: {}, generatedAt: '' };
  } } as never, serverOptions));
  const response = await gateway(new Request('https://worldmonitor.app/api/news/v1/list-feed-digest?lang=en', {
    headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': token, 'x-vercel-forwarded-for': '192.0.2.83' },
  }));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(builds, 0);
});
