import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

// @ts-expect-error — JS module, no declaration file
import { issueSessionToken } from '../api/_session.js';
import type { ServerContext } from '../src/generated/server/worldmonitor/webcam/v1/service_server.ts';
import { __resetKeyPrefixCacheForTests } from '../server/_shared/redis.ts';
import {
  __resetRateLimitForTest,
  checkEndpointRateLimit,
  ENDPOINT_RATE_POLICIES,
  FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED,
} from '../server/_shared/rate-limit.ts';
import { PUBLIC_NO_AUTH_RPC_PATHS, createDomainGateway } from '../server/gateway.ts';
import { getWebcamImage } from '../server/worldmonitor/webcam/v1/get-webcam-image.ts';
import { PREMIUM_RPC_PATHS } from '../src/shared/premium-paths.ts';
import { createRedisFetch } from './helpers/fake-upstash-redis.mts';
import webcamGateway from '../api/webcam/v1/[rpc].ts';

const REDIS_URL = 'https://redis.test';
const WINDY_URL = 'https://api.windy.com/webcams/api/v3/webcams';
const WEBCAM_IMAGE_PATH = '/api/webcam/v1/get-webcam-image';
const OTHER_FAIL_CLOSED_PATH = '/api/news/v1/summarize-article-cache';
const ENV_KEYS = [
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'WINDY_API_KEY',
  'WM_SESSION_SECRET',
  'LOCAL_API_MODE',
  'VERCEL_ENV',
  'VERCEL_GIT_COMMIT_SHA',
] as const;

const originalEnv = new Map<string, string | undefined>();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  for (const key of ENV_KEYS) originalEnv.set(key, process.env[key]);
  process.env.UPSTASH_REDIS_REST_URL = REDIS_URL;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-redis-token';
  process.env.WINDY_API_KEY = 'test-windy-key';
  __resetKeyPrefixCacheForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetRateLimitForTest();
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnv.clear();
  __resetKeyPrefixCacheForTests();
});

function ctx(): ServerContext {
  return {} as ServerContext;
}

function installProviderAndRedisFixture(
  seededWebcamIds: string[] = [],
  cachedImage: Record<string, unknown> | null = null,
) {
  const calls: Array<{ url: string; headers: Headers; body: string }> = [];
  const seededIds = new Set(seededWebcamIds);
  const activeVersion = '20260911';
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    calls.push({ url, headers, body: String(init?.body ?? '') });

    if (url === `${REDIS_URL}/get/webcam%3Acameras%3Aactive`) {
      return Response.json({ result: seededIds.size > 0 ? activeVersion : null });
    }
    if (url === `${REDIS_URL}/pipeline`) {
      const [command] = JSON.parse(String(init?.body ?? '[]')) as string[][];
      const fields = command?.[0] === 'HMGET' ? command.slice(2) : [];
      return Response.json([{ result: fields.map(field => seededIds.has(field) ? '{}' : null) }]);
    }
    if (url.startsWith(`${REDIS_URL}/get/webcam%3Aimage%3A`)) {
      return Response.json({ result: cachedImage == null ? null : JSON.stringify(cachedImage) });
    }
    if (url.startsWith(`${REDIS_URL}/get/`)) return Response.json({ result: null });
    if (url === `${REDIS_URL}/`) return Response.json({ result: 'OK' });
    if (url.startsWith(WINDY_URL)) {
      return Response.json({
        webcams: [{
          images: { current: { preview: 'https://cdn.example/cam.jpg' } },
          urls: { player: 'https://player.example/cam' },
          title: 'Test camera',
          lastUpdatedOn: '2026-09-11T00:00:00.000Z',
        }],
      });
    }

    throw new Error(`unexpected fetch: ${url}`);
  };
  return calls;
}

describe('Windy webcam image proxy input boundary', () => {
  it('rejects an overlong ID before it can create a Redis key or Windy request', async () => {
    const calls = installProviderAndRedisFixture();

    const response = await getWebcamImage(ctx(), { webcamId: 'a'.repeat(65) });

    assert.equal(response.error, 'missing webcam_id');
    assert.deepEqual(calls, []);
  });

  it('rejects a malformed ID before it can create a Redis key or Windy request', async () => {
    const calls = installProviderAndRedisFixture();

    for (const webcamId of [
      'camera/123', 'http://127.0.0.1/private', '//attacker.example',
      '../private', 'camera?include=secrets', 'camera%2fprivate', 'camera#fragment',
    ]) {
      const response = await getWebcamImage(ctx(), { webcamId });
      assert.equal(response.error, 'missing webcam_id');
      assert.deepEqual(calls, []);
    }
  });

  it('does not forward a provider redirect or Windy credentials to another origin', async () => {
    const { createServer } = await import('node:http');
    let targetRequests = 0;
    let receivedWindyKey = false;
    const target = createServer((req, res) => {
      targetRequests += 1;
      receivedWindyKey ||= req.headers['x-windy-api-key'] === 'test-windy-key';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ title: 'Redirect target' }));
    });
    const provider = createServer((_req, res) => {
      const targetPort = (target.address() as { port: number }).port;
      res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/private` });
      res.end();
    });
    try {
      for (const server of [target, provider]) {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', resolve);
        });
      }
      const providerPort = (provider.address() as { port: number }).port;
      installProviderAndRedisFixture(['redirect-camera']);
      const fixtureFetch = globalThis.fetch;
      let providerRequests = 0;
      globalThis.fetch = async (input, init) => {
        if (String(input).startsWith(WINDY_URL)) {
          providerRequests += 1;
          // Keep real Fetch redirect behavior while mapping Windy to a local fixture.
          return originalFetch(`http://127.0.0.1:${providerPort}/camera`, init);
        }
        return fixtureFetch(input, init);
      };

      const response = await getWebcamImage(ctx(), { webcamId: 'redirect-camera' });

      assert.deepEqual({ targetRequests, receivedWindyKey }, { targetRequests: 0, receivedWindyKey: false });
      assert.equal(providerRequests, 1);
      assert.equal(response.error, 'unavailable');
      assert.equal(response.thumbnailUrl, '');
    } finally {
      await Promise.all([provider, target].map(server => new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      })));
    }
  });

  it('accepts an ID at the maximum allowed length', async () => {
    const webcamId = 'a'.repeat(64);
    const calls = installProviderAndRedisFixture([webcamId]);

    const response = await getWebcamImage(ctx(), { webcamId });

    assert.equal(response.error, '');
    assert.equal(calls[0]?.url, `${REDIS_URL}/get/webcam%3Aimage%3A${webcamId}`);
    assert.equal(calls[3]?.url, `${WINDY_URL}/${webcamId}?include=images,urls`);
  });

  it('normalizes an accepted ID before its cache key and Windy request', async () => {
    const calls = installProviderAndRedisFixture(['camera-123']);

    const response = await getWebcamImage(ctx(), { webcamId: '  camera-123  ' });

    assert.equal(response.error, '');
    assert.equal(response.thumbnailUrl, 'https://cdn.example/cam.jpg');
    assert.equal(response.windyUrl, 'https://www.windy.com/webcams/camera-123');
    assert.deepEqual(calls.map(call => call.url), [
      `${REDIS_URL}/get/webcam%3Aimage%3Acamera-123`,
      `${REDIS_URL}/get/webcam%3Acameras%3Aactive`,
      `${REDIS_URL}/pipeline`,
      `${WINDY_URL}/camera-123?include=images,urls`,
      `${REDIS_URL}/`,
    ]);
    assert.equal(calls[3]?.headers.get('x-windy-api-key'), 'test-windy-key');
    assert.ok(calls[3]?.headers.get('User-Agent'));
  });

  it('rejects an unseeded well-formed ID before it can create an image cache key or Windy request', async () => {
    const calls = installProviderAndRedisFixture(['camera-123']);

    const response = await getWebcamImage(ctx(), { webcamId: 'camera-456' });

    assert.equal(response.error, 'unavailable');
    assert.deepEqual(calls.map(call => call.url), [
      `${REDIS_URL}/get/webcam%3Aimage%3Acamera-456`,
      `${REDIS_URL}/get/webcam%3Acameras%3Aactive`,
      `${REDIS_URL}/pipeline`,
    ]);
  });

  it('fails closed on an image-cache miss when the active seed catalog is unavailable', async () => {
    const calls = installProviderAndRedisFixture();

    const response = await getWebcamImage(ctx(), { webcamId: 'camera-123' });

    assert.equal(response.error, 'unavailable');
    assert.deepEqual(calls.map(call => call.url), [
      `${REDIS_URL}/get/webcam%3Aimage%3Acamera-123`,
      `${REDIS_URL}/get/webcam%3Acameras%3Aactive`,
    ]);
  });

  it('reads the seed-owned catalog without a deployment prefix', async () => {
    process.env.VERCEL_ENV = 'preview';
    process.env.VERCEL_GIT_COMMIT_SHA = '1234567890abcdef';
    __resetKeyPrefixCacheForTests();
    const calls = installProviderAndRedisFixture(['camera-123']);

    const response = await getWebcamImage(ctx(), { webcamId: 'camera-123' });

    assert.equal(response.error, '');
    assert.ok(calls.some(call => call.url === `${REDIS_URL}/get/webcam%3Acameras%3Aactive`));
    assert.equal(
      calls.some(call => call.url === `${REDIS_URL}/get/preview%3A12345678%3Awebcam%3Acameras%3Aactive`),
      false,
    );
    const metadataLookup = calls.find(call => call.url === `${REDIS_URL}/pipeline`);
    assert.ok(metadataLookup);
    assert.deepEqual(JSON.parse(metadataLookup.body), [[
      'HMGET',
      'webcam:cameras:meta:20260911',
      'camera-123',
    ]]);
    assert.ok(calls.some(call => call.url.startsWith(WINDY_URL)));
  });

  it('serves a cached image when the seed catalog is unavailable', async () => {
    const cachedImage = {
      thumbnailUrl: 'https://cdn.example/cached-cam.jpg',
      playerUrl: 'https://player.example/cached-cam',
      title: 'Cached camera',
      windyUrl: 'https://www.windy.com/webcams/camera-123',
      lastUpdated: '2026-09-11T00:00:00.000Z',
      error: '',
    };
    const calls = installProviderAndRedisFixture([], cachedImage);

    const response = await getWebcamImage(ctx(), { webcamId: 'camera-123' });

    assert.deepEqual(response, cachedImage);
    assert.deepEqual(calls.map(call => call.url), [
      `${REDIS_URL}/get/webcam%3Aimage%3Acamera-123`,
    ]);
  });

  it('keeps the desktop sidecar image path independent of the cloud seed catalog', async () => {
    process.env.LOCAL_API_MODE = 'tauri-sidecar';
    const calls = installProviderAndRedisFixture();

    const response = await getWebcamImage(ctx(), { webcamId: 'sidecar-camera-123' });

    assert.equal(response.error, '');
    assert.equal(response.thumbnailUrl, 'https://cdn.example/cam.jpg');
    assert.deepEqual(calls.map(call => call.url), [
      `${WINDY_URL}/sidecar-camera-123?include=images,urls`,
    ]);
  });
});

describe('Windy webcam image proxy access contract', () => {
  it('uses a 30/min fail-closed provider-proxy policy', async () => {
    assert.deepEqual(ENDPOINT_RATE_POLICIES[WEBCAM_IMAGE_PATH], { limit: 30, window: '60 s' });
    assert.equal(
      FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED[WEBCAM_IMAGE_PATH]?.reason,
      'Webcam image resolution proxies the Windy provider on cache miss.',
    );

    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    __resetRateLimitForTest();

    const response = await checkEndpointRateLimit(
      new Request(`https://worldmonitor.app${WEBCAM_IMAGE_PATH}`),
      WEBCAM_IMAGE_PATH,
      {},
    );

    assert.ok(response);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('X-RateLimit-Mode'), 'degraded');
  });

  it('fails closed at the gateway before route execution when Redis is unavailable', async () => {
    process.env.WM_SESSION_SECRET = 'webcam-proxy-session-test-secret-at-least-32-chars';
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    __resetRateLimitForTest();

    const { token } = await issueSessionToken();
    let handlerCalls = 0;
    const gateway = createDomainGateway([{
      method: 'GET',
      path: WEBCAM_IMAGE_PATH,
      handler: async () => {
        handlerCalls += 1;
        return Response.json({ ok: true });
      },
    }]);

    const response = await gateway(new Request(`https://worldmonitor.app${WEBCAM_IMAGE_PATH}?webcam_id=camera-123`, {
      headers: {
        Origin: 'https://worldmonitor.app',
        Cookie: `wm-session=${token}`,
      },
    }));

    assert.equal(response.status, 503);
    assert.equal(response.headers.get('X-RateLimit-Mode'), 'degraded');
    assert.equal(handlerCalls, 0, 'the gateway must reject before route execution');
  });

  it('lets the bundled Tauri sidecar webcam gateway run without Upstash', async () => {
    process.env.LOCAL_API_MODE = 'tauri-sidecar';
    process.env.WM_SESSION_SECRET = 'webcam-proxy-session-test-secret-at-least-32-chars';
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    __resetRateLimitForTest();
    const calls = installProviderAndRedisFixture();
    const { token } = await issueSessionToken();

    const response = await webcamGateway(new Request(`http://127.0.0.1:46123${WEBCAM_IMAGE_PATH}?webcam_id=bundled-sidecar-camera-123`, {
      headers: {
        Origin: 'http://127.0.0.1:46123',
        Cookie: `wm-session=${token}`,
      },
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      thumbnailUrl: 'https://cdn.example/cam.jpg',
      playerUrl: 'https://player.example/cam',
      title: 'Test camera',
      windyUrl: 'https://www.windy.com/webcams/bundled-sidecar-camera-123',
      lastUpdated: '2026-09-11T00:00:00.000Z',
      error: '',
    });
    assert.deepEqual(calls.map(call => call.url), [
      `${WINDY_URL}/bundled-sidecar-camera-123?include=images,urls`,
    ]);
  });

  it('keeps other cloud endpoint policies fail closed in Tauri mode', async () => {
    process.env.LOCAL_API_MODE = 'tauri-sidecar';
    process.env.WM_SESSION_SECRET = 'webcam-proxy-session-test-secret-at-least-32-chars';
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    __resetRateLimitForTest();

    const { token } = await issueSessionToken();
    let handlerCalls = 0;
    const gateway = createDomainGateway([{
      method: 'GET',
      path: OTHER_FAIL_CLOSED_PATH,
      handler: async () => {
        handlerCalls += 1;
        return Response.json({ ok: true });
      },
    }]);

    const response = await gateway(new Request(`http://127.0.0.1:46123${OTHER_FAIL_CLOSED_PATH}`, {
      headers: {
        Origin: 'http://127.0.0.1:46123',
        Cookie: `wm-session=${token}`,
      },
    }));

    assert.equal(response.status, 503);
    assert.equal(response.headers.get('X-RateLimit-Mode'), 'degraded');
    assert.equal(handlerCalls, 0, 'only the webcam path may bypass the cloud endpoint limiter');
  });

  it('admits browser cookies and header fallback through an available limiter, but requires a credential', async () => {
    process.env.WM_SESSION_SECRET = 'webcam-proxy-session-test-secret-at-least-32-chars';
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-redis-token';
    const { fetchImpl } = createRedisFetch({});
    globalThis.fetch = fetchImpl;
    __resetRateLimitForTest();

    const { token } = await issueSessionToken();
    let handlerCalls = 0;
    const gateway = createDomainGateway([{
      method: 'GET',
      path: WEBCAM_IMAGE_PATH,
      handler: async () => {
        handlerCalls += 1;
        return Response.json({ ok: true });
      },
    }]);

    assert.equal(PUBLIC_NO_AUTH_RPC_PATHS.has(WEBCAM_IMAGE_PATH), false);
    assert.equal(PREMIUM_RPC_PATHS.has(WEBCAM_IMAGE_PATH), false);

    const response = await gateway(new Request(`https://worldmonitor.app${WEBCAM_IMAGE_PATH}?webcam_id=camera-123`, {
      headers: {
        Origin: 'https://worldmonitor.app',
        'X-WorldMonitor-Key': token,
      },
    }));

    assert.equal(response.status, 200);
    assert.equal(handlerCalls, 1);

    const cookieResponse = await gateway(new Request(`https://worldmonitor.app${WEBCAM_IMAGE_PATH}?webcam_id=camera-123`, {
      headers: {
        Origin: 'https://worldmonitor.app',
        Cookie: `wm-session=${token}`,
      },
    }));

    assert.equal(cookieResponse.status, 200);
    assert.equal(handlerCalls, 2);

    const unauthenticatedResponse = await gateway(new Request(`https://worldmonitor.app${WEBCAM_IMAGE_PATH}?webcam_id=camera-123`, {
      headers: { Origin: 'https://worldmonitor.app' },
    }));

    assert.equal(unauthenticatedResponse.status, 401);
    assert.equal(handlerCalls, 2, 'a credential-less request must not reach the route');
  });
});
