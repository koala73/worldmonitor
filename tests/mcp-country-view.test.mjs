import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HMAC_SECRET, callBody, makeProDeps, proReq, PRO_USER_ID } from './helpers/mcp-pro-deps.mjs';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
describe('country view MCP boundary', () => {
  let handler;
  let requests;
  let status;
  let headers;
  beforeEach(async () => {
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.MCP_TELEMETRY = 'false';
    requests = [];
    status = 200;
    headers = {};
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ countryCode: 'US', hasDemand: false, demand: 0, observationMonth: '2026-05' }), { status, headers: { 'Content-Type': 'application/json', ...headers } });
    };
    handler = (await import(`../api/mcp.ts?country-view=${Date.now()}-${Math.random()}`)).mcpHandler;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });
  const invoke = async (name, args) => {
    const deps = makeProDeps();
    const response = await handler(proReq('POST', callBody(name, args)), deps.deps);
    return { response, body: await response.json(), deps };
  };
  it('opens a validated view without changing the narrative tool or fetching an assessment', async () => {
    const { body } = await invoke('open_country_brief', { country_code: 'USA', topic: 'resources' });
    assert.equal(body.result.structuredContent.countryCode, 'US');
    assert.equal(body.result.structuredContent.topic, 'resources');
    assert.equal(body.result.structuredContent.panelRequest.usage.remaining, 49);
    const listed = await handler(proReq('POST', { jsonrpc: '2.0', id: 1, method: 'tools/list' }), makeProDeps().deps);
    const tool = (await listed.json()).result.tools.find(tool => tool.name === 'open_country_brief');
    assert.equal(tool._meta.ui.resourceUri, 'ui://worldmonitor/country-view-v2.html');
    assert.equal(requests.length, 0);
    const invalid = await invoke('open_country_brief', { country_code: 'not-a-country' });
    assert.equal(invalid.body.error.code, -32602);
  });
  it('uses a fixed signed reader, charges its weight and retains native availability and dates', async () => {
    const { body, deps } = await invoke('get_country_brief_section', { section: 'energy', arguments: { country_code: 'US' } });
    const result = body.result.structuredContent;
    assert.equal(result.state, 'ready');
    assert.equal(result.value.hasDemand, false);
    assert.equal(result.value.observationMonth, '2026-05');
    assert.match(result.retrievedAt, /^\d{4}-/);
    assert.equal(new URL(requests[0].url).pathname, '/api/intelligence/v1/get-country-energy-profile');
    assert.equal(requests[0].init.headers['X-WM-MCP-User-Id'], PRO_USER_ID);
    assert.match(requests[0].init.headers['X-WM-MCP-Internal'], /^\d+\./);
    assert.equal(deps.pipe.count, 1);
  });
  it('rejects oversized Atlas responses before JSON parsing and cancels their bodies', async () => {
    for (const headers of [{ 'Content-Length': '524289' }, {}]) {
      let cancelled = false;
      globalThis.fetch = async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(524289)); },
        cancel() { cancelled = true; },
      }), { headers });
      const { body } = await invoke('get_country_brief_section', { section: 'pipelines', arguments: {} });
      assert.equal(body.error.code, -32603);
      assert.equal(body.result, undefined);
      assert.equal(cancelled, true);
    }
  });
  it('rejects unknown readers and extra URL/header authority before downstream fetch', async () => {
    for (const args of [
      { section: 'arbitrary', arguments: {} },
      { section: 'facts', arguments: { country_code: 'US', url: 'https://attacker.example' } },
      { section: 'facts', arguments: { country_code: 'US' }, headers: { Authorization: 'bad' } },
      { section: 'imf', arguments: { keys: 'privateAccounts' } },
    ]) assert.equal((await invoke('get_country_brief_section', args)).body.error.code, -32602);
    assert.equal(requests.length, 0);
  });
  it('loads IMF and housing through the real public bootstrap boundary within one paid country request', async () => {
    const bootstrap = (await import('../api/bootstrap.js')).default;
    const { BOOTSTRAP_CACHE_KEYS } = await import('../api/_bootstrap-tier-keys.js');
    const datasets = {
      imfMacro: { countries: { US: { inflationPct: 2.5, year: 2026 } } },
      imfGrowth: { countries: { US: { realGdpGrowthPct: 1.8, year: 2026 } } },
      imfLabor: { countries: { US: { unemploymentPct: 4.1, year: 2026 } } },
      imfExternal: { countries: { US: { exportsUsd: 123, year: 2026 } } },
      bisDsr: { entries: [{ countryCode: 'US', dsrPct: 11.5, period: '2026-Q1' }] },
      bisPropertyResidential: { entries: [{ countryCode: 'US', indexValue: 150, period: '2026-Q1' }] },
      bisPropertyCommercial: { entries: [{ countryCode: 'US', indexValue: 110, period: '2026-Q1' }] },
    };
    process.env.UPSTASH_REDIS_REST_URL = 'https://country-bootstrap-redis.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'controlled-bootstrap-token';
    globalThis.fetch = async (url, init) => {
      if (new URL(url).origin === 'https://country-bootstrap-redis.test') {
        const commands = JSON.parse(init.body);
        return Response.json(commands.map(([, key]) => ({ result: JSON.stringify(datasets[Object.keys(datasets).find(name => BOOTSTRAP_CACHE_KEYS[name] === key)]) })));
      }
      requests.push({ url: String(url), init });
      return bootstrap(new Request(url, init));
    };
    const { deps, pipe } = makeProDeps();
    const invokePaid = async (name, args) => (await handler(proReq('POST', callBody(name, args)), deps)).json();
    const opened = await invokePaid('open_country_brief', { country_code: 'US' });
    const panel_request = opened.result.structuredContent.panelRequest.token;
    for (const [section, keys] of [
      ['imf', 'imfMacro,imfGrowth,imfLabor,imfExternal'],
      ['housing', 'bisDsr,bisPropertyResidential,bisPropertyCommercial'],
    ]) {
      const args = { section, arguments: { keys }, panel_request };
      const result = (await invokePaid('get_country_brief_section', args)).result?.structuredContent;
      assert.equal(result?.state, 'ready', `${section} must accept paid MCP without an API key`);
      assert.deepEqual(result.value, { data: Object.fromEntries(keys.split(',').map(key => [key, datasets[key]])), missing: [] });
      await invokePaid('get_country_brief_section', args);
    }
    assert.equal(pipe.count, 1);
    assert.equal(requests.length, 7);
    for (const { url, init } of requests) {
      assert.equal(new URL(url).searchParams.get('public'), '1');
      assert.equal(new URL(url).searchParams.get('keys').includes(','), false);
      assert.equal(new Headers(init.headers).get('X-WM-MCP-User-Id'), null);
      assert.equal(new Headers(init.headers).get('X-WorldMonitor-Key'), null);
    }
  });
  for (const partial of [false, true]) it(`retries ${partial ? 'partial' : 'missing'} bootstrap data under the same country allocation`, async () => {
    let recovered = false;
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init });
      const key = new URL(url).searchParams.get('keys');
      const missing = !recovered && (!partial || key === 'imfGrowth');
      return Response.json({ data: missing ? {} : { [key]: { countries: { US: { year: 2026 } } } }, missing: missing ? [key] : [] });
    };
    const { deps, pipe } = makeProDeps();
    const invokePaid = async (name, args) => (await handler(proReq('POST', callBody(name, args)), deps)).json();
    const opened = await invokePaid('open_country_brief', { country_code: 'US' });
    const args = { section: 'imf', arguments: { keys: 'imfMacro,imfGrowth,imfLabor,imfExternal' }, panel_request: opened.result.structuredContent.panelRequest.token };
    const first = (await invokePaid('get_country_brief_section', args)).result.structuredContent;
    assert.equal(first.state, partial ? 'ready' : 'unavailable');
    if (partial) {
      assert.deepEqual(first.value.missing, ['imfGrowth']);
      assert.equal(first.value.data.imfMacro.countries.US.year, 2026);
    }
    recovered = true;
    const second = (await invokePaid('get_country_brief_section', args)).result.structuredContent;
    assert.equal(second.state, 'ready');
    assert.deepEqual(second.value.missing, []);
    await invokePaid('get_country_brief_section', args);
    assert.equal(requests.filter(request => new URL(request.url).pathname === '/api/bootstrap').length, 8);
    assert.equal(pipe.count, 1);
  });
  it('preserves bootstrap backoff and rejects oversized or malformed upstream payloads', async () => {
    const args = { section: 'housing', arguments: { keys: 'bisDsr,bisPropertyResidential,bisPropertyCommercial' } };
    globalThis.fetch = async () => new Response('temporarily unavailable', { status: 503, headers: { 'Retry-After': '7' } });
    const backoff = await invoke('get_country_brief_section', args);
    assert.equal(backoff.response.status, 503);
    assert.equal(backoff.response.headers.get('Retry-After'), '7');
    for (const response of [() => Response.json({}), () => new Response('x'.repeat(524289))]) {
      globalThis.fetch = async () => response();
      const failed = await invoke('get_country_brief_section', args);
      assert.ok(failed.body.error);
      assert.equal(failed.body.result, undefined);
    }
  });
  it('retains successful siblings when one bootstrap dataset fails', async () => {
    for (const failure of [() => new Response('unavailable', { status: 503 }), () => { throw new DOMException('Timed out', 'TimeoutError'); }, () => Response.json({})]) {
      globalThis.fetch = async url => new URL(url).searchParams.get('keys') === 'imfGrowth'
        ? failure() : Response.json({ data: { [new URL(url).searchParams.get('keys')]: { countries: { US: { year: 2026 } } } }, missing: [] });
      const { body } = await invoke('get_country_brief_section', { section: 'imf', arguments: { keys: 'imfMacro,imfGrowth,imfLabor,imfExternal' } });
      assert.equal(body.result.structuredContent.state, 'ready');
      assert.deepEqual(body.result.structuredContent.value.missing, ['imfGrowth']);
      assert.equal(body.result.structuredContent.value.data.imfMacro.countries.US.year, 2026);
      assert.equal(body.result.structuredContent.value.data.imfGrowth, undefined);
    }
  });
  it('bounds the assembled bootstrap result while keeping fitting datasets visible', async () => {
    globalThis.fetch = async url => {
      const key = new URL(url).searchParams.get('keys');
      return Response.json({ data: { [key]: { countries: { US: { year: 2026 } }, padding: '測'.repeat(60000) } }, missing: [] });
    };
    const { body } = await invoke('get_country_brief_section', { section: 'imf', arguments: { keys: 'imfMacro,imfGrowth,imfLabor,imfExternal' } });
    const result = body.result.structuredContent;
    assert.equal(result.state, 'ready');
    assert.equal(result._budget_exceeded, undefined);
    assert.deepEqual(Object.keys(result.value.data), ['imfMacro', 'imfGrowth']);
    assert.deepEqual(result.value.missing, ['imfLabor', 'imfExternal']);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 524288);
  });
  it('serves only the fixed country build with no credentials and a separate CSP', async () => {
    const { readCountryView, COUNTRY_VIEW_META } = await import('../api/mcp/ui/news-dashboard-app.ts');
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://www.worldmonitor.app/plugin/country.html');
      assert.equal(new Headers(init.headers).get('Authorization'), null);
      assert.equal(init.redirect, 'manual');
      return new Response('<!DOCTYPE html><html><head></head><body><main id="countryRoot"></main><script type="module" src="/plugin/assets/removed-build.js"></script></body></html>', { headers: { 'Content-Type': 'text/html' } });
    };
    const body = await (await readCountryView(1, {})).json();
    assert.match(body.result.contents[0].text, /<base href="https:\/\/www.worldmonitor.app\/">/);
    assert.doesNotMatch(body.result.contents[0].text, /removed-build\.js/);
    assert.deepEqual(body.result.contents[0]._meta, COUNTRY_VIEW_META);
    assert.deepEqual(COUNTRY_VIEW_META.ui.csp.frameDomains, []);
    assert.ok(new Set(COUNTRY_VIEW_META.ui.csp.resourceDomains).has('https://upload.wikimedia.org'));
  });
  it('advertises each served app resource in the discovery card', async () => {
    const { UI_RESOURCE_LIST_RESPONSE } = await import('../api/mcp/ui/registry.ts');
    const card = JSON.parse(readFileSync(new URL('../public/.well-known/mcp/server-card.json', import.meta.url), 'utf8'));
    assert.deepEqual([...card.metadata.mcpApps.uiResources].sort(), UI_RESOURCE_LIST_RESPONSE.map(resource => resource.uri).sort());
    assert.match(card.metadata.mcpApps.note, /open_country_brief → country-view-v2\.html/);
    const { parseMcpAppsInventory } = await import('../scripts/docs-stats.mjs');
    assert.deepEqual(parseMcpAppsInventory().uiResources.sort(), UI_RESOURCE_LIST_RESPONSE.map(resource => resource.uri).sort());
  });
  it('preserves access denials and upstream failures instead of reporting empty successful measurements', async () => {
    status = 403;
    assert.equal((await invoke('get_country_brief_section', { section: 'facts', arguments: { country_code: 'US' } })).body.result.structuredContent.state, 'locked');
    headers = { 'X-Billing-Verification': 'subscription_lapsed' };
    const billing = await invoke('get_country_brief_section', { section: 'facts', arguments: { country_code: 'US' } });
    assert.equal(billing.response.status, 403);
    assert.equal(billing.body.error.data.code, 'subscription_lapsed');
    status = 503;
    headers = { 'Retry-After': '5' };
    const outage = await invoke('get_country_brief_section', { section: 'facts', arguments: { country_code: 'US' } });
    assert.equal(outage.response.status, 503);
    assert.equal(outage.response.headers.get('Retry-After'), '5');
    assert.ok(outage.body.error);
  });
});
