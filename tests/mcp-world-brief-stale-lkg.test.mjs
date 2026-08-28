// get_world_brief must serve last-known-good instead of failing closed
// (WORLDMONITOR-YJ).
//
// The producer deliberately preserves LKG when synthesis fails —
// `scripts/seed-insights.mjs` has two explicit branches for it and a whole
// `LKG_PRESERVED` run outcome. The consumer then threw that work away 60
// minutes later: `INSIGHTS_MAX_AGE_MS` rejected the snapshot and the tool
// raised `McpSourceUnavailableError`, so a Pro caller got a hard error while a
// complete, valid brief sat in Redis for another two hours (the key's TTL is
// 3h; the gate is 1h).
//
// Measured 2026-08-28: `news:insights:v1` TTL 10362s remaining against a
// 60-minute gate — a ~2h window where usable content existed and every
// consumer refused it. WORLDMONITOR-YJ fired 31 times / 28 users.
//
// Staleness is now reported, not thrown. Only `stale-snapshot` becomes
// serveable: every other rejection reason means the payload is absent or
// broken (no stories, no brief text, an unparseable or future timestamp, a
// producer that disclaimed its own output), and those still fail closed.

import { afterEach, beforeEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { mcpHandler } from '../api/mcp.ts';
import { HMAC_SECRET, callBody, makePipelineMock } from './helpers/mcp-pro-deps.mjs';

const ENV_KEY = 'operator_test_key_world_brief_stale_lkg';
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

/** One story as `scripts/seed-insights.mjs` writes it into news:insights:v1. */
function seededStory() {
  return {
    primaryTitle: 'Corroborated headline',
    primarySource: 'Example Wire',
    primaryLink: 'https://example.com/story',
    pubDate: '2026-08-10T00:00:00.000Z',
    sourceCount: 9,
    uniqueSourceCount: 6,
    sources: ['Reuters', 'AP'],
    memberTitles: ['Corroborated headline'],
    lastUpdated: '2026-08-10T00:00:00.000Z',
    sourceTier: 1,
    upstreamImportanceScore: 71,
    entityCorroboration: true,
    corroborationSourceCount: 5,
    effectiveImportanceScore: 88,
  };
}

function insightsPayload(overrides = {}) {
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
    topStories: [seededStory()],
    ...overrides,
  };
}

function stubInsights(payload) {
  globalThis.fetch = async (input) => {
    const { pathname } = new URL(String(input));
    if (pathname === '/api/infrastructure/v1/get-bootstrap-data') {
      return new Response(JSON.stringify({
        data: { insights: JSON.stringify(payload) },
        missing: [],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`Unexpected downstream URL: ${String(input)}`);
  };
}

/** Raw RPC envelope, so a test can assert on the ERROR path too. */
async function callWorldBriefRpc(id = 1) {
  const request = new Request(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': ENV_KEY },
    body: JSON.stringify(callBody('get_world_brief', {}, id)),
  });
  const response = await mcpHandler(request, makeDeps());
  assert.equal(response.status, 200, 'transport status');
  return response.json();
}

async function callWorldBrief(id = 1) {
  const rpc = await callWorldBriefRpc(id);
  assert.ok(rpc.result?.content?.[0]?.text, `no tool result: ${JSON.stringify(rpc).slice(0, 400)}`);
  return JSON.parse(rpc.result.content[0].text);
}

const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

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

describe('get_world_brief serves stale LKG instead of failing (WORLDMONITOR-YJ)', () => {
  it('serves a 90-minute-old brief rather than erroring', async () => {
    // The exact case that produced WORLDMONITOR-YJ: past the 60-minute gate,
    // well inside the 3h Redis TTL, payload otherwise perfect.
    stubInsights(insightsPayload({ generatedAt: minutesAgo(90) }));

    const payload = await callWorldBrief();

    assert.equal(payload.brief, 'Seeded grounded world brief.');
    assert.equal(payload.headlines.length, 1, 'the served brief keeps its content');
  });

  it('labels the staleness so an agent can decide', async () => {
    stubInsights(insightsPayload({ generatedAt: minutesAgo(90) }));

    const payload = await callWorldBrief();

    assert.equal(payload.stale, true, 'must say it is stale');
    assert.ok(
      payload.ageMinutes >= 89 && payload.ageMinutes <= 92,
      `ageMinutes should be ~90, got ${payload.ageMinutes}`,
    );
    assert.ok(payload.generatedAt, 'generatedAt must survive so the age is checkable');
  });

  it('reports stale:false on a fresh snapshot', async () => {
    // Positive control: the flag has to discriminate, not be hardcoded true.
    stubInsights(insightsPayload({ generatedAt: minutesAgo(2) }));

    const payload = await callWorldBrief();

    assert.equal(payload.stale, false);
    assert.ok(payload.ageMinutes <= 4, `ageMinutes should be ~2, got ${payload.ageMinutes}`);
  });

  it('still fails closed when the payload is BROKEN rather than merely old', async () => {
    // Serving LKG is licensed by the content being intact. These are not.
    const brokenCases = [
      ['no stories', { topStories: [] }],
      ['empty brief text', { worldBrief: '   ' }],
      ['producer disclaimed it', { status: 'degraded' }],
      ['unparseable timestamp', { generatedAt: 'not-a-date' }],
      ['future timestamp', { generatedAt: new Date(Date.now() + 3_600_000).toISOString() }],
    ];
    for (const [label, override] of brokenCases) {
      stubInsights(insightsPayload(override));
      const rpc = await callWorldBriefRpc();
      const text = rpc.result?.content?.[0]?.text ?? '';
      const surfaced = rpc.error ? JSON.stringify(rpc.error) : text;
      assert.ok(
        /unavailable/i.test(surfaced),
        `${label}: must still fail closed, got ${surfaced.slice(0, 200)}`,
      );
    }
  });

  it('a stale AND broken payload still fails closed', async () => {
    // Staleness must not become a blanket amnesty: age is only forgiven when
    // everything else about the snapshot is sound.
    stubInsights(insightsPayload({ generatedAt: minutesAgo(90), worldBrief: '' }));

    const rpc = await callWorldBriefRpc();
    const text = rpc.result?.content?.[0]?.text ?? '';
    const surfaced = rpc.error ? JSON.stringify(rpc.error) : text;
    assert.ok(/unavailable/i.test(surfaced), `got ${surfaced.slice(0, 200)}`);
  });
});
