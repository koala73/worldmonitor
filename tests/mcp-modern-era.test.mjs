// MCP 2026-07-28 ("modern", handshake-free) era detection and validation.
// A request is modern only when params._meta carries the protocolVersion
// envelope claim (the TS SDK's isLegacyRequest rule). Behind the default-off
// MCP_PROTOCOL_2026_07_28 flag a modern request is validated before dispatch:
// _meta fields (-32602), version (-32022) and mirrored headers (-32020). With
// the flag off, and for every request without the envelope, behavior is
// exactly today's. Binds the real handler to a localhost listener, like
// tests/mcp-transport-conformance.test.mjs.

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import { Ratelimit } from '@upstash/ratelimit';

import { SERVER_INSTRUCTIONS } from '../api/mcp/constants.ts';
import { HMAC_SECRET, PRO_BEARER, makeProDeps } from './helpers/mcp-pro-deps.mjs';

const originalEnv = { ...process.env };
const ORIGINAL_SLIDING_WINDOW = Ratelimit.slidingWindow;
const MODERN = '2026-07-28';
const PV_KEY = 'io.modelcontextprotocol/protocolVersion';
const CAPS_KEY = 'io.modelcontextprotocol/clientCapabilities';

function modernMeta(overrides = {}) {
  return {
    [PV_KEY]: MODERN,
    'io.modelcontextprotocol/clientInfo': { name: 'modern-test', version: '1.0' },
    [CAPS_KEY]: {},
    ...overrides,
  };
}

function modernBody(id, method, params = {}, metaOverrides = {}) {
  return { jsonrpc: '2.0', id, method, params: { ...params, _meta: modernMeta(metaOverrides) } };
}

function baseHeaders(extra = {}) {
  return {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${PRO_BEARER}`,
    ...extra,
  };
}

function modernHeaders(method, extra = {}) {
  return baseHeaders({ 'MCP-Protocol-Version': MODERN, 'Mcp-Method': method, ...extra });
}

function anonModernHeaders(method, extra = {}) {
  const { Authorization: _omit, ...headers } = modernHeaders(method, extra);
  return headers;
}

function anonLegacyHeaders(extra = {}) {
  return { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...extra };
}

function legacyInitializeBody(id = 1) {
  return {
    jsonrpc: '2.0', id, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  };
}

const ALL_VERSIONS_NEWEST_FIRST = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];
const UI_URI = 'ui://worldmonitor/country-risk.html';
const RESOURCE_METADATA_MCP = /resource_metadata="[^"]*\/\.well-known\/oauth-protected-resource\/mcp"/;

function sentinel(value) {
  return `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

// The data payloads of an SSE body, in order. Throws on an `id:` line: modern
// streams are session-free and never resumable.
function sseEvents(text) {
  return text.split('\n\n').filter((block) => block.trim() !== '').map((block) => {
    const lines = block.split('\n');
    assert.equal(lines.some((line) => line.startsWith('id:')), false, `modern SSE carries no id: lines: ${block}`);
    return JSON.parse(lines.filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n'));
  });
}

function parseBody(text, contentType) {
  if (!text) return null;
  if (/text\/event-stream/.test(contentType ?? '')) return sseEvents(text).at(-1);
  return JSON.parse(text);
}

// Every response the handler gives a modern request while the flag is on, for
// the suite-wide sweep at the end of the file.
const modernResponses = [];

function recordingHandler(mcpHandler) {
  return async (request, deps) => {
    const bodyText = request.method === 'POST' ? await request.clone().text() : '';
    const response = await mcpHandler(request, deps);
    let modern = false;
    try {
      modern = process.env.MCP_PROTOCOL_2026_07_28 === 'on'
        && Object.prototype.hasOwnProperty.call(JSON.parse(bodyText)?.params?._meta ?? {}, PV_KEY);
    } catch { /* unparseable bodies are legacy */ }
    if (modern) {
      const text = await response.clone().text();
      modernResponses.push({ method: JSON.parse(bodyText).method, status: response.status, json: parseBody(text, response.headers.get('content-type')) });
    }
    return response;
  };
}

async function readIncomingBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function webHeadersFromIncoming(req) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) headers.set(key, value.join(', '));
    else if (value !== undefined) headers.set(key, value);
  }
  return headers;
}

async function startMcpServer(mcpHandler, deps) {
  const server = createServer(async (incoming, outgoing) => {
    try {
      const body = await readIncomingBody(incoming);
      const method = incoming.method ?? 'GET';
      const init = { method, headers: webHeadersFromIncoming(incoming) };
      if (method !== 'GET' && method !== 'HEAD' && body.byteLength > 0) {
        init.body = body;
        init.duplex = 'half';
      }
      const reqUrl = new URL(incoming.url ?? '/mcp', `http://${incoming.headers.host}`);
      const response = await mcpHandler(new Request(reqUrl, init), deps);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (!response.body) {
        outgoing.end();
        return;
      }
      Readable.fromWeb(response.body).pipe(outgoing);
    } catch (err) {
      // The handler error goes to the test log, not the response body.
      console.error(err);
      outgoing.writeHead(500, { 'Content-Type': 'text/plain' });
      outgoing.end('handler threw');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object', 'test server must expose a bound TCP address');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
}

const LEGACY_VERSION_REJECTION = JSON.stringify({
  jsonrpc: '2.0',
  id: null,
  error: { code: -32600, message: 'Unsupported MCP-Protocol-Version' },
});

describe('api/mcp.ts — MCP 2026-07-28 era detection and validation', () => {
  let server;
  let deps;
  let handler;

  async function boot(flag, depsOverrides = {}) {
    if (server) await server.close();
    if (flag === undefined) delete process.env.MCP_PROTOCOL_2026_07_28;
    else process.env.MCP_PROTOCOL_2026_07_28 = flag;
    const mod = await import(`../api/mcp.ts?t=${Date.now()}-${Math.random()}`);
    deps = makeProDeps(depsOverrides).deps;
    handler = recordingHandler(mod.mcpHandler);
    server = await startMcpServer(handler, deps);
  }

  // Calls the handler in process, for tests that stub globalThis.fetch.
  async function invoke(body, headers, path = '/mcp') {
    const res = await handler(new Request(`https://worldmonitor.app${path}`, {
      method: 'POST', headers, body: JSON.stringify(body),
    }), deps);
    const text = await res.text();
    return { status: res.status, text, brief: text.slice(0, 300), json: parseBody(text, res.headers.get('content-type')), headers: res.headers };
  }

  async function post(body, headers, path = '/mcp') {
    const res = await fetch(server.url.replace(/\/mcp$/, path), {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    // `brief` keeps assertion messages readable when a full catalog comes back.
    return { status: res.status, text, brief: text.slice(0, 300), json: parseBody(text, res.headers.get('content-type')), headers: res.headers };
  }

  // Status, body and every header but Date: what "byte-identical" compares.
  function wire(res) {
    const headers = [...res.headers].filter(([name]) => name !== 'date' && name !== 'keep-alive' && name !== 'connection');
    return { status: res.status, text: res.text, headers };
  }

  async function expectError(body, headers, code, status = 400) {
    const res = await post(body, headers);
    assert.equal(res.status, status, `${res.brief} for ${JSON.stringify(body)}`);
    assert.equal(res.json.error?.code, code, res.brief);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    return res;
  }

  beforeEach(async () => {
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.MCP_TELEMETRY = 'false';
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.MCP_PROTOCOL_2025_11_25;
    delete process.env.MCP_PROTOCOL_FLOOR_2025_06_18;
  });

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  describe('flag off (default)', () => {
    for (const flag of [undefined, 'off', 'true', '1', 'ON']) {
      it(`answers a modern tools/list exactly as main does (MCP_PROTOCOL_2026_07_28=${flag})`, async () => {
        await boot(flag);
        const res = await post(modernBody(1, 'tools/list'), modernHeaders('tools/list'));
        assert.equal(res.status, 400);
        assert.equal(res.text, LEGACY_VERSION_REJECTION);
        assert.equal(res.headers.get('cache-control'), 'no-store');
      });
    }

    it('never emits a modern error code for a malformed or mismatched modern request', async () => {
      await boot(undefined);
      for (const [body, headers] of [
        [modernBody(1, 'tools/list', {}, { [PV_KEY]: '2027-01-01' }), modernHeaders('tools/list', { 'MCP-Protocol-Version': '2027-01-01' })],
        [modernBody(1, 'tools/list', {}, { [CAPS_KEY]: undefined }), modernHeaders('tools/list')],
        [modernBody(1, 'tools/call', { name: 'get_market_data', arguments: {} }), modernHeaders('tools/list')],
      ]) {
        const res = await post(body, headers);
        assert.equal(res.status, 400);
        assert.equal(res.text, LEGACY_VERSION_REJECTION);
      }
    });

    it('serves an enveloped request with no version header as a legacy request', async () => {
      await boot(undefined);
      const res = await post(modernBody(1, 'tools/list'), baseHeaders());
      assert.equal(res.status, 200);
      assert.ok(res.json.result.tools.length > 0);
    });
  });

  describe('flag on', () => {
    beforeEach(async () => { await boot('on'); });

    it('serves a valid modern tools/list (no Mcp-Name needed)', async () => {
      const res = await post(modernBody(1, 'tools/list'), modernHeaders('tools/list'));
      assert.equal(res.status, 200, res.brief);
      assert.equal(res.json.id, 1);
      assert.ok(res.json.result.tools.length > 0);
    });

    it('treats header names case-insensitively', async () => {
      const res = await post(modernBody(2, 'tools/list'), baseHeaders({
        'mcp-protocol-version': MODERN,
        'MCP-METHOD': 'tools/list',
      }));
      assert.equal(res.status, 200, res.brief);
    });

    it('rejects an unsupported modern version with -32022 listing every supported version newest first', async () => {
      for (const requested of ['2027-01-01', '2025-11-25', 'not-a-version', '']) {
        const res = await expectError(
          modernBody(7, 'tools/list', {}, { [PV_KEY]: requested }),
          modernHeaders('tools/list', { 'MCP-Protocol-Version': requested }),
          -32022,
        );
        assert.equal(res.json.id, 7);
        assert.equal(res.json.error.message, 'Unsupported protocol version');
        assert.deepEqual(res.json.error.data, {
          supported: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'],
          requested,
        });
      }
    });

    it('decides -32022 from the body even when the header is absent or differs', async () => {
      for (const headers of [baseHeaders(), modernHeaders('tools/list')]) {
        const res = await expectError(
          modernBody(8, 'tools/list', {}, { [PV_KEY]: '2027-01-01' }), headers, -32022,
        );
        assert.equal(res.json.error.data.requested, '2027-01-01');
      }
    });

    it('lists only the legacy versions the server currently serves in -32022', async () => {
      process.env.MCP_PROTOCOL_2025_11_25 = 'off';
      const res = await expectError(
        modernBody(9, 'tools/list', {}, { [PV_KEY]: '2027-01-01' }),
        modernHeaders('tools/list', { 'MCP-Protocol-Version': '2027-01-01' }),
        -32022,
      );
      assert.deepEqual(res.json.error.data.supported, ['2026-07-28', '2025-06-18', '2025-03-26']);
    });

    it('rejects a missing or malformed required _meta field with -32602', async () => {
      for (const overrides of [
        { [CAPS_KEY]: undefined },
        { [CAPS_KEY]: null },
        { [CAPS_KEY]: [] },
        { [CAPS_KEY]: 'tools' },
        { [PV_KEY]: 20260728 },
        { [PV_KEY]: null },
      ]) {
        const body = modernBody(3, 'tools/list', {}, overrides);
        // JSON.stringify drops undefined, so `undefined` models an absent key.
        const res = await expectError(body, modernHeaders('tools/list'), -32602);
        assert.equal(res.json.id, 3);
      }
    });

    it('rejects missing, malformed or mismatched standard headers with -32020', async () => {
      const call = modernBody(4, 'tools/call', { name: 'get_market_data', arguments: {} });
      const cases = [
        ['Mcp-Method absent', modernBody(4, 'tools/list'), baseHeaders({ 'MCP-Protocol-Version': MODERN })],
        ['MCP-Protocol-Version absent', modernBody(4, 'tools/list'), baseHeaders({ 'Mcp-Method': 'tools/list' })],
        ['Mcp-Method disagrees', call, modernHeaders('tools/list', { 'Mcp-Name': 'get_market_data' })],
        ['Mcp-Method case differs', modernBody(4, 'tools/list'), modernHeaders('Tools/List')],
        ['MCP-Protocol-Version disagrees', modernBody(4, 'tools/list'), modernHeaders('tools/list', { 'MCP-Protocol-Version': '2027-01-01' })],
        ['MCP-Protocol-Version names a legacy version', modernBody(4, 'tools/list'), modernHeaders('tools/list', { 'MCP-Protocol-Version': '2025-11-25' })],
        ['Mcp-Name absent on tools/call', call, modernHeaders('tools/call')],
        ['Mcp-Name disagrees on tools/call', call, modernHeaders('tools/call', { 'Mcp-Name': 'get_news' })],
        ['Mcp-Name disagrees on prompts/get', modernBody(4, 'prompts/get', { name: 'market-open-prep' }), modernHeaders('prompts/get', { 'Mcp-Name': 'conflict-pulse' })],
        ['Mcp-Name absent on resources/read', modernBody(4, 'resources/read', { uri: 'ui://worldmonitor/country-risk.html' }), modernHeaders('resources/read')],
        ['Mcp-Name sentinel decodes to another name', call, modernHeaders('tools/call', { 'Mcp-Name': sentinel('get_news') })],
        ['Mcp-Name sentinel is not Base64', call, modernHeaders('tools/call', { 'Mcp-Name': '=?base64?***?=' })],
        ['Mcp-Name sentinel is not UTF-8', call, modernHeaders('tools/call', { 'Mcp-Name': `=?base64?${Buffer.from([0xff, 0xfe]).toString('base64')}?=` })],
        ['Mcp-Name on tools/call with no body name', modernBody(4, 'tools/call', { arguments: {} }), modernHeaders('tools/call', { 'Mcp-Name': 'get_market_data' })],
      ];
      for (const [label, body, headers] of cases) {
        const res = await post(body, headers);
        assert.equal(res.status, 400, `${label}: ${res.brief}`);
        assert.equal(res.json.error?.code, -32020, `${label}: ${res.brief}`);
        assert.equal(res.json.id, 4, label);
        assert.match(res.json.error.message, /^Header mismatch/, label);
      }
    });

    it('accepts an Mcp-Name Base64 sentinel that decodes to the body name', async () => {
      const prompt = await post(
        modernBody(5, 'prompts/get', { name: 'market-open-prep' }),
        modernHeaders('prompts/get', { 'Mcp-Name': sentinel('market-open-prep') }),
      );
      assert.equal(prompt.status, 200, prompt.brief);
      assert.ok(prompt.json.result, prompt.brief);

      const uri = 'ui://worldmonitor/country-risk.html';
      for (const name of [uri, sentinel(uri)]) {
        const read = await post(
          modernBody(6, 'resources/read', { uri }),
          modernHeaders('resources/read', { 'Mcp-Name': name }),
        );
        assert.equal(read.status, 200, read.brief);
        assert.ok(read.json.result, read.brief);
      }
    });

    it('accepts a matching plain Mcp-Name on prompts/get', async () => {
      const res = await post(
        modernBody(5, 'prompts/get', { name: 'market-open-prep' }),
        modernHeaders('prompts/get', { 'Mcp-Name': 'market-open-prep' }),
      );
      assert.equal(res.status, 200, res.brief);
    });

    it('skips the header rules for an enveloped notification POST (then refuses the removed method)', async () => {
      const res = await expectError(
        { jsonrpc: '2.0', method: 'notifications/initialized', params: { _meta: modernMeta() } },
        baseHeaders(),
        -32601,
        404,
      );
      assert.equal(res.json.id, null);
    });

    it('still refuses an enveloped notification that names an unsupported version', async () => {
      const res = await expectError(
        { jsonrpc: '2.0', method: 'notifications/initialized', params: { _meta: modernMeta({ [PV_KEY]: '2027-01-01' }) } },
        baseHeaders(),
        -32022,
      );
      assert.equal(res.json.id, null);
    });

    it('keeps the legacy -32600 for a modern header without an envelope', async () => {
      for (const body of [
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: {} } },
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: 'x' } },
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        [modernBody(1, 'tools/list')],
        '{',
      ]) {
        const res = await post(body, modernHeaders('tools/list'));
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.equal(res.text, LEGACY_VERSION_REJECTION, JSON.stringify(body));
      }
    });

    it('keeps legacy initialize negotiation unchanged', async () => {
      const res = await post({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: MODERN, capabilities: {}, clientInfo: { name: 't', version: '1' } },
      }, baseHeaders({ Accept: 'application/json', 'MCP-Protocol-Version': MODERN }));
      assert.equal(res.status, 200);
      assert.equal(res.json.result.protocolVersion, '2025-11-25');
    });

    it('lists Mcp-Method and Mcp-Name in the CORS preflight', async () => {
      const res = await fetch(server.url, { method: 'OPTIONS', headers: { Origin: 'https://claude.ai' } });
      assert.equal(res.status, 204);
      const allowed = res.headers.get('access-control-allow-headers') ?? '';
      assert.match(allowed, /\bMcp-Method\b/);
      assert.match(allowed, /\bMcp-Name\b/);
    });
  });

  // The modern shaping step never touches a legacy response.
  // Each legacy request is answered byte-for-byte the same with the flag on and
  // off; only Date may differ.
  describe('legacy responses are byte-identical with the flag on and off', () => {
    const LEGACY_REQUESTS = [
      ['credentialed tools/list', { jsonrpc: '2.0', id: 40, method: 'tools/list', params: {} }, () => baseHeaders({ Accept: 'application/json' })],
      ['anonymous tools/list', { jsonrpc: '2.0', id: 41, method: 'tools/list', params: {} }, () => anonLegacyHeaders({ Accept: 'application/json' })],
      ['resources/list', { jsonrpc: '2.0', id: 42, method: 'resources/list', params: {} }, () => baseHeaders({ Accept: 'application/json' })],
      ['tools/call get_sources', { jsonrpc: '2.0', id: 43, method: 'tools/call', params: { name: 'get_sources', arguments: {} } }, () => baseHeaders({ Accept: 'application/json' })],
      ['unknown method', { jsonrpc: '2.0', id: 44, method: 'no/such/method' }, () => baseHeaders()],
    ];

    for (const [label, body, headers] of LEGACY_REQUESTS) {
      it(`answers a legacy ${label} identically`, async () => {
        await boot(undefined);
        const off = wire(await post(body, headers()));
        await boot('on');
        const on = wire(await post(body, headers()));
        assert.ok(isDeepStrictEqual(on, off), `flag on differs from off:\n${JSON.stringify(on).slice(0, 400)}\n${JSON.stringify(off).slice(0, 400)}`);
        assert.equal(/"resultType"|"ttlMs"|"cacheScope"|io\.modelcontextprotocol\/serverInfo/.test(on.text), false, on.text.slice(0, 300));
      });
    }
  });

  // The modern method surface: server/discover, the per-era instructions,
  // the /mcp sign-in challenge for anonymous modern traffic, the
  // 404 -32601 for removed and unknown methods, and no sessions.
  // /mcp emits no change notifications, so a listen stream is acknowledged
  // with an empty honored filter and closed gracefully at once (the session-free encoder).
  describe('flag on — subscriptions/listen', () => {
    beforeEach(async () => { await boot('on'); });

    async function listenRaw(headers, id = 7, notifications = { toolsListChanged: true }) {
      const res = await fetch(server.url, {
        method: 'POST', headers,
        body: JSON.stringify(modernBody(id, 'subscriptions/listen', { notifications })),
      });
      return { status: res.status, headers: res.headers, text: await res.text() };
    }

    it('acknowledges an empty filter, then closes with the graceful completion result', async () => {
      const res = await listenRaw(modernHeaders('subscriptions/listen'), 7);
      assert.equal(res.status, 200, res.text);
      assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream/);
      assert.equal(res.headers.get('mcp-session-id'), null);
      const events = sseEvents(res.text);
      assert.equal(events.length, 2, res.text);
      const [ack, done] = events;
      assert.equal(ack.method, 'notifications/subscriptions/acknowledged');
      assert.equal(ack.id, undefined);
      assert.deepEqual(ack.params.notifications, {});
      assert.equal(ack.params._meta['io.modelcontextprotocol/subscriptionId'], 7);
      assert.equal(done.id, 7);
      assert.equal(done.result.resultType, 'complete');
      assert.equal(done.result._meta['io.modelcontextprotocol/subscriptionId'], 7);
      assert.equal(done.result._meta['io.modelcontextprotocol/serverInfo'].name, 'worldmonitor');
    });

    it('carries a string listen id through both events', async () => {
      const [ack, done] = sseEvents((await listenRaw(modernHeaders('subscriptions/listen'), 'sub-a')).text);
      assert.equal(ack.params._meta['io.modelcontextprotocol/subscriptionId'], 'sub-a');
      assert.equal(done.id, 'sub-a');
    });

    it('refuses a listen whose Accept cannot take a stream with 406 -32600', async () => {
      const res = await listenRaw(modernHeaders('subscriptions/listen', { Accept: 'application/json' }));
      assert.equal(res.status, 406, res.text);
      assert.equal(JSON.parse(res.text).error.code, -32600);
    });

    it('refuses a listen whose Accept rules out a stream with q=0', async () => {
      const res = await listenRaw(modernHeaders('subscriptions/listen', { Accept: 'application/json, text/event-stream;q=0' }));
      assert.equal(res.status, 406, res.text);
    });

    it('refuses a non-object notifications filter with 400 -32602', async () => {
      const res = await listenRaw(modernHeaders('subscriptions/listen'), 8, ['toolsListChanged']);
      assert.equal(res.status, 400, res.text);
      assert.equal(JSON.parse(res.text).error.code, -32602);
    });

    it('serves an anonymous listen on the machine-discovery alias', async () => {
      const res = await fetch(server.url.replace(/\/mcp$/, '/.well-known/mcp'), {
        method: 'POST', headers: anonModernHeaders('subscriptions/listen'),
        body: JSON.stringify(modernBody(9, 'subscriptions/listen', { notifications: {} })),
      });
      assert.equal(res.status, 200);
      assert.equal(sseEvents(await res.text()).at(-1).result.resultType, 'complete');
    });
  });

  describe('flag on — modern method surface', () => {
    beforeEach(async () => { await boot('on'); });

    async function discover(headers = modernHeaders('server/discover'), path = '/mcp', id = 'd-1') {
      return post(modernBody(id, 'server/discover'), headers, path);
    }

    it('serves server/discover with every version, initialize capabilities minus logging, and serverInfo', async () => {
      const init = await post(legacyInitializeBody(), baseHeaders({ Accept: 'application/json' }));
      assert.equal(init.status, 200, init.brief);
      const res = await discover();
      assert.equal(res.status, 200, res.brief);
      assert.equal(res.json.id, 'd-1');
      const { result } = res.json;
      assert.deepEqual(result.supportedVersions, ALL_VERSIONS_NEWEST_FIRST);
      const { logging, ...expectedCapabilities } = init.json.result.capabilities;
      assert.deepEqual(logging, {}, 'initialize still advertises logging');
      assert.deepEqual(result.capabilities, expectedCapabilities);
      assert.equal('logging' in result.capabilities, false);
      assert.deepEqual(result._meta, { 'io.modelcontextprotocol/serverInfo': init.json.result.serverInfo });
      assert.equal(result.serverInfo, undefined, 'modern serverInfo lives in _meta only');
      assert.equal(typeof result.instructions, 'string');
    });

    it('names the modern codes in discover instructions and keeps initialize instructions byte-identical', async () => {
      const init = await post(legacyInitializeBody(), baseHeaders({ Accept: 'application/json' }));
      const legacy = init.json.result.instructions;
      assert.equal(legacy, SERVER_INSTRUCTIONS);
      assert.ok(legacy.includes('-32029/429 reason=allowance-exhausted, and -32002/403'), 'legacy text names the legacy codes');

      const modern = (await discover()).json.result.instructions;
      assert.equal(modern.includes('-32029'), false);
      assert.equal(modern.includes('-32002'), false);
      assert.equal(
        modern,
        legacy.replace('-32029/429', '-31029/429').replace('-32002/403', '-31002/403'),
        'the modern copy differs from the legacy one only in the two denial codes',
      );
    });

    it('challenges an anonymous server/discover and subscriptions/listen on /mcp with the sign-in 401', async () => {
      for (const method of ['server/discover', 'subscriptions/listen']) {
        const res = await post(modernBody('anon-1', method), anonModernHeaders(method));
        assert.equal(res.status, 401, `${method}: ${res.brief}`);
        assert.equal(res.json.id, 'anon-1', method);
        assert.match(res.headers.get('www-authenticate') ?? '', RESOURCE_METADATA_MCP, method);
      }
    });

    it('serves an anonymous server/discover on /.well-known/mcp', async () => {
      const res = await discover(anonModernHeaders('server/discover'), '/.well-known/mcp');
      assert.equal(res.status, 200, res.brief);
      assert.deepEqual(res.json.result.supportedVersions, ALL_VERSIONS_NEWEST_FIRST);
    });

    it('challenges every anonymous modern catalog request on /mcp, but not on /.well-known/mcp', async () => {
      for (const method of ['tools/list', 'resources/list', 'prompts/list', 'resources/templates/list', 'skills/list']) {
        const res = await post(modernBody(11, method), anonModernHeaders(method));
        assert.equal(res.status, 401, `${method}: ${res.brief}`);
        assert.equal(res.json.id, 11, method);
        assert.match(res.headers.get('www-authenticate') ?? '', RESOURCE_METADATA_MCP, method);

        const alias = await post(modernBody(12, method), anonModernHeaders(method), '/.well-known/mcp');
        assert.equal(alias.status, 200, `${method} on the alias: ${alias.brief}`);
        assert.ok(alias.json.result, `${method} on the alias: ${alias.brief}`);
      }
    });

    it('challenges an anonymous modern read of a keyless legacy resource on /mcp', async () => {
      const uri = 'worldmonitor://seed-meta/freshness';
      const res = await post(modernBody(10, 'resources/read', { uri }), anonModernHeaders('resources/read', { 'Mcp-Name': uri }));
      assert.equal(res.status, 401, res.brief);
      assert.match(res.headers.get('www-authenticate') ?? '', RESOURCE_METADATA_MCP);
    });

    it('serves an anonymous modern ui:// read on /mcp', async () => {
      const res = await post(
        modernBody(13, 'resources/read', { uri: UI_URI }),
        anonModernHeaders('resources/read', { 'Mcp-Name': UI_URI }),
      );
      assert.equal(res.status, 200, res.brief);
      assert.equal(res.json.result.contents[0].uri, UI_URI);
    });

    it('keeps an anonymous legacy tools/list on /mcp at 200 (unchanged)', async () => {
      const res = await post({ jsonrpc: '2.0', id: 14, method: 'tools/list', params: {} }, anonLegacyHeaders());
      assert.equal(res.status, 200, res.brief);
      assert.ok(res.json.result.tools.length > 0);
    });

    it('answers removed and unknown modern methods with 404 -32601, credentialed or not, before auth', async () => {
      // Object.prototype keys are unknown methods too, not tools/call-style names.
      for (const method of ['ping', 'logging/setLevel', 'initialize', 'notifications/initialized', 'no/such/method', 'constructor', 'toString', '__proto__']) {
        const params = method === 'logging/setLevel' ? { level: 'info' } : {};
        for (const [label, headers] of [['credentialed', modernHeaders(method)], ['anonymous', anonModernHeaders(method)]]) {
          const res = await expectError(modernBody(15, method, params), headers, -32601, 404);
          assert.equal(res.json.id, 15, `${label} ${method}`);
          assert.equal(res.headers.get('www-authenticate'), null, `${label} ${method}`);
        }
      }
    });

    it('accepts modern client notifications with 202 and 404s only the removed notifications/initialized', async () => {
      for (const method of ['notifications/cancelled', 'notifications/progress']) {
        for (const [label, headers] of [['credentialed', modernHeaders(method)], ['anonymous', anonModernHeaders(method)]]) {
          const res = await post({ jsonrpc: '2.0', method, params: { requestId: 1, _meta: modernMeta() } }, headers);
          assert.equal(res.status, 202, `${label} ${method}: ${res.brief}`);
        }
      }
      const removed = await post(
        { jsonrpc: '2.0', method: 'notifications/initialized', params: { _meta: modernMeta() } },
        modernHeaders('notifications/initialized'),
      );
      assert.equal(removed.status, 404, removed.brief);
      assert.equal(removed.json.error.code, -32601);
    });

    it('keeps the legacy answers for the methods the modern era removed', async () => {
      const ping = await post({ jsonrpc: '2.0', id: 16, method: 'ping' }, baseHeaders());
      assert.equal(ping.status, 200, ping.brief);
      assert.deepEqual(ping.json.result, {});
      const level = await post({ jsonrpc: '2.0', id: 17, method: 'logging/setLevel', params: { level: 'info' } }, baseHeaders());
      assert.equal(level.status, 200, level.brief);
      assert.deepEqual(level.json.result, {});
      const unknown = await post({ jsonrpc: '2.0', id: 18, method: 'no/such/method' }, baseHeaders());
      assert.equal(unknown.status, 200, unknown.brief);
      assert.equal(unknown.json.error.code, -32601);
      const note = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, anonLegacyHeaders());
      assert.equal(note.status, 202);
    });

    it('serves the skills extension on a modern request', async () => {
      const res = await post(modernBody(19, 'skills/list'), modernHeaders('skills/list'));
      assert.equal(res.status, 200, res.brief);
      assert.ok(Array.isArray(res.json.result.skills), res.brief);
    });

    it('never echoes Mcp-Session-Id or stores a replay buffer for a modern response', async () => {
      const { __sseReplayStoreForTest: store } = await import('../api/mcp/handler.ts');
      const sessionHeaders = { 'Mcp-Session-Id': 'client-chosen-session' };

      store.reset();
      const legacy = await fetch(server.url, {
        method: 'POST',
        headers: baseHeaders(sessionHeaders),
        // prompts/list, not tools/list: the full catalog exceeds the 128 KiB
        // replay cap and would never be stored either way.
        body: JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'prompts/list', params: {} }),
      });
      assert.equal(legacy.status, 200);
      assert.match(legacy.headers.get('content-type') ?? '', /text\/event-stream/, 'control: legacy streams on the session id');
      await legacy.text();
      assert.ok(store.totalBytes() > 0, 'control: the same legacy request stores a replay buffer');

      store.reset();
      for (const method of ['prompts/list', 'server/discover']) {
        const res = await post(modernBody(21, method), modernHeaders(method, sessionHeaders));
        assert.equal(res.status, 200, `${method}: ${res.brief}`);
        assert.match(res.headers.get('content-type') ?? '', /application\/json/, method);
        assert.equal(res.headers.get('mcp-session-id'), null, method);
        assert.equal(store.totalBytes(), 0, `${method} must not store a replay buffer`);
      }
    });

    it('keeps a GET with Last-Event-ID exactly as with the flag off', async () => {
      const get = async () => {
        const res = await fetch(server.url, {
          headers: { Accept: 'text/event-stream', 'Last-Event-ID': 'stream:0', 'Mcp-Session-Id': 's', Authorization: `Bearer ${PRO_BEARER}` },
        });
        return { status: res.status, text: await res.text() };
      };
      const on = await get();
      await boot(undefined);
      assert.deepEqual(on, await get());
    });

    it('keeps the 410 migration answer for a valid modern request on a product alias host', async () => {
      const res = await handler(new Request('https://www.worldmonitor.app/mcp', {
        method: 'POST',
        headers: modernHeaders('server/discover'),
        body: JSON.stringify(modernBody(22, 'server/discover')),
      }), deps);
      assert.equal(res.status, 410);
      const json = await res.json();
      assert.equal(json.id, 22);
      assert.equal(json.error.code, -32000);
    });
  });

  // The modern result and error contract, applied once on the way out:
  // resultType + serverInfo on every result, cache hints by method and
  // caller, -32029/-32002 remapped by code, and the
  // session-free SSE encoder for tools/call.
  describe('flag on — modern result shaping', () => {
    const SERVER_INFO_KEY = 'io.modelcontextprotocol/serverInfo';
    const HOUR_MS = 3_600_000;
    const OPERATOR_KEY = 'wm_modern_operator_fixture';
    const JSON_ONLY = { Accept: 'application/json' };
    let serverInfo;
    const originalFetch = globalThis.fetch;

    beforeEach(async () => {
      process.env.WORLDMONITOR_VALID_KEYS = OPERATOR_KEY;
      await boot('on');
      const init = await post(legacyInitializeBody(), baseHeaders(JSON_ONLY));
      serverInfo = init.json.result.serverInfo;
      assert.equal(typeof serverInfo.name, 'string');
      assert.equal(typeof serverInfo.version, 'string');
    });

    afterEach(() => { globalThis.fetch = originalFetch; });

    function assertComplete(res, label) {
      assert.equal(res.status, 200, `${label}: ${res.brief}`);
      assert.equal(res.json.result.resultType, 'complete', label);
      assert.deepEqual(res.json.result._meta?.[SERVER_INFO_KEY], serverInfo, label);
    }

    function assertCacheHint(res, ttlMs, cacheScope, label) {
      assert.equal(res.json.result.ttlMs, ttlMs, label);
      assert.equal(res.json.result.cacheScope, cacheScope, label);
    }

    function assertNoCacheHint(res, label) {
      assert.equal('ttlMs' in res.json.result, false, label);
      assert.equal('cacheScope' in res.json.result, false, label);
    }

    it('stamps tools/list with resultType, serverInfo and a public one-hour cache hint', async () => {
      const res = await post(modernBody(50, 'tools/list'), modernHeaders('tools/list'));
      assertComplete(res, 'tools/list');
      assertCacheHint(res, HOUR_MS, 'public', 'tools/list');
      assert.ok(res.json.result.tools.length > 0);
    });

    it('marks the caller-independent catalogs public for one hour', async () => {
      for (const method of ['prompts/list', 'resources/templates/list']) {
        const res = await post(modernBody(51, method), modernHeaders(method));
        assertComplete(res, method);
        assertCacheHint(res, HOUR_MS, 'public', method);
      }
    });

    it('re-serializes the body so Content-Length equals its byte length and it parses completely', async () => {
      for (const method of ['tools/list', 'server/discover']) {
        const res = await post(modernBody(52, method), modernHeaders(method, JSON_ONLY));
        assert.equal(res.status, 200, res.brief);
        assert.equal(res.headers.get('content-length'), String(Buffer.byteLength(res.text, 'utf8')), method);
        assert.equal(JSON.parse(res.text).result.resultType, 'complete', method);
        assert.equal(res.headers.get('cache-control'), 'no-store', method);
      }
    });

    it('marks resources/list private with TTL 0 for an anonymous caller and for a Pro caller', async () => {
      const pro = await post(modernBody(53, 'resources/list'), modernHeaders('resources/list'));
      assertComplete(pro, 'pro resources/list');
      assertCacheHint(pro, 0, 'private', 'pro resources/list');
      assert.ok(pro.json.result.resources.some((r) => r.uri === 'worldmonitor://account/mcp-allowance'), 'the Pro list carries account resources');

      const anon = await post(modernBody(54, 'resources/list'), anonModernHeaders('resources/list'), '/.well-known/mcp');
      assertComplete(anon, 'anonymous resources/list');
      assertCacheHint(anon, 0, 'private', 'anonymous resources/list');
      assert.equal(anon.json.result.resources.some((r) => r.uri === 'worldmonitor://account/mcp-allowance'), false);
    });

    it('marks resources/read private with TTL 0 for data, account and ui:// reads', async () => {
      for (const [uri, headers] of [
        ['worldmonitor://seed-meta/freshness', (h) => modernHeaders('resources/read', h)],
        ['worldmonitor://account/mcp-allowance', (h) => modernHeaders('resources/read', h)],
        [UI_URI, (h) => anonModernHeaders('resources/read', h)],
      ]) {
        const res = await post(modernBody(55, 'resources/read', { uri }), headers({ 'Mcp-Name': uri }));
        assertComplete(res, uri);
        assertCacheHint(res, 0, 'private', uri);
        assert.ok(res.json.result.contents.length > 0, uri);
      }
    });

    it('marks server/discover private on /mcp and public on /.well-known/mcp, one hour each', async () => {
      const transport = await post(modernBody(56, 'server/discover'), modernHeaders('server/discover'));
      assertComplete(transport, 'discover on /mcp');
      assertCacheHint(transport, HOUR_MS, 'private', 'discover on /mcp');

      for (const path of ['/.well-known/mcp', '/.well-known/mcp.json']) {
        const alias = await post(modernBody(57, 'server/discover'), anonModernHeaders('server/discover'), path);
        assertComplete(alias, `discover on ${path}`);
        assertCacheHint(alias, HOUR_MS, 'public', `discover on ${path}`);
      }
    });

    it('stamps a successful tools/call and the uncached methods without cache hints', async () => {
      const call = await post(
        modernBody(58, 'tools/call', { name: 'get_sources', arguments: {} }),
        modernHeaders('tools/call', { 'Mcp-Name': 'get_sources', ...JSON_ONLY }),
      );
      assertComplete(call, 'tools/call');
      assertNoCacheHint(call, 'tools/call');
      assert.match(call.headers.get('content-type') ?? '', /application\/json/);

      const prompt = await post(modernBody(59, 'prompts/list'), modernHeaders('prompts/list'));
      const { name } = prompt.json.result.prompts.find((entry) => !(entry.arguments ?? []).some((arg) => arg.required));
      for (const [method, params, extra] of [
        ['skills/list', {}, {}],
        ['prompts/get', { name }, { 'Mcp-Name': name }],
      ]) {
        const res = await post(modernBody(60, method, params), modernHeaders(method, extra));
        assertComplete(res, method);
        assertNoCacheHint(res, method);
      }
    });

    it('streams a tools/call as session-free SSE when Accept allows it, final event shaped', async () => {
      const { __sseReplayStoreForTest: store } = await import('../api/mcp/handler.ts');
      store.reset();
      const res = await post(
        modernBody(61, 'tools/call', { name: 'get_sources', arguments: {} }),
        modernHeaders('tools/call', { 'Mcp-Name': 'get_sources', 'Mcp-Session-Id': 'client-chosen-session' }),
      );
      assert.equal(res.status, 200, res.brief);
      assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream/);
      assert.equal(res.headers.get('x-accel-buffering'), 'no');
      assert.equal(res.headers.get('mcp-session-id'), null);
      assert.equal(res.headers.get('content-length'), null);
      assert.doesNotMatch(res.text, /^id:/m);
      const events = sseEvents(res.text);
      assert.equal(events.length, 1);
      assert.equal(events[0].id, 61);
      assert.equal(events[0].result.resultType, 'complete');
      assert.deepEqual(events[0].result._meta[SERVER_INFO_KEY], serverInfo);
      assert.equal(store.totalBytes(), 0, 'a modern stream is never stored for replay');
    });

    it('streams a tools/call JSON-RPC error as SSE too, the final event carrying the error', async () => {
      const res = await post(
        modernBody(64, 'tools/call', { name: 'no_such_tool', arguments: {} }),
        modernHeaders('tools/call', { 'Mcp-Name': 'no_such_tool' }),
      );
      assert.equal(res.status, 200, res.brief);
      assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream/);
      const events = sseEvents(res.text);
      assert.equal(events.at(-1).id, 64);
      assert.ok(events.at(-1).error, res.text);
      assert.equal(events.at(-1).result, undefined);
    });

    it('keeps non-tools/call modern methods on plain JSON even when Accept allows SSE', async () => {
      const res = await post(modernBody(62, 'tools/list'), modernHeaders('tools/list'));
      assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    });

    it('merges serverInfo into an existing result _meta without dropping worldmonitor/usage', async () => {
      const { shapeModernResponse } = await import('../api/mcp/modern.ts');
      const usage = { remaining: 3, limit: 5 };
      const original = new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 63, result: { content: [], _meta: { 'worldmonitor/usage': usage } } }),
        { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Length': '1', 'X-Custom': 'kept' } },
      );
      const shaped = await shapeModernResponse(original, { method: 'tools/call', onAlias: false, acceptsSse: false });
      const text = await shaped.text();
      const json = JSON.parse(text);
      assert.deepEqual(json.result._meta, { 'worldmonitor/usage': usage, [SERVER_INFO_KEY]: serverInfo });
      assert.equal(json.result.resultType, 'complete');
      assert.equal(shaped.headers.get('content-length'), String(Buffer.byteLength(text)));
      assert.equal(shaped.headers.get('x-custom'), 'kept');
    });

    it('passes empty, 202 and non-JSON bodies through untouched', async () => {
      const { shapeModernResponse } = await import('../api/mcp/modern.ts');
      const options = { method: 'tools/call', onAlias: false, acceptsSse: true };
      for (const original of [
        new Response(null, { status: 202, headers: { 'X-A': '1' } }),
        new Response(null, { status: 429, headers: { 'Retry-After': '9' } }),
        new Response('Forbidden origin', { status: 403, headers: { 'Content-Type': 'text/plain' } }),
        new Response('not json', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      ]) {
        const status = original.status;
        const headers = [...original.headers];
        const shaped = await shapeModernResponse(original, options);
        assert.equal(shaped.status, status);
        assert.deepEqual([...shaped.headers], headers);
      }
      const garbled = await shapeModernResponse(new Response('not json', { status: 200, headers: { 'Content-Type': 'application/json' } }), options);
      assert.equal(await garbled.text(), 'not json');
    });

    // The three -32002 sources, each answered for a legacy request and the
    // same modern request. Only the code may differ.
    async function compareDenial(label, method, params, extraHeaders, expectStatus) {
      // A null header value drops that header (the operator key replaces the bearer).
      const finish = (headers) => Object.fromEntries(Object.entries(headers).filter(([, value]) => value !== null));
      const legacyBody = { jsonrpc: '2.0', id: 70, method, params };
      const legacy = await invoke(legacyBody, finish({ ...baseHeaders(JSON_ONLY), ...extraHeaders }));
      const modern = await invoke(modernBody(70, method, params), finish(modernHeaders(method, { 'Mcp-Name': params.name, ...JSON_ONLY, ...extraHeaders })));
      assert.equal(legacy.status, expectStatus, `${label} legacy: ${legacy.brief}`);
      assert.equal(legacy.json.error.code, -32002, `${label} legacy: ${legacy.brief}`);
      assert.equal(modern.status, expectStatus, `${label} modern: ${modern.brief}`);
      assert.equal(modern.json.error.code, -31002, `${label} modern: ${modern.brief}`);
      assert.equal(modern.json.error.message, legacy.json.error.message, label);
      assert.deepEqual(modern.json.error.data, legacy.json.error.data, label);
      assert.deepEqual(wire(modern).headers, wire(legacy).headers, label);
      return { legacy, modern };
    }

    it('remaps a confirmed-lapse -32002 to -31002 with the same 403, headers and data', async () => {
      globalThis.fetch = async (url, init) => {
        if (String(url).includes('/api/aviation/v1/track-aircraft')) {
          return new Response(JSON.stringify({ error: 'Subscription lapsed', code: 'subscription_lapsed' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Billing-Verification': 'subscription_lapsed' },
          });
        }
        return originalFetch(url, init);
      };
      const { modern } = await compareDenial(
        'lapse', 'tools/call', { name: 'get_airspace', arguments: { country_code: 'DE', type: 'civilian' } },
        { Authorization: null, 'X-WorldMonitor-Key': OPERATOR_KEY }, 403,
      );
      assert.equal(modern.headers.get('x-billing-verification'), 'subscription_lapsed');
      assert.equal(modern.json.error.data.code, 'subscription_lapsed');
    });

    it('remaps an upgrade-required -32002 to -31002 with the same 403 and data', async () => {
      await boot('on', {
        getEntitlements: async () => ({ planKey: 'pro', features: { tier: 1, mcpAccess: true }, validUntil: Date.now() - 1000 }),
      });
      const { modern } = await compareDenial('upgrade-required', 'tools/call', { name: 'get_market_data', arguments: {} }, {}, 403);
      assert.equal(modern.json.error.data.reason, 'upgrade-required');
    });

    it('remaps a daily-quota -32029 to -31029 with the same 429, Retry-After and data', async () => {
      await boot('on', { pipelineOpts: { initialCount: 1_000_000 } });
      const params = { name: 'get_market_data', arguments: {} };
      const legacy = await invoke({ jsonrpc: '2.0', id: 71, method: 'tools/call', params }, baseHeaders(JSON_ONLY));
      const modern = await invoke(modernBody(71, 'tools/call', params), modernHeaders('tools/call', { 'Mcp-Name': params.name, ...JSON_ONLY }));
      for (const [label, res, code] of [['legacy', legacy, -32029], ['modern', modern, -31029]]) {
        assert.equal(res.status, 429, `${label}: ${res.brief}`);
        assert.equal(res.json.error.code, code, `${label}: ${res.brief}`);
        assert.ok(res.headers.get('retry-after'), label);
      }
      assert.equal(modern.json.error.message, legacy.json.error.message);
      assert.deepEqual(modern.json.error.data, legacy.json.error.data);
      assert.deepEqual(wire(modern).headers, wire(legacy).headers);

      // A non-200 denial is never SSE-framed, even when Accept allows a stream.
      const streamed = await invoke(modernBody(72, 'tools/call', params), modernHeaders('tools/call', { 'Mcp-Name': params.name }));
      assert.equal(streamed.status, 429, streamed.brief);
      assert.match(streamed.headers.get('content-type') ?? '', /application\/json/);
      assert.equal(streamed.json.error.code, -31029, streamed.brief);
    });

    it('remaps a user-bound-credential -32002 to -31002 with the same status', async () => {
      const { modern } = await compareDenial(
        'user-bound', 'tools/call', { name: 'get_mcp_allowance', arguments: {} },
        { Authorization: null, 'X-WorldMonitor-Key': OPERATOR_KEY }, 200,
      );
      assert.match(modern.json.error.message, /user-bound credential/);
    });
  });

  // Last in the file: the limiter singletons in api/mcp/auth.ts memoize the
  // first construction, so the stub is installed before any can be built and
  // reads its verdict at call time (see tests/mcp-rate-limit-request-id.test.mjs).
  describe('flag on — modern method surface limits', () => {
    let deniedKeyPrefixes = [];
    let limiterKeys = [];

    before(() => {
      Ratelimit.slidingWindow = (tokens) => () => ({
        async limit(_ctx, key) {
          limiterKeys.push(key);
          const denied = deniedKeyPrefixes.some((prefix) => key.startsWith(prefix));
          return { success: !denied, limit: tokens, remaining: denied ? 0 : tokens - 1, reset: Date.now() + 60_000, pending: Promise.resolve() };
        },
      });
    });

    after(() => { Ratelimit.slidingWindow = ORIGINAL_SLIDING_WINDOW; });

    beforeEach(async () => {
      process.env.UPSTASH_REDIS_REST_URL = 'https://stub.upstash.invalid';
      process.env.UPSTASH_REDIS_REST_TOKEN = 'stub-token';
      deniedKeyPrefixes = [];
      limiterKeys = [];
      await boot('on');
    });

    it('charges a credentialed server/discover to the protocol bucket, never the data burst bucket', async () => {
      const res = await post(modernBody(30, 'server/discover'), modernHeaders('server/discover'));
      assert.equal(res.status, 200, res.brief);
      assert.ok(limiterKeys.some((key) => key.startsWith('rl:mcp:pro-min:pro-protocol:')), JSON.stringify(limiterKeys));
      assert.equal(limiterKeys.some((key) => key.startsWith('rl:mcp:pro-min:pro-user:')), false, JSON.stringify(limiterKeys));
    });

    it('meters an anonymous server/discover on /.well-known/mcp through the anonymous discovery limiter', async () => {
      deniedKeyPrefixes = ['rl:mcp:anon:'];
      const res = await post(modernBody(31, 'server/discover'), anonModernHeaders('server/discover'), '/.well-known/mcp');
      assert.equal(res.json.error?.code, -31029, res.brief);
      assert.equal(res.json.id, 31);
      assert.ok(limiterKeys.some((key) => key.startsWith('rl:mcp:anon:')), JSON.stringify(limiterKeys));
    });

    // The anonymous limiter answers -32029 at HTTP 200; the modern
    // form keeps the status and headers and changes only the code.
    it('remaps the anonymous discovery limiter -32029 to -31029, legacy unchanged', async () => {
      deniedKeyPrefixes = ['rl:mcp:anon:'];
      const legacy = await post({ jsonrpc: '2.0', id: 33, method: 'tools/list', params: {} }, anonLegacyHeaders({ Accept: 'application/json' }), '/.well-known/mcp');
      const modern = await post(modernBody(33, 'tools/list'), anonModernHeaders('tools/list'), '/.well-known/mcp');
      assert.equal(legacy.json.error?.code, -32029, legacy.brief);
      assert.equal(modern.json.error?.code, -31029, modern.brief);
      assert.equal(modern.status, legacy.status);
      assert.equal(modern.json.error.message, legacy.json.error.message);
      assert.deepEqual(wire(modern).headers, wire(legacy).headers);
    });

    it('remaps the per-minute limiter -32029 to -31029 with the same status and X-RateLimit headers', async () => {
      deniedKeyPrefixes = ['rl:mcp:pro-min:'];
      const legacy = await post({ jsonrpc: '2.0', id: 34, method: 'tools/list', params: {} }, baseHeaders({ Accept: 'application/json' }));
      const modern = await post(modernBody(34, 'tools/list'), modernHeaders('tools/list'));
      assert.equal(legacy.json.error?.code, -32029, legacy.brief);
      assert.equal(modern.json.error?.code, -31029, modern.brief);
      assert.equal(modern.status, legacy.status);
      assert.equal(modern.headers.get('x-ratelimit-remaining'), '0');
      assert.equal(modern.json.error.message, legacy.json.error.message);
      assert.deepEqual(wire(modern).headers, wire(legacy).headers);
    });

    it('answers a legacy rate-limited request byte-identically with the flag on and off', async () => {
      deniedKeyPrefixes = ['rl:mcp:pro-min:', 'rl:mcp:anon:'];
      const requests = [
        [{ jsonrpc: '2.0', id: 35, method: 'tools/list', params: {} }, baseHeaders({ Accept: 'application/json' }), '/mcp'],
        [{ jsonrpc: '2.0', id: 36, method: 'tools/list', params: {} }, anonLegacyHeaders({ Accept: 'application/json' }), '/.well-known/mcp'],
      ];
      const on = [];
      for (const [body, headers, path] of requests) on.push(wire(await post(body, headers, path)));
      await boot(undefined);
      for (const [index, [body, headers, path]] of requests.entries()) {
        const off = wire(await post(body, headers, path));
        assert.match(off.text, /-32029/);
        assert.deepEqual(on[index], off);
      }
    });

    it('serves an anonymous modern get_sources call on /mcp under the free-tier ceiling', async () => {
      const res = await post(
        modernBody(32, 'tools/call', { name: 'get_sources', arguments: {} }),
        anonModernHeaders('tools/call', { 'Mcp-Name': 'get_sources' }),
      );
      assert.equal(res.status, 200, res.brief);
      assert.ok(res.json.result, res.brief);
      assert.ok(limiterKeys.some((key) => key.startsWith('rl:mcp:free:')), JSON.stringify(limiterKeys));
    });
  });
});

describe('api/mcp/modern.ts — era recorded on the usage object', () => {
  afterEach(() => {
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  async function load() {
    const usageMod = await import('../api/mcp/usage.ts');
    const modern = await import(`../api/mcp/modern.ts?t=${Date.now()}-${Math.random()}`);
    return { usageMod, modern };
  }

  function req(headers) {
    return new Request('https://worldmonitor.app/mcp', { method: 'POST', headers });
  }

  it('defaults to legacy', async () => {
    const { usageMod } = await load();
    assert.equal(usageMod.createMcpUsage().era, 'legacy');
  });

  it('marks a validated modern request modern and leaves legacy and flag-off requests legacy', async () => {
    const { usageMod, modern } = await load();
    const body = modernBody(1, 'tools/list');
    const headers = { 'MCP-Protocol-Version': MODERN, 'Mcp-Method': 'tools/list' };

    process.env.MCP_PROTOCOL_2026_07_28 = 'on';
    const served = usageMod.createMcpUsage();
    assert.deepEqual(modern.validateModernRequest(req(headers), body, served, {}), { era: 'modern' });
    assert.equal(served.era, 'modern');

    const rejected = usageMod.createMcpUsage();
    const outcome = modern.validateModernRequest(req({}), body, rejected, {});
    assert.equal(outcome.era, 'modern');
    assert.equal(outcome.response.status, 400);
    assert.equal(rejected.era, 'modern');

    const legacy = usageMod.createMcpUsage();
    assert.deepEqual(modern.validateModernRequest(req(headers), { jsonrpc: '2.0', id: 1, method: 'tools/list' }, legacy, {}), { era: 'legacy' });
    assert.equal(legacy.era, 'legacy');

    delete process.env.MCP_PROTOCOL_2026_07_28;
    const off = usageMod.createMcpUsage();
    assert.deepEqual(modern.validateModernRequest(req(headers), body, off, {}), { era: 'legacy' });
    assert.equal(off.era, 'legacy');
  });

  it('detects the envelope only from a protocolVersion key in params._meta', async () => {
    const { modern } = await load();
    assert.equal(modern.isModernEnvelope(modernBody(1, 'tools/list')), true);
    assert.equal(modern.isModernEnvelope(modernBody(1, 'tools/list', {}, { [PV_KEY]: 7 })), true);
    for (const body of [
      null, 'x', [], {}, { params: null }, { params: [] }, { params: {} },
      { params: { _meta: null } }, { params: { _meta: [] } },
      { params: { _meta: { [CAPS_KEY]: {} } } },
      { params: { protocolVersion: MODERN } },
    ]) {
      assert.equal(modern.isModernEnvelope(body), false, JSON.stringify(body));
    }
  });
});

// Suite-wide sweep: no modern response produced anywhere in this file carries -32002,
// or a code from the spec's reserved -32020..-32099 range other than the two it
// defines (-32020 HeaderMismatch, -32022 UnsupportedProtocolVersion). Runs last
// so the recording handler has seen every modern request above.
describe('api/mcp.ts — modern error codes across the whole suite', () => {
  it('never answers a modern request with -32002 or an undefined reserved-range code', () => {
    assert.ok(modernResponses.length >= 50, `the sweep saw only ${modernResponses.length} modern responses`);
    const codes = new Set();
    for (const { method, status, json } of modernResponses) {
      const code = json?.error?.code;
      if (typeof code !== 'number') continue;
      codes.add(code);
      assert.notEqual(code, -32002, `${method} (${status}) answered -32002`);
      if (code <= -32020 && code >= -32099) {
        assert.ok(code === -32020 || code === -32022, `${method} (${status}) answered reserved code ${code}`);
      }
    }
    for (const expected of [-31029, -31002, -32020, -32022]) {
      assert.ok(codes.has(expected), `the sweep must observe ${expected}; saw ${[...codes].join(', ')}`);
    }
  });
});
