import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { HMAC_SECRET, callBody, makeProDeps, proReq } from './helpers/mcp-pro-deps.mjs';
import { dispatchToolsCall } from '../api/mcp/dispatch.ts';
import { TOOL_REGISTRY } from '../api/mcp/registry/index.ts';

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
    assert.deepEqual(tool.inputSchema.oneOf, [
      { required: ['country_code'] },
      { required: ['preset'] },
      { required: ['members'] },
    ]);
    assert.deepEqual(tool.inputSchema.properties.preset.enum, ['USMCA', 'EU27', 'BRICS', 'GCC', 'ASEAN', 'NATO']);
    assert.equal(tool.inputSchema.properties.members.minItems, 2);
    assert.equal(tool.inputSchema.properties.members.maxItems, 30);
    assert.equal(tool.inputSchema.properties.members.uniqueItems, true);
    assert.equal(tool.inputSchema.properties.members.items.pattern, '^[A-Z]{2}$');
    assert.ok(tool.outputSchema.properties.scorecard.properties.id);
    assert.ok(tool.outputSchema.properties.scorecard.properties.label);
    assert.ok(tool.outputSchema.properties.scorecard.properties.includedMembers);
    assert.ok(tool.outputSchema.properties.scorecard.properties.excludedMembers);
    assert.ok(tool.outputSchema.properties.scorecard.properties.pillars.items.properties.includedMembers);
    assert.ok(tool.outputSchema.properties.scorecard.properties.pillars.items.properties.excludedMembers);
    assert.ok(tool.outputSchema.properties.scorecard.properties.pillars.items.properties.memberWeights);
    assert.equal(tool.outputSchema.oneOf.length, 2);
    assert.deepEqual(tool.outputSchema.oneOf[0].properties, {
      unavailable: { const: false },
      unavailableReason: { const: '' },
    });
    assert.deepEqual(tool.outputSchema.oneOf[1].properties, {
      unavailable: { const: true },
      unavailableReason: {
        enum: ['country-unavailable', 'bloc-members-unavailable', 'scorecard-snapshot-unavailable'],
      },
    });
    assert.equal(tool.outputSchema.properties.scorecard.oneOf.length, 2);
    const pillarSchema = tool.outputSchema.properties.scorecard.properties.pillars.items.properties;
    assert.deepEqual(pillarSchema.pillar.enum, ['food', 'energy', 'demographics', 'technology', 'defense']);
    assert.deepEqual(pillarSchema.band.enum, ['', 'severe-deficit', 'material-deficit', 'mixed-capability', 'strong-capability', 'high-capability']);
    assert.deepEqual(pillarSchema.aggregationMethod.enum, ['country-weighted-components', 'aggregate-physical-inputs', 'population-weighted-continuous-score']);
    assert.deepEqual(pillarSchema.insufficientReasons.items.enum, [
      'source-unavailable', 'country-unavailable', 'invalid-value', 'stale', 'coverage-below-floor',
      'required-group-missing', 'missing-population', 'redistribution-blocked',
    ]);
    assert.deepEqual([pillarSchema.score.minimum, pillarSchema.score.maximum], [0, 5]);
    assert.deepEqual([pillarSchema.subScore.minimum, pillarSchema.subScore.maximum], [0, 100]);
    assert.deepEqual([pillarSchema.inputCoverage.minimum, pillarSchema.inputCoverage.maximum], [0, 1]);
    const observationSchema = tool.outputSchema.properties.scorecard.properties.pillars.items.properties.inputs.items.properties.observations.items;
    assert.deepEqual(Object.keys(observationSchema.properties), ['name', 'value', 'year', 'unit', 'source', 'indicatorCode']);

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

  it('preserves a full NATO-sized provenance response within the measured 1 MiB budget', async () => {
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
          inputs: Array.from({ length: pillarIndex < 2 ? 32 * 4 : pillarIndex < 4 ? 32 * 7 : 32 * 5 }, (_, inputIndex) => ({
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
    assert.ok(responseBytes > 524_288, `fixture must exceed the prior incomplete budget, got ${responseBytes}`);
    assert.ok(responseBytes < 1_048_576, `fixture must fit measured budget, got ${responseBytes}`);

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
        countryCode: canonicalResponse.scorecard.countryCode,
        pillars: canonicalResponse.scorecard.pillars.map((pillar) => ({
          pillar: pillar.pillar,
          hasScore: pillar.hasScore,
          score: pillar.score,
          subScore: pillar.subScore,
          band: pillar.band,
          inputCoverage: pillar.inputCoverage,
          insufficientReasons: pillar.insufficientReasons,
        })),
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
    assert.match(listTool.description, /read hasScore first/);
    assert.match(listTool.outputSchema.properties.scorecards.items.properties.pillars.items.properties.hasScore.description, /proto3 zero placeholders/);
    assert.deepEqual(listTool.outputSchema.oneOf, [
      {
        properties: {
          unavailable: { const: false },
          unavailableReason: { const: '' },
          methodologyVersion: { const: '1.0.0' },
        },
      },
      {
        properties: {
          unavailable: { const: true },
          unavailableReason: { const: 'scorecard-snapshot-unavailable' },
          methodologyVersion: { const: '' },
          computedAt: { const: '' },
          scorecards: { maxItems: 0 },
        },
      },
    ]);

    const { deps } = makeProDeps();
    const response = await mcpHandler(proReq('POST', callBody('list_five_factor_scorecards', {})), deps);
    const body = JSON.parse((await response.json()).result.content[0].text);
    assert.equal(new URL(requests[0].url).pathname, '/api/scorecard/v1/list-five-factor-scorecards');
    assert.equal(body.scorecards[0].countryCode, 'ZW');
    assert.equal(body.scorecards[0].pillars[0].hasScore, false);
    assert.equal(body.scorecards[0].pillars[0].inputCoverage, 0.55);
    assert.deepEqual(body, downstreamResponse);
    assert.ok(Buffer.byteLength(JSON.stringify(body)) < 262_144);
  });
});

// Every test above authenticates as Pro. The one generic denial sweep,
// tests/mcp-free-tier-subset.test.mjs, only samples
// `TOOL_REGISTRY.filter(t => t._freeTier !== true).slice(0, 12)` -- and since
// get_sources is the sole free-tier tool, that window is exactly the first 12
// CACHE_TOOLS entries. The scorecard tools live in RPC_TOOLS well past index 12,
// so they were structurally unreachable by it: a regression in the entitlement
// gate on these paid endpoints would have shipped with every test still green.
describe('five-factor scorecard MCP tools refuse a free principal', () => {
  const call = (toolName) => dispatchToolsCall(
    new Request('https://worldmonitor.app/mcp', { method: 'POST' }),
    { kind: 'free' },
    { redisPipeline: async () => { throw new Error('quota must not be reached'); } },
    { id: 1, params: { name: toolName, arguments: { countryCode: 'ZW' } } },
    {},
  );

  // Derived from the registry rather than hardcoded, so a fourth scorecard tool
  // added later cannot quietly skip this check the way these two skipped the
  // sampled sweep.
  const scorecardTools = TOOL_REGISTRY
    .filter((tool) => tool._freeTier !== true && /five_factor_scorecard|bloc_scorecard/.test(tool.name))
    .map((tool) => tool.name);

  it('covers every gated scorecard tool in the registry', () => {
    assert.ok(scorecardTools.length >= 2, `expected the scorecard tools in TOOL_REGISTRY, got ${JSON.stringify(scorecardTools)}`);
    assert.ok(scorecardTools.includes('get_five_factor_scorecard'));
    assert.ok(scorecardTools.includes('list_five_factor_scorecards'));
  });

  for (const toolName of ['get_five_factor_scorecard', 'list_five_factor_scorecards']) {
    it(`refuses ${toolName} without an entitlement`, async () => {
      const res = await call(toolName);
      const body = await res.json();
      assert.ok(body.error, `${toolName} must not be served to a free principal`);
      assert.equal(body.error.code, -32001);
    });
  }
});
