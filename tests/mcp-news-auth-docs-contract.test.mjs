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

async function captureRpcFetches(toolName, params) {
  const calls = [];
  let result;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const { pathname } = new URL(url);

    if (pathname === '/api/news/v1/list-feed-digest') {
      return new Response(JSON.stringify({
        generatedAt: '2026-06-07T00:00:00.000Z',
        categories: {
          world: {
            items: [
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

    if (pathname === '/api/news/v1/summarize-article') {
      return new Response(JSON.stringify({ summary: 'Grounded world brief.' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (pathname === '/api/intelligence/v1/get-country-intel-brief') {
      return new Response(JSON.stringify({ brief: 'Grounded country brief.' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`Unexpected fetch in ${toolName}: ${url}`);
  };

  result = await rpcTool(toolName)._execute(params, 'https://worldmonitor.app', {
    kind: 'env_key',
    apiKey: 'wm_test_key_mcp_news_contract',
  });
  return { calls, result };
}

describe('MCP news/auth public contract', () => {
  it('RPC news-brief tools use the documented full digest variant for grounding', async () => {
    const { calls: worldCalls } = await captureRpcFetches('get_world_brief', { geo_context: 'Middle East tensions' });
    const { calls: countryCalls } = await captureRpcFetches('get_country_brief', { country_code: 'US' });
    const allCalls = [...worldCalls, ...countryCalls];

    const digestUrls = allCalls
      .map((call) => new URL(call.url))
      .filter((url) => url.pathname === '/api/news/v1/list-feed-digest');
    assert.equal(digestUrls.length, 2, 'both RPC brief tools should ground on list-feed-digest');
    assert.deepEqual(
      digestUrls.map((url) => url.searchParams.get('variant')),
      ['full', 'full'],
      'MCP RPC tools must not rely on unsupported digest variants such as geo',
    );

    const summarizeCall = allCalls.find((call) => new URL(call.url).pathname === '/api/news/v1/summarize-article');
    assert.ok(summarizeCall, 'get_world_brief should call summarize-article');
    assert.equal(JSON.parse(String(summarizeCall.init.body)).variant, 'full');
  });

  it('RPC brief tools return sources from grounding digest items, not LLM text', async () => {
    const { result: worldResult } = await captureRpcFetches('get_world_brief', { geo_context: 'Middle East tensions' });
    const { result: countryResult, calls: countryCalls } = await captureRpcFetches('get_country_brief', { country_code: 'US' });

    assert.deepEqual(worldResult.sources, [{
      title: 'United States headline used for MCP grounding',
      source: 'Example Wire',
      url: 'https://example.com/world-grounding',
      publishedAt: '2026-06-07T00:00:00.000Z',
    }]);
    assert.equal(worldResult.summary, 'Grounded world brief.');
    assert.equal(worldResult.sources.some((source) => source.url.startsWith('javascript:')), false);

    assert.deepEqual(countryResult.sources, worldResult.sources);
    const countryBriefCall = countryCalls.find((call) => new URL(call.url).pathname === '/api/intelligence/v1/get-country-intel-brief');
    assert.ok(countryBriefCall, 'get_country_brief should call country brief endpoint');
    const context = new URL(countryBriefCall.url).searchParams.get('context') || '';
    assert.match(decodeURIComponent(context), /Source \[1\]: \{"title":"United States headline used for MCP grounding","source":"Example Wire","url":"https:\/\/example\.com\/world-grounding","publishedAt":"2026-06-07T00:00:00.000Z"\}/);
    assert.doesNotMatch(decodeURIComponent(context), /russia-house/);
  });

  it('RPC brief output schemas expose structured sources', () => {
    for (const name of ['get_world_brief', 'get_country_brief']) {
      const schema = rpcTool(name).outputSchema;
      assert.equal(schema.properties.sources.type, 'array', `${name} must expose sources array`);
      assert.equal(schema.properties.sources.items.properties.url.type, 'string', `${name} sources must expose url`);
      assert.equal(schema.properties.sources.items.properties.title.type, 'string', `${name} sources must expose title`);
      assert.equal(schema.properties.sources.items.properties.source.type, 'string', `${name} sources must expose source`);
    }
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
