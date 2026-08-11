// Served-shape coverage for get_world_brief corroboration (#4925 item 3).
//
// Before this suite, get_world_brief had no served-shape enforcement at all:
// tests/mcp-tool-output-contracts.test.mjs monkey-patches _execute and states
// that field-level drift for RPC tools is out of scope, and none of the three
// jmespath fixtures in tests/mcp-output-schema-coverage.test.mjs cover this
// tool. So these cases drive the real projector against a real snapshot.

import { afterEach, beforeEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { mcpHandler } from '../api/mcp.ts';
import { HMAC_SECRET, callBody, makePipelineMock } from './helpers/mcp-pro-deps.mjs';

const ENV_KEY = 'operator_test_key_world_brief_corroboration';
const MCP_URL = 'https://api.worldmonitor.app/api/mcp';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const originalLog = console.log;
const originalWarn = console.warn;

function makeDeps() {
  const pipe = makePipelineMock();
  return {
    resolveBearerToContext: async () => null,
    validateProMcpToken: async () => null,
    getEntitlements: async () => ({
      planKey: 'pro',
      features: { tier: 1, mcpAccess: true, apiAccess: true },
      validUntil: Date.now() + 86_400_000,
    }),
    validateUserApiKey: async () => null,
    guardUserApiKeyValidation: async () => null,
    redisPipeline: pipe.pipeline,
  };
}

/** One story as `scripts/seed-insights.mjs` actually writes it into
 *  `news:insights:v1` — the field names come from that producer, not from the
 *  MCP layer, so a rename upstream must break these tests. */
function seededStory(overrides = {}) {
  return {
    primaryTitle: 'Corroborated headline',
    primarySource: 'Example Wire',
    primaryLink: 'https://example.com/story',
    pubDate: '2026-08-10T00:00:00.000Z',
    sourceCount: 9,
    uniqueSourceCount: 6,
    sources: ['Reuters', 'AP', 'BBC', 'AFP', 'Kyodo', 'DPA'],
    memberTitles: ['Corroborated headline', 'A second wording of the same story'],
    lastUpdated: '2026-08-10T00:00:00.000Z',
    sourceTier: 1,
    upstreamImportanceScore: 71,
    entityCorroboration: true,
    corroborationSourceCount: 5,
    effectiveImportanceScore: 88,
    ...overrides,
  };
}

function insightsPayload(stories) {
  return {
    worldBrief: 'Seeded grounded world brief.',
    briefStoryLines: [{ n: 1, text: 'Seeded grounded world brief.' }],
    worldBriefSources: [{
      title: 'Corroborated headline',
      source: 'Example Wire',
      url: 'https://example.com/story',
      publishedAt: '2026-08-10T00:00:00.000Z',
    }],
    briefProvider: 'seeded-provider',
    briefModel: 'seeded-model',
    generatedAt: new Date().toISOString(),
    status: 'ok',
    topStories: stories,
  };
}

function stubInsights(stories) {
  globalThis.fetch = async (input) => {
    const { pathname } = new URL(String(input));
    if (pathname === '/api/infrastructure/v1/get-bootstrap-data') {
      return new Response(JSON.stringify({
        data: { insights: JSON.stringify(insightsPayload(stories)) },
        missing: [],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`Unexpected downstream URL: ${String(input)}`);
  };
}

async function callWorldBrief(id = 1) {
  const request = new Request(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': ENV_KEY },
    body: JSON.stringify(callBody('get_world_brief', {}, id)),
  });
  const response = await mcpHandler(request, makeDeps());
  assert.equal(response.status, 200, 'transport status');
  const rpc = await response.json();
  assert.ok(rpc.result?.content?.[0]?.text, `no tool result: ${JSON.stringify(rpc).slice(0, 400)}`);
  return { payload: JSON.parse(rpc.result.content[0].text), rawText: rpc.result.content[0].text };
}

beforeEach(() => {
  process.env.WORLDMONITOR_VALID_KEYS = ENV_KEY;
  process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
  delete process.env.MCP_TELEMETRY;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  console.log = () => {};
  console.warn = () => {};
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.warn = originalWarn;
  Object.keys(process.env).forEach((key) => {
    if (!(key in originalEnv)) delete process.env[key];
  });
  Object.assign(process.env, originalEnv);
});

describe('get_world_brief story corroboration (#4925 item 3)', () => {
  it('carries the corroboration counts the seeder published', async () => {
    stubInsights([seededStory()]);

    const { payload } = await callWorldBrief();

    assert.deepEqual(payload.topStories, [{
      title: 'Corroborated headline',
      sourceCount: 9,
      uniqueSourceCount: 6,
      corroborationSourceCount: 5,
      entityCorroboration: true,
      sourceTier: 1,
      sources: ['Reuters', 'AP', 'BBC', 'AFP', 'Kyodo', 'DPA'],
    }]);
  });

  it('keeps topStories index-aligned with headlines', async () => {
    // The alignment is the contract an agent relies on to attach evidence to a
    // headline, so assert it across a mixed batch that also exercises the
    // skip path (a story with no usable primaryTitle must drop from BOTH).
    stubInsights([
      seededStory({ primaryTitle: 'First story', uniqueSourceCount: 2 }),
      seededStory({ primaryTitle: '' }),
      seededStory({ primaryTitle: 'Third story', uniqueSourceCount: 4 }),
    ]);

    const { payload } = await callWorldBrief();

    assert.deepEqual(payload.headlines, ['First story', 'Third story']);
    assert.equal(payload.topStories.length, payload.headlines.length);
    payload.headlines.forEach((headline, index) => {
      assert.equal(payload.topStories[index].title, headline, `topStories[${index}] must describe headlines[${index}]`);
    });
    assert.deepEqual(payload.topStories.map((s) => s.uniqueSourceCount), [2, 4]);
  });

  it('caps the per-story outlet list at 12', async () => {
    // sources is the only unbounded sub-array on this payload, and the tool has
    // a hard 64 KB output budget whose overflow replaces the whole response.
    const manyOutlets = Array.from({ length: 25 }, (_, i) => `Outlet ${i + 1}`);
    stubInsights([seededStory({ sources: manyOutlets })]);

    const { payload } = await callWorldBrief();

    assert.equal(payload.topStories[0].sources.length, 12);
    assert.deepEqual(payload.topStories[0].sources.slice(0, 2), ['Outlet 1', 'Outlet 2']);
  });

  it('omits memberTitles from the world brief', async () => {
    // Deliberate: memberTitles is a full set of clustered headlines and would be
    // the single largest field in a 64 KB budget, while being the most
    // redundant with `title`. It IS declared on get_news_intelligence, which
    // has twice the budget. Asserted so a later "just add everything" change
    // has to argue with a test rather than silently blow the budget.
    stubInsights([seededStory()]);

    const { payload } = await callWorldBrief();

    assert.equal(payload.topStories[0].memberTitles, undefined);
  });

  it('omits missing and non-finite producer fields instead of fabricating corroboration state', async () => {
    // This projector is the trust boundary for the MCP surface. A pre-#4925
    // snapshot has none of these fields at all.
    stubInsights([{
      primaryTitle: 'Legacy story with no corroboration fields',
      sourceCount: Number.NaN,
      uniqueSourceCount: null,
      entityCorroboration: 'yes',
      sources: ['Real Outlet', 42, '', null],
    }]);

    const { payload } = await callWorldBrief();

    assert.deepEqual(payload.topStories, [{
      title: 'Legacy story with no corroboration fields',
      sources: ['Real Outlet'],
    }]);
  });

  it('preserves explicit zero and false corroboration values', async () => {
    stubInsights([seededStory({
      sourceCount: 0,
      uniqueSourceCount: 0,
      corroborationSourceCount: 0,
      entityCorroboration: false,
      sources: [],
    })]);

    const { payload } = await callWorldBrief();

    assert.deepEqual(payload.topStories, [{
      title: 'Corroborated headline',
      sourceCount: 0,
      uniqueSourceCount: 0,
      corroborationSourceCount: 0,
      entityCorroboration: false,
      sourceTier: 1,
      sources: [],
    }]);
  });

  it('stays inside the 64KB output budget with a worst-case snapshot', async () => {
    // 12 stories (the headline cap) each at the 500-char title clip and the
    // 12-outlet cap. If this ever exceeds the budget, api/mcp/dispatch.ts
    // replaces the entire response with { _budget_exceeded: true } — a
    // user-visible regression, not a silent truncation.
    const longTitle = 'W'.repeat(600);
    const outlets = Array.from({ length: 12 }, (_, i) => `Long Outlet Name Number ${i + 1}`);
    stubInsights(Array.from({ length: 12 }, (_, i) => seededStory({
      primaryTitle: `${i} ${longTitle}`,
      sources: outlets,
    })));

    const { payload, rawText } = await callWorldBrief();

    assert.equal(payload._budget_exceeded, undefined, 'response must not be replaced by the budget guard');
    assert.equal(payload.topStories.length, 12);
    assert.ok(
      Buffer.byteLength(rawText, 'utf8') < 65_536,
      `serialized world brief is ${Buffer.byteLength(rawText, 'utf8')} bytes, over the 65536 budget`,
    );
  });
});
