// Drives /mcp with the official MCP TypeScript SDK v2 client
// (@modelcontextprotocol/client) over real HTTP, in all three negotiation
// modes: `auto` (server/discover probe, legacy fallback), a 2026-07-28 pin,
// and the default legacy `initialize` handshake. The SDK validates every
// modern result (resultType, cache fields, serverInfo stamp, discover shape),
// so a passing call here is conformance evidence from the reference
// implementation, not from our own reading of the spec.

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { Ratelimit } from '@upstash/ratelimit';

import { Client, SdkError, SdkErrorCode, SdkHttpError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { HMAC_SECRET, PRO_BEARER, makeProDeps } from './helpers/mcp-pro-deps.mjs';

const originalEnv = { ...process.env };
const MODERN = '2026-07-28';
const AUTH = { headers: { Authorization: `Bearer ${PRO_BEARER}` } };

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

// Binds the real handler to a localhost listener, as in
// tests/mcp-modern-era.test.mjs. Records each request's JSON-RPC method so
// tests can assert which handshake the SDK actually performed.
async function startMcpServer(mcpHandler, deps) {
  const seen = [];
  const server = createServer(async (incoming, outgoing) => {
    try {
      const body = await readIncomingBody(incoming);
      const method = incoming.method ?? 'GET';
      if (method === 'POST') {
        try { seen.push(JSON.parse(body.toString('utf8')).method); } catch { seen.push(null); }
      } else {
        seen.push(`HTTP ${method}`);
      }
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
    url: new URL(`http://127.0.0.1:${address.port}/mcp`),
    seen,
    close: () => new Promise((resolve, reject) => {
      server.closeAllConnections();
      server.close((err) => err ? reject(err) : resolve());
    }),
  };
}

function newClient(versionNegotiation) {
  return new Client(
    { name: 'wm-sdk-dual-era-test', version: '1.0.0' },
    versionNegotiation ? { versionNegotiation } : undefined,
  );
}

describe('api/mcp.ts — official SDK v2 client in both protocol eras', () => {
  let server;
  let client;

  async function boot(flag) {
    if (flag === undefined) delete process.env.MCP_PROTOCOL_2026_07_28;
    else process.env.MCP_PROTOCOL_2026_07_28 = flag;
    const mod = await import(`../api/mcp.ts?t=${Date.now()}-${Math.random()}`);
    server = await startMcpServer(mod.mcpHandler, makeProDeps().deps);
  }

  async function connect(versionNegotiation, { anonymous = false, path } = {}) {
    client = newClient(versionNegotiation);
    const url = path ? new URL(path, server.url) : server.url;
    await client.connect(new StreamableHTTPClientTransport(url, anonymous ? undefined : { requestInit: AUTH }));
    return client;
  }

  beforeEach(() => {
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.MCP_TELEMETRY = 'false';
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.MCP_PROTOCOL_2025_11_25;
    delete process.env.MCP_PROTOCOL_FLOOR_2025_06_18;
  });

  afterEach(async () => {
    if (client) await client.close().catch(() => {});
    client = undefined;
    if (server) await server.close();
    server = undefined;
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  async function assertToolsWork(c) {
    const { tools } = await c.listTools();
    assert.ok(tools.length > 10, `expected the full catalog, got ${tools.length}`);
    assert.ok(tools.some((t) => t.name === 'get_sources'));
    const result = await c.callTool({ name: 'get_sources', arguments: {} });
    assert.notEqual(result.isError, true, JSON.stringify(result).slice(0, 300));
    assert.ok(Array.isArray(result.content) && result.content.length > 0);
  }

  describe('flag on', () => {
    beforeEach(async () => { await boot('on'); });

    it('auto mode negotiates the modern era with no initialize, and tools work', async () => {
      const c = await connect({ mode: 'auto' });
      assert.equal(c.getProtocolEra(), 'modern');
      assert.equal(c.getNegotiatedProtocolVersion(), MODERN);
      assert.equal(c.getServerVersion()?.name, 'worldmonitor');
      const discover = c.getDiscoverResult();
      assert.ok(discover, 'the SDK parsed and kept the server/discover result');
      assert.ok(discover.supportedVersions.includes(MODERN));
      assert.ok(discover.capabilities.tools);
      assert.equal(typeof discover.instructions, 'string');
      await assertToolsWork(c);
      assert.equal(server.seen.includes('initialize'), false, `methods seen: ${server.seen}`);
      assert.equal(server.seen[0], 'server/discover');
    });

    it('a 2026-07-28 pin connects modern and serves the method surface', async () => {
      const c = await connect({ mode: { pin: MODERN } });
      assert.equal(c.getProtocolEra(), 'modern');
      await assertToolsWork(c);
      const { prompts } = await c.listPrompts();
      assert.ok(Array.isArray(prompts));
      const { resources } = await c.listResources();
      assert.ok(Array.isArray(resources));
      const { resourceTemplates } = await c.listResourceTemplates();
      assert.ok(Array.isArray(resourceTemplates));
    });

    it('a pinned modern client without credentials gets the SDK authorization failure', async () => {
      await assert.rejects(
        connect({ mode: { pin: MODERN } }, { anonymous: true }),
        (err) => {
          assert.ok(err instanceof SdkHttpError, `expected SdkHttpError, got ${err?.constructor?.name}: ${err?.message}`);
          assert.equal(err.code, SdkErrorCode.ClientHttpAuthentication);
          return true;
        },
      );
      assert.deepEqual(server.seen, ['server/discover']);
    });

    it('auto mode without credentials is an authorization failure, never a legacy fallback', async () => {
      await assert.rejects(
        connect({ mode: 'auto' }, { anonymous: true }),
        (err) => {
          assert.ok(err instanceof SdkHttpError, `expected SdkHttpError, got ${err?.constructor?.name}: ${err?.message}`);
          assert.equal(err.code, SdkErrorCode.ClientHttpAuthentication);
          return true;
        },
      );
      assert.equal(server.seen.includes('initialize'), false, `methods seen: ${server.seen}`);
    });

    it('an anonymous pinned client discovers on the /.well-known/mcp alias', async () => {
      const c = await connect({ mode: { pin: MODERN } }, { anonymous: true, path: '/.well-known/mcp' });
      assert.equal(c.getProtocolEra(), 'modern');
      assert.ok(c.getDiscoverResult()?.supportedVersions.includes(MODERN));
    });

    it('an anonymous modern client that skips discover is challenged on tools/list but served get_sources', async (t) => {
      // The free tier is rate limited; stub the limiter as the modern-era suite does.
      const limiterKeys = [];
      process.env.UPSTASH_REDIS_REST_URL = 'https://stub.upstash.invalid';
      process.env.UPSTASH_REDIS_REST_TOKEN = 'stub-token';
      t.mock.method(Ratelimit, 'slidingWindow', (tokens) => () => ({
        async limit(_ctx, key) {
          limiterKeys.push(key);
          return { success: true, limit: tokens, remaining: tokens - 1, reset: Date.now() + 60_000, pending: Promise.resolve() };
        },
      }));

      const alias = newClient({ mode: { pin: MODERN } });
      await alias.connect(new StreamableHTTPClientTransport(new URL('/.well-known/mcp', server.url)));
      const discover = alias.getDiscoverResult();
      await alias.close();

      client = newClient({ mode: { pin: MODERN } });
      await client.connect(new StreamableHTTPClientTransport(server.url), { prior: { kind: 'modern', discover } });
      assert.equal(client.getProtocolEra(), 'modern');
      const result = await client.callTool({ name: 'get_sources', arguments: {} });
      assert.notEqual(result.isError, true, JSON.stringify(result).slice(0, 300));
      assert.ok(limiterKeys.some((key) => key.startsWith('rl:mcp:free:')), JSON.stringify(limiterKeys));
      // After connect, a 401 with no authProvider is the transport's generic
      // HTTP rejection; the typed ClientHttpAuthentication code is reserved for
      // the connect-time probe. The status is the authorization evidence.
      await assert.rejects(client.listTools(), (err) => {
        assert.ok(err instanceof SdkHttpError, `expected SdkHttpError, got ${err?.constructor?.name}: ${err?.message}`);
        assert.equal(err.data?.status, 401, JSON.stringify(err.data));
        return true;
      });
    });

    it('the SDK caches the public tools/list hint and does not refetch it', async () => {
      const c = await connect({ mode: { pin: MODERN } });
      await c.listTools();
      await c.listTools();
      assert.equal(server.seen.filter((m) => m === 'tools/list').length, 1, `methods seen: ${server.seen}`);
    });

    it('the default legacy client still runs the initialize handshake', async () => {
      const c = await connect(undefined);
      assert.equal(c.getProtocolEra(), 'legacy');
      assert.notEqual(c.getNegotiatedProtocolVersion(), MODERN);
      assert.equal(server.seen[0], 'initialize');
      assert.equal(server.seen.includes('server/discover'), false);
      await assertToolsWork(c);
    });

    it('listen() on a modern connection closes gracefully', async () => {
      const c = await connect({ mode: { pin: MODERN } });
      const subscription = await c.listen({ toolsListChanged: true });
      assert.equal(typeof subscription.honoredFilter, 'object');
      assert.equal(await subscription.closed, 'graceful');
    });

    it('listen() on a legacy connection is refused by the SDK, not sent', async () => {
      const c = await connect(undefined);
      await assert.rejects(c.listen({ toolsListChanged: true }), (err) => {
        assert.ok(err instanceof SdkError);
        assert.equal(err.code, SdkErrorCode.MethodNotSupportedByProtocolVersion);
        return true;
      });
      assert.equal(server.seen.includes('subscriptions/listen'), false);
    });
  });

  describe('flag off', () => {
    beforeEach(async () => { await boot(undefined); });

    it('auto mode falls back to initialize and lands on the legacy era', async () => {
      const c = await connect({ mode: 'auto' });
      assert.equal(c.getProtocolEra(), 'legacy');
      assert.equal(c.getDiscoverResult(), undefined);
      assert.ok(server.seen.indexOf('server/discover') < server.seen.indexOf('initialize'), `methods seen: ${server.seen}`);
      await assertToolsWork(c);
    });

    it('a 2026-07-28 pin fails negotiation instead of falling back', async () => {
      await assert.rejects(connect({ mode: { pin: MODERN } }), (err) => {
        assert.ok(err instanceof SdkError);
        assert.equal(err.code, SdkErrorCode.EraNegotiationFailed);
        return true;
      });
      assert.equal(server.seen.includes('initialize'), false);
    });

    it('the default legacy client is unaffected', async () => {
      const c = await connect(undefined);
      assert.equal(c.getProtocolEra(), 'legacy');
      await assertToolsWork(c);
    });
  });
});
