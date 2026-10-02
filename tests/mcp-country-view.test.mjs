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
    assert.deepEqual(body.result.structuredContent, { countryCode: 'US', topic: 'resources' });
    const listed = await handler(proReq('POST', { jsonrpc: '2.0', id: 1, method: 'tools/list' }), makeProDeps().deps);
    const tool = (await listed.json()).result.tools.find(tool => tool.name === 'open_country_brief');
    assert.equal(tool._meta.ui.resourceUri, 'ui://worldmonitor/country-view-v1.html');
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
  it('rejects unknown readers and extra URL/header authority before downstream fetch', async () => {
    for (const args of [
      { section: 'arbitrary', arguments: {} },
      { section: 'facts', arguments: { country_code: 'US', url: 'https://attacker.example' } },
      { section: 'facts', arguments: { country_code: 'US' }, headers: { Authorization: 'bad' } },
      { section: 'imf', arguments: { keys: 'privateAccounts' } },
    ]) assert.equal((await invoke('get_country_brief_section', args)).body.error.code, -32602);
    assert.equal(requests.length, 0);
  });
  it('serves only the fixed country build with no credentials and a separate CSP', async () => {
    const { readCountryView, COUNTRY_VIEW_META } = await import('../api/mcp/ui/news-dashboard-app.ts');
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://www.worldmonitor.app/plugin/country.html');
      assert.equal(new Headers(init.headers).get('Authorization'), null);
      assert.equal(init.redirect, 'manual');
      return new Response('<!DOCTYPE html><html><head></head><body><main id="countryRoot"></main></body></html>', { headers: { 'Content-Type': 'text/html' } });
    };
    const body = await (await readCountryView(1, {})).json();
    assert.match(body.result.contents[0].text, /<base href="https:\/\/www.worldmonitor.app\/">/);
    assert.deepEqual(body.result.contents[0]._meta, COUNTRY_VIEW_META);
    assert.deepEqual(COUNTRY_VIEW_META.ui.csp.frameDomains, []);
    assert.ok(new Set(COUNTRY_VIEW_META.ui.csp.resourceDomains).has('https://upload.wikimedia.org'));
  });
  it('advertises each served app resource in the discovery card', async () => {
    const { UI_RESOURCE_LIST_RESPONSE } = await import('../api/mcp/ui/registry.ts');
    const card = JSON.parse(readFileSync(new URL('../public/.well-known/mcp/server-card.json', import.meta.url), 'utf8'));
    assert.deepEqual([...card.metadata.mcpApps.uiResources].sort(), UI_RESOURCE_LIST_RESPONSE.map(resource => resource.uri).sort());
    assert.match(card.metadata.mcpApps.note, /open_country_brief → country-view-v1\.html/);
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
