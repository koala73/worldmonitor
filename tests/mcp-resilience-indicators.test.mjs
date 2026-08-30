import assert from 'node:assert/strict';
import { afterEach, describe, mock, test } from 'node:test';

import { TOOL_REGISTRY } from '../api/mcp/registry/index.ts';
import { HMAC_SECRET } from './helpers/mcp-pro-deps.mjs';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_HMAC_SECRET = process.env.MCP_INTERNAL_HMAC_SECRET;

afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_HMAC_SECRET == null) delete process.env.MCP_INTERNAL_HMAC_SECRET;
  else process.env.MCP_INTERNAL_HMAC_SECRET = ORIGINAL_HMAC_SECRET;
});

describe('get_resilience_indicators MCP tool', () => {
  test('is subscription-only with exact API, coverage, schema and annotation metadata', () => {
    const tool = TOOL_REGISTRY.find((candidate) => candidate.name === 'get_resilience_indicators');
    assert.ok(tool);
    assert.equal(tool._jmespathDisabled, true);
    assert.deepEqual(tool._apiPaths, ['GET /api/resilience/v1/get-resilience-indicators']);
    assert.deepEqual(tool.inputSchema.required, ['country_code']);
    assert.equal(tool._outputBudgetBytes, 262144);
    assert.deepEqual(tool.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    assert.notEqual(tool._freeTier, true);
    assert.ok(tool.outputSchema.properties.indicators.items.properties.state);
    assert.ok(tool.outputSchema.properties.indicators.items.properties.effectiveContribution);
    assert.ok(tool.outputSchema.properties.indicators.items.properties.rawValue);
    assert.ok(tool.outputSchema.properties.indicators.items.properties.sources.items.properties.observationProvenance);
    assert.ok(tool.outputSchema.properties.indicators.items.properties.sources.items.properties.licenseUrl);
    assert.ok(tool.outputSchema.properties.indicators.items.properties.sources.items.properties.attributionUrl);
    assert.match(
      tool.outputSchema.properties.indicators.items.properties.rawValue.properties.status.description,
      /audit-incomplete/,
    );
    assert.ok(tool.outputSchema.properties.constructVersions);
    assert.ok(tool.outputSchema.properties.constructVersions.properties.financialSystemExposure);
    for (const key of [
      'resilience:low-carbon-generation:v1',
      'resilience:power-losses:v1',
      'resilience:education-attainment:v1',
      'resilience:recovery:fiscal-space:v1',
      'resilience:recovery:reserve-adequacy:v1',
      'resilience:recovery:reexport-share:v1',
      'resilience:recovery:sovereign-wealth:v1',
      'resilience:recovery:external-debt:v1',
      'resilience:recovery:import-hhi:v1',
    ]) {
      assert.ok(tool._coverageKeys.includes(key), `missing exact resilience coverage key ${key}`);
    }
  });

  test('normalizes ISO-2 and signs the exact Pro RPC fetch', async () => {
    const tool = TOOL_REGISTRY.find((candidate) => candidate.name === 'get_resilience_indicators');
    assert.ok(tool?._execute);
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    let timeoutSignal;
    mock.method(AbortSignal, 'timeout', (milliseconds) => {
      assert.ok(milliseconds > 8_000, 'timeout must exceed the former cold-path limit');
      assert.ok(milliseconds >= 15_000, 'timeout must cover the bounded cold scorer path');
      timeoutSignal = new AbortController().signal;
      return timeoutSignal;
    });
    globalThis.fetch = async (input, init) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const url = new URL(String(input));
      assert.equal(url.pathname, '/api/resilience/v1/get-resilience-indicators');
      assert.equal(url.searchParams.get('countryCode'), 'DE');
      assert.equal(init?.headers?.['User-Agent'], 'worldmonitor-mcp-edge/1.0');
      assert.match(init?.headers?.['X-WM-MCP-Internal'] ?? '', /^\d+\.[A-Za-z0-9_-]+$/);
      assert.equal(init?.headers?.['X-WM-MCP-User-Id'], 'user-6507');
      assert.match(init?.headers?.['X-WM-MCP-Nonce'] ?? '', /^[A-Za-z0-9_-]+$/);
      assert.equal(init?.signal, timeoutSignal);
      assert.equal(init?.signal?.aborted, false);
      return Response.json({
        countryCode: 'DE',
        methodology: 'score-generation-trace-v1',
        formula: 'pc',
        dataVersion: '2026-08-30',
        schemaVersion: '2.0',
        constructVersions: { energy: 'v2', education: 'active', financialSystemExposure: 'active' },
        dimensions: [{ id: 'macroFiscal', score: 62, effectiveContributionTotal: 62 }],
        indicators: [{ id: 'govRevenuePct', dimension: 'macroFiscal', state: 'observed', effectiveContribution: 20 }],
      });
    };

    const result = await tool._execute(
      { country_code: ' de ' },
      'https://worldmonitor.app',
      { kind: 'pro', userId: 'user-6507', mcpTokenId: 'token-6507' },
    );
    assert.equal(result.countryCode, 'DE');
    assert.equal(result.indicators[0].state, 'observed');
    assert.equal(result.dimensions[0].effectiveContributionTotal, 62);
  });

  test('passes structured RPC validation failures through assertToolFetchOk', async () => {
    const tool = TOOL_REGISTRY.find((candidate) => candidate.name === 'get_resilience_indicators');
    assert.ok(tool?._execute);
    globalThis.fetch = async () => new Response(JSON.stringify({
      violations: [{ field: 'countryCode', description: 'countryCode must be a 2-letter ISO 3166-1 alpha-2 code' }],
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });

    await assert.rejects(
      tool._execute(
        { country_code: 'DEU' },
        'https://worldmonitor.app',
        { kind: 'env_key', apiKey: 'test-key' },
      ),
      (error) => error?.status === 400 && error?.operation === 'get-resilience-indicators',
    );
  });
});
