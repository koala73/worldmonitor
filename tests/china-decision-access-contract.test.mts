import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { issueSessionToken } from '../api/_session.js';
import seedHealthHandler from '../api/seed-health.js';
import { __testing__ as healthTesting } from '../api/health.js';
import {
  createDomainGateway,
  PUBLIC_NO_AUTH_RPC_PATHS,
} from '../server/gateway.ts';

const PATH = '/api/intelligence/v1/get-china-decision-signals';
const CHINA_DATA_KEY = 'intelligence:china-decision-signals:v1';
const CHINA_META_KEY = 'seed-meta:intelligence:china-decision-signals';
const OPERATOR_KEY = 'china-decision-test-operator-key';
const RESILIENCE_INTERVAL_PROBE_KEY = 'resilience:intervals:v9:US';
const RESILIENCE_INTERVAL_METHODOLOGY = 'weight-perturbation-sensitivity-v3';
const RESILIENCE_INTERVAL_SOURCE_VERSION =
  `resilience-intervals:resilience:intervals:v9:${RESILIENCE_INTERVAL_METHODOLOGY}`;
const originalFetch = globalThis.fetch;
const originalEnv = {
  WM_SESSION_SECRET: process.env.WM_SESSION_SECRET,
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  WORLDMONITOR_VALID_KEYS: process.env.WORLDMONITOR_VALID_KEYS,
  RESILIENCE_PILLAR_COMBINE_ENABLED: process.env.RESILIENCE_PILLAR_COMBINE_ENABLED,
  RESILIENCE_SCHEMA_V2_ENABLED: process.env.RESILIENCE_SCHEMA_V2_ENABLED,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
});

function installSeedHealthPipelineMock(chinaMeta: { fetchedAt: number; recordCount: number }) {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-token';
  process.env.WORLDMONITOR_VALID_KEYS = OPERATOR_KEY;
  process.env.RESILIENCE_PILLAR_COMBINE_ENABLED = 'false';
  process.env.RESILIENCE_SCHEMA_V2_ENABLED = 'true';

  globalThis.fetch = async (_url, init) => {
    const commands = JSON.parse(String(init?.body));
    const results = commands.map(([operation, key]: [string, string]) => {
      if (operation === 'EXISTS') return { result: 0 };
      assert.equal(operation, 'GET');
      if (key === RESILIENCE_INTERVAL_PROBE_KEY) {
        return {
          result: JSON.stringify({
            p05: 65.2,
            p95: 72.8,
            _formula: 'd6',
            methodology: RESILIENCE_INTERVAL_METHODOLOGY,
            computedAt: new Date(chinaMeta.fetchedAt).toISOString(),
          }),
        };
      }
      if (key === CHINA_META_KEY) return { result: JSON.stringify(chinaMeta) };
      return {
        result: JSON.stringify({
          fetchedAt: chinaMeta.fetchedAt,
          recordCount: 1_000,
          sourceVersion: key === 'seed-meta:resilience:intervals'
            ? RESILIENCE_INTERVAL_SOURCE_VERSION
            : 'test',
        }),
      };
    });
    return new Response(JSON.stringify(results), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

function classifyMainHealth(chinaMeta: { fetchedAt: number; recordCount: number }) {
  return healthTesting.classifyKey(
    'chinaDecisionSignals',
    CHINA_DATA_KEY,
    { allowOnDemand: false },
    {
      keyStrens: new Map([[CHINA_DATA_KEY, 128]]),
      keyErrors: new Map(),
      keyMetaValues: new Map([[CHINA_META_KEY, JSON.stringify(chinaMeta)]]),
      keyMetaErrors: new Map(),
      now: chinaMeta.fetchedAt + 60_000,
    },
  );
}

async function readSeedHealth(chinaMeta: { fetchedAt: number; recordCount: number }) {
  installSeedHealthPipelineMock(chinaMeta);
  const response = await seedHealthHandler(new Request(
    'https://api.worldmonitor.app/api/seed-health',
    { headers: { 'X-WorldMonitor-Key': OPERATOR_KEY } },
  ));
  return {
    response,
    body: await response.json(),
  };
}

describe('China decision-signal access tiers (#5580)', () => {
  it('serves the bounded public RPC without a session or API key', async () => {
    assert.equal(PUBLIC_NO_AUTH_RPC_PATHS.has(PATH), true);
    const gateway = createDomainGateway([{
      method: 'GET',
      path: PATH,
      handler: async () => new Response(JSON.stringify({ payloadJson: '{}' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    }]);

    const response = await gateway(new Request(`https://api.worldmonitor.app${PATH}`, {
      headers: { Origin: 'https://worldmonitor.app' },
    }));

    assert.equal(response.status, 200);
  });

  it('rejects a freely minted anonymous session at the operator seed-health boundary', async () => {
    process.env.WM_SESSION_SECRET = 'china-decision-health-secret-at-least-32-chars';
    const { token } = await issueSessionToken();
    const response = await seedHealthHandler(new Request(
      'https://api.worldmonitor.app/api/seed-health',
      { headers: { Cookie: `wm-session=${token}` } },
    ));

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'Operator API key required' });
  });

  it('keeps China source freshness out of the anonymous compact health projection', () => {
    const compact = healthTesting.healthResponseBody({
      status: 'WARNING',
      summary: { ok: 1, warning: 2 },
      checkedAt: '2026-07-26T12:00:00.000Z',
      checks: {
        chinaDecisionSignals: {
          status: 'STALE_SEED',
          seedAgeMin: 61,
          maxStaleMin: 60,
        },
        publicExample: {
          status: 'STALE_SEED',
          seedAgeMin: 20,
        },
      },
    }, true);

    assert.equal(compact.problems?.chinaDecisionSignals, undefined);
    assert.equal(compact.problems?.publicExample?.status, 'STALE_SEED');
  });

  it('keeps 5/6 partial and 6/6 healthy across both health surfaces', async () => {
    for (const expectation of [
      {
        recordCount: 5,
        mainStatus: 'COVERAGE_PARTIAL',
        seedStatus: 'coverage_partial',
        seedOverall: 'warning',
        seedStale: true,
      },
      {
        recordCount: 6,
        mainStatus: 'OK',
        seedStatus: 'ok',
        seedOverall: 'healthy',
        seedStale: false,
      },
    ] as const) {
      const chinaMeta = {
        fetchedAt: Date.now() - 60_000,
        recordCount: expectation.recordCount,
      };
      const mainEntry = classifyMainHealth(chinaMeta);
      const { response, body } = await readSeedHealth(chinaMeta);
      const seedEntry = body.seeds['intelligence:china-decision-signals'];

      assert.equal(mainEntry.status, expectation.mainStatus);
      assert.equal(mainEntry.records, expectation.recordCount);
      assert.equal(mainEntry.minRecordCount, 6);
      assert.equal(response.status, 200);
      assert.equal(body.overall, expectation.seedOverall);
      assert.equal(seedEntry.status, expectation.seedStatus);
      assert.equal(seedEntry.stale, expectation.seedStale);
      assert.equal(seedEntry.recordCount, expectation.recordCount);
      assert.equal(seedEntry.minRecordCount, 6);
    }
  });
});
