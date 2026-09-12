import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { listAirportDelays } from '../server/worldmonitor/aviation/v1/list-airport-delays.ts';
import bootstrap from '../api/bootstrap.js';
import { buildDelaysBootstrapPayload, BOOTSTRAP_KEY, BOOTSTRAP_META_KEY } from '../scripts/seed-aviation.mjs';
import { MONITORED_AIRPORTS } from '../src/config/airports.ts';

const FAA_KEY = 'aviation:delays:faa:v1';
const INTL_KEY = 'aviation:delays:intl:v3';
const coverage = [{ iata: 'LHR', status: 'normal', flightCount: 12 }];
const faa = { alerts: [] };
const intl = { alerts: [], coverage };

for (const mode of ['healthy', 'miss', 'intl-error', 'timeout'] as const) {
  test(`airport RPC preserves the producer bootstrap and metadata after ${mode} source reads`, async (t) => {
    for (const [name, value] of Object.entries({
      UPSTASH_REDIS_REST_URL: 'https://redis.test', UPSTASH_REDIS_REST_TOKEN: 'fixture-token',
      VERCEL_ENV: 'production', ICAO_API_KEY: undefined, SEED_FALLBACK_NOTAM: undefined,
      BOOTSTRAP_R2_SHADOW_MEASURE: '0',
    })) {
      const original = process.env[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
      t.after(() => {
        if (original === undefined) delete process.env[name];
        else process.env[name] = original;
      });
    }
    const seeded = buildDelaysBootstrapPayload({
      faaPayload: faa, intlPayload: intl, notamPayload: null,
      fillerRegistry: MONITORED_AIRPORTS.filter(a => ['JFK', 'LHR'].includes(a.iata)),
    });
    const originalPayload = JSON.stringify(seeded);
    const originalMeta = JSON.stringify({ fetchedAt: 1_789_000_000_000, recordCount: seeded.alerts.length });
    const store = new Map([[BOOTSTRAP_KEY, originalPayload], [BOOTSTRAP_META_KEY, originalMeta]]);
    let bootstrapTtl = 3_600;
    const writes: unknown[][] = [];
    const reads: string[] = [];
    const origins = new Set<string>();
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      origins.add(url.origin);
      assert.equal(url.origin, 'https://redis.test', 'no provider access allowed');
      if (url.pathname.startsWith('/get/')) {
        const key = decodeURIComponent(url.pathname.slice(5));
        reads.push(key);
        if ([FAA_KEY, INTL_KEY].includes(key)) {
          if (mode === 'timeout') {
            await delay(5_000, undefined, { signal: init?.signal ?? undefined });
            assert.fail('cache read must abort before five seconds');
          }
          if (mode === 'intl-error' && key === INTL_KEY) return Response.json({ error: 'fixture read failure' }, { status: 503 });
          if (mode === 'miss') return Response.json({ result: null });
          return Response.json({ result: JSON.stringify(key === FAA_KEY ? faa : intl) });
        }
        return Response.json({ result: null });
      }
      const command = JSON.parse(String(init?.body));
      if (url.pathname === '/pipeline') {
        assert.ok(command.every(([op]: string[]) => op === 'GET'));
        return Response.json(command.map(([, key]: string[]) => ({ result: store.get(key) ?? null })));
      }
      writes.push(command);
      assert.equal(command[0], 'SET');
      store.set(command[1], command[2]);
      if (command[1] === BOOTSTRAP_KEY) bootstrapTtl = Number(command[4]);
      return Response.json({ result: 'OK' });
    });

    const rpc = await listAirportDelays({} as never, {} as never);
    assert.ok(reads.includes(FAA_KEY) && reads.includes(INTL_KEY));
    const severity = (iata: string) => rpc.alerts.find(a => a.iata === iata)?.severity;
    assert.equal(severity('JFK'), mode === 'healthy' || mode === 'intl-error' ? 'FLIGHT_DELAY_SEVERITY_NORMAL' : 'FLIGHT_DELAY_SEVERITY_UNKNOWN');
    assert.equal(severity('LHR'), mode === 'healthy' ? 'FLIGHT_DELAY_SEVERITY_NORMAL' : 'FLIGHT_DELAY_SEVERITY_UNKNOWN');

    const response = await bootstrap(new Request('https://api.worldmonitor.app/api/bootstrap?keys=flightDelays&public=1'));
    assert.equal(response.status, 200);
    const hydrated = (await response.json()).data.flightDelays;
    assert.ok(JSON.stringify(hydrated) === originalPayload, 'public bootstrap must still return the producer snapshot');
    assert.equal(store.get(BOOTSTRAP_META_KEY), originalMeta);
    assert.equal(bootstrapTtl, 3_600, 'request must not refresh the shared seed TTL');
    assert.deepEqual(writes, [], 'request must not publish a bootstrap snapshot');
    assert.deepEqual([...origins], ['https://redis.test']);
  });
}
