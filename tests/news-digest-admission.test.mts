import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDomainGateway, serverOptions } from '../server/gateway';
import { createNewsServiceRoutes } from '../src/generated/server/worldmonitor/news/v1/service_server';
import { issueSessionToken } from '../api/_session.js';
import { ENDPOINT_RATE_POLICIES, __resetRateLimitForTest } from '../server/_shared/rate-limit';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
afterEach(() => {
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

const digestPath = '/api/news/v1/list-feed-digest';
const operatorKey = 'synthetic-digest-operator-key';

it('cloud and Docker digest requests remain fail closed without Redis', async () => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.WORLDMONITOR_VALID_KEYS = operatorKey;
  let builds = 0;
  globalThis.fetch = async () => { throw new Error('Unexpected network request'); };
  const gateway = createDomainGateway(createNewsServiceRoutes({ listFeedDigest: async () => {
    builds++;
    return { categories: {}, feedStatuses: {}, generatedAt: '' };
  } } as never, serverOptions));
  for (const mode of ['', 'docker']) {
    process.env.LOCAL_API_MODE = mode;
    __resetRateLimitForTest();
    const response = await gateway(new Request(`https://worldmonitor.app${digestPath}?lang=en`, {
      headers: { 'X-WorldMonitor-Key': operatorKey, 'x-vercel-forwarded-for': '192.0.2.83' },
    }));
    assert.equal(response.status, 503, `${mode || 'cloud'} must retain its Redis admission gate`);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  assert.equal(builds, 0);
});

it('authenticated native sidecar admits digest reads without Redis, limits bursts and expires the window', async () => {
  const { createLocalApiServer } = await import('../src-tauri/sidecar/local-api-server.mjs');
  const root = await mkdtemp(join(tmpdir(), 'digest-admission-sidecar-'));
  await mkdir(join(root, 'news/v1'), { recursive: true });
  const serviceUrl = new URL('../src/generated/server/worldmonitor/news/v1/service_server.ts', import.meta.url).href;
  const gatewayUrl = new URL('../server/gateway.ts', import.meta.url).href;
  await writeFile(join(root, 'news/v1/list-feed-digest.js'), `import {createNewsServiceRoutes} from ${JSON.stringify(serviceUrl)}; import {createDomainGateway,serverOptions} from ${JSON.stringify(gatewayUrl)}; export default createDomainGateway(createNewsServiceRoutes({listFeedDigest:async()=>({categories:{},feedStatuses:{},generatedAt:'fixture-digest'})},serverOptions));`);
  process.env.LOCAL_API_MODE = 'tauri-sidecar';
  process.env.LOCAL_API_TOKEN = 'synthetic-digest-transport';
  process.env.WORLDMONITOR_VALID_KEYS = operatorKey;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  __resetRateLimitForTest();
  const app = await createLocalApiServer({ port: 0, apiDir: root, dataDir: root, mode: 'tauri-sidecar', cloudFallback: false, logger: { log() {}, warn() {}, error() {} } });
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    const { port } = await app.start();
    const url = `http://127.0.0.1:${port}${digestPath}?lang=en`;
    const headers = { 'x-worldmonitor-local-token': process.env.LOCAL_API_TOKEN, 'X-WorldMonitor-Key': operatorKey };
    assert.equal((await originalFetch(url, { headers: { ...headers, 'x-worldmonitor-local-token': 'invalid' } })).status, 401);
    assert.equal((await originalFetch(url, { headers: { ...headers, 'X-WorldMonitor-Key': 'invalid' } })).status, 401);
    assert.deepEqual(ENDPOINT_RATE_POLICIES[digestPath], { limit: 30, window: '60 s' });
    for (let i = 0; i < 30; i++) {
      const response = await originalFetch(url, { headers });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).generatedAt, 'fixture-digest');
    }
    const denied = await originalFetch(url, { headers });
    assert.equal(denied.status, 429);
    assert.equal(Number(denied.headers.get('Retry-After')), 60);
    now += 59_999;
    assert.equal((await originalFetch(url, { headers })).status, 429);
    now += 1;
    assert.equal((await originalFetch(url, { headers })).status, 200);
  } finally {
    Date.now = originalNow;
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
