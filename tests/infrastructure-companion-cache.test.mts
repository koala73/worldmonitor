import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { build } from 'esbuild';

// Keep the real service, breaker, generated HTTP client/router, error mapper,
// and Redis reader together. Only the Redis HTTP transport and clock are controlled.
let bundledSource: string;
before(async () => {
  const result = await build({
    stdin: {
      contents: `
        export { fetchDdosAttacks, fetchTrafficAnomalies } from './src/services/infrastructure/index.ts';
        import { createInfrastructureServiceRoutes } from './src/generated/server/worldmonitor/infrastructure/v1/service_server.ts';
        import { listInternetDdosAttacks } from './server/worldmonitor/infrastructure/v1/list-ddos-attacks.ts';
        import { listInternetTrafficAnomalies } from './server/worldmonitor/infrastructure/v1/list-traffic-anomalies.ts';
        import { mapErrorToResponse } from './server/error-mapper.ts';
        export const routes = createInfrastructureServiceRoutes(
          { listInternetDdosAttacks, listInternetTrafficAnomalies }, { onError: mapErrorToResponse });
      `,
      resolveDir: process.cwd(), loader: 'ts',
    },
    bundle: true, write: false, format: 'esm', platform: 'node',
    define: { 'import.meta.env': '{"DEV":false}' }, logLevel: 'silent',
  });
  bundledSource = result.outputFiles[0]!.text;
});

const ddos = {
  protocol: [{ label: 'TCP', percentage: 80 }], vector: [],
  dateRangeStart: '2026-09-01', dateRangeEnd: '2026-09-08', topTargetLocations: [],
};
const emptyDdos = { ...ddos, protocol: [] };
const traffic = { anomalies: [{ id: 'traffic-us', locationCode: 'US' }], totalCount: 1 };
const emptyTraffic = { anomalies: [], totalCount: 0 };
const ttl = 30 * 60 * 1000;

for (const kind of ['ddos', 'traffic', 'country'] as const) {
  test(`${kind}: confirmed empty replaces stale data; failed Redis reads preserve last-good`, async (t) => {
    const harness = await import(`data:text/javascript;base64,${Buffer.from(bundledSource).toString('base64')}#${kind}`);
    const read = kind === 'ddos' ? harness.fetchDdosAttacks
      : () => harness.fetchTrafficAnomalies(kind === 'country' ? 'US' : undefined);
    const good = kind === 'ddos' ? ddos : traffic;
    const empty = kind === 'ddos' ? emptyDdos : emptyTraffic;
    let payload: unknown = good;
    let failure: 'http' | 'network' | 'command' | 'json' | 'timeout' | undefined;
    let now = Date.now();
    const statuses: number[] = [];
    t.mock.method(Date, 'now', () => now);
    // Expected failure logs would otherwise contain the entire data-URL bundle.
    const logs: string[] = [];
    const recordLog = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    t.mock.method(console, 'warn', recordLog);
    t.mock.method(console, 'error', recordLog);
    const env = { ...process.env };
    t.after(() => { process.env = env; });
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.fixture';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
    delete process.env.LOCAL_API_MODE;
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
      const rawUrl = input instanceof Request ? input.url : String(input);
      const url = new URL(rawUrl, 'https://app.fixture');
      if (url.origin === 'https://redis.fixture') {
        assert.equal(decodeURIComponent(url.pathname), `/get/cf:radar:${kind === 'ddos' ? 'ddos' : 'traffic-anomalies'}:v1`);
        if (failure === 'timeout') throw new DOMException('fixture timeout', 'TimeoutError');
        if (failure === 'network') throw new TypeError('fetch failed');
        if (failure === 'http') return new Response('', { status: 503 });
        if (failure === 'command') return Response.json({ error: 'fixture read failure' });
        if (failure === 'json') return Response.json({ result: '{broken' });
        return Response.json({ result: payload === null ? null : JSON.stringify(payload) });
      }
      const route = harness.routes.find((r: { path: string }) => r.path === url.pathname);
      assert.ok(route, `unexpected request: ${url}`);
      const response = await route.handler(new Request(url));
      statuses.push(response.status);
      return response;
    });

    async function refresh(expected: unknown, status: number) {
      now += ttl + 1;
      const count = statuses.length;
      await read(); // SWR may serve the old value while refreshing.
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(statuses.length, count + 1);
      assert.equal(statuses.at(-1), status);
      assert.deepEqual(await read(), expected);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    assert.deepEqual(await read(), good);
    for (const error of ['http', 'network', 'command', 'json', 'timeout'] as const) {
      failure = error;
      logs.length = 0;
      await refresh(good, 503);
      if (error === 'timeout') {
        assert.ok(logs.some((line) => line.includes(`[REDIS-TIMEOUT] getCachedJson key=cf:radar:${kind === 'ddos' ? 'ddos' : 'traffic-anomalies'}:v1`)));
      } else {
        assert.ok(logs.some((line) => line.startsWith('[redis] getCachedJson failed:')));
      }
      failure = undefined;
      await refresh(good, 200);
    }
    for (const invalid of [null, {}, { anomalies: null, protocol: null }]) {
      payload = invalid;
      await refresh(good, 503);
      payload = good;
      await refresh(good, 200);
    }
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    await refresh(good, 503);
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
    await refresh(good, 200);
    payload = empty;
    await refresh(empty, 200);
    failure = 'http';
    await refresh(empty, 503);
    failure = undefined;
    payload = { _seed: { fetchedAt: now, state: 'OK' }, data: good };
    await refresh(good, 200);
    if (kind === 'country') {
      payload = { anomalies: [traffic.anomalies[0], { id: 'traffic-fr', locationCode: 'FR' }], totalCount: 2 };
      await refresh({ anomalies: traffic.anomalies, totalCount: 2 }, 200);
      payload = { anomalies: [{ id: 'traffic-fr', locationCode: 'FR' }], totalCount: 1 };
      await refresh({ anomalies: [], totalCount: 1 }, 200);
    }
  });
}
