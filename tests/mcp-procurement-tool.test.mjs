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
  tenders: [{
    id: 'sam:abc-123', source: 'sam', sourceNoticeId: 'abc-123',
    officialUrl: 'https://sam.gov/opp/abc-123', countryCode: 'US', region: 'North America',
    title: 'Cloud security platform', description: 'A long procurement description that must not enter the default MCP result.',
    buyer: 'Example agency', publishedAt: '2026-07-14T00:00:00.000Z', updatedAt: '', deadline: '2026-08-01T00:00:00.000Z',
    status: 'open', noticeType: 'solicitation', money: { amount: 420000, currency: 'USD' },
    categoryCodes: ['541512'], sectors: ['technology'], eligibilityRequirements: ['long upstream eligibility text'],
    submissionUrls: ['https://sam.gov/submit/abc-123'], participationMode: 'unknown',
    automationFit: { level: 'high', score: 91, classificationVersion: 'keyword-v1', matchReasons: ['cloud', 'cybersecurity'], evidence: ['cloud security platform'] },
  }],
  nextCursor: '10', fetchedAt: '2026-07-14T12:00:00.000Z', dataAvailable: true,
  availability: 'partial', sourceStatuses: [{ source: 'sam', state: 'ok', recordCount: 1, fetchedAt: '2026-07-14T12:00:00.000Z', lastSuccessfulAt: '2026-07-14T12:00:00.000Z', stale: false, paced: true }],
  total: 22, appliedFilters: ['country', 'min_automation_score'], countryCoverage: 'unknown',
};

describe('get_procurement_opportunities MCP tool', () => {
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
    const mod = await import(`../api/mcp.ts?procurement=${Date.now()}-${Math.random()}`);
    mcpHandler = mod.mcpHandler;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach((key) => {
      if (!(key in originalEnv)) delete process.env[key];
    });
    Object.assign(process.env, originalEnv);
  });

  async function callTool(args = {}, depsOverrides = {}) {
    const { deps } = makeProDeps(depsOverrides);
    const response = await mcpHandler(proReq('POST', callBody('get_procurement_opportunities', args)), deps);
    return { response, body: await response.json() };
  }

  it('is listed and proxies the canonical route with the bounded query budget', async () => {
    const listed = await mcpHandler(new Request('https://worldmonitor.app/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }));
    const tool = (await listed.json()).result.tools.find((entry) => entry.name === 'get_procurement_opportunities');
    assert.ok(tool, 'tool must be discoverable through tools/list');
    assert.equal(tool.inputSchema.properties.page_size.maximum, 25);
    assert.equal(tool.inputSchema.properties.min_automation_score.maximum, undefined, 'the canonical route owns the score upper-bound clamp');
    assert.match(tool.outputSchema.properties.nextCursor.description, /empty string means no further pages/i);

    const { response, body } = await callTool({
      country: 'US', countries: ['CA', 'GB'], source: 'sam', query: 'cloud security', buyer: 'Example agency',
      deadline_from: '2026-07-15', deadline_to: '2026-08-31', sort: 'relevance', min_automation_score: 101,
      page_size: 100, cursor: '10',
    });

    assert.equal(response.status, 200);
    const requestUrl = new URL(requests[0].url);
    assert.equal(requestUrl.pathname, '/api/economic/v1/list-global-tenders');
    assert.equal(requestUrl.searchParams.get('country'), 'US');
    assert.deepEqual(requestUrl.searchParams.getAll('countries'), ['CA', 'GB']);
    assert.equal(requestUrl.searchParams.get('source'), 'sam');
    assert.equal(requestUrl.searchParams.get('query'), 'cloud security');
    assert.equal(requestUrl.searchParams.get('buyer'), 'Example agency');
    assert.equal(requestUrl.searchParams.get('deadline_from'), '2026-07-15');
    assert.equal(requestUrl.searchParams.get('deadline_to'), '2026-08-31');
    assert.equal(requestUrl.searchParams.get('sort'), 'relevance');
    assert.equal(requestUrl.searchParams.get('min_automation_score'), '101');
    assert.equal(requestUrl.searchParams.get('page_size'), '25');
    assert.equal(requestUrl.searchParams.get('cursor'), '10');
    assert.ok(requests[0].init.headers['X-WM-MCP-Internal'], 'Pro route call must retain internal entitlement identity');

    const result = JSON.parse(body.result.content[0].text);
    assert.equal(result.nextCursor, '10');
    assert.deepEqual(result.appliedFilters, ['country', 'min_automation_score']);
    assert.equal(result.countryCoverage, 'unknown', 'unknown coverage is never a confirmed zero-result');
    assert.equal(result.availability, 'partial');
    assert.deepEqual(result.sourceStatuses, canonicalResponse.sourceStatuses);
    assert.equal(result.sourceStatuses[0].paced, true, 'paced source status survives the canonical route proxy');
    assert.deepEqual(result.opportunities[0], {
      id: 'sam:abc-123', source: 'sam', officialUrl: 'https://sam.gov/opp/abc-123', countryCode: 'US', region: 'North America',
      title: 'Cloud security platform', buyer: 'Example agency', publishedAt: '2026-07-14T00:00:00.000Z', deadline: '2026-08-01T00:00:00.000Z',
      status: 'open', noticeType: 'solicitation', money: { amount: 420000, currency: 'USD' }, categoryCodes: ['541512'], sectors: ['technology'],
      participationMode: 'unknown', automationFit: { score: 91, level: 'high', classificationVersion: 'keyword-v1', matchReasons: ['cloud', 'cybersecurity'] },
    });
    assert.equal('description' in result.opportunities[0], false);
    assert.equal('eligibilityRequirements' in result.opportunities[0], false);
    assert.equal('submissionUrls' in result.opportunities[0], false);
  });

  it('defaults to ten records, caps at 25, and ignores malformed relevance thresholds', async () => {
    await callTool({ min_automation_score: 30.5, page_size: -1 });
    let requestUrl = new URL(requests[0].url);
    assert.equal(requestUrl.searchParams.get('page_size'), '10');
    assert.equal(requestUrl.searchParams.has('min_automation_score'), false);

    requests = [];
    await callTool({ min_automation_score: 1, page_size: 25 });
    requestUrl = new URL(requests[0].url);
    assert.equal(requestUrl.searchParams.get('page_size'), '25');
    assert.equal(requestUrl.searchParams.get('min_automation_score'), '1');
  });

  it('uses the same Pro entitlement gate as the canonical route before fetching data', async () => {
    const { response, body } = await callTool({}, {
      getEntitlements: async () => ({ planKey: 'free', features: { tier: 0, mcpAccess: false }, validUntil: Date.now() + 86_400_000 }),
    });
    assert.equal(response.status, 401);
    assert.equal(body.error.code, -32001);
    assert.equal(requests.length, 0, 'failed entitlement must not reach the canonical route');
  });
});
