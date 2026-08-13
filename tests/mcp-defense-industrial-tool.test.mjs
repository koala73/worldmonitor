import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  HMAC_SECRET,
  callBody,
  makeProDeps,
  proReq,
} from './helpers/mcp-pro-deps.mjs';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

const canonicalResponse = {
  countryCode: 'UA',
  available: true,
  expenditurePctGdp: {
    available: true,
    value: 34.4815,
    year: 2024,
    previousValue: 36.5282,
    previousYear: 2023,
    source: 'World Bank',
  },
  expenditureUsd: { available: false, value: 0, year: 0, previousValue: 0, previousYear: 0, source: '' },
  personnel: { available: false, value: 0, year: 0, previousValue: 0, previousYear: 0, source: '' },
  armsExportsTiv: { available: false, value: 0, year: 0, previousValue: 0, previousYear: 0, source: '' },
  armsImportsTiv: { available: false, value: 0, year: 0, previousValue: 0, previousYear: 0, source: '' },
  suppliers: [
    { supplierIso2: 'US', tivShare: 0.4089 },
    { supplierIso2: 'DE', tivShare: 0.1398 },
  ],
  supplierHhi: 0.2042,
  windowStartYear: 2021,
  windowEndYear: 2025,
  supplierSource: 'SIPRI Arms Transfers Database',
  fetchedAt: '2026-08-12T00:00:00.000Z',
  industrialFetchedAt: '2026-08-12T00:00:00.000Z',
  supplierFetchedAt: '2026-08-12T00:00:00.000Z',
  supplierRetained: false,
  supplierMappingCoverage: 0.97,
};

describe('get_defense_industrial_base MCP tool', () => {
  let mcpHandler;
  let requests;

  beforeEach(async () => {
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.MCP_TELEMETRY = 'false';
    requests = [];
    globalThis.fetch = async (input, init = {}) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify(canonicalResponse), {
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const mod = await import(`../api/mcp.ts?defense-industrial=${Date.now()}-${Math.random()}`);
    mcpHandler = mod.mcpHandler;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach((key) => {
      if (!(key in originalEnv)) delete process.env[key];
    });
    Object.assign(process.env, originalEnv);
  });

  it('lists the tool and answers through the canonical military RPC', async () => {
    const listed = await mcpHandler(new Request('https://worldmonitor.app/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }));
    const tool = (await listed.json()).result.tools.find((entry) => entry.name === 'get_defense_industrial_base');
    assert.ok(tool, 'tool must be discoverable through tools/list');
    assert.deepEqual(tool.inputSchema.required, ['country_code']);
    assert.deepEqual(tool.outputSchema.properties.expenditurePctGdp.required, [
      'available', 'value', 'year', 'previousValue', 'previousYear', 'source',
    ]);
    assert.equal(tool.outputSchema.properties.expenditurePctGdp.properties.year.type, 'integer');
    assert.equal(tool.outputSchema.properties.suppliers.items.properties.tivShare.maximum, 1);
    assert.equal(tool.outputSchema.properties.supplierHhi.maximum, 1);
    assert.equal(tool.outputSchema.properties.supplierMappingCoverage.maximum, 1);

    const { deps } = makeProDeps();
    const response = await mcpHandler(
      proReq('POST', callBody('get_defense_industrial_base', { country_code: 'ua' })),
      deps,
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    const requestUrl = new URL(requests[0].url);
    assert.equal(requestUrl.pathname, '/api/military/v1/get-defense-industrial-base');
    assert.equal(requestUrl.searchParams.get('country_code'), 'UA');
    assert.equal(requestUrl.searchParams.get('public'), '1');
    assert.equal(requests[0].init.headers['X-WM-MCP-Internal'], undefined);
    assert.deepEqual(JSON.parse(body.result.content[0].text), canonicalResponse);
  });

  it('authenticates only a local loopback self-fetch with the sidecar token', async () => {
    process.env.LOCAL_API_TOKEN = 'local-sidecar-token';
    const { deps } = makeProDeps();
    const response = await mcpHandler(new Request('http://127.0.0.1:43123/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer pro-bearer-uuid',
      },
      body: JSON.stringify(callBody('get_defense_industrial_base', { country_code: 'UA' })),
    }), deps);

    assert.equal(response.status, 200);
    assert.equal(new URL(requests[0].url).origin, 'http://127.0.0.1:43123');
    assert.equal(requests[0].init.headers['X-WorldMonitor-Local-Token'], 'local-sidecar-token');
  });
});
