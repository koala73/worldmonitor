import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { PANEL_REQUEST_READ_SCRIPT } from '../shared/panel-request-scripts.mjs';
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
    assert.equal(tool._meta.ui.resourceUri, 'ui://worldmonitor/country-view-v3.html');
    assert.equal(requests.length, 0);
    const invalid = await invoke('open_country_brief', { country_code: 'not-a-country' });
    assert.equal(invalid.body.error.code, -32602);
  });
  it('delivers closed raw Signals with all failed family outcomes and no extra allocation', async () => {
    globalThis.fetch = async (url, init) => { requests.push({ url: String(url), init }); return new Response('unavailable', { status: 503 }); };
    const { deps, pipe } = makeProDeps();
    const paid = async (name, args) => (await handler(proReq('POST', callBody(name, args)), deps)).json();
    const opened = await paid('open_country_brief', { country_code: 'US' });
    const panel_request = opened.result.structuredContent.panelRequest.token;
    const reply = await paid('get_country_brief_section', { section: 'signalsRaw', arguments: { country_code: 'US' }, panel_request });
    assert.equal(reply.result?.structuredContent?.state, 'unavailable');
    assert.deepEqual(Object.keys(reply.result.structuredContent.value.sources), ['earthquakes', 'outages', 'advisories', 'thermal']);
    assert.equal(reply.result.structuredContent.value.countryCode, 'US');
    assert.equal(requests.length, 4);
    assert.equal(pipe.count, 1);
  });
  const rawBodies = () => ({
    '/api/seismology/v1/list-earthquakes': { earthquakes: [{ id: 'quake', place: 'United States \"測\" \\ observation', magnitude: 4.5, location: { latitude: 38, longitude: -77 }, occurredAt: 1791000000000, source: 'USGS', category: 'earthquake', sourceUrl: 'https://example.com/quake' }] },
    '/api/infrastructure/v1/list-internet-outages': { outages: [] },
    '/api/intelligence/v1/list-security-advisories': { advisories: [], byCountry: {} },
    '/api/thermal/v1/list-thermal-escalations': { clusters: [{ id: 'cluster', countryCode: 'XX', status: 'THERMAL_STATUS_NORMAL', firstDetectedAt: '2026-10-01T00:00:00Z', lastDetectedAt: '2026-10-01T12:00:00Z' }], fetchedAt: '2026-10-01T14:00:00Z', observationWindowHours: 24, sourceVersion: 'thermal-escalation-v1' },
  });
  it('reuses one complete original, four signed fixed GETs and one country allocation', async () => {
    let active = 0; let maximum = 0;
    let release; const firstThree = new Promise(resolve => { release = resolve; });
    const bodies = rawBodies();
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init }); active++; maximum = Math.max(maximum, active);
      if (requests.length <= 3) { if (requests.length === 3) release(); await firstThree; }
      active--;
      return Response.json(bodies[new URL(url).pathname]);
    };
    const { deps, pipe } = makeProDeps();
    const paid = async (name, args) => handler(proReq('POST', callBody(name, args)), deps);
    const opened = await (await paid('open_country_brief', { country_code: 'US' })).json();
    const args = { section: 'signalsRaw', arguments: { country_code: 'US' }, panel_request: opened.result.structuredContent.panelRequest.token };
    const response = await paid('get_country_brief_section', args);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const result = JSON.parse(new TextDecoder().decode(bytes)).result.structuredContent;
    assert.equal(result.state, 'ready'); assert.deepEqual(result.value.missing, []);
    await paid('get_country_brief_section', args);
    assert.equal(requests.length, 4); assert.equal(maximum, 3); assert.equal(pipe.count, 1);
    assert.equal(pipe.ops.flat().filter(command => command[0] === 'EVAL' && command[1] === PANEL_REQUEST_READ_SCRIPT).length, 1);
    for (const request of requests) {
      assert.equal(request.init.method ?? 'GET', 'GET');
      assert.equal(request.init.headers['X-WM-MCP-User-Id'], PRO_USER_ID);
      assert.match(request.init.headers['X-WM-MCP-Internal'], /^\d+\./);
      assert.equal(request.init.headers['User-Agent'], 'WorldMonitor-MCP/1.0');
    }
    assert.deepEqual(requests.map(request => new URL(request.url).pathname).sort(), Object.keys(bodies).sort());
    assert.equal(new URL(requests.find(request => request.url.includes('list-earthquakes')).url).searchParams.get('page_size'), '500');
    assert.equal(new URL(requests.find(request => request.url.includes('list-thermal-escalations')).url).searchParams.get('max_items'), '12');
    assert.ok(bytes.length < 131072);
    const projectedResponse = await paid('get_country_brief_section', { ...args, jmespath: 'value.sources.earthquakes.records[].magnitude' });
    const projectedBytes = new Uint8Array(await projectedResponse.arrayBuffer());
    const projected = JSON.parse(new TextDecoder().decode(projectedBytes)).result.structuredContent;
    assert.ok(projected._attribution.sources.some(source => source.attribution.includes('USGS')));
    assert.ok(projected._attribution.sources.some(source => source.attribution.includes('CWFIS')));
    writeFileSync('/private/tmp/wm-mcp-metering-evidence/signals-observed-implementation-worker/dispatch-byte-proof.json', JSON.stringify({ domainEnvelopeBytes: Buffer.byteLength(JSON.stringify(result)), completeHttpResponseBytes: bytes.length, projectedCompleteHttpResponseBytes: projectedBytes.length, fixture: 'Actual MCP dispatch; quotes, backslash, multibyte place, attribution and duplicated text/structuredContent', maximumActive: maximum, downstreamGETs: requests.length, dailyAllocations: pipe.count }, null, 2));
  });
  it('measures the dense valid wrapped response separately from the domain-envelope cap', async () => {
    const bodies = rawBodies(); const quake = bodies['/api/seismology/v1/list-earthquakes'].earthquakes[0];
    bodies['/api/seismology/v1/list-earthquakes'].earthquakes = Array.from({ length: 400 }, (_, index) => ({ ...quake, id: String(index), place: '\"\\測 United States' }));
    globalThis.fetch = async (url, init) => { requests.push({ url: String(url), init }); return Response.json(bodies[new URL(url).pathname]); };
    const { deps } = makeProDeps();
    const response = await handler(proReq('POST', callBody('get_country_brief_section', { section: 'signalsRaw', arguments: { country_code: 'US' } })), deps);
    const bytes = new Uint8Array(await response.arrayBuffer()); const dispatched = JSON.parse(new TextDecoder().decode(bytes)).result; const result = dispatched.structuredContent;
    assert.equal(result.state, 'ready'); assert.equal(result.value.sources.earthquakes.records.length, 400);
    const toolTextBytes = Buffer.byteLength(dispatched.content.find(item => item.type === 'text').text);
    assert.ok(toolTextBytes <= 524288); assert.equal(result._budget_exceeded, undefined);
    const envelopeBytes = Buffer.byteLength(JSON.stringify(result));
    assert.ok(envelopeBytes <= 131072); assert.ok(bytes.length <= 524288);
    writeFileSync('/private/tmp/wm-mcp-metering-evidence/signals-observed-implementation-worker/dense-dispatch-byte-proof.json', JSON.stringify({ domainEnvelopeBytes: envelopeBytes, toolTextBytes, unchangedToolTextBudgetBytes: 524288, completeHttpResponseBytes: bytes.length, returnedGlobalQuakeRows: 400, fullHttpFits128KiB: bytes.length <= 131072, scope: 'Actual dense valid MCP dispatch with multibyte/quote/backslash strings; no universal128KiB complete HTTP guarantee' }, null, 2));
  });
  it('rejects closed argument and receipt violations before downstream work', async () => {
    const { deps, pipe } = makeProDeps();
    const paid = async (args) => (await handler(proReq('POST', callBody('get_country_brief_section', args)), deps)).json();
    const opened = await (await handler(proReq('POST', callBody('open_country_brief', { country_code: 'US' })), deps)).json();
    const token = opened.result.structuredContent.panelRequest.token;
    for (const args of [
      { section: 'signalsRaw', arguments: { country_code: 'CN' }, panel_request: token },
      { section: 'signalsRaw', arguments: { country_code: 'US', max_items: 25 }, panel_request: token },
      { section: 'signalsRaw', arguments: { country_code: 'US', url: 'https://attacker.example' }, panel_request: token },
      { section: 'signalsRaw', arguments: { country_code: 'XX' }, panel_request: token },
      { section: 'signalsRaw', arguments: { country_code: 'US' }, panel_request: 'forged' },
      { section: 'signalsRaw', arguments: { country_code: 'US' }, panel_request: token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a') },
    ]) assert.equal((await paid(args)).error?.code, -32602, JSON.stringify(args));
    const { authorizePanelRead } = await import('../api/mcp/panel-requests.ts');
    const context = { kind: 'pro', userId: PRO_USER_ID, tokenId: 'fixture', subscriptionTier: 'mcp_pro' };
    const read = { section: 'signalsRaw', arguments: { country_code: 'US' } };
    await assert.rejects(authorizePanelRead({ ...context, userId: 'other-user' }, pipe.pipeline, 'get_country_brief_section', read, token));
    await assert.rejects(authorizePanelRead(context, pipe.pipeline, 'get_country_brief_section', read, token, Date.parse(opened.result.structuredContent.panelRequest.expiresAt)));
    assert.equal(requests.length, 0); assert.equal(pipe.count, 1);
  });
  it('keeps mixed and all-denied outcomes retryable and recovers under the same receipt', async () => {
    let mode = 'mixed'; const bodies = rawBodies();
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init });
      if (mode === 'denied' || mode === 'mixed' && new URL(url).pathname.includes('list-earthquakes')) return new Response('Denied', { status: 403 });
      return Response.json(bodies[new URL(url).pathname]);
    };
    const { deps, pipe } = makeProDeps();
    const paid = async (name, args) => (await handler(proReq('POST', callBody(name, args)), deps)).json();
    const opened = await paid('open_country_brief', { country_code: 'US' });
    const args = { section: 'signalsRaw', arguments: { country_code: 'US' }, panel_request: opened.result.structuredContent.panelRequest.token };
    const mixed = (await paid('get_country_brief_section', args)).result.structuredContent;
    assert.equal(mixed.state, 'ready'); assert.deepEqual(mixed.value.missing, ['earthquakes']);
    mode = 'denied'; const denied = (await paid('get_country_brief_section', args)).result.structuredContent;
    assert.equal(denied.state, 'locked'); assert.equal(denied.value.missing.length, 4);
    mode = 'recovered'; const recovered = (await paid('get_country_brief_section', args)).result.structuredContent;
    assert.equal(recovered.state, 'ready'); assert.deepEqual(recovered.value.missing, []);
    await paid('get_country_brief_section', args);
    assert.equal(requests.length, 12); assert.equal(pipe.count, 1);
    assert.equal(pipe.ops.flat().filter(command => command[0] === 'EVAL' && command[1] === PANEL_REQUEST_READ_SCRIPT).length, 3);
  });
  it('rejects oversized source bodies and assembled envelopes before positive caching', async () => {
    for (const kind of ['source', 'envelope']) {
      requests = []; const bodies = rawBodies();
      globalThis.fetch = async (url, init) => {
        requests.push({ url: String(url), init });
        if (new URL(url).pathname.includes('list-earthquakes')) {
          if (kind === 'source') return new Response('測'.repeat(174763));
          const quake = bodies['/api/seismology/v1/list-earthquakes'].earthquakes[0];
          return Response.json({ earthquakes: Array.from({ length: 200 }, (_, index) => ({ ...quake, id: String(index), place: '\"\\測'.repeat(200) })) });
        }
        return Response.json(bodies[new URL(url).pathname]);
      };
      const { deps, pipe } = makeProDeps();
      const paid = async (name, args) => (await handler(proReq('POST', callBody(name, args)), deps)).json();
      const opened = await paid('open_country_brief', { country_code: 'US' });
      const args = { section: 'signalsRaw', arguments: { country_code: 'US' }, panel_request: opened.result.structuredContent.panelRequest.token };
      const result = (await paid('get_country_brief_section', args)).result.structuredContent;
      assert.ok(result.value.missing.includes('earthquakes'));
      if (kind === 'envelope') { assert.equal(result.state, 'unavailable'); assert.equal(result.value.missing.length, 4); }
      await paid('get_country_brief_section', args);
      assert.equal(requests.length, 8); assert.equal(pipe.count, 1);
    }
  });
  for (const stall of ['fetch', 'body']) it(`uses one shared deadline for a stalled ${stall} and never starts the queued fourth after expiry`, async t => {
    const deadline = new AbortController(); const timeout = AbortSignal.timeout; let deadlines = 0; let cancelledBodies = 0;
    let started; const threeStarted = new Promise(resolve => { started = resolve; });
    t.mock.method(AbortSignal, 'timeout', ms => ms === 15000 ? (deadlines++, deadline.signal) : timeout(ms));
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init });
      if (requests.length === 3) started();
      if (stall === 'fetch') return new Promise(() => {});
      return new Response(new ReadableStream({ cancel() { cancelledBodies++; } }));
    };
    const pending = invoke('get_country_brief_section', { section: 'signalsRaw', arguments: { country_code: 'US' } });
    await threeStarted;
    assert.equal(requests.length, 3); deadline.abort(new DOMException('Shared deadline expired', 'TimeoutError'));
    const result = (await pending).body.result.structuredContent;
    assert.equal(result.state, 'unavailable'); assert.equal(result.value.missing.length, 4);
    assert.equal(requests.length, 3); assert.equal(deadlines, 1);
    assert.ok(requests.every(request => request.init.signal.aborted));
    if (stall === 'body') { await new Promise(resolve => setImmediate(resolve)); assert.equal(cancelledBodies, 3); }
  });
  it('propagates global typed billing denial and cancels siblings before the queued fourth', async () => {
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init });
      if (new URL(url).pathname.includes('list-earthquakes')) return new Response('Denied', { status: 403, headers: { 'X-Billing-Verification': 'subscription_lapsed' } });
      return new Promise(() => {});
    };
    const { response, body } = await invoke('get_country_brief_section', { section: 'signalsRaw', arguments: { country_code: 'US' } });
    assert.equal(response.status, 403); assert.equal(body.error.data.code, 'subscription_lapsed');
    assert.ok(requests.length >= 1 && requests.length <= 3); assert.ok(requests.every(request => request.init.signal.aborted));
  });
  it('keeps unrelated section projection shape unchanged', async () => {
    const { body } = await invoke('get_country_brief_section', { section: 'facts', arguments: { country_code: 'US' }, jmespath: 'value.countryCode' });
    assert.deepEqual(body.result.structuredContent, { projection: 'US' });
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
    assert.match(card.metadata.mcpApps.note, /open_country_brief → country-view-v3\.html/);
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
