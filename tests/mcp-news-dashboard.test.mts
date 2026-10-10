import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOOL_REGISTRY, buildPublicTool } from '../api/mcp/registry/index.ts';
import { NEWS_DASHBOARD_META } from '../api/mcp/ui/news-dashboard-app.ts';
import Ajv2020 from 'ajv/dist/2020.js';

test('public headline schema advertises one translation headline and up to eight brief headlines', () => {
  const tool = TOOL_REGISTRY.find(t => t.name === 'analyze_news_headlines')!;
  const validate = new Ajv2020({ strict: false }).compile(buildPublicTool(tool, { compressDescriptions: false }).inputSchema);
  assert.equal(validate({ headlines: ['First'], mode: 'translate', lang: 'ar' }), true);
  assert.equal(validate({ headlines: ['First', 'Second'], mode: 'translate', lang: 'ar' }), false);
  assert.equal(validate({ headlines: Array(8).fill('Headline'), mode: 'brief' }), true);
  assert.equal(validate({ headlines: ['First', 'Second'] }), true);
});

test('dashboard CSP permits the tile, sprite and boundary dependencies requested by its basemap', () => {
  const csp = NEWS_DASHBOARD_META.ui.csp;
  for (const url of [
    'https://tiles.openfreemap.org/sprites/ofm_f384/ofm.json',
    'https://tiles.openfreemap.org/sprites/ofm_f384/ofm.png',
    'https://tiles.openfreemap.org/fonts/Noto%20Sans%20Regular/0-255.pbf',
    'https://tiles.openfreemap.org/planet',
  ]) {
    assert.ok(csp.connectDomains.includes(new URL(url).origin), `Blocked map asset: ${url}`);
    assert.ok(csp.resourceDomains.includes(new URL(url).origin), `Blocked map asset: ${url}`);
  }
});

test('dashboard entry opens the actual feed panels with empty arguments', () => {
  const tool = TOOL_REGISTRY.find(t => t.name === 'open_news_dashboard');
  assert.ok(tool, 'news dashboard entry must exist separately from the intelligence summary');
  assert.deepEqual(tool.inputSchema.required, []);
  const publicTool = buildPublicTool(tool, { compressDescriptions: false });
  assert.equal(publicTool._meta?.ui?.resourceUri, 'ui://worldmonitor/news-dashboard-v3.html');
  assert.deepEqual(publicTool._meta?.['openai/ui']?.entrypoints, [{type: 'global'}, {type: 'thread'}]);
});

import { afterEach } from 'node:test';
import { readNewsDashboard } from '../api/mcp/ui/news-dashboard-app.ts';
import { buildUiResourceRead, isUiResourceUri } from '../api/mcp/ui/registry.ts';
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('legacy installed resource links remain public aliases that return the cache-safe shell', async () => {
  globalThis.fetch = async input => new Response(`<html><head></head><body><main id="${String(input).endsWith('country.html') ? 'countryRoot' : String(input).endsWith('market.html') ? 'marketRoot' : 'pluginRoot'}"></main></body></html>`, { headers: { 'Content-Type': 'text/html' } });
  for (const uri of ['ui://worldmonitor/country-view-v1.html', 'ui://worldmonitor/news-dashboard.html', 'ui://worldmonitor/country-view-v2.html', 'ui://worldmonitor/news-dashboard-v2.html', 'ui://worldmonitor/market-radar-v2.html']) {
    assert.equal(isUiResourceUri(uri), true);
    const body = await (await buildUiResourceRead(1, uri, {})).json();
    assert.equal(body.result.contents[0].uri, uri);
    assert.match(body.result.contents[0].text, /Retry interface/);
  }
});

test('dashboard resource serves only the fixed build origin and never forwards credentials', async () => {
  let redirect: RequestRedirect | undefined;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://www.worldmonitor.app/plugin/plugin.html');
    redirect = init?.redirect;
    assert.equal(new Headers(init?.headers).get('Authorization'), null);
    return new Response('<!DOCTYPE html><html><head></head><body><main id="pluginRoot"></main></body></html>', { headers: { 'Content-Type': 'text/html' } });
  };
  const body = await (await readNewsDashboard(1, {})).json();
  assert.equal(redirect, 'manual');
  assert.match(body.result.contents[0].text, /<base href="https:\/\/www.worldmonitor.app\/">/);
  assert.deepEqual(body.result.contents[0]._meta.ui.csp.frameDomains, []);
});

test('dashboard resource rejects redirects without following their location', async () => {
  let redirect: RequestRedirect | undefined;
  globalThis.fetch = async (_input, init) => {
    redirect = init?.redirect;
    return new Response('<head><main id="pluginRoot"></main>', { status: 302, headers: { 'Content-Type': 'text/html', Location: 'https://example.com/' } });
  };
  const body = await (await readNewsDashboard(1, {})).json();
  assert.equal(redirect, 'manual');
  assert.equal(body.error.code, -32603);
  assert.equal(body.result, undefined);
});

test('missing or oversized plugin documents fail explicitly instead of returning a website error page', async () => {
  for (const html of ['<html>Sign in</html>', '<head><main id="pluginRoot">' + 'x'.repeat(131073)]) {
    globalThis.fetch = async () => new Response(html, { headers: { 'Content-Type': 'text/html' } });
    const body = await (await readNewsDashboard(1, {})).json();
    assert.equal(body.error.code, -32603);
    assert.equal(body.result, undefined);
  }
});

test('dashboard data uses the existing authenticated endpoint and does not claim the view was applied', async () => {
  const tool = TOOL_REGISTRY.find(t => t.name === 'open_news_dashboard')!;
  assert.ok(tool._execute);
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://www.worldmonitor.app/api/news/v1/list-feed-digest?variant=full&lang=en');
    assert.equal(new Headers(init?.headers).get('X-WorldMonitor-Key'), 'fixture-key');
    return Response.json({ categories: {}, feedStatuses: {}, generatedAt: 'fixture' });
  };
  const result = await tool._execute({ query: 'shipping', jmespath: 'categories' }, 'https://www.worldmonitor.app', { kind: 'env_key', apiKey: 'fixture-key' }, undefined) as Record<string, unknown>;
  assert.deepEqual(result.requestedView, { query: 'shipping' });
  assert.equal(result.applied, undefined);
});

test('billing denials from the news endpoint propagate instead of becoming empty success', async () => {
  const tool = TOOL_REGISTRY.find(t => t.name === 'open_news_dashboard')!;
  assert.ok(tool._execute);
  globalThis.fetch = async () => Response.json({ error: 'subscription_lapsed' }, { status: 403 });
  await assert.rejects(tool._execute({}, 'https://www.worldmonitor.app', { kind: 'env_key', apiKey: 'fixture-key' }, undefined));
});

test('invalid map-center intent fails validation before any downstream request', async () => {
  const tool = TOOL_REGISTRY.find(t => t.name === 'open_news_dashboard')!;
  assert.ok(tool._execute);
  globalThis.fetch = async () => { throw new Error('Must not fetch'); };
  await assert.rejects(tool._execute({ map_latitude: 30 }, 'https://www.worldmonitor.app', { kind: 'env_key', apiKey: 'fixture-key' }, undefined), { name: 'RpcValidationError' });
});

test('map layer intent is closed and duplicate selections fail before requesting news', async () => {
  const tool = TOOL_REGISTRY.find(t => t.name === 'open_news_dashboard')!;
  const validate = new Ajv2020({ strict: false }).compile(buildPublicTool(tool, { compressDescriptions: false }).inputSchema);
  assert.equal(validate({ map_layers: ['natural', 'fires', 'cables'] }), true);
  assert.equal(validate({ map_layers: [] }), true);
  assert.equal(validate({ map_layers: ['military'] }), false);
  assert.equal(validate({ map_layers: ['natural', 'natural'] }), false);
  globalThis.fetch = async () => { throw new Error('Must not fetch'); };
  for (const map_layers of [['military'], ['natural', 'natural']]) {
    await assert.rejects(tool._execute!({ map_layers }, 'https://www.worldmonitor.app', { kind: 'env_key', apiKey: 'fixture-key' }, undefined), { name: 'RpcValidationError' });
  }
});

test('headline translation sends the target language through the existing RPC contract', async () => {
  const tool = TOOL_REGISTRY.find(t => t.name === 'analyze_news_headlines')!;
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(request.mode, 'translate');
    assert.equal(request.variant, 'ar');
    assert.equal(request.lang, '');
    return Response.json({ summary: 'ارتفعت البطالة في ألمانيا', status: 'success' });
  };
  const result = await tool._execute!({ headlines: ['Germany unemployment rises'], mode: 'translate', lang: 'ar' }, 'https://www.worldmonitor.app', { kind: 'env_key', apiKey: 'fixture-key' }, undefined) as Record<string, unknown>;
  assert.equal(result.status, 'success');
});

test('translation rejects multiple headlines instead of silently dropping all but the first', async () => {
  const tool = TOOL_REGISTRY.find(t => t.name === 'analyze_news_headlines')!;
  globalThis.fetch = async () => { throw new Error('Must not fetch'); };
  await assert.rejects(tool._execute!({ headlines: ['First', 'Second'], mode: 'translate', lang: 'ar' }, 'https://www.worldmonitor.app', { kind: 'env_key', apiKey: 'fixture-key' }, undefined), { name: 'RpcValidationError' });
});

test('brief analysis retains the full dashboard variant and requested summary language', async () => {
  const tool = TOOL_REGISTRY.find(t => t.name === 'analyze_news_headlines')!;
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(request.provider, 'openrouter');
    assert.equal(request.mode, 'brief');
    assert.equal(request.variant, 'full');
    assert.equal(request.lang, 'fr');
    return Response.json({ summary: 'Résumé', status: 'success' });
  };
  await tool._execute!({ headlines: ['First', 'Second'], lang: 'fr' }, 'https://www.worldmonitor.app', { kind: 'env_key', apiKey: 'fixture-key' }, undefined);
});
