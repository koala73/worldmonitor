import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { HMAC_SECRET, callBody, makeProDeps, proReq } from './helpers/mcp-pro-deps.mjs';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const canonicalResponse = {
  scorecard: {
    countryCode: 'ZW',
    methodologyVersion: '1.0.0',
    computedAt: '2026-08-29T00:00:00.000Z',
    pillars: [{
      pillar: 'food', hasScore: false, score: 0, subScore: 0, band: '', inputCoverage: 0.55,
      aggregationMethod: 'country-weighted-components', insufficientReasons: ['coverage-below-floor'],
      includedMembers: [], excludedMembers: [],
      inputs: [{ inputId: 'food.productionBalance', available: true, value: 0.8, hasValue: true, year: 2024, unit: 'ratio', source: 'USDA PSD', sourceKey: 'resilience:food-stocks:v1', unavailableReason: '', quality: 'observed', observations: [] }],
    }],
  },
  unavailable: false,
  unavailableReason: '',
};

describe('get_five_factor_scorecard MCP tool', () => {
  let mcpHandler;
  let requests;
  let downstreamResponse;

  beforeEach(async () => {
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.MCP_TELEMETRY = 'false';
    requests = [];
    downstreamResponse = canonicalResponse;
    globalThis.fetch = async (input, init = {}) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify(downstreamResponse), { headers: { 'Content-Type': 'application/json' } });
    };
    const mod = await import(`../api/mcp.ts?five-factor=${Date.now()}-${Math.random()}`);
    mcpHandler = mod.mcpHandler;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach((key) => { if (!(key in originalEnv)) delete process.env[key]; });
    Object.assign(process.env, originalEnv);
  });

  it('lists one country-or-bloc tool and preserves the canonical API response byte-for-byte', async () => {
    const listed = await mcpHandler(new Request('https://worldmonitor.app/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }));
    const tool = (await listed.json()).result.tools.find((entry) => entry.name === 'get_five_factor_scorecard');
    assert.ok(tool);
    assert.ok(tool.inputSchema.properties.country_code);
    assert.ok(tool.inputSchema.properties.preset);
    assert.ok(tool.inputSchema.properties.members);
    assert.ok(tool.outputSchema.properties.scorecard.properties.id);
    assert.ok(tool.outputSchema.properties.scorecard.properties.label);
    assert.ok(tool.outputSchema.properties.scorecard.properties.includedMembers);
    assert.ok(tool.outputSchema.properties.scorecard.properties.excludedMembers);
    assert.ok(tool.outputSchema.properties.scorecard.properties.pillars.items.properties.includedMembers);
    assert.ok(tool.outputSchema.properties.scorecard.properties.pillars.items.properties.excludedMembers);

    const { deps } = makeProDeps();
    const response = await mcpHandler(proReq('POST', callBody('get_five_factor_scorecard', { country_code: 'zw' })), deps);
    const body = await response.json();
    const requestUrl = new URL(requests[0].url);
    assert.equal(requestUrl.pathname, '/api/scorecard/v1/get-five-factor-scorecard');
    assert.equal(requestUrl.searchParams.get('countryCode'), 'ZW');
    assert.deepEqual(JSON.parse(body.result.content[0].text), canonicalResponse);
  });

  it('routes preset and custom blocs to the bloc RPC with repeated members', async () => {
    const { deps } = makeProDeps();
    await mcpHandler(proReq('POST', callBody('get_five_factor_scorecard', { preset: 'ASEAN' })), deps);
    let requestUrl = new URL(requests[0].url);
    assert.equal(requestUrl.pathname, '/api/scorecard/v1/get-bloc-scorecard');
    assert.equal(requestUrl.searchParams.get('preset'), 'ASEAN');

    requests = [];
    await mcpHandler(proReq('POST', callBody('get_five_factor_scorecard', { members: ['US', 'CA', 'MX'] })), deps);
    requestUrl = new URL(requests[0].url);
    assert.deepEqual(requestUrl.searchParams.getAll('members'), ['US', 'CA', 'MX']);
  });

  it('rejects mixed or absent country/bloc selection before fetching', async () => {
    const { deps } = makeProDeps();
    let response = await mcpHandler(proReq('POST', callBody('get_five_factor_scorecard', {})), deps);
    assert.equal((await response.json()).error.code, -32602);
    response = await mcpHandler(proReq('POST', callBody('get_five_factor_scorecard', { country_code: 'US', preset: 'NATO' })), deps);
    assert.equal((await response.json()).error.code, -32602);
    assert.equal(requests.length, 0);
  });

  it('preserves a NATO-sized provenance response that exceeds the old 128 KiB budget', async () => {
    const members = Array.from({ length: 32 }, (_, index) => `M${String(index).padStart(2, '0')}`);
    const verboseObservation = {
      name: 'source-preserving technology observation', value: 1, year: 2024, unit: 'per million',
      source: `World Bank indicator provenance ${'x'.repeat(380)}`, indicatorCode: 'IP.JRN.ARTC.SC',
    };
    downstreamResponse = {
      scorecard: {
        id: 'NATO', label: 'NATO', methodologyVersion: '1.0.0', computedAt: '2026-08-29T00:00:00.000Z',
        members, includedMembers: [], excludedMembers: members.map((countryCode) => ({ countryCode, reason: 'country-unavailable' })),
        pillars: Array.from({ length: 5 }, (_, pillarIndex) => ({
          pillar: `pillar-${pillarIndex}`, hasScore: false, score: 0, subScore: 0, band: '', inputCoverage: 0,
          aggregationMethod: 'population-weighted-continuous-score', insufficientReasons: ['coverage-below-floor'],
          includedMembers: [], excludedMembers: members.map((countryCode) => ({ countryCode, reason: 'country-unavailable' })),
          inputs: Array.from({ length: 42 }, (_, inputIndex) => ({
            inputId: `input-${pillarIndex}-${inputIndex}`, available: true, value: 1, hasValue: true, year: 2024,
            unit: 'index', source: 'World Bank', sourceKey: 'economic:worldbank-techreadiness:v1', unavailableReason: '',
            quality: 'observed', observations: [verboseObservation],
          })),
        })),
      },
      unavailable: false,
      unavailableReason: '',
    };
    const responseBytes = Buffer.byteLength(JSON.stringify(downstreamResponse));
    assert.ok(responseBytes > 131_072, `fixture must exceed old budget, got ${responseBytes}`);
    assert.ok(responseBytes < 524_288, `fixture must fit new budget, got ${responseBytes}`);

    const { deps } = makeProDeps();
    const response = await mcpHandler(proReq('POST', callBody('get_five_factor_scorecard', { preset: 'NATO' })), deps);
    const body = await response.json();
    assert.deepEqual(JSON.parse(body.result.content[0].text), downstreamResponse);
  });

  it('lists compact country summaries through the bulk REST route', async () => {
    downstreamResponse = {
      methodologyVersion: '1.0.0',
      computedAt: '2026-08-29T00:00:00.000Z',
      scorecards: [{
        ...canonicalResponse.scorecard,
        pillars: canonicalResponse.scorecard.pillars.map((pillar) => ({ ...pillar, inputs: [{ ...pillar.inputs[0], source: 'not returned by compact MCP list' }] })),
      }],
      unavailable: false,
      unavailableReason: '',
    };
    const listed = await mcpHandler(new Request('https://worldmonitor.app/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }));
    const listTool = (await listed.json()).result.tools.find((entry) => entry.name === 'list_five_factor_scorecards');
    assert.ok(listTool);

    const { deps } = makeProDeps();
    const response = await mcpHandler(proReq('POST', callBody('list_five_factor_scorecards', {})), deps);
    const body = JSON.parse((await response.json()).result.content[0].text);
    assert.equal(new URL(requests[0].url).pathname, '/api/scorecard/v1/list-five-factor-scorecards');
    assert.equal(body.scorecards[0].countryCode, 'ZW');
    assert.equal(body.scorecards[0].pillars[0].hasScore, false);
    assert.equal(body.scorecards[0].pillars[0].inputCoverage, 0.55);
    assert.ok(!('inputs' in body.scorecards[0].pillars[0]));
    assert.ok(Buffer.byteLength(JSON.stringify(body)) < 262_144);
  });
});
