import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { TOOL_REGISTRY } from '../api/mcp/registry/index.ts';

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe('get_demographics_capability MCP tool', () => {
  test('is discoverable with exact API and coverage metadata', () => {
    const tool = TOOL_REGISTRY.find((candidate) => candidate.name === 'get_demographics_capability');
    assert.ok(tool);
    assert.deepEqual(tool._apiPaths, ['GET /api/resilience/v1/get-demographics-capability']);
    assert.deepEqual(tool._coverageKeys, ['demographics:capability:v1']);
    assert.deepEqual(tool.inputSchema.required, ['country_code']);
    assert.notEqual(tool._freeTier, true, 'the RPC-backed tool stays in the subscription tool set');
  });

  test('normalizes ISO-2, calls the exact RPC, and returns partial structured data', async () => {
    const tool = TOOL_REGISTRY.find((candidate) => candidate.name === 'get_demographics_capability');
    assert.ok(tool?._execute);
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, '/api/resilience/v1/get-demographics-capability');
      assert.equal(url.searchParams.get('countryCode'), 'DE');
      assert.equal(init?.headers?.['User-Agent'], 'worldmonitor-mcp-edge/1.0');
      return Response.json({
        countryCode: 'DE',
        available: true,
        fetchedAt: '2026-08-18T00:00:00.000Z',
        stages: [{ name: 'education', status: 'retained', fetchedAt: '2026-08-17T00:00:00.000Z', source: 'World Bank WDI / UNESCO UIS' }],
        ageStructure: { available: true, medianAgeYears: { available: true, value: 45.69, year: 2026, source: 'UN WPP 2024', unit: 'years' } },
        education: { available: false },
        industrialWorkforce: { available: false },
      });
    };

    const result = await tool._execute(
      { country_code: ' de ' },
      'https://worldmonitor.app',
      { kind: 'env_key', apiKey: 'test-key' },
    );
    assert.equal(result.countryCode, 'DE');
    assert.equal(result.ageStructure.medianAgeYears.year, 2026);
    assert.equal(result.education.available, false);
    assert.equal(result.stages[0].status, 'retained');
  });

  test('passes structured RPC validation failures through assertToolFetchOk', async () => {
    const tool = TOOL_REGISTRY.find((candidate) => candidate.name === 'get_demographics_capability');
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
      (error) => error?.status === 400 && error?.operation === 'get-demographics-capability',
    );
  });
});
