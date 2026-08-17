// Served-shape coverage for get_country_brief grounding corroboration
// (#4925 item 3).
//
// The digest carries corroborationCount and storyMeta on every item
// (server/worldmonitor/news/v1/list-feed-digest.ts toProtoItem), and the tool
// threw both away. Corroboration cannot ride on `sources`: that array is the
// proto BriefSource shape returned by the gateway, so it lands on a sibling
// `groundingStories` field instead. These cases pin that decision.

import { afterEach, beforeEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { mcpHandler } from '../api/mcp.ts';
import { HMAC_SECRET, callBody, makePipelineMock } from './helpers/mcp-pro-deps.mjs';

const ENV_KEY = 'operator_test_key_country_brief_grounding';
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

/** A digest item as toProtoItem actually emits it. */
function digestItem(overrides = {}) {
  return {
    title: 'France announces new energy package',
    source: 'Example Wire',
    link: 'https://example.com/fr-energy',
    publishedAt: 1_786_320_000_000,
    corroborationCount: 4,
    storyMeta: {
      firstSeen: 1_754_000_000_000,
      mentionCount: 3,
      sourceCount: 4,
      phase: 'STORY_PHASE_DEVELOPING',
    },
    ...overrides,
  };
}

/** The gateway's own source list, which wins over the MCP-local grounding set
 *  on the common path — this is why groundingStories cannot derive from it. */
const UPSTREAM_SOURCES = [{
  title: 'Upstream server-side grounding article',
  source: 'Server Wire',
  link: 'https://example.com/upstream',
  publishedAt: '2026-08-10T01:00:00.000Z',
}];

function stubDownstream({ digestItems, digestOk = true, briefSources = UPSTREAM_SOURCES }) {
  globalThis.fetch = async (input) => {
    const { pathname } = new URL(String(input));
    if (pathname === '/api/news/v1/list-feed-digest') {
      if (!digestOk) throw new Error('digest unavailable');
      return new Response(JSON.stringify({
        categories: { world: { items: digestItems } },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (pathname === '/api/intelligence/v1/get-country-intel-brief') {
      return new Response(JSON.stringify({
        country_code: 'FR',
        brief: 'Synthesized country brief.',
        framework: '',
        generatedAt: '2026-08-10T02:00:00.000Z',
        provider: 'seeded-provider',
        model: 'seeded-model',
        sources: briefSources,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`Unexpected downstream URL: ${String(input)}`);
  };
}

async function callCountryBriefResult(id = 1) {
  const request = new Request(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WorldMonitor-Key': ENV_KEY },
    body: JSON.stringify(callBody('get_country_brief', { country_code: 'FR' }, id)),
  });
  const response = await mcpHandler(request, makeDeps());
  assert.equal(response.status, 200, 'transport status');
  const rpc = await response.json();
  assert.ok(rpc.result?.content?.[0]?.text, `no tool result: ${JSON.stringify(rpc).slice(0, 400)}`);
  const rawText = rpc.result.content[0].text;
  return { payload: JSON.parse(rawText), rawText };
}

async function callCountryBrief(id = 1) {
  const { payload } = await callCountryBriefResult(id);
  return payload;
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

describe('get_country_brief grounding corroboration (#4925 item 3)', () => {
  it('emits groundingStories even when the upstream supplies its own sources', async () => {
    // The decision this pins: sources keeps the gateway's proto BriefSource
    // list untouched, and corroboration arrives on a sibling field that is
    // still populated on that path.
    stubDownstream({ digestItems: [digestItem()] });

    const payload = await callCountryBrief();

    assert.deepEqual(
      payload.sources.map((s) => s.title),
      ['Upstream server-side grounding article'],
      'sources must still be the upstream citation list',
    );
    assert.deepEqual(payload.groundingStories, [{
      title: 'France announces new energy package',
      source: 'Example Wire',
      url: 'https://example.com/fr-energy',
      publishedAt: '2026-08-10T00:00:00.000Z',
      corroborationCount: 4,
      mentionCount: 3,
      storyPhase: 'STORY_PHASE_DEVELOPING',
    }]);
  });

  it('drops digest items that carry no corroboration metadata', async () => {
    // A digest predating the story-identity service has neither field. Emitting
    // a row of zeroes for it would read as "single unconfirmed source", which
    // is a claim we cannot make; omission is the honest answer.
    stubDownstream({
      digestItems: [
        { title: 'Legacy item, no story tracking', source: 'Old Wire', link: 'https://example.com/legacy' },
        digestItem({ title: 'Tracked item', corroborationCount: 7 }),
      ],
    });

    const payload = await callCountryBrief();

    assert.deepEqual(payload.groundingStories.map((s) => s.title), ['Tracked item']);
    assert.equal(payload.groundingStories[0].corroborationCount, 7);
  });

  it('returns an empty groundingStories when the digest read fails', async () => {
    // The brief is still produced without grounding context; an empty array is
    // the signal that no corroboration was observed, not that there was none.
    stubDownstream({ digestItems: [], digestOk: false });

    const payload = await callCountryBrief();

    assert.equal(payload.brief, 'Synthesized country brief.');
    assert.deepEqual(payload.groundingStories, []);
  });

  it('caps groundingStories at six and dedupes repeated titles', async () => {
    const items = Array.from({ length: 9 }, (_, i) => digestItem({
      title: `Story ${i}`,
      link: `https://example.com/s${i}`,
      corroborationCount: i,
    }));
    // A duplicate title is the same story reaching the digest twice.
    items.push(digestItem({ title: 'Story 0', link: 'https://example.com/dupe' }));
    stubDownstream({ digestItems: items });

    const payload = await callCountryBrief();

    assert.equal(payload.groundingStories.length, 6);
    assert.deepEqual(
      payload.groundingStories.map((s) => s.title),
      ['Story 0', 'Story 1', 'Story 2', 'Story 3', 'Story 4', 'Story 5'],
    );
  });

  it('omits optional fields rather than emitting undefined placeholders', async () => {
    stubDownstream({
      digestItems: [{
        title: 'Corroboration count only',
        source: 'Example Wire',
        link: 'https://example.com/count-only',
        corroborationCount: 2,
      }],
    });

    const payload = await callCountryBrief();

    assert.deepEqual(payload.groundingStories, [{
      title: 'Corroboration count only',
      source: 'Example Wire',
      url: 'https://example.com/count-only',
      corroborationCount: 2,
    }]);
  });

  it('omits oversized grounding URLs before the serialized response exceeds its budget', async () => {
    const longUrls = Array.from({ length: 6 }, (_, i) => (
      `https://example.com/${'x'.repeat(6_000)}-${i}`
    ));
    stubDownstream({
      digestItems: longUrls.map((link, i) => digestItem({
        title: `France grounding story ${i}`,
        link,
      })),
      // Keep the canonical citation URLs present. The regression was the new
      // groundingStories field duplicating all six and crossing the 64 KB cap.
      briefSources: longUrls.map((link, i) => ({
        title: `France grounding story ${i}`,
        source: 'Example Wire',
        link,
      })),
    });

    const { payload, rawText } = await callCountryBriefResult();

    assert.equal(payload._budget_exceeded, undefined, 'response must not be replaced by the budget guard');
    assert.equal(payload.sources.length, 6, 'canonical citations remain available');
    assert.equal(payload.groundingStories.length, 6);
    assert.ok(payload.groundingStories.every((story) => story.url === undefined));
    assert.ok(
      Buffer.byteLength(rawText, 'utf8') < 65_536,
      `serialized country brief is ${Buffer.byteLength(rawText, 'utf8')} bytes, over the 65536 budget`,
    );
  });
});
