// Focused behavior tests for get_wto_trade_flows (#6323). Drives the REAL
// _execute through a mocked upstream fetch to the RPC route, so a change to the
// query params, projection, or fault/coverage mapping reddens here rather than
// only in a source grep.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { TOOL_REGISTRY } from '../api/mcp/registry/index.ts';

const originalFetch = globalThis.fetch;
const originalEnv = {
  redisUrl: process.env.UPSTASH_REDIS_REST_URL,
  redisToken: process.env.UPSTASH_REDIS_REST_TOKEN,
};

const tool = TOOL_REGISTRY.find((t) => t.name === 'get_wto_trade_flows');
assert.ok(tool, 'get_wto_trade_flows must be registered');
if (tool._execute === undefined) throw new Error('get_wto_trade_flows must be an _execute tool');

const BASE = 'https://api.worldmonitor.app';

function wtoResponse(overrides = {}) {
  return new Response(JSON.stringify({
    flows: [
      { year: 2014, reportingCountry: 'United States of America', partnerCountry: 'World', exportValueUsd: 1_620_000_000_000, importValueUsd: 2_330_000_000_000, yoyExportChange: 2.5, yoyImportChange: 3.1, productSector: 'Total merchandise' },
      { year: 2015, reportingCountry: 'United States of America', partnerCountry: 'World', exportValueUsd: 1_500_000_000_000, importValueUsd: 2_280_000_000_000, yoyExportChange: -7.4, yoyImportChange: -2.1, productSector: 'Total merchandise' },
    ],
    fetchedAt: '2026-08-07T00:00:00.000Z',
    upstreamUnavailable: false,
    unavailableReason: 'TRADE_FLOW_UNAVAILABLE_REASON_UNSPECIFIED',
    coverageStartYear: 2014,
    coverageEndYear: 2015,
    ...overrides,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

let requestedUrl = '';

beforeEach(() => {
  requestedUrl = '';
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  globalThis.fetch = (async (input) => {
    requestedUrl = String(input);
    return wtoResponse();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of [
    ['UPSTASH_REDIS_REST_URL', originalEnv.redisUrl],
    ['UPSTASH_REDIS_REST_TOKEN', originalEnv.redisToken],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const CTX = { kind: 'env_key', apiKey: 'test' } as Parameters<typeof tool._execute>[2];

describe('get_wto_trade_flows', () => {
  it('is registered with projection, coverage, and api parity contracts', () => {
    assert.ok(tool._apiPaths.includes('GET /api/trade/v1/get-trade-flows'), '_apiPaths must cover the RPC op');
    assert.ok(tool._coverageKeys?.includes('seed-meta:trade:flows'), '_coverageKeys must cover the seed-meta key');
    assert.ok(tool._coverageKeys?.includes('trade:flows:v2:index'), '_coverageKeys must cover the manifest');
    assert.ok(tool._coverageKeys?.includes('trade:flows:v2:840:000'), '_coverageKeys must cover the default reporter data key');
  });

  it('forwards reporter and years to the route and projects the response', async () => {
    const result = await tool._execute({ reporter: '156', years: 5 }, BASE, CTX, {});
    assert.match(requestedUrl, /^https:\/\/api\.worldmonitor\.app\/api\/trade\/v1\/get-trade-flows\?/);
    assert.match(requestedUrl, /reporting_country=156/);
    assert.match(requestedUrl, /years=5/);
    assert.equal(result.flows.length, 2);
    assert.equal(result.flows[1].year, 2015);
    assert.equal(result.flows[1].exportValueUsd, 1_500_000_000_000);
    assert.equal(result.flows[1].yoyExportChange, -7.4);
    assert.equal(result.unavailableReason, 'TRADE_FLOW_UNAVAILABLE_REASON_UNSPECIFIED');
    assert.equal(result.upstreamUnavailable, false);
    assert.equal(result.coverageEndYear, 2015);
  });

  it('defaults reporter to 840 and years to 10', async () => {
    await tool._execute({}, BASE, CTX, {});
    assert.match(requestedUrl, /reporting_country=840/);
    assert.match(requestedUrl, /years=10/);
  });

  it('rejects malformed reporter without answering for the default country', async () => {
    const result = await tool._execute({ reporter: 'not-a-code' }, BASE, CTX, {});
    assert.equal(requestedUrl, '', 'invalid input must not issue an upstream request');
    assert.equal(result.unavailableReason, 'TRADE_FLOW_UNAVAILABLE_REASON_INVALID_REQUEST');
    assert.equal(result.upstreamUnavailable, false);
    assert.deepEqual(result.flows, []);
  });

  it('rejects years outside the public input contract', async () => {
    const result = await tool._execute({ years: 31 }, BASE, CTX, {});
    assert.equal(requestedUrl, '', 'invalid input must not issue an upstream request');
    assert.equal(result.unavailableReason, 'TRADE_FLOW_UNAVAILABLE_REASON_INVALID_REQUEST');
    assert.deepEqual(result.flows, []);
  });

  it('surfaces NOT_COVERED distinguishably from a fault', async () => {
    globalThis.fetch = (async () => wtoResponse({
      flows: [],
      upstreamUnavailable: false,
      unavailableReason: 'TRADE_FLOW_UNAVAILABLE_REASON_NOT_COVERED',
      coverageStartYear: 0,
      coverageEndYear: 0,
    })) as typeof fetch;

    const result = await tool._execute({ reporter: '840', partner: '156' }, BASE, CTX, {});
    assert.equal(result.unavailableReason, 'TRADE_FLOW_UNAVAILABLE_REASON_NOT_COVERED');
    assert.equal(result.upstreamUnavailable, false, 'not_covered is a contract answer, not an outage');
    assert.deepEqual(result.flows, []);
  });

  it('surfaces a fault (seed missing) with upstreamUnavailable true', async () => {
    globalThis.fetch = (async () => wtoResponse({
      flows: [],
      upstreamUnavailable: true,
      unavailableReason: 'TRADE_FLOW_UNAVAILABLE_REASON_SEED_MISSING',
      coverageStartYear: 0,
      coverageEndYear: 0,
    })) as typeof fetch;

    const result = await tool._execute({ reporter: '156' }, BASE, CTX, {});
    assert.equal(result.unavailableReason, 'TRADE_FLOW_UNAVAILABLE_REASON_SEED_MISSING');
    assert.equal(result.upstreamUnavailable, true);
    assert.deepEqual(result.flows, []);
  });

  it('projects numeric years robustly whether the wire sends strings or numbers', async () => {
    globalThis.fetch = (async () => wtoResponse({
      flows: [
        { year: '2020', reportingCountry: 'Test', partnerCountry: 'World', exportValueUsd: '100', importValueUsd: '200', yoyExportChange: 0, yoyImportChange: 0, productSector: 'Total merchandise' },
      ],
    })) as typeof fetch;

    const result = await tool._execute({ years: 1 }, BASE, CTX, {});
    assert.equal(result.flows[0].year, 2020);
    assert.equal(result.flows[0].exportValueUsd, 100);
  });
});
