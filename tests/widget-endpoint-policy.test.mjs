import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const { WIDGET_DATA_CATALOG, buildWidgetDataUrl } = require('../scripts/_widget-data-policy.cjs');
const parserText = readFileSync(new URL('../scripts/_widget-response-parser.cjs', import.meta.url), 'utf8');
const handlerText = between('async function handleWidgetAgentRequest(', '\n// Map a thrown error');
const mockedHandler = handlerText.replace("const { default: Anthropic } = await import('@anthropic-ai/sdk');", 'const Anthropic = MockAnthropic;');
// Run the actual relay handler without starting its HTTP server or loading the SDK.
// Only external transport, admission, timers and SSE output are replaced.
async function loop(input, tier = 'basic', transport = null) {
  const requests = [];
  const fetches = [];
  const context = {
    module: { exports: {} }, URL, AbortSignal, console, buildWidgetDataUrl,
    requireWidgetAgentAccess: () => ({ anthropicConfigured: true, admittedAs: tier }),
    readRequestBody: async () => JSON.stringify({ prompt: 'Build a market widget', tier }),
    safeEnd: () => { throw Error('unexpected early rejection'); },
    PRO_WIDGET_KEY: 'synthetic', WIDGET_ANTHROPIC_KEY: 'synthetic',
    checkWidgetRateLimit: () => false, checkProWidgetRateLimit: () => false,
    isWidgetInjectionAttempt: () => false,
    WIDGET_MAX_HTML: 50000, WIDGET_PRO_MAX_HTML: 80000,
    WIDGET_SYSTEM_PROMPT: 'basic', WIDGET_PRO_SYSTEM_PROMPT: 'pro',
    WIDGET_FETCH_TOOL: { name: 'fetch_worldmonitor_data' }, WIDGET_SEARCH_TOOL: { name: 'search_web' },
    sanitizeToolContent: value => value,
    sendWidgetSSE: () => {}, setTimeout: () => 1, clearTimeout: () => {},
    classifyWidgetAgentError: error => error.message,
    fetch: async (url, options) => {
      fetches.push({ url, options });
      return transport ? transport(url, options) : { text: async () => '{"data":[]}' };
    },
    MockAnthropic: class {
      messages = {
        create: async request => {
          requests.push(structuredClone(request));
          if (requests.length === 1) return {
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'data', name: 'fetch_worldmonitor_data', input }],
          };
          return {
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: '<!-- widget-html --><div>OK</div><!-- /widget-html -->' }],
          };
        },
      };
    },
  };
  const run = vm.runInNewContext(`${parserText}\n${mockedHandler}\nhandleWidgetAgentRequest`, context);
  await run({ headers: {}, on() {} }, {
    writeHead() {}, end() { this.writableEnded = true; }, writableEnded: false,
  });
  return { fetches, requests };
}

for (const tier of ['basic', 'pro']) describe(`widget data request boundary (${tier})`, () => {
  for (const input of [
    {endpoint:'/api/bootstrap?keys=marketQuotes,cryptoQuotes'},
    {endpoint:'/api/bootstrap',params:{keys:'weatherAlerts'}},
    {endpoint:'/api/economic/v1/get-fred-series?series_id=CPIAUCSL',params:{series_id:'DGS10', note:'A+B & café'}},
    {endpoint:'/api/supply-chain/v1/get-bypass-options',params:{chokepointId:'hormuz'}},
  ]) it(`fetches approved ${JSON.stringify(input)}`, async () => {
    const result = await loop(input, tier);
    assert.equal(result.fetches.length, 1);
    const request = result.fetches[0];
    const url = new URL(request.url);
    assert.equal(url.origin, 'https://api.worldmonitor.app');
    for (const [key, value] of Object.entries(input.params || {})) assert.equal(url.searchParams.get(key), value);
    assert.deepEqual(Object.keys(request.options.headers), ['User-Agent']);
  });
  for (const input of [
    {endpoint:'/api/not-in-catalog'}, {endpoint:'/api/bootstrap?keys=notAdvertised'},
    {endpoint:'/api/../health'}, {endpoint:'/api/market/v1/analyze-stock'},
    {endpoint:'/api/news/v1/summarize-article'}, {endpoint:'/api/intelligence/v1/deduct-situation'},
    {endpoint:'/api/intelligence/v1/get-country-intel-brief'},
    {endpoint:'/api/bootstrap'}, {endpoint:'/api/bootstrap?keys='},
    {endpoint:'/api/bootstrap?keys=marketQuotes,,cryptoQuotes'},
    {endpoint:'/api/bootstrap?keys=marketQuotes&keys=notAdvertised'},
    {endpoint:'/api/bootstrap?keys=marketQuotes',params:{keys:'notAdvertised'}},
    {endpoint:'/api/bootstrap?keys=notAdvertised',params:{keys:'marketQuotes'}},
    {endpoint:'/api/bootstrap?keys=marketQuotes',params:{tier:'fast'}},
    {endpoint:'/api/bootstrap?keys=marketQuotes&tier=fast'},
    {endpoint:'/api/bootstrap?keys=marketQuotes%252cnotAdvertised'},
    {endpoint:'/api/bootstrap?keys=chokepointTransits'},
    {endpoint:'/api/bootstrap?keys=marketImplications'}, {endpoint:'/api/bootstrap?keys=iranEvents'},
    {endpoint:'/api/x/../bootstrap?keys=marketQuotes'},
    {endpoint:'/api/%2e%2e/health'}, {endpoint:'/api/%62ootstrap?keys=marketQuotes'},
    {endpoint:'/api/bootstrap/?keys=marketQuotes'},
    {endpoint:'/api/bootstrap#?keys=marketQuotes'},
    {endpoint:'https://api.worldmonitor.app/api/bootstrap?keys=marketQuotes'},
    {endpoint:'//example.com/api/bootstrap?keys=marketQuotes'},
    {endpoint:'/api/\\example.com/bootstrap?keys=marketQuotes'},
    {endpoint:'/api/boot\nstrap?keys=marketQuotes'},
    {endpoint:'/api/bootstrap?keys=marketQuotes%ZZ'},
    {endpoint:'/api/bootstrap?keys=weatherAlerts&public=0'},
    {endpoint:'/api/bootstrap?keys=weatherAlerts&public=1&public=1'},
    {endpoint:'/api/bootstrap?keys=weatherAlerts,forecasts&public=1'},
    {endpoint:'/api/bootstrap?keys=weatherAlerts',params:{public:'2'}},
    {endpoint:null}, {endpoint:42},
    {endpoint:'/api/bootstrap',params:null},
    {endpoint:'/api/bootstrap',params:{keys:['marketQuotes']}},
  ]) it(`denies before fetch ${JSON.stringify(input)}`, async () => {
    const result = await loop(input, tier);
    assert.equal(result.fetches.length, 0);
    assert.ok(result.requests.length >= 2, 'invalid tool inputs must return a tool result, not abort the agent');
    assert.match(result.requests[1].messages.at(-1).content[0].content, /not allowed/i);
  });
  it('returns transport failures to the model without a second data fetch', async () => {
    const result = await loop({ endpoint: '/api/bootstrap?keys=marketQuotes' }, tier, async () => {
      throw new TypeError('fetch failed: unexpected redirect');
    });
    assert.equal(result.fetches.length, 1);
    assert.match(result.requests[1].messages.at(-1).content[0].content, /Fetch failed:.*unexpected redirect/);
  });
  it('preserves downstream entitlement errors without adding credentials', async () => {
    const result = await loop({ endpoint: '/api/supply-chain/v1/get-bypass-options' }, tier, async () => ({
      status: 403, text: async () => '{"error":"Pro subscription required"}',
    }));
    assert.equal(result.requests[1].messages.at(-1).content[0].content, '{"error":"Pro subscription required"}');
    assert.deepEqual(Object.keys(result.fetches[0].options.headers), ['User-Agent']);
  });
  it('disables redirect following on approved requests', async () => {
    const {fetches} = await loop({endpoint:'/api/bootstrap?keys=marketQuotes'}, tier);
    assert.equal(fetches[0].options.redirect, 'error');
  });
});


describe('reviewed catalog consistency', () => {
  it('preserves the real public bootstrap admission shape in both tiers', async () => {
    const { classifyPublicBootstrapUrl } = await import('../api/_bootstrap-public-tier.js');
    for (const tier of ['basic', 'pro']) {
      for (const key of ['weatherAlerts', 'forecasts', 'cyberThreats', 'flightDelays', 'correlationCards']) {
        for (const input of [
          { endpoint: `/api/bootstrap?keys=${key}&public=1` },
          { endpoint: `/api/bootstrap?keys=${key}`, params: { public: '1' } },
          { endpoint: '/api/bootstrap?public=1', params: { keys: key } },
        ]) {
          const { fetches } = await loop(input, tier);
          assert.equal(fetches.length, 1);
          assert.ok(classifyPublicBootstrapUrl(new URL(fetches[0].url)), key);
        }
      }
    }
  });

  it('advertised keys exist in the active bootstrap registry and pass the request boundary', async () => {
    const { resolveBootstrapRegistry } = await import('../shared/bootstrap-tier-keys.js');
    const registry = resolveBootstrapRegistry({ iranEventsEnabled: false }).cacheKeys;
    const bootstrap = WIDGET_DATA_CATALOG.split('## Option 2')[0];
    const keys = [...bootstrap.matchAll(/^ {2}(.+)$/gm)].flatMap(match => match[1].split(', '));
    assert.ok(keys.length > 0);
    for (const key of keys) {
      assert.ok(Object.hasOwn(registry, key), `unknown registry key: ${key}`);
      assert.equal((await loop({ endpoint: '/api/bootstrap', params: { keys: key } })).fetches.length, 1, key);
    }
  });

  it('advertised RPCs have generated GET routes and pass the request boundary', async () => {
    const routes = [...WIDGET_DATA_CATALOG.matchAll(/^(\/api\/([a-z-]+)\/v1\/([a-z-]+))/gm)];
    assert.ok(routes.length > 0);
    for (const [, route, service] of routes) {
      const generated = readFileSync(new URL(`../src/generated/server/worldmonitor/${service.replaceAll('-', '_')}/v1/service_server.ts`, import.meta.url), 'utf8');
      assert.ok(generated.includes(`"${route}"`), `missing generated route: ${route}`);
      assert.equal((await loop({ endpoint: route })).fetches.length, 1, route);
    }
  });

  it('both actual tier prompts use the reviewed catalog and retain their output rules', () => {
    const prompts = ['WIDGET_SYSTEM_PROMPT', 'WIDGET_PRO_SYSTEM_PROMPT'].map(name => {
      const template = source.split(`const ${name} = `)[1].split('`;')[0] + '`';
      return vm.runInNewContext(template, { WIDGET_DATA_CATALOG });
    });
    for (const prompt of prompts) assert.ok(prompt.includes(WIDGET_DATA_CATALOG));
    assert.match(prompts[0], /display-only HTML/);
    assert.match(prompts[1], /inline JavaScript/);
  });
});
