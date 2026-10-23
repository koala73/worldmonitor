// MCP 2026-07-28 ("modern", handshake-free) era detection and validation (U1).
// A request is modern only when params._meta carries the protocolVersion
// envelope claim (the TS SDK's isLegacyRequest rule). Behind the default-off
// MCP_PROTOCOL_2026_07_28 flag a modern request is validated before dispatch:
// _meta fields (-32602), version (-32022) and mirrored headers (-32020). With
// the flag off, and for every request without the envelope, behavior is
// exactly today's. Binds the real handler to a localhost listener, like
// tests/mcp-transport-conformance.test.mjs.

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';

import { HMAC_SECRET, PRO_BEARER, makeProDeps } from './helpers/mcp-pro-deps.mjs';

const originalEnv = { ...process.env };
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

  async function post(body, headers) {
    const res = await fetch(server.url, {
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

    it('accepts an enveloped notification POST without the standard headers', async () => {
      const res = await post(
        { jsonrpc: '2.0', method: 'notifications/initialized', params: { _meta: modernMeta() } },
        baseHeaders(),
      );
      assert.equal(res.status, 202);
      assert.equal(res.text, '');
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
