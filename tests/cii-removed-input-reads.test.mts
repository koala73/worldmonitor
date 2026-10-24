/**
 * The CII build stops reading inputs that docs/methodology/cii-input-register.md
 * removes or shows as context only: sanctions entry counts, climate anomalies,
 * FIRMS fires (summary and canonical), GPS jamming, aviation delays,
 * earthquakes, and the military-cii feed (foreign military presence and AIS
 * disruptions). Each read was a way to fail: an
 * errored read of any of them rejected the whole build. Their health entries
 * go with them. The keys stay seeded for their other readers.
 */
import { strict as assert } from 'node:assert';
import { after, beforeEach, describe, it } from 'node:test';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
const UPSTASH = 'https://upstash.test';

process.env.UPSTASH_REDIS_REST_URL = UPSTASH;
process.env.UPSTASH_REDIS_REST_TOKEN = 'upstash-token';
delete process.env.VERCEL_ENV;
delete process.env.LOCAL_API_MODE;
delete process.env.ACLED_ACCESS_TOKEN;
delete process.env.ACLED_EMAIL;
delete process.env.ACLED_PASSWORD;

const { getRiskScores, CII_HEALTH_INPUT_IDS } = await import('../server/worldmonitor/intelligence/v1/get-risk-scores');
const { __clearLocalUnavailableBackoffForTests } = await import('../server/_shared/redis');
const { CII_INPUT_POLICY } = await import('../api/_cii-input-health.js');

const REMOVED_KEYS = [
  'sanctions:pressure:v1', 'sanctions:country-counts:v1', 'climate:anomalies:v2',
  'wildfire:fires-summary:v1', 'wildfire:fires:v1', 'intelligence:gpsjam:v2', 'aviation:delays-bootstrap:v2',
  'seismology:earthquakes:v1', 'intelligence:military-cii:v1',
];
const REMOVED_INPUT_IDS = ['sanctionsPressure', 'sanctionsCounts', 'climate', 'fires', 'gpsjam', 'aviation', 'earthquakes', 'militaryCii'];
const SEED_META_KEY = 'seed-meta:intelligence:risk-scores';

let writes: Array<{ key: string; value: string }> = [];
let gets: string[] = [];

function stubRedis({ failing = [] as string[] } = {}): void {
  const failingKeys = new Set(failing);
  writes = [];
  gets = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.origin !== UPSTASH) throw new Error(`unexpected fetch: ${url}`);
    if (url.pathname.startsWith('/get/')) {
      const key = decodeURIComponent(url.pathname.slice('/get/'.length));
      gets.push(key);
      if (failingKeys.has(key)) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      return Response.json({ result: null });
    }
    const body = JSON.parse(String(init.body ?? '[]'));
    const commands: unknown[][] = Array.isArray(body[0]) ? body : [body];
    for (const command of commands) {
      if (command[0] === 'SET') writes.push({ key: String(command[1]), value: String(command[2]) });
    }
    return Response.json(Array.isArray(body[0]) ? commands.map(() => ({ result: 'OK' })) : { result: 'OK' });
  }) as typeof fetch;
}

beforeEach(() => {
  __clearLocalUnavailableBackoffForTests();
  console.error = () => {};
});
after(() => {
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
  process.env = originalEnv;
});

describe('CII build reads no removed input', () => {
  it('never reads a removed key, and a failing read of one cannot reject the build', async () => {
    stubRedis({ failing: REMOVED_KEYS });
    const response = await getRiskScores({} as never, {} as never);
    assert.equal(response.ciiScores.length, 31);
    assert.deepEqual(gets.filter((key) => REMOVED_KEYS.includes(key)), []);
    assert.ok(writes.some((write) => write.key === SEED_META_KEY), 'the build publishes');
  });

  it('reports no health state for a removed input, in the producer or the reader policy', async () => {
    stubRedis();
    await getRiskScores({} as never, {} as never);
    const meta = writes.find((write) => write.key === SEED_META_KEY);
    assert.ok(meta, 'the build must stamp its seed-meta');
    const inputs = (JSON.parse(meta.value) as { inputs: Record<string, unknown> }).inputs;
    for (const id of REMOVED_INPUT_IDS) {
      assert.ok(!(id in inputs), `seed-meta still reports ${id}`);
      assert.ok(!(CII_HEALTH_INPUT_IDS as readonly string[]).includes(id), `CII_HEALTH_INPUT_IDS still lists ${id}`);
      assert.ok(!(id in CII_INPUT_POLICY.inputs), `api/_cii-input-health.js still grades ${id}`);
    }
    assert.ok(!('security' in CII_INPUT_POLICY.families), 'the Security family has no inputs left');
  });
});
