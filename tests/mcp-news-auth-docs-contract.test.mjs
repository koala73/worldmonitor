import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { __testing__ } from '../api/mcp.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function readRepoFile(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

function rpcTool(name) {
  const tool = __testing__.TOOL_REGISTRY.find((candidate) => candidate.name === name);
  assert.ok(tool, `${name} must be registered`);
  assert.equal(typeof tool._execute, 'function', `${name} must be an RPC tool`);
  return tool;
}

function seededInsights(overrides = {}) {
  return {
    worldBrief: 'Seeded grounded world brief.',
    briefStoryLines: [{ n: 1, text: 'Seeded grounded world brief.' }],
    worldBriefSources: [{
      title: 'United States headline used for MCP grounding',
      source: 'Example Wire',
      url: 'https://example.com/world-grounding',
      publishedAt: '2026-06-07T00:00:00.000Z',
    }],
    briefProvider: 'seeded-provider',
    briefModel: 'seeded-model',
    generatedAt: new Date().toISOString(),
    status: 'ok',
    topStories: [{ primaryTitle: 'United States headline used for MCP grounding' }],
    ...overrides,
  };
}

async function captureRpcFetches(toolName, params, opts = {}) {
  const calls = [];
  const insights = seededInsights(opts.insights);
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const { pathname } = new URL(url);

    if (pathname === '/api/infrastructure/v1/get-bootstrap-data') {
      return new Response(JSON.stringify({ data: { insights: JSON.stringify(insights) }, missing: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (pathname === '/api/news/v1/list-feed-digest') {
      return new Response(JSON.stringify({
        generatedAt: '2026-06-07T00:00:00.000Z',
        categories: {
          world: {
            items: [
              ...(opts.longCountryHeadline ? [{
                title: `United States ${'%'.repeat(3900)}`,
                source: 'Long Wire',
                link: 'https://example.com/long-context',
                publishedAt: '2026-06-07T00:00:00.000Z',
                snippet: 'Large context headline used to prove the signed URL stays short.',
              }] : []),
              {
                title: 'United States headline used for MCP grounding',
                source: 'Example Wire',
                link: 'https://example.com/world-grounding',
                publishedAt: '2026-06-07T00:00:00.000Z',
                snippet: 'Short RSS context used by the LLM prompt.',
              },
              {
                title: 'Unsafe link should not become a source',
                source: 'Bad Feed',
                link: 'javascript:alert(1)',
                snippet: 'This item has an unsafe URL.',
              },
              ...(toolName === 'get_country_brief' ? [{
                title: 'Russia housing vote should not match the country code',
                source: 'Substring Wire',
                link: 'https://example.com/russia-house',
                publishedAt: '2026-06-07T00:00:00.000Z',
                snippet: 'A Moscow story whose text contains incidental substrings.',
              }] : []),
            ],
          },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (pathname === '/api/intelligence/v1/get-country-intel-brief') {
      return new Response(JSON.stringify({ brief: 'Grounded country brief.' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`Unexpected fetch in ${toolName}: ${url}`);
  };

  const result = await rpcTool(toolName)._execute(params, 'https://worldmonitor.app', {
    kind: 'env_key',
    apiKey: 'wm_test_key_mcp_news_contract',
  });
  return { calls, result };
}

describe('MCP news/auth public contract', () => {
  it('get_world_brief reads the seeded dashboard brief while country briefs retain digest grounding', async () => {
    const { calls: worldCalls } = await captureRpcFetches('get_world_brief', { geo_context: 'Middle East tensions' });
    const { calls: countryCalls } = await captureRpcFetches('get_country_brief', { country_code: 'US' });

    const worldBootstrapUrls = worldCalls
      .map((call) => new URL(call.url))
      .filter((url) => url.pathname === '/api/infrastructure/v1/get-bootstrap-data');
    assert.equal(worldBootstrapUrls.length, 1, 'world brief should read the shared insights gateway payload');
    assert.equal(worldBootstrapUrls[0].search, '?keys=insights');
    assert.equal(
      worldCalls.some((call) => /\/api\/news\/v1\/(list-feed-digest|summarize-article)/.test(call.url)),
      false,
      'world brief must not invoke the live digest or LLM summarizer paths',
    );

    const digestUrls = countryCalls
      .map((call) => new URL(call.url))
      .filter((url) => url.pathname === '/api/news/v1/list-feed-digest');
    assert.equal(digestUrls.length, 1, 'country brief should still ground on list-feed-digest');
    assert.deepEqual(
      digestUrls.map((url) => url.searchParams.get('variant')),
      ['full'],
      'MCP RPC tools must not rely on unsupported digest variants such as geo',
    );
  });

  it('keeps geo_context as compatibility-only input', async () => {
    const withContext = await captureRpcFetches('get_world_brief', { geo_context: 'Middle East tensions' });
    const withoutContext = await captureRpcFetches('get_world_brief', {});
    const requestShape = ({ calls }) => calls.map((call) => [call.url, String(call.init.body ?? '')]);
    const resultWithoutTimestamp = ({ result }) => {
      const { generatedAt, ...stable } = result;
      assert.match(generatedAt, /^\d{4}-\d{2}-\d{2}T/);
      return stable;
    };

    assert.deepEqual(resultWithoutTimestamp(withContext), resultWithoutTimestamp(withoutContext));
    assert.deepEqual(requestShape(withContext), requestShape(withoutContext));
  });

  it('RPC brief tools return sources from producer records, not generated text', async () => {
    const { result: worldResult } = await captureRpcFetches('get_world_brief', { geo_context: 'Middle East tensions' });
    const { result: countryResult, calls: countryCalls } = await captureRpcFetches('get_country_brief', { country_code: 'US' });

    assert.deepEqual(worldResult.sources, [{
      title: 'United States headline used for MCP grounding',
      source: 'Example Wire',
      url: 'https://example.com/world-grounding',
      publishedAt: '2026-06-07T00:00:00.000Z',
    }]);
    assert.equal(worldResult.summary, 'Seeded grounded world brief.');
    assert.equal(worldResult.sources.some((source) => source.url.startsWith('javascript:')), false);

    assert.deepEqual(countryResult.sources, worldResult.sources);
    const countryBriefCall = countryCalls.find((call) => new URL(call.url).pathname === '/api/intelligence/v1/get-country-intel-brief');
    assert.ok(countryBriefCall, 'get_country_brief should call country brief endpoint');
    const context = JSON.parse(String(countryBriefCall.init.body)).context || '';
    assert.match(context, /Source \[1\]: \{"title":"United States headline used for MCP grounding","source":"Example Wire","url":"https:\/\/example\.com\/world-grounding","publishedAt":"2026-06-07T00:00:00.000Z"\}/);
    assert.doesNotMatch(context, /russia-house/);
  });

  it('fails closed when the shared dashboard payload has no accepted brief', async () => {
    const rejectedPayloads = [
      { worldBrief: '', status: 'degraded' },
      { worldBrief: 'Degraded but non-empty', status: 'degraded' },
      { status: 'unknown' },
      { status: undefined },
      // A merely-OLD snapshot is deliberately absent from this list: it is now
      // served as last-known-good with stale:true rather than failing
      // (WORLDMONITOR-YJ), asserted in the sibling case below. An UNPARSEABLE
      // timestamp stays — that is corruption, not age.
      { generatedAt: 'not-a-timestamp' },
      { topStories: [], generatedAt: new Date().toISOString() },
      { worldBriefSources: [], generatedAt: new Date().toISOString() },
      {
        worldBriefSources: [{
          title: 'No usable source URL',
          source: 'Example Wire',
          url: 'javascript:alert(1)',
        }],
        generatedAt: new Date().toISOString(),
      },
    ];
    for (const insights of rejectedPayloads) {
      await assert.rejects(
        () => captureRpcFetches('get_world_brief', {}, { insights }),
        (error) => error?.name === 'McpSourceUnavailableError'
          && /world brief unavailable/i.test(error.message),
      );
    }
  });

  it('serves an old-but-intact snapshot as flagged last-known-good (WORLDMONITOR-YJ)', () => {
    // The counterpart to the entry removed from rejectedPayloads above. Keeps
    // this contract suite covering staleness rather than losing the case: the
    // producer preserves LKG when synthesis fails, so refusing it 60 minutes
    // later handed Pro callers an error while a complete brief sat in Redis
    // for another two hours.
    return captureRpcFetches('get_world_brief', {}, {
      insights: { generatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() },
    }).then(({ result }) => {
      assert.ok(result?.brief, `expected a served brief, got ${JSON.stringify(result).slice(0, 200)}`);
      assert.equal(result.stale, true, 'must be flagged stale');
      assert.ok(result.ageMinutes >= 118, `ageMinutes should be ~120, got ${result.ageMinutes}`);
    });
  });

  it('preserves producer citation indexes when one source has no usable URL', async () => {
    const { result } = await captureRpcFetches('get_world_brief', {}, {
      insights: seededInsights({
        worldBrief: 'First claim [1]. Second claim [2].',
        topStories: [
          { primaryTitle: 'First headline' },
          { primaryTitle: 'Second headline' },
        ],
        worldBriefSources: [
          { title: 'First headline', source: 'Unavailable Wire', url: '' },
          { title: 'Second headline', source: 'Example Wire', url: 'https://example.com/second' },
        ],
      }),
    });
    assert.deepEqual(result.sources, [
      { title: 'First headline', source: 'Unavailable Wire', url: '' },
      { title: 'Second headline', source: 'Example Wire', url: 'https://example.com/second' },
    ]);
  });

  it('get_country_brief keeps large grounding context out of the signed URL', async () => {
    const { calls } = await captureRpcFetches('get_country_brief', { country_code: 'US' }, { longCountryHeadline: true });
    const countryBriefCall = calls.find((call) => new URL(call.url).pathname === '/api/intelligence/v1/get-country-intel-brief');
    assert.ok(countryBriefCall, 'get_country_brief should call country brief endpoint');

    const url = new URL(countryBriefCall.url);
    assert.equal(url.searchParams.has('context'), false, 'grounding context must not travel in the signed URL query');
    assert.ok(countryBriefCall.url.length < 512, `signed URL should stay short, got ${countryBriefCall.url.length} chars`);

    const body = JSON.parse(String(countryBriefCall.init.body));
    assert.equal(body.country_code, 'US');
    assert.match(body.context, /Brief source articles:/);
    assert.ok(body.context.length >= 3900, `expected large body context, got ${body.context.length} chars`);
  });

  it('RPC brief output schemas expose structured sources', () => {
    for (const name of ['get_world_brief', 'get_country_brief']) {
      const schema = rpcTool(name).outputSchema;
      assert.equal(schema.properties.sources.type, 'array', `${name} must expose sources array`);
      assert.equal(schema.properties.sources.items.properties.url.type, 'string', `${name} sources must expose url`);
      assert.equal(schema.properties.sources.items.properties.title.type, 'string', `${name} sources must expose title`);
      assert.equal(schema.properties.sources.items.properties.source.type, 'string', `${name} sources must expose source`);
    }
    assert.match(rpcTool('get_world_brief').description, /seeded|precomputed|dashboard/i);
    assert.doesNotMatch(rpcTool('get_world_brief').description, /live-fetches.*LLM/i);
  });

  it('MCP-facing docs and fixture helpers do not teach stale API-key prefixes', () => {
    const mcpFacingFiles = [
      'docs/mcp-quickstart.mdx',
      'tests/fixtures/jmespath-samples/README.md',
      'scripts/capture-mcp-fixture.mjs',
    ];

    for (const path of mcpFacingFiles) {
      const text = readRepoFile(path);
      assert.doesNotMatch(text, /wm_live_|wm_pro_/, `${path} must use current wm_ API-key/OAuth-token wording`);
    }

    const quickstart = readRepoFile('docs/mcp-quickstart.mdx');
    assert.match(quickstart, /X-WorldMonitor-Key/, 'quickstart must teach API keys via X-WorldMonitor-Key');
    assert.match(quickstart, /Authorization: Bearer \$TOKEN/, 'quickstart may teach Bearer only for OAuth tokens');
    assert.doesNotMatch(quickstart, /Authorization:\s*Bearer\s+\$WM_KEY/, 'quickstart must not show API keys as bearer tokens');

    const captureScript = readRepoFile('scripts/capture-mcp-fixture.mjs');
    assert.match(captureScript, /WM_MCP_KEY/, 'fixture capture should expose an API-key env var');
    assert.match(captureScript, /WM_MCP_OAUTH_TOKEN/, 'fixture capture should expose an OAuth-token env var');
    assert.doesNotMatch(captureScript, /supplied bearer/i, 'fixture capture should not call API-key credentials bearer credentials');
  });
});
