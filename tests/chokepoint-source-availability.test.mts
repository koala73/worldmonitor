import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { listNavigationalWarnings } from '../server/worldmonitor/maritime/v1/list-navigational-warnings.ts';
import { getChokepointStatus } from '../server/worldmonitor/supply-chain/v1/get-chokepoint-status.ts';

const originalFetch = globalThis.fetch;
const originalDateNow = Date.now;
const ENV_KEYS = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'WS_RELAY_URL'] as const;
const originalEnv = new Map<string, string | undefined>();

function redisHarness(externalFetch: (url: string) => Promise<Response>) {
  const values = new Map<string, string>();
  const writes: Array<unknown[]> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.startsWith('https://redis.test/get/')) {
      const key = decodeURIComponent(new URL(url).pathname.slice('/get/'.length));
      return Response.json({ result: values.get(key) ?? null });
    }
    if (url === 'https://redis.test/') {
      const command = JSON.parse(String(init?.body || '[]')) as unknown[];
      writes.push(command);
      if (command[0] === 'SET') {
        values.set(String(command[1]), String(command[2]));
        return Response.json({ result: 'OK' });
      }
      return Response.json({ result: null });
    }
    return externalFetch(url);
  };
  return { values, writes, fetchImpl };
}

beforeEach(() => {
  for (const key of ENV_KEYS) originalEnv.set(key, process.env[key]);
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  process.env.WS_RELAY_URL = 'https://relay.test';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalDateNow;
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnv.clear();
});

describe('chokepoint source availability', () => {
  it('uses append-only proto fields and the private NGA v2 cache key', async () => {
    const maritimeProto = await readFile('proto/worldmonitor/maritime/v1/list_navigational_warnings.proto', 'utf8');
    const supplyChainProto = await readFile('proto/worldmonitor/supply_chain/v1/supply_chain_data.proto', 'utf8');
    const handler = await readFile('server/worldmonitor/maritime/v1/list-navigational-warnings.ts', 'utf8');

    assert.match(maritimeProto, /bool data_available = 3;/);
    assert.match(supplyChainProto, /bool navigational_warnings_available = 17;/);
    assert.match(supplyChainProto, /bool ais_snapshot_available = 18;/);
    assert.match(supplyChainProto, /"normal" is an observed AIS level/);
    assert.match(handler, /maritime:navwarnings:v2/);
  });

  it('marks a successful empty NGA response available and caches it', async () => {
    let ngaRequests = 0;
    const harness = redisHarness(async (url) => {
      assert.match(url, /msi\.nga\.mil/);
      ngaRequests += 1;
      return Response.json([]);
    });
    globalThis.fetch = harness.fetchImpl as typeof fetch;

    const first = await listNavigationalWarnings({} as never, { area: '', pageSize: 0, cursor: '' });
    const second = await listNavigationalWarnings({} as never, { area: '', pageSize: 0, cursor: '' });

    assert.deepEqual(first.warnings, []);
    assert.equal(first.dataAvailable, true);
    assert.deepEqual(second.warnings, []);
    assert.equal(second.dataAvailable, true);
    assert.equal(ngaRequests, 1);
    assert.ok(harness.values.has('maritime:navwarnings:v2:all'));
  });

  it('marks an NGA fetch failure unavailable', async () => {
    const harness = redisHarness(async () => new Response('unavailable', { status: 503 }));
    globalThis.fetch = harness.fetchImpl as typeof fetch;

    const response = await listNavigationalWarnings({} as never, { area: 'failure-case', pageSize: 0, cursor: '' });

    assert.deepEqual(response, { warnings: [], pagination: undefined, dataAvailable: false });
  });

  it('marks malformed NGA payloads unavailable instead of treating them as empty', async () => {
    const malformedPayloads = [
      { area: 'malformed-envelope', body: { broadcast_warn: {} } },
      { area: 'malformed-entry', body: [null] },
    ];

    for (const { area, body } of malformedPayloads) {
      const harness = redisHarness(async () => Response.json(body));
      globalThis.fetch = harness.fetchImpl as typeof fetch;

      const response = await listNavigationalWarnings({} as never, { area, pageSize: 0, cursor: '' });

      assert.deepEqual(response, { warnings: [], pagination: undefined, dataAvailable: false });
    }
  });

  it('fails closed for legacy cached chokepoints while preserving sibling metrics', async () => {
    const harness = redisHarness(async (url) => {
      throw new Error(`unexpected fetch: ${url}`);
    });
    harness.values.set('supply_chain:chokepoints:v4', JSON.stringify({
      chokepoints: [{
        id: 'suez',
        name: 'Suez Canal',
        activeWarnings: 4,
        aisDisruptions: 2,
        congestionLevel: 'elevated',
        transitSummary: {
          todayTotal: 0,
          todayCountsAvailable: true,
          dataAvailable: true,
        },
      }],
      fetchedAt: '2026-09-02T00:00:00.000Z',
      upstreamUnavailable: false,
    }));
    globalThis.fetch = harness.fetchImpl as typeof fetch;

    const response = await getChokepointStatus({} as never, {});

    assert.equal(response.chokepoints.length, 1);
    const [suez] = response.chokepoints;
    assert.equal(suez?.navigationalWarningsAvailable, false);
    assert.equal(suez?.aisSnapshotAvailable, false);
    assert.equal(suez?.activeWarnings, 4);
    assert.equal(suez?.aisDisruptions, 2);
    assert.equal(suez?.congestionLevel, 'elevated');
    assert.equal(suez?.transitSummary?.todayTotal, 0);
    assert.equal(suez?.transitSummary?.todayCountsAvailable, true);
    assert.equal(suez?.transitSummary?.dataAvailable, true);
  });

  it('keeps AIS rows and advisories when NGA and transit data are unavailable', async () => {
    Date.now = () => Date.parse('2026-03-05T00:00:00.000Z');
    const harness = redisHarness(async (url) => {
      if (url.includes('msi.nga.mil')) return new Response('unavailable', { status: 503 });
      if (url.startsWith('https://relay.test/ais/snapshot')) {
        return Response.json({
          density: [],
          disruptions: [{
            id: 'hormuz-congestion',
            name: 'Strait of Hormuz congestion',
            type: 'chokepoint_congestion',
            lat: 26.56,
            lon: 56.25,
            severity: 'high',
            region: 'Strait of Hormuz',
            description: 'Observed AIS congestion.',
          }],
          snapshotAt: Date.now(),
          status: { connected: true, vessels: 10, messages: 20 },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = harness.fetchImpl as typeof fetch;

    const response = await getChokepointStatus({} as never, {});

    assert.equal(response.chokepoints.length, 13);
    assert.equal(response.upstreamUnavailable, true);
    assert.ok(response.chokepoints.every((row) => row.navigationalWarningsAvailable === false));
    assert.ok(response.chokepoints.every((row) => row.aisSnapshotAvailable === true));
    assert.ok(response.chokepoints.every((row) => row.transitSummary?.dataAvailable === false));
    const hormuz = response.chokepoints.find((row) => row.id === 'hormuz_strait');
    assert.equal(hormuz?.aisDisruptions, 1);
    assert.equal(hormuz?.congestionLevel, 'high');
    assert.match(hormuz?.description || '', /Active conflict/);
    const quietRow = response.chokepoints.find((row) => row.description.includes('source coverage incomplete'));
    assert.ok(quietRow, 'quiet rows must qualify the all-clear when any source is unavailable');
    assert.doesNotMatch(quietRow.description, /^No active disruptions$/);

    const cachedResponse = await getChokepointStatus({} as never, {});
    assert.equal(cachedResponse.chokepoints.length, 13, 'partial rows must survive the outer cache');
    assert.equal(cachedResponse.upstreamUnavailable, true);
    assert.equal(cachedResponse.chokepoints.find((row) => row.id === 'hormuz_strait')?.aisDisruptions, 1);

    await new Promise<void>((resolve) => setImmediate(resolve));
    const meta = JSON.parse(harness.values.get('seed-meta:supply_chain:chokepoints') || '{}');
    assert.equal(meta.recordCount, 0);
    assert.equal(meta.uncoveredChokepoints?.length, 13);
  });
});
