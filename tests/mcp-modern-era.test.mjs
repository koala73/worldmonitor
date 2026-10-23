// MCP 2026-07-28 ("modern", handshake-free) era detection and validation (U1).
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
      outgoing.writeHead(500, { 'Content-Type': 'text/plain' });
      outgoing.end(err instanceof Error ? err.message : String(err));
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

  async function boot(flag) {
    if (server) await server.close();
    if (flag === undefined) delete process.env.MCP_PROTOCOL_2026_07_28;
    else process.env.MCP_PROTOCOL_2026_07_28 = flag;
    const mod = await import(`../api/mcp.ts?t=${Date.now()}-${Math.random()}`);
    deps = makeProDeps().deps;
    server = await startMcpServer(mod.mcpHandler, deps);
  }

  async function post(body, headers, path = '/mcp') {
    const res = await fetch(server.url.replace(/\/mcp$/, path), {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    // `brief` keeps assertion messages readable when a full catalog comes back.
    return { status: res.status, text, brief: text.slice(0, 300), json: text ? JSON.parse(text) : null, headers: res.headers };
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

    it('skips the header rules for an enveloped notification POST (U2 then refuses the removed method)', async () => {
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

    it('keeps the legacy -32600 for a modern header without an envelope (KTD1)', async () => {
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

  // U2 — the modern method surface: server/discover, the per-era instructions,
  // the /mcp sign-in challenge for anonymous modern traffic (KTD4, KTD4a), the
  // 404 -32601 for removed and unknown methods (R8), and no sessions (R10).
  describe('flag on — modern method surface (U2)', () => {
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

    it('challenges every anonymous modern catalog request on /mcp (KTD4a), but not on /.well-known/mcp', async () => {
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
      for (const method of ['ping', 'logging/setLevel', 'initialize', 'notifications/initialized', 'no/such/method']) {
        const params = method === 'logging/setLevel' ? { level: 'info' } : {};
        for (const [label, headers] of [['credentialed', modernHeaders(method)], ['anonymous', anonModernHeaders(method)]]) {
          const res = await expectError(modernBody(15, method, params), headers, -32601, 404);
          assert.equal(res.json.id, 15, `${label} ${method}`);
          assert.equal(res.headers.get('www-authenticate'), null, `${label} ${method}`);
        }
      }
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
      const mod = await import('../api/mcp.ts');
      const res = await mod.mcpHandler(new Request('https://www.worldmonitor.app/mcp', {
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

  // Last in the file: the limiter singletons in api/mcp/auth.ts memoize the
  // first construction, so the stub is installed before any can be built and
  // reads its verdict at call time (see tests/mcp-rate-limit-request-id.test.mjs).
  describe('flag on — modern method surface limits (U2)', () => {
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
      assert.equal(res.json.error?.code, -32029, res.brief);
      assert.equal(res.json.id, 31);
      assert.ok(limiterKeys.some((key) => key.startsWith('rl:mcp:anon:')), JSON.stringify(limiterKeys));
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
