import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { build } from 'esbuild';

const good = {
  threats: [{
    id: 'fixture', type: 'CYBER_THREAT_TYPE_C2_SERVER', source: 'CYBER_THREAT_SOURCE_FEODO',
    indicator: '192.0.2.1', indicatorType: 'CYBER_THREAT_INDICATOR_TYPE_IP',
    location: { latitude: 1, longitude: 2 }, country: 'XX', severity: 'CRITICALITY_LEVEL_HIGH',
    malwareFamily: '', tags: [], firstSeenAt: 0, lastSeenAt: 0,
  }],
};
let harnessId = 0;

async function createHarness(t: TestContext) {
  const built = await build({
    stdin: {
      contents: `
        export const harnessId = ${++harnessId};
        export { fetchCyberThreats } from './src/services/cyber/index.ts';
        import { createCyberServiceRoutes } from './src/generated/server/worldmonitor/cyber/v1/service_server.ts';
        import { listCyberThreats } from './server/worldmonitor/cyber/v1/list-cyber-threats.ts';
        import { mapErrorToResponse } from './server/error-mapper.ts';
        export const routes = createCyberServiceRoutes({ listCyberThreats }, { onError: mapErrorToResponse });
      `,
      resolveDir: process.cwd(), loader: 'ts',
    },
    bundle: true, write: false, format: 'esm', platform: 'node',
    define: { 'import.meta.env': '{"DEV":false}' }, logLevel: 'silent',
  });
  const harness = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0]!.text).toString('base64')}`);
  const env = { ...process.env };
  t.after(() => { process.env = env; });
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.fixture';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
  delete process.env.LOCAL_API_MODE;
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const state = { payload: good as unknown, hydrated: undefined as unknown, failure: false, statuses: [] as number[] };
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'https://app.fixture');
    if (url.pathname === '/api/bootstrap') {
      return Response.json({ data: state.hydrated === undefined ? {} : { cyberThreats: state.hydrated } });
    }
    if (url.origin === 'https://redis.fixture') {
      if (state.failure) throw new TypeError('offline');
      return Response.json({ result: state.payload === null ? null : JSON.stringify(state.payload) });
    }
    return request(url);
  });
  async function request(url: URL) {
    const route = harness.routes.find((r: { path: string }) => r.path === url.pathname);
    assert.ok(route);
    const response = await route.handler(new Request(url));
    state.statuses.push(response.status);
    return response;
  }
  return {
    state, fetch: harness.fetchCyberThreats as () => Promise<unknown[]>,
    advance: () => { now += 10 * 60 * 1000 + 1; },
    settle: () => new Promise<void>(resolve => setImmediate(resolve)),
    request: (query = '') => request(new URL(`/api/cyber/v1/list-cyber-threats${query}`, 'https://app.fixture')),
  };
}

test('cyber RPC preserves last-good through unavailable snapshots and recovers to empty', async t => {
  const h = await createHarness(t);
  const initial = await h.fetch();
  assert.equal(initial.length, 1);
  async function refresh(expected: unknown, status: number) {
    h.advance();
    await h.fetch();
    await h.settle();
    assert.equal(h.state.statuses.at(-1), status);
    assert.deepEqual(await h.fetch(), expected);
    await h.settle();
  }
  for (const bad of [null, {}, { threats: null }, { threats: [null] }, { threats: [{}] }]) {
    h.state.payload = bad;
    await refresh(initial, 503);
    h.state.payload = good;
    await refresh(initial, 200);
  }
  h.state.failure = true;
  await refresh(initial, 503);
  h.state.failure = false;
  h.state.payload = { threats: [] };
  await refresh([], 200);
  h.state.failure = true;
  await refresh([], 503);
  h.state.failure = false;
  h.state.payload = good;
  await refresh(initial, 200);
});

test('successful on-demand hydration becomes last-good, including confirmed empty', async t => {
  const h = await createHarness(t);
  h.state.hydrated = good;
  const initial = await h.fetch();
  assert.equal(initial.length, 1);
  assert.equal(h.state.statuses.length, 0);
  h.state.hydrated = undefined;
  h.state.failure = true;
  h.advance();
  assert.deepEqual(await h.fetch(), initial);
  await h.settle();
  assert.equal(h.state.statuses.at(-1), 503);
  h.state.hydrated = { threats: [] };
  assert.deepEqual(await h.fetch(), []);
  h.state.hydrated = undefined;
  h.advance();
  assert.deepEqual(await h.fetch(), []);
  await h.settle();
  assert.deepEqual(await h.fetch(), []);
});

test('cold-cache unavailability rejects instead of reporting a healthy empty feed', async t => {
  const h = await createHarness(t);
  h.state.payload = null;
  await assert.rejects(h.fetch(), /unavailable/i);
  assert.equal(h.state.statuses.at(-1), 503);
  h.state.payload = { threats: [] };
  h.advance();
  assert.deepEqual(await h.fetch(), []);
});

test('malformed entries cannot become cached successes through RPC or hydration', async t => {
  const h = await createHarness(t);
  const initial = await h.fetch();
  for (const threat of [null, {}, { ...good.threats[0], lastSeenAt: 1e20 }]) {
    h.state.payload = { threats: [threat] };
    const response = await h.request('?type=CYBER_THREAT_TYPE_C2_SERVER');
    assert.equal(response.status, 503);
    h.state.hydrated = h.state.payload;
    h.advance();
    assert.deepEqual(await h.fetch(), initial);
    await h.settle();
  }
});
