import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';

const serverRoot = new URL('../src/generated/server/worldmonitor/', import.meta.url);
const serverFiles = readdirSync(serverRoot, { recursive: true })
  .filter((file) => file.endsWith('/service_server.ts'));
const privateDetail = 'private-password at /srv/private/worker.ts:42';

function requestFor(route: { path: string; method: string }): Request {
  return new Request(`https://worldmonitor.invalid${route.path}`, {
    method: route.method,
    ...(route.method === 'POST' ? { body: '{}' } : {}),
  });
}

test('every generated RPC hides unexpected exception details', async (t) => {
  assert.ok(serverFiles.length > 0);
  for (const file of serverFiles) {
    await t.test(file, async () => {
      const module = await import(new URL(file, serverRoot).href);
      const factory = Object.entries(module).find(([name]) => /^create.*ServiceRoutes$/.test(name))?.[1];
      assert.equal(typeof factory, 'function');
      for (const thrown of [new Error(privateDetail), privateDetail]) {
        let calls = 0;
        const handler = new Proxy({}, {
          get: () => async () => { calls++; throw thrown; },
        });
        const routes = factory(handler);
        assert.ok(routes.length > 0);
        for (const route of routes) {
          const response = await route.handler(requestFor(route));
          assert.equal(response.status, 500, route.path);
          assert.equal(response.headers.get('Content-Type'), 'application/json');
          assert.deepEqual(await response.json(), { message: 'Internal server error' }, route.path);
        }
        assert.equal(calls, routes.length, 'each request must reach its handler');
      }
    });
  }
});

test('generated routes preserve custom errors and request validation', async () => {
  const { createNewsServiceRoutes, ValidationError } = await import('../src/generated/server/worldmonitor/news/v1/service_server.ts');
  const error = new Error(privateDetail);
  const handler = new Proxy({}, { get: () => async () => { throw error; } });
  const request = requestFor(createNewsServiceRoutes(handler)[0]!);
  let observed: unknown;
  const customRoute = createNewsServiceRoutes(handler, {
    onError: (err, req) => {
      observed = err;
      assert.equal(req, request);
      return new Response('Service unavailable', { status: 503, headers: { 'Retry-After': '30' } });
    },
  })[0]!;
  const custom = await customRoute.handler(request);
  assert.equal(observed, error);
  assert.equal(custom.status, 503);
  assert.equal(custom.headers.get('Retry-After'), '30');
  assert.equal(await custom.text(), 'Service unavailable');

  const violations = [{ field: 'query', description: 'required' }];
  const validationHandler = new Proxy({}, {
    get: () => async () => { throw new ValidationError(violations); },
  });
  const validationRoute = createNewsServiceRoutes(validationHandler)[0]!;
  const validation = await validationRoute.handler(requestFor(validationRoute));
  assert.equal(validation.status, 400);
  assert.deepEqual(await validation.json(), { violations });
});
