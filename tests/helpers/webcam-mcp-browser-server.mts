import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mcpHandler } from '../../api/mcp/handler.ts';
import { createWebcamServiceRoutes } from '../../src/generated/server/worldmonitor/webcam/v1/service_server.ts';
import { listWebcams } from '../../server/worldmonitor/webcam/v1/list-webcams.ts';
import { getWebcamImage } from '../../server/worldmonitor/webcam/v1/get-webcam-image.ts';
import { mapErrorToResponse } from '../../server/error-mapper.ts';
import { __resetKeyPrefixCacheForTests } from '../../server/_shared/redis.ts';
import { HMAC_SECRET, makeProDeps } from './mcp-pro-deps.mjs';

const originalFetch = globalThis.fetch;
const REDIS = 'https://webcam-e2e-redis.invalid';
const camera = { webcamId: '123', title: 'Synthetic port camera', lat: 51.5, lng: 4.5, category: 'harbor', country: 'NL' };
const provider = {
  webcamId: 123, status: 'active', title: camera.title, lastUpdatedOn: '2026-10-01T12:00:00Z',
  images: { current: { preview: 'https://images.windy.com/fixture.jpg' } },
  player: { day: 'https://webcams.windy.com/webcams/public/embed/player/123/day' },
  urls: { detail: 'https://www.windy.com/webcams/123' },
};
const routes = createWebcamServiceRoutes({ listWebcams, getWebcamImage }, { onError: mapErrorToResponse });
let store = new Map<string, unknown>();
let providerCalls = 0;
let providerStatus = 200;
let routeCalls: string[] = [];
let deps = makeProDeps().deps;
let origin = '';

Object.assign(process.env, {
  VERCEL_ENV: 'production', WINDY_API_KEY: 'fixture', MCP_TELEMETRY: 'false',
  MCP_INTERNAL_HMAC_SECRET: HMAC_SECRET,
  UPSTASH_REDIS_REST_URL: REDIS, UPSTASH_REDIS_REST_TOKEN: 'fixture',
});
delete process.env.LOCAL_API_MODE;

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin === origin) return originalFetch(input, init);
  if (url.origin === 'https://api.windy.com') {
    providerCalls++;
    return providerStatus === 200 ? Response.json(provider) : new Response('', { status: providerStatus });
  }
  assert.equal(url.origin, REDIS, 'unexpected outbound request');
  if (url.pathname.startsWith('/get/')) {
    const value = store.get(decodeURIComponent(url.pathname.slice(5)));
    return Response.json({ result: value === undefined ? null : JSON.stringify(value) });
  }
  const body = JSON.parse(String(init?.body));
  if (url.pathname === '/pipeline') {
    const [command] = body;
    if (command[0] === 'GEOSEARCH') return Response.json([{ result: [camera.webcamId] }]);
    assert.equal(command[0], 'HMGET');
    return Response.json([{ result: command.slice(2).map((id: string) => id === camera.webcamId ? JSON.stringify(camera) : null) }]);
  }
  assert.equal(body[0], 'SET');
  store.set(body[1], JSON.parse(body[2]));
  return Response.json({ result: 'OK' });
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url!, origin);
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>MCP webcam browser test</title><h1>MCP webcam browser test</h1><p>Synthetic data; real local MCP and WebcamService handlers.</p>');
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    const request = new Request(url, { method: req.method, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
    let response: Response;
    if (url.pathname === '/mcp') response = await mcpHandler(request, deps);
    else {
      const route = routes.find(candidate => candidate.path === url.pathname);
      if (!route) { res.writeHead(404); res.end(); return; }
      routeCalls.push(url.pathname);
      response = await route.handler(request);
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(String(error));
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address !== 'string');
origin = `http://127.0.0.1:${address.port}`;
process.on('message', action => {
  switch (action) {
    case 'reset':
      store = new Map<string, unknown>([
        ['webcam:cameras:active', 'fixture-v1'],
        ['seed-meta:webcam:cameras:geo', { fetchedAt: Date.now(), recordCount: 1 }],
      ]);
      providerCalls = 0;
      providerStatus = 200;
      routeCalls = [];
      deps = makeProDeps().deps;
      process.env.WINDY_API_KEY = 'fixture';
      __resetKeyPrefixCacheForTests();
      break;
    case 'missing-key': delete process.env.WINDY_API_KEY; break;
    case 'restore-key': process.env.WINDY_API_KEY = 'fixture'; break;
    case 'missing-catalog': store.delete('webcam:cameras:active'); break;
    case 'restore-catalog': store.set('webcam:cameras:active', 'fixture-v1'); break;
    case 'provider-failure': providerStatus = 503; break;
    case 'expired-media': store.set('webcam:image:123', { thumbnailUrl: provider.images.current.preview, error: '', resolvedAt: Date.now() - 600_000 }); break;
    case 'stats': break;
    default: throw new Error(`Unknown fixture action: ${action}`);
  }
  process.send?.({ origin, providerCalls, routeCalls });
});
process.on('disconnect', () => process.exit());
process.send?.({ origin });
