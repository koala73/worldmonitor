import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { listThermalEscalations } from '../server/worldmonitor/thermal/v1/list-thermal-escalations.ts';

const ENV_KEYS = ['LOCAL_API_MODE', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'] as const;
const originalEnv = new Map<string, string | undefined>();

const SEEDED_SUMMARY = {
  clusterCount: 586,
  elevatedCount: 29,
  spikeCount: 18,
  persistentCount: 71,
  conflictAdjacentCount: 397,
  highRelevanceCount: 76,
};

function seededCluster(id: string) {
  return {
    id,
    regionLabel: 'Iran',
    status: 'THERMAL_STATUS_PERSISTENT',
    context: 'THERMAL_CONTEXT_CONFLICT_ADJACENT',
    strategicRelevance: 'THERMAL_RELEVANCE_HIGH',
  };
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-token';
  const seeded = {
    fetchedAt: '2026-11-25T04:00:00.000Z',
    observationWindowHours: 24,
    sourceVersion: 'thermal-escalation-v1',
    clusters: Array.from({ length: 24 }, (_, i) => seededCluster(`c${i}`)),
    totalClusters: 586,
    summary: SEEDED_SUMMARY,
  };
  mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `https://redis.test/get/${encodeURIComponent('thermal:escalation:v1')}`) {
      return new Response(JSON.stringify({ result: JSON.stringify(seeded) }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
});

afterEach(() => {
  mock.restoreAll();
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnv.clear();
});

describe('listThermalEscalations summary', () => {
  it('returns the seeded world totals, not counts of the returned page', async () => {
    const response = await listThermalEscalations({} as never, { maxItems: 12 });

    assert.equal(response.dataAvailable, true);
    assert.equal(response.clusters.length, 12);
    assert.deepEqual(response.summary, SEEDED_SUMMARY);
  });
});
