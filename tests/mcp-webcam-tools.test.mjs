import assert from 'node:assert/strict';
import { beforeEach, afterEach, it } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { TOOL_REGISTRY, buildPublicTool, toolAccess, toolWeight } from '../api/mcp/registry/index.ts';
import { validateToolArgs } from '../api/mcp/_validate-args.ts';
import { dispatchToolsCall } from '../api/mcp/dispatch.ts';
import { RpcValidationError } from '../api/mcp/billing-denial.ts';
import { createWebcamServiceRoutes } from '../src/generated/server/worldmonitor/webcam/v1/service_server.ts';
import { listWebcams } from '../server/worldmonitor/webcam/v1/list-webcams.ts';
import { getWebcamImage } from '../server/worldmonitor/webcam/v1/get-webcam-image.ts';
import { mapErrorToResponse } from '../server/error-mapper.ts';
import { __resetKeyPrefixCacheForTests } from '../server/_shared/redis.ts';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const BASE = 'https://api.worldmonitor.app';
const REDIS = 'https://webcam-redis.invalid';
const ctx = { kind: 'env_key', apiKey: 'synthetic-key' };
const bounds = { bound_w: 4, bound_s: 51, bound_e: 5, bound_n: 52, zoom: 9 };
const find = TOOL_REGISTRY.find(t => t.name === 'find_webcams');
const media = TOOL_REGISTRY.find(t => t.name === 'get_webcam_media');
const routes = createWebcamServiceRoutes({ listWebcams, getWebcamImage }, { onError: mapErrorToResponse });
const camera = { webcamId: '123', title: 'Port camera', lat: 51.5, lng: 4.5, category: 'harbor', country: 'NL' };
const provider = {
  webcamId: 123, status: 'active', title: 'Port camera', lastUpdatedOn: '2026-10-01T12:00:00Z',
  images: { current: { preview: 'https://images.windy.com/preview.jpg' } },
  player: { day: 'https://webcams.windy.com/webcams/public/embed/player/123/day' },
  urls: { detail: 'https://www.windy.com/webcams/123' },
};
let store;
let cameras;
let calls;
let failRoute;
let failRouteHeaders;
let providerStatus;
let providerThrows;
let routeReply;
let expiredSeed;
let bodyFailure;
const run = (tool, args) => { validateToolArgs(tool, args); return tool._execute(args, BASE, ctx); };
function validOutput(tool, output) {
  const check = new Ajv2020({ strict: true, strictRequired: false }).compile(tool.outputSchema);
  assert.equal(check(output), true, JSON.stringify(check.errors));
}
beforeEach(() => {
  calls = [];
  cameras = [camera];
  failRoute = 0;
  failRouteHeaders = {};
  providerStatus = 200;
  providerThrows = false;
  routeReply = null;
  expiredSeed = false;
  bodyFailure = '';
  store = new Map([
    ['webcam:cameras:active', 'v1'],
    ['seed-meta:webcam:cameras:geo', { fetchedAt: Date.now(), recordCount: 1 }],
  ]);
  process.env.VERCEL_ENV = 'production';
  process.env.WINDY_API_KEY = 'synthetic-key';
  process.env.UPSTASH_REDIS_REST_URL = REDIS;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
  delete process.env.LOCAL_API_MODE;
  __resetKeyPrefixCacheForTests();
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.origin === BASE) {
      assert.equal(new Headers(init.headers).get('X-WorldMonitor-Key'), 'synthetic-key');
      assert.ok(new Headers(init.headers).get('User-Agent'));
      if (failRoute) return new Response('', { status: failRoute, headers: failRouteHeaders });
      if (bodyFailure === 'malformed') return new Response('invalid JSON');
      if (bodyFailure === 'interrupted') return new Response(new ReadableStream({
        start(controller) { controller.error(new TypeError('fixture interrupted body')); },
      }));
      if (routeReply) return Response.json(routeReply);
      const route = routes.find(r => r.path === url.pathname);
      assert.ok(route, `must use an existing shared WebcamService route: ${url.pathname}`);
      return route.handler(new Request(url, init));
    }
    if (url.origin === 'https://api.windy.com') {
      if (providerThrows) throw new TypeError('controlled provider outage');
      return providerStatus === 200 ? Response.json(provider) : new Response('', { status: providerStatus });
    }
    assert.equal(url.origin, REDIS, 'tests must never fetch live services or media');
    if (url.pathname.startsWith('/get/')) {
      const key = decodeURIComponent(url.pathname.slice(5));
      return Response.json({ result: store.has(key) ? JSON.stringify(store.get(key)) : null });
    }
    const body = JSON.parse(init.body);
    if (url.pathname === '/pipeline') {
      const [command] = body;
      if (command[0] === 'EXISTS') return Response.json([{ result: expiredSeed ? 0 : 2 }]);
      if (command[0] === 'GEOSEARCH') {
        // Dateline viewports make two disjoint queries; each fixture row belongs to one side.
        const longitude = Number(command[3]);
        const rows = Math.abs(longitude) > 170 ? cameras.filter(c => Math.sign(c.lng) === Math.sign(longitude)) : cameras;
        return Response.json([{ result: rows.map(c => c.webcamId) }]);
      }
      assert.equal(command[0], 'HMGET');
      return Response.json([{ result: command.slice(2).map(id => {
        const row = cameras.find(c => c.webcamId === id);
        return row ? JSON.stringify(row) : null;
      }) }]);
    }
    assert.equal(body[0], 'SET');
    store.set(body[1], JSON.parse(body[2]));
    return Response.json({ result: 'OK' });
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  __resetKeyPrefixCacheForTests();
});
const providerCalls = () => calls.filter(url => url.origin === 'https://api.windy.com');
const routeCalls = () => calls.filter(url => url.origin === BASE);

it('advertises both bounded tools with complete schemas, parity, projection and access metadata', () => {
  for (const tool of [find, media]) {
    assert.ok(tool);
    assert.equal(toolAccess(tool), 'subscription');
    assert.equal(toolWeight(tool), 2);
    assert.ok(buildPublicTool(tool, { compressDescriptions: false }).inputSchema.properties.jmespath);
    assert.ok(tool._attribution);
  }
  assert.deepEqual(find._apiPaths, ['GET /api/webcam/v1/list-webcams']);
  assert.deepEqual(media._apiPaths, ['GET /api/webcam/v1/get-webcam-image']);
  assert.ok(find._coverageKeys.includes('webcam:cameras:active'));
  assert.equal(find.inputSchema.properties.country_code, undefined);
  assert.equal(find.inputSchema.properties.category, undefined);
});

it('discovers via the real shared seeded viewport handler without provider calls', async () => {
  const result = await run(find, bounds);
  assert.equal(result.state, 'available');
  assert.deepEqual(result.webcams, [camera]);
  assert.equal(result.totalInView, 1);
  assert.equal(result.catalog.stale, false);
  assert.ok(result.catalog.cached_at);
  assert.equal(providerCalls().length, 0);
  assert.equal(routeCalls().length, 1);
  assert.equal(routeCalls()[0].searchParams.get('zoom'), '9');
  validOutput(find, result);
});

it('bounds camera and cluster rows together and preserves the shared total', async () => {
  routeReply = { webcams: [camera, { ...camera, webcamId: '456' }], clusters: [{ lat: 51, lng: 4, count: 3, categories: ['city'] }], totalInView: 5 };
  const result = await run(find, { ...bounds, limit: 2 });
  assert.equal(result.webcams.length + result.clusters.length, 2);
  assert.equal(result.totalInView, 5);
  assert.equal(result.truncated, true);
  validOutput(find, result);
});

it('returns clusters from low zoom and forwards an antimeridian viewport unchanged', async () => {
  cameras = [{ ...camera, lng: 179.5 }, { ...camera, webcamId: '456', lng: 179.5 }];
  const result = await run(find, { ...bounds, bound_w: 179, bound_e: -179, zoom: 2 });
  assert.equal(result.clusters[0].count, 2);
  assert.equal(result.webcams.length, 0);
  assert.equal(routeCalls()[0].searchParams.get('bound_w'), '179');
  assert.equal(routeCalls()[0].searchParams.get('bound_e'), '-179');
  assert.equal(providerCalls().length, 0);
});

it('distinguishes an empty viewport from a missing catalog and marks unknown freshness stale', async () => {
  cameras = [];
  const empty = await run(find, bounds);
  assert.equal(empty.state, 'available');
  assert.equal(empty.totalInView, 0);
  store.delete('webcam:cameras:active');
  store.delete('seed-meta:webcam:cameras:geo');
  const missing = await run(find, bounds);
  assert.equal(missing.state, 'unavailable');
  assert.equal(missing.catalog.stale, true);
  assert.equal(missing.catalog.cached_at, null);
  validOutput(find, missing);
});

it('reports an expired geo seed as unavailable while the longer-lived active pointer remains', async () => {
  cameras = [];
  expiredSeed = true;
  const result = await run(find, bounds);
  assert.equal(result.state, 'unavailable');
  assert.equal(result.reason, 'catalog_unavailable');
  assert.equal(result.catalog.stale, true);
  assert.equal(providerCalls().length, 0);
  validOutput(find, result);
});

for (const meta of [null, { fetchedAt: Date.now() - 25 * 3600_000, recordCount: 1 }, { fetchedAt: Date.now(), recordCount: 0 }, { fetchedAt: Date.now(), recordCount: 1, status: 'error' }]) {
  it(`keeps stale or missing catalog metadata separate from media capture time: ${JSON.stringify(meta)}`, async () => {
    store.set('seed-meta:webcam:cameras:geo', meta);
    assert.equal((await run(find, bounds)).catalog.stale, true);
  });
}

it('reads seed freshness without the preview deployment prefix', async () => {
  process.env.VERCEL_ENV = 'preview';
  process.env.VERCEL_GIT_COMMIT_SHA = '123456789';
  assert.equal((await run(find, bounds)).catalog.stale, false);
  assert.ok(calls.some(u => decodeURIComponent(u.pathname) === '/get/seed-meta:webcam:cameras:geo'));
});

it('resolves one discovered camera through the real shared route with exactly one Windy request', async () => {
  const result = await run(media, { webcam_id: '123' });
  assert.equal(result.state, 'available');
  assert.equal(result.thumbnailUrl, provider.images.current.preview);
  assert.equal(result.playerUrl, provider.player.day);
  assert.equal(result.windyUrl, provider.urls.detail);
  assert.equal(result.lastUpdated, '2026-10-01T12:00:00.000Z');
  assert.equal(Date.parse(result.refreshAfter) - Date.parse(result.resolvedAt), 300_000);
  assert.equal(result.mediaType, 'timelapse');
  assert.equal(providerCalls().length, 1);
  assert.equal(routeCalls().length, 1);
  assert.equal(routeCalls()[0].searchParams.get('webcam_id'), '123');
  assert.match(result.source.attribution, /Windy.com/);
  assert.equal(result.source.url, provider.urls.detail);
  assert.match(result.context, /does not confirm current conditions/);
  validOutput(media, result);
});

for (const problem of ['missing-key', 'missing-catalog', 'unknown-id', 'provider-404', 'provider-503', 'network']) {
  it(`returns structured unavailable for ${problem} without a provider fan-out`, async () => {
    if (problem === 'missing-key') delete process.env.WINDY_API_KEY;
    if (problem === 'missing-catalog') store.delete('webcam:cameras:active');
    if (problem === 'unknown-id') cameras = [];
    if (problem === 'provider-404') providerStatus = 404;
    if (problem === 'provider-503') providerStatus = 503;
    if (problem === 'network') providerThrows = true;
    const result = await run(media, { webcam_id: '123' });
    assert.equal(result.state, 'unavailable');
    assert.equal(result.thumbnailUrl, '');
    assert.equal(result.playerUrl, '');
    assert.ok(providerCalls().length <= 1);
    validOutput(media, result);
  });
}

it('rejects expired media without retrying or publishing expired URLs', async () => {
  store.set('webcam:image:123', { thumbnailUrl: provider.images.current.preview, playerUrl: '', windyUrl: provider.urls.detail, title: 'Old cached media', error: '', lastUpdated: provider.lastUpdatedOn, resolvedAt: Date.now() - 600_000, mediaType: 'snapshot' });
  const result = await run(media, { webcam_id: '123' });
  assert.equal(result.state, 'unavailable');
  assert.equal(result.reason, 'media_expired');
  assert.equal(result.thumbnailUrl, '');
  assert.equal(providerCalls().length, 0);
});

it('never relabels legacy cached URLs with the current resolution time', async () => {
  store.set('webcam:image:123', { thumbnailUrl: provider.images.current.preview, playerUrl: '', windyUrl: provider.urls.detail, title: 'Legacy cached media', error: '', lastUpdated: provider.lastUpdatedOn });
  const result = await run(media, { webcam_id: '123' });
  assert.equal(result.reason, 'resolution_time_unknown');
  assert.equal(result.resolvedAt, '');
  assert.equal(providerCalls().length, 0);
});

for (const tool of [find, media]) {
  for (const failure of ['malformed', 'interrupted']) {
    it(`${tool.name} reports a ${failure} downstream response body as unavailable`, async () => {
      bodyFailure = failure;
      const result = await run(tool, tool === find ? bounds : { webcam_id: '123' });
      assert.equal(result.state, 'unavailable');
      assert.equal(result.reason, tool === find ? 'catalog_unavailable' : 'provider_unavailable');
      assert.equal(providerCalls().length, 0);
      validOutput(tool, result);
    });
  }

  it(`${tool.name} preserves retryable gateway billing denials through dispatch`, async () => {
    failRoute = 503;
    failRouteHeaders = { 'X-Billing-Verification': 'entitlement_verification_unavailable', 'Retry-After': '17' };
    const response = await dispatchToolsCall(
      new Request('https://worldmonitor.app/mcp', { method: 'POST' }), ctx,
      { redisPipeline: async () => [{ result: 1 }, { result: 1 }] },
      { id: 1, params: { name: tool.name, arguments: tool === find ? bounds : { webcam_id: '123' } } }, {},
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('X-Billing-Verification'), 'entitlement_verification_unavailable');
    assert.equal(response.headers.get('Retry-After'), '17');
    assert.equal((await response.json()).error.data.code, 'entitlement_verification_unavailable');
    assert.equal(providerCalls().length, 0);
  });

  it(`${tool.name} preserves auth and rate-limit errors instead of describing them as missing media`, async () => {
    for (const status of [401, 403, 429]) {
      failRoute = status;
      await assert.rejects(run(tool, tool === find ? bounds : { webcam_id: '123' }));
    }
  });
}

it('rejects missing, non-finite, oversized and invalid input before any network work', async () => {
  for (const args of [{}, { ...bounds, bound_s: 53 }, { ...bounds, bound_w: 999 }, { ...bounds, zoom: 1.5 }, { ...bounds, bound_n: NaN }, { ...bounds, limit: 201 }]) {
    assert.throws(() => run(find, args), RpcValidationError);
  }
  for (const webcam_id of ['', 'x'.repeat(65), '../camera', 'id,id2']) assert.throws(() => run(media, { webcam_id }), RpcValidationError);
  assert.equal(calls.length, 0);
});

it('applies normal JMESPath through dispatch and retains Windy courtesy and image linking', async () => {
  const response = await dispatchToolsCall(
    new Request('https://worldmonitor.app/mcp', { method: 'POST' }), ctx,
    { redisPipeline: async () => [{ result: 1 }, { result: 1 }] },
    { id: 1, params: { name: 'get_webcam_media', arguments: { webcam_id: '123', jmespath: '{image: thumbnailUrl, captured: lastUpdated}' } } }, {},
  );
  const body = await response.json();
  const result = JSON.parse(body.result.content[0].text);
  assert.equal(result.data.image, provider.images.current.preview);
  assert.equal(result.data.captured, '2026-10-01T12:00:00.000Z');
  assert.equal(result._attribution.required, true);
  assert.equal(result._attribution.sources[0].url, provider.urls.detail);
  assert.match(result._attribution.sources[0].attribution, /Windy/);
});
