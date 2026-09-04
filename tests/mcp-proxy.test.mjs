// RUN WITH: `npm run test:data` OR `node --import=tsx --test tests/mcp-proxy.test.mjs`.
// The handler under test (api/mcp-proxy.ts) imports premium auth helpers from
// server/_shared/premium-check (extensionless TS). Plain `node --test`
// cannot resolve that import and will fail with ERR_MODULE_NOT_FOUND —
// this is expected; use tsx (the project's standard test runner).
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach, before } from 'node:test';
import { MAX_MCP_PROXY_JSON_DEPTH } from '../api/mcp/bounded-json.ts';

// validateApiKey runs with forceKey:true on this endpoint (PR #3768 review
// finding — wms_ session tokens are anonymous and freely mintable via
// /api/wm-session, so accepting them turned the auth gate into a two-step
// bypass). The positive-path tests need an enterprise key, not a session
// token. WM_SESSION_SECRET is set so the session module loads without throw;
// SESSION_TOKEN is kept around so the explicit "wms_ tokens are rejected"
// regression test below can prove the bypass is closed.
process.env.WM_SESSION_SECRET ||= 'test-secret-must-be-at-least-32-chars-long-xxx';
const ENTERPRISE_KEY = 'test-enterprise-key-mcp-proxy-123';
process.env.WORLDMONITOR_VALID_KEYS = ENTERPRISE_KEY;
const { issueSessionToken } = await import('../api/_session.js');
let SESSION_TOKEN;
before(async () => {
  SESSION_TOKEN = (await issueSessionToken()).token;
});

const originalFetch = globalThis.fetch;

function buildHeaders(origin, { authed = true, extra = {} } = {}) {
  const h = { ...extra };
  if (origin !== null) h.origin = origin;
  if (authed) h['X-WorldMonitor-Key'] = ENTERPRISE_KEY;
  return h;
}

// @upstash/ratelimit's module-level `Cache.blockUntil` persists block
// decisions for the configured window — once a test rate-limits a given IP,
// subsequent tests reusing the same IP stay blocked even if Redis is mocked
// to allow them. The pool must therefore span the full test suite without
// recycling. We use a /16 (10.<high>.<low>.0 = 65,536 IPs), which is the
// TEST-NET-3-style spirit applied to RFC1918 space. Tests that need
// cf-connecting-ip to key the limiter must include the Cloudflare proof header;
// otherwise the hardened helper falls back to x-real-ip / unknown.
//
// Earlier this helper used `203.0.113.${counter % 250}` and wrapped at 250
// requests — flaky as soon as the suite grew past ~250 rate-limit-touching
// cases, because a previously-blocked IP would silently fail downstream
// tests. PR #3821 r2.
let __testIpCounter = 0;
function uniqueCallerIp() {
  __testIpCounter += 1;
  if (__testIpCounter > 0xffff) {
    // Hard fail rather than wrap — the wrap is the bug we're avoiding above.
    // If the suite ever genuinely needs >65,536 unique caller IPs, expand
    // the pool to a /8 first (and rethink whether the rate-limit cache
    // should be reset between describe blocks instead).
    throw new Error(
      `[mcp-proxy test] uniqueCallerIp() exhausted the /16 pool (>${0xffff} calls). ` +
        `Recycling an IP risks reviving @upstash/ratelimit's module-level Cache.blockUntil ` +
        `state from an earlier test. Expand the pool or reset the limiter cache.`,
    );
  }
  const high = (__testIpCounter >> 8) & 0xff;
  const low = __testIpCounter & 0xff;
  return `10.${high}.${low}.0`;
}

function makeGetRequest(params = {}, origin = 'https://worldmonitor.app', opts = {}) {
  const url = new URL('https://worldmonitor.app/api/mcp-proxy');
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  return new Request(url.toString(), {
    method: 'GET',
    headers: buildHeaders(origin, opts),
  });
}

function makePostRequest(body = {}, origin = 'https://worldmonitor.app', opts = {}) {
  return new Request('https://worldmonitor.app/api/mcp-proxy', {
    method: 'POST',
    headers: buildHeaders(origin, { ...opts, extra: { 'Content-Type': 'application/json', ...(opts.extra || {}) } }),
    body: JSON.stringify(body),
  });
}

function makeOptionsRequest(origin = 'https://worldmonitor.app') {
  return new Request('https://worldmonitor.app/api/mcp-proxy', {
    method: 'OPTIONS',
    headers: { origin },
  });
}

function assertNoStore(res, label) {
  assert.equal(res.headers.get('Cache-Control'), 'no-store', `${label} must include Cache-Control: no-store`);
}

// Minimal MCP server stub — returns valid JSON-RPC responses
function makeMcpFetch({ initStatus = 200, listStatus = 200, callStatus = 200, tools = [], callResult = { content: [] } } = {}) {
  return async (_url, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : {};
    if (body.method === 'initialize' || body.method === 'notifications/initialized') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'test', version: '1' } } }), {
        status: initStatus,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (body.method === 'tools/list') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools } }), {
        status: listStatus,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (body.method === 'tools/call') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: callResult }), {
        status: callStatus,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

let handler;
const TEST_RESOLVER_KEY = Symbol.for('worldmonitor.mcpProxy.resolveHostnameForTest');

const PUBLIC_TEST_ADDRESS = '93.184.216.34';
const MCP_PROXY_RESPONSE_CAP_BYTES = 1024 * 1024;

function setResolveHostnameForTest(resolver) {
  if (typeof resolver === 'function') {
    globalThis[TEST_RESOLVER_KEY] = resolver;
  } else {
    delete globalThis[TEST_RESOLVER_KEY];
  }
}

function setResolvedAddresses(addresses) {
  setResolveHostnameForTest(async () => addresses);
}

function dnsJsonResponse(records) {
  return new Response(JSON.stringify({
    Status: 0,
    Answer: records.map(({ type, data }) => ({ type, data })),
  }), { status: 200, headers: { 'Content-Type': 'application/dns-json' } });
}

describe('api/mcp-proxy', () => {
  beforeEach(async () => {
    // mcp-proxy migrated .js → .ts in PR #3768 to unlock the
    // premium-check import from server/. Test must follow the rename.
    const mod = await import(`../api/mcp-proxy.ts?t=${Date.now()}`);
    handler = mod.default;
    assert.equal(mod.__setMcpProxyResolveHostnameForTest, undefined);
    setResolvedAddresses([PUBLIC_TEST_ADDRESS]);
  });

  afterEach(() => {
    setResolveHostnameForTest?.(null);
    globalThis.fetch = originalFetch;
  });

  // ── Auth gate (issue #3723) ───────────────────────────────────────────────

  describe('Auth gate', () => {
    it('returns 401 when no X-WorldMonitor-Key is provided', async () => {
      const res = await handler(makeGetRequest({ serverUrl: 'https://mcp.example.com/mcp' }, 'https://worldmonitor.app', { authed: false }));
      assert.equal(res.status, 401);
      assertNoStore(res, 'GET auth error');
    });

    it('returns 401 for curl-style request (no Origin, no key) — the #3723 bypass', async () => {
      // isDisallowedOrigin returns false on null Origin (correct for legit
      // server-to-server callers on other endpoints). The auth check is what
      // closes the bypass here.
      const url = new URL('https://worldmonitor.app/api/mcp-proxy');
      url.searchParams.set('serverUrl', 'https://mcp.example.com/mcp');
      const res = await handler(new Request(url.toString(), { method: 'GET' }));
      assert.equal(res.status, 401);
    });

    it('returns 401 for POST without key', async () => {
      const res = await handler(makePostRequest({ serverUrl: 'https://mcp.example.com/mcp', toolName: 'search' }, 'https://worldmonitor.app', { authed: false }));
      assert.equal(res.status, 401);
      assertNoStore(res, 'POST auth error');
    });

    it('still returns 204 for OPTIONS preflight without key (preflights must not require auth)', async () => {
      const res = await handler(makeOptionsRequest());
      assert.equal(res.status, 204);
      assertNoStore(res, 'OPTIONS preflight');
    });

    // wms_ session tokens are anonymous and freely mintable by any caller
    // via POST /api/wm-session. Without forceKey:true, they would pass the
    // auth gate — turning the gate into a two-step bypass (mint + call).
    // PR #3768 review finding; closes the residual #3723 surface.
    // wms_ session tokens are anonymous and freely mintable via
    // /api/wm-session. The auth gate must reject them — otherwise the
    // bypass is "mint, then proxy". resolvePremiumCallerIdentity does this by
    // requiring keyCheck.required === true (wms_ short-circuits at
    // required:false). PR #3768 review regression.
    it('rejects a wms_ session token even though it is technically valid', async () => {
      const url = new URL('https://worldmonitor.app/api/mcp-proxy');
      url.searchParams.set('serverUrl', 'https://mcp.example.com/mcp');
      const req = new Request(url.toString(), {
        method: 'GET',
        headers: { origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': SESSION_TOKEN },
      });
      const res = await handler(req);
      assert.equal(res.status, 401, 'wms_ session token must NOT unlock /api/mcp-proxy');
      const body = await res.json();
      assert.match(body.error, /Pro authentication required/i);
    });

    // wm_ user keys: resolvePremiumCallerIdentity calls validateUserApiKey which hits
    // Convex. With CONVEX_SITE_URL unset in test env, it returns null →
    // 401. This proves the wm_ branch fails closed when the validator
    // can't run — and that the path is exercised (no MODULE_NOT_FOUND
    // like the previous .js → .ts dynamic-import attempt).
    //
    // The key MUST be canonically shaped (`wm_` + 40 lowercase hex). Since
    // #5379, validateUserApiKey rejects a malformed key BEFORE hashing or
    // calling Convex, so the old placeholder 'wm_user_abc123' still returned
    // 401 but short-circuited at the format gate — the test kept passing while
    // silently covering none of the path its comment claims to prove. This key
    // is well-shaped but never minted, so it reaches fetchFromConvex and is
    // rejected there.
    it('rejects wm_ user keys when Convex validation cannot run / returns null', async () => {
      const url = new URL('https://worldmonitor.app/api/mcp-proxy');
      url.searchParams.set('serverUrl', 'https://mcp.example.com/mcp');
      const req = new Request(url.toString(), {
        method: 'GET',
        headers: { origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': `wm_${'a'.repeat(40)}` },
      });
      const res = await handler(req);
      assert.equal(res.status, 401);
    });

    it('accepts a valid enterprise key', async () => {
      // Positive-path smoke. Other tests under "GET /api/mcp-proxy
      // (list tools)" / "POST /api/mcp-proxy (call tool)" already use
      // ENTERPRISE_KEY via the helper; this is the explicit assertion.
      globalThis.fetch = makeMcpFetch({ tools: [] });
      const res = await handler(makeGetRequest({ serverUrl: 'https://mcp.example.com/mcp' }));
      assert.equal(res.status, 200);
    });

    // Bearer-JWT acceptance is the OTHER positive path (normal web Pro
    // users). End-to-end coverage would need a stubbed Clerk
    // validateBearerToken — out of scope for this unit test. The Bearer
    // path is exercised in tests/chat-analyst.test.mts / production E2E.
  });

  // ── SSRF defence-in-depth: cloud-metadata header stripping (GHSA-887j) ─────

  describe('customHeaders — cloud-metadata header stripping (GHSA-887j)', () => {
    function captureForwardedHeaders() {
      const captured = { headers: null };
      globalThis.fetch = async (_url, opts) => {
        captured.headers = opts?.headers ?? {};
        const body = opts?.body ? JSON.parse(opts.body) : {};
        if (body.method === 'tools/list') {
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [] } }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 't', version: '1' } } }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      };
      return captured;
    }

    it('drops Metadata-Flavor / X-aws-ec2-metadata-token but forwards legit headers', async () => {
      const captured = captureForwardedHeaders();
      const res = await handler(makeGetRequest({
        serverUrl: 'https://mcp.example.com/mcp',
        headers: JSON.stringify({
          'Metadata-Flavor': 'Google',
          'metadata': 'true',
          'X-aws-ec2-metadata-token': 'stolen-token',
          'X-aws-ec2-metadata-token-ttl-seconds': '21600',
          'Authorization': 'Bearer legit-mcp-token',
        }),
      }));
      assert.equal(res.status, 200);
      assert.ok(captured.headers, 'target fetch must have been called');
      const lowerKeys = Object.keys(captured.headers).map((k) => k.toLowerCase());
      assert.ok(!lowerKeys.includes('metadata-flavor'), 'Metadata-Flavor must be stripped');
      assert.ok(!lowerKeys.includes('metadata'), 'Azure Metadata header must be stripped');
      assert.ok(!lowerKeys.includes('x-aws-ec2-metadata-token'), 'AWS IMDSv2 token header must be stripped');
      assert.ok(!lowerKeys.includes('x-aws-ec2-metadata-token-ttl-seconds'), 'AWS IMDSv2 ttl header must be stripped');
      assert.ok(lowerKeys.includes('authorization'), 'legitimate Authorization must pass through');
    });
  });

  // ── CORS / method guards ──────────────────────────────────────────────────

  describe('CORS and method handling', () => {
    it('returns 403 for disallowed origin', async () => {
      const res = await handler(makeGetRequest({ serverUrl: 'https://mcp.example.com/mcp' }, 'https://evil.com'));
      assert.equal(res.status, 403);
      assertNoStore(res, 'disallowed origin');
    });

    it('returns 204 for OPTIONS preflight', async () => {
      const res = await handler(makeOptionsRequest());
      assert.equal(res.status, 204);
      assertNoStore(res, 'OPTIONS preflight');
    });

    it('returns 405 for DELETE', async () => {
      const res = await handler(new Request('https://worldmonitor.app/api/mcp-proxy', {
        method: 'DELETE',
        headers: { origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': ENTERPRISE_KEY },
      }));
      assert.equal(res.status, 405);
      assertNoStore(res, 'DELETE method guard');
    });

    it('returns 405 for PUT', async () => {
      const res = await handler(new Request('https://worldmonitor.app/api/mcp-proxy', {
        method: 'PUT',
        headers: { origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': ENTERPRISE_KEY },
        body: '{}',
      }));
      assert.equal(res.status, 405);
    });
  });

  // ── GET — list tools ──────────────────────────────────────────────────────

  describe('GET /api/mcp-proxy (list tools)', () => {
    it('returns 400 when serverUrl is missing', async () => {
      const res = await handler(makeGetRequest());
      assert.equal(res.status, 400);
      assertNoStore(res, 'GET validation error');
      const data = await res.json();
      assert.match(data.error, /serverUrl/i);
    });

    it('returns 400 for non-HTTPS protocol', async () => {
      const res = await handler(makeGetRequest({ serverUrl: 'ftp://mcp.example.com/mcp' }));
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /invalid serverUrl/i);
    });

    it('returns 400 for plain HTTP public upstreams before DNS or fetch', async () => {
      let resolverCalled = false;
      let fetchCalled = false;
      setResolveHostnameForTest(async () => {
        resolverCalled = true;
        return [PUBLIC_TEST_ADDRESS];
      });
      globalThis.fetch = async () => {
        fetchCalled = true;
        return new Response('{}', { status: 200 });
      };
      const res = await handler(makeGetRequest({ serverUrl: 'http://public-mcp.example/mcp' }));
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /invalid serverUrl/i);
      assert.equal(resolverCalled, false, 'HTTP upstream validation must reject before DNS resolution');
      assert.equal(fetchCalled, false, 'HTTP upstream validation must reject before upstream fetch');
    });

    it('returns 400 for localhost', async () => {
      const res = await handler(makeGetRequest({ serverUrl: 'https://localhost/mcp' }));
      assert.equal(res.status, 400);
    });

    it('returns 400 for 127.x.x.x', async () => {
      const res = await handler(makeGetRequest({ serverUrl: 'https://127.0.0.1:8080/mcp' }));
      assert.equal(res.status, 400);
    });

    it('returns 400 for 10.x.x.x (RFC1918)', async () => {
      const res = await handler(makeGetRequest({ serverUrl: 'https://10.0.0.1/mcp' }));
      assert.equal(res.status, 400);
    });

    it('returns 400 for 192.168.x.x (RFC1918)', async () => {
      const res = await handler(makeGetRequest({ serverUrl: 'https://192.168.1.1/mcp' }));
      assert.equal(res.status, 400);
    });

    it('returns 400 for 172.16.x.x (RFC1918)', async () => {
      const res = await handler(makeGetRequest({ serverUrl: 'https://172.16.0.1/mcp' }));
      assert.equal(res.status, 400);
    });

    it('returns 400 for link-local 169.254.x.x (cloud metadata)', async () => {
      const res = await handler(makeGetRequest({ serverUrl: 'https://169.254.169.254/latest/meta-data/' }));
      assert.equal(res.status, 400);
    });

    it('returns 400 when DNS resolves a hostname to blocked private/reserved addresses', async () => {
      const cases = [
        ['private IPv4', '10.0.0.5'],
        ['link-local IPv4', '169.254.169.254'],
        ['loopback IPv4', '127.0.0.1'],
        ['ULA IPv6', 'fd00::1234'],
        ['link-local IPv6', 'fe80::1'],
        // Embedded / reserved IPv6 encodings that previously slipped through
        // the classifier (only dotted ::ffff: was decoded). Each decodes to a
        // private/reserved IPv4 or is a reserved v6 range.
        ['dotted v4-mapped loopback', '::ffff:127.0.0.1'],
        ['hex v4-mapped loopback', '::ffff:7f00:1'],
        ['hex v4-mapped metadata IP', '::ffff:a9fe:a9fe'],
        ['uppercase hex v4-mapped RFC1918', '::FFFF:0A00:0001'],
        ['NAT64 RFC1918', '64:ff9b::a00:1'],
        ['NAT64 metadata IP', '64:ff9b::a9fe:a9fe'],
        ['IPv4-compatible loopback', '::7f00:1'],
        ['IPv4-compatible metadata IP', '::a9fe:a9fe'],
        ['6to4 loopback', '2002:7f00:1::'],
        ['6to4 metadata IP', '2002:a9fe:a9fe::'],
        ['site-local IPv6', 'fec0::1'],
      ];
      for (const [label, address] of cases) {
        setResolvedAddresses([address]);
        const res = await handler(makeGetRequest({ serverUrl: `https://${label.toLowerCase().replaceAll(' ', '-')}.example/mcp` }));
        assert.equal(res.status, 400, `${label} DNS result must be rejected`);
        const data = await res.json();
        assert.match(data.error, /invalid serverUrl/i);
      }
    });

    it('allows a hostname whose DNS answers are public addresses', async () => {
      setResolveHostnameForTest(null);
      globalThis.fetch = async (url, opts) => {
        const u = new URL(url.toString());
        if (u.hostname === 'cloudflare-dns.com') {
          const type = u.searchParams.get('type');
          if (type === 'A') return dnsJsonResponse([{ type: 1, data: PUBLIC_TEST_ADDRESS }]);
          if (type === 'AAAA') return dnsJsonResponse([{ type: 28, data: '2606:2800:220:1:248:1893:25c8:1946' }]);
        }
        return makeMcpFetch({ tools: [] })(url, opts);
      };
      const res = await handler(makeGetRequest({ serverUrl: 'https://public-mcp.example/mcp' }));
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.deepEqual(data.tools, []);
    });

    it('ignores the test resolver outside NODE_TEST_CONTEXT', async () => {
      const previousNodeTestContext = process.env.NODE_TEST_CONTEXT;
      delete process.env.NODE_TEST_CONTEXT;
      setResolvedAddresses(['10.0.0.5']);
      globalThis.fetch = async (url, opts) => {
        const u = new URL(url.toString());
        if (u.hostname === 'cloudflare-dns.com') {
          const type = u.searchParams.get('type');
          if (type === 'A') return dnsJsonResponse([{ type: 1, data: PUBLIC_TEST_ADDRESS }]);
          if (type === 'AAAA') return dnsJsonResponse([]);
        }
        return makeMcpFetch({ tools: [] })(url, opts);
      };
      try {
        const res = await handler(makeGetRequest({ serverUrl: 'https://public-mcp.example/mcp' }));
        assert.equal(res.status, 200);
      } finally {
        if (previousNodeTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
        else process.env.NODE_TEST_CONTEXT = previousNodeTestContext;
      }
    });

    it('returns 400 for garbled URL', async () => {
      const res = await handler(makeGetRequest({ serverUrl: 'not a url at all' }));
      assert.equal(res.status, 400);
    });

    it('returns 200 with tools array on successful list', async () => {
      const sampleTools = [{ name: 'search', description: 'Web search', inputSchema: {} }];
      globalThis.fetch = makeMcpFetch({ tools: sampleTools });
      const res = await handler(makeGetRequest({ serverUrl: 'https://mcp.example.com/mcp' }));
      assert.equal(res.status, 200);
      assertNoStore(res, 'GET list success');
      const data = await res.json();
      assert.ok(Array.isArray(data.tools));
      assert.equal(data.tools.length, 1);
      assert.equal(data.tools[0].name, 'search');
    });

    it('preserves deep schemas and reserved property names from third-party servers', async () => {
      let deep = { type: ['number', 'null'] };
      for (let depth = 0; depth < 24; depth += 1) deep = { type: 'array', items: deep };
      const sampleTools = [{
        name: 'foreign_tool',
        inputSchema: { type: 'object' },
        outputSchema: {
          type: 'object',
          required: ['cause'],
          properties: {
            cause: { type: 'string' },
            stack: { type: 'string' },
            stackTrace: { type: 'array', items: { type: 'string' } },
            deep,
          },
        },
      }];
      globalThis.fetch = makeMcpFetch({ tools: sampleTools });

      const res = await handler(makeGetRequest({ serverUrl: 'https://mcp.example.com/mcp' }));

      assert.equal(res.status, 200);
      assert.deepEqual((await res.json()).tools, sampleTools);
    });

    it('rejects a deeply nested streamable response before parsing it', async () => {
      const depth = 10_000;
      const deepSchema = '{"nested":'.repeat(depth) + 'true' + '}'.repeat(depth);
      const payload = `{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"deep_tool","inputSchema":{"type":"object"},"outputSchema":${deepSchema}}]}}`;
      assert.ok(new TextEncoder().encode(payload).byteLength < MCP_PROXY_RESPONSE_CAP_BYTES);

      globalThis.fetch = async (url, opts) => {
        const body = opts?.body ? JSON.parse(opts.body) : {};
        if (body.method === 'tools/list') {
          return new Response(payload, { headers: { 'Content-Type': 'application/json' } });
        }
        return makeMcpFetch({ tools: [] })(url, opts);
      };

      const res = await handler(makeGetRequest({ serverUrl: 'https://mcp.example.com/mcp' }));

      assert.equal(res.status, 422);
      assert.equal(
        (await res.json()).error,
        `MCP proxy JSON exceeds ${MAX_MCP_PROXY_JSON_DEPTH} nesting levels`,
      );
    });

    it('cancels the ignored streamable initialized response body', async () => {
      let cancelled = false;
      globalThis.fetch = async (url, opts) => {
        const body = opts?.body ? JSON.parse(opts.body) : {};
        if (body.method === 'notifications/initialized') {
          return new Response(new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }), { status: 202 });
        }
        return makeMcpFetch({ tools: [] })(url, opts);
      };

      const res = await handler(makeGetRequest({ serverUrl: 'https://mcp.example.com/mcp' }));

      assert.equal(res.status, 200);
      assert.equal(cancelled, true);
    });

    it('rejects oversized streamable JSON before parsing it', async () => {
      globalThis.fetch = async (_url, opts) => {
        const body = opts?.body ? JSON.parse(opts.body) : {};
        if (body.method === 'initialize') {
          const payload = JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              protocolVersion: '2025-03-26',
              capabilities: {},
              padding: 'x'.repeat(MCP_PROXY_RESPONSE_CAP_BYTES),
            },
          });
          return new Response(payload, { headers: { 'Content-Type': 'application/json' } });
        }
        return makeMcpFetch({ tools: [] })(_url, opts);
      };

      const res = await handler(makeGetRequest({ serverUrl: 'https://mcp.example.com/mcp' }));

      assert.equal(res.status, 422);
      assert.equal((await res.json()).error, `MCP server response exceeds ${MCP_PROXY_RESPONSE_CAP_BYTES} bytes`);
    });

    it('returns empty tools array when server returns none', async () => {
      globalThis.fetch = makeMcpFetch({ tools: [] });
      const res = await handler(makeGetRequest({ serverUrl: 'https://mcp.example.com/mcp' }));
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.deepEqual(data.tools, []);
    });

    it('returns 422 when upstream returns non-ok status', async () => {
      globalThis.fetch = makeMcpFetch({ initStatus: 401 });
      const res = await handler(makeGetRequest({ serverUrl: 'https://mcp.example.com/mcp' }));
      assert.equal(res.status, 422);
      assertNoStore(res, 'GET upstream error');
    });

    it('returns 422 when upstream returns JSON-RPC error', async () => {
      globalThis.fetch = async () => new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
      const res = await handler(makeGetRequest({ serverUrl: 'https://mcp.example.com/mcp' }));
      assert.equal(res.status, 422);
      const data = await res.json();
      assert.match(data.error, /Method not found/i);
    });

    it('returns 504 on fetch timeout', async () => {
      globalThis.fetch = async () => {
        const err = new Error('The operation timed out.');
        err.name = 'TimeoutError';
        throw err;
      };
      const res = await handler(makeGetRequest({ serverUrl: 'https://mcp.example.com/mcp' }));
      assert.equal(res.status, 504);
      const data = await res.json();
      assert.match(data.error, /timed out/i);
    });

    it('ignores invalid JSON in headers param', async () => {
      globalThis.fetch = makeMcpFetch({ tools: [] });
      const url = new URL('https://worldmonitor.app/api/mcp-proxy');
      url.searchParams.set('serverUrl', 'https://mcp.example.com/mcp');
      url.searchParams.set('headers', 'not json');
      const req = new Request(url.toString(), { method: 'GET', headers: { origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': ENTERPRISE_KEY } });
      const res = await handler(req);
      assert.equal(res.status, 200);
    });

    it('passes custom headers to upstream', async () => {
      let capturedHeaders = {};
      globalThis.fetch = async (url, opts) => {
        capturedHeaders = Object.fromEntries(Object.entries(opts?.headers || {}));
        return makeMcpFetch({ tools: [] })(url, opts);
      };
      const res = await handler(makeGetRequest({
        serverUrl: 'https://mcp.example.com/mcp',
        headers: JSON.stringify({ Authorization: 'Bearer test-key' }),
      }));
      assert.equal(res.status, 200);
      assert.equal(capturedHeaders['Authorization'], 'Bearer test-key');
    });

    it('strips CRLF from injected headers', async () => {
      let capturedHeaders = {};
      globalThis.fetch = async (url, opts) => {
        capturedHeaders = Object.fromEntries(Object.entries(opts?.headers || {}));
        return makeMcpFetch({ tools: [] })(url, opts);
      };
      const res = await handler(makeGetRequest({
        serverUrl: 'https://mcp.example.com/mcp',
        headers: JSON.stringify({ 'X-Evil\r\nInjected': 'bad' }),
      }));
      assert.equal(res.status, 200);
      for (const k of Object.keys(capturedHeaders)) {
        assert.ok(!k.includes('\r') && !k.includes('\n'), `Header key contains CRLF: ${JSON.stringify(k)}`);
      }
    });

    it('does not automatically follow upstream redirects', async () => {
      const redirectModes = [];
      globalThis.fetch = async (url, opts) => {
        redirectModes.push(opts?.redirect);
        return makeMcpFetch({ tools: [] })(url, opts);
      };
      const res = await handler(makeGetRequest({ serverUrl: 'https://mcp.example.com/mcp' }));
      assert.equal(res.status, 200);
      assert.deepEqual(redirectModes, ['manual', 'manual', 'manual']);
    });

    // NOTE: this validates the per-dispatch re-resolve + classifier path, NOT
    // true socket-level rebind prevention. Vercel Edge fetch cannot pin the
    // connection to a vetted IP (P1, issue #4674), so a residual rebind window
    // between our resolve and fetch's own resolve is an accepted limitation.
    // What this asserts: when a subsequent re-resolution returns a blocked
    // address, revalidateBeforeFetch rejects it before the next upstream fetch,
    // and the caller sees the GENERIC SSRF message (never the internal IP).
    it('re-resolves and re-checks the same host before each streamable HTTP dispatch (classifier/revalidation path)', async () => {
      const resolutions = [
        [PUBLIC_TEST_ADDRESS], // request validation
        [PUBLIC_TEST_ADDRESS], // initialize POST
        ['10.0.0.9'],          // notifications/initialized would rebind
      ];
      setResolveHostnameForTest(async (hostname) => {
        assert.equal(hostname, 'mcp.example.com');
        return resolutions.shift() ?? [PUBLIC_TEST_ADDRESS];
      });
      let upstreamCalls = 0;
      globalThis.fetch = async (url, opts) => {
        upstreamCalls += 1;
        return makeMcpFetch({ tools: [] })(url, opts);
      };

      const res = await handler(makeGetRequest({ serverUrl: 'https://mcp.example.com/mcp' }));
      assert.equal(res.status, 422);
      const data = await res.json();
      // Caller gets a generic message — the resolved internal IP (10.0.0.9)
      // must never be echoed back (address-oracle SSRF review finding).
      assert.match(data.error, /host is not allowed/i);
      assert.doesNotMatch(data.error, /10\.0\.0\.9/, 'must NOT leak the blocked internal IP to the caller');
      assert.equal(upstreamCalls, 1, 'rebound same-host request must be blocked before the second upstream fetch');
    });
  });

  // ── POST — call tool ──────────────────────────────────────────────────────

  describe('POST /api/mcp-proxy (call tool)', () => {
    it('returns 400 when serverUrl is missing', async () => {
      const res = await handler(makePostRequest({ toolName: 'search' }));
      assert.equal(res.status, 400);
      assertNoStore(res, 'POST validation error');
      const data = await res.json();
      assert.match(data.error, /serverUrl/i);
    });

    it('rejects a request whose tool arguments exceed the JSON nesting limit', async () => {
      let toolArgs = { leaf: true };
      for (let depth = 0; depth < MAX_MCP_PROXY_JSON_DEPTH; depth += 1) {
        toolArgs = { nested: toolArgs };
      }
      let fetchCalled = false;
      globalThis.fetch = async () => {
        fetchCalled = true;
        return new Response('{}');
      };

      const res = await handler(makePostRequest({
        serverUrl: 'https://mcp.example.com/mcp',
        toolName: 'deep_tool',
        toolArgs,
      }));

      assert.equal(res.status, 400);
      assert.equal(
        (await res.json()).error,
        `MCP proxy JSON exceeds ${MAX_MCP_PROXY_JSON_DEPTH} nesting levels`,
      );
      assert.equal(fetchCalled, false);
    });

    it('returns 400 when toolName is missing', async () => {
      const res = await handler(makePostRequest({ serverUrl: 'https://mcp.example.com/mcp' }));
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /toolName/i);
    });

    it('rejects an oversized POST body before forwarding (#7406)', async () => {
      const { MAX_JSON_RPC_BODY_BYTES } = await import('../api/mcp/body-limits.ts');
      const previousUpstashUrl = process.env.UPSTASH_REDIS_REST_URL;
      const previousUpstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
      delete process.env.UPSTASH_REDIS_REST_URL;
      delete process.env.UPSTASH_REDIS_REST_TOKEN;
      try {
        const upstreamHosts = [];
        globalThis.fetch = async (url) => {
          upstreamHosts.push(String(url));
          return new Response('{}');
        };
        const base = JSON.stringify({
          serverUrl: 'https://mcp.example.com/mcp',
          toolName: 'search',
          toolArgs: { q: 'x' },
        });
        const oversized = `${base.slice(0, -1)}${' '.repeat(MAX_JSON_RPC_BODY_BYTES - base.length + 1)}}`;
        assert.ok(new TextEncoder().encode(oversized).byteLength > MAX_JSON_RPC_BODY_BYTES);

        const res = await handler(new Request('https://worldmonitor.app/api/mcp-proxy', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-WorldMonitor-Key': ENTERPRISE_KEY,
            origin: 'https://worldmonitor.app',
          },
          body: oversized,
        }));

        assert.equal(res.status, 413);
        assert.equal(
          upstreamHosts.filter((url) => url.includes('mcp.example.com')).length,
          0,
          'oversized bodies must not reach upstream MCP servers',
        );
        const data = await res.json();
        // Exact equality, not a substring match: api/mcp-proxy.ts is under
        // `@ts-nocheck`, so `typecheck:api` cannot verify the RequestBodyTooLargeError
        // wiring there. This assertion is the only thing pinning that contract.
        assert.equal(data.error, `Request body exceeds ${MAX_JSON_RPC_BODY_BYTES} bytes`);
      } finally {
        if (previousUpstashUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
        else process.env.UPSTASH_REDIS_REST_URL = previousUpstashUrl;
        if (previousUpstashToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
        else process.env.UPSTASH_REDIS_REST_TOKEN = previousUpstashToken;
      }
    });

    it('returns 400 for a malformed JSON POST body (#7406: was 422 pre-cap)', async () => {
      // Before #7406 the bare `await req.json()` threw past handleCallTool into
      // handler()'s outer catch, which answered 422 and echoed the raw parser
      // message (which quotes caller-supplied bytes). The local catch now answers
      // a fixed 400. Pinned so neither the status nor the fixed message drifts back.
      const res = await handler(new Request('https://worldmonitor.app/api/mcp-proxy', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-WorldMonitor-Key': ENTERPRISE_KEY,
          origin: 'https://worldmonitor.app',
        },
        body: '{"serverUrl":',
      }));

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.error, 'Invalid JSON');
    });

    it('returns 400 for blocked host in POST body', async () => {
      const res = await handler(makePostRequest({
        serverUrl: 'https://localhost/mcp',
        toolName: 'search',
      }));
      assert.equal(res.status, 400);
    });

    it('returns 400 for plain HTTP public upstreams in POST before DNS or fetch', async () => {
      let resolverCalled = false;
      let fetchCalled = false;
      setResolveHostnameForTest(async () => {
        resolverCalled = true;
        return [PUBLIC_TEST_ADDRESS];
      });
      globalThis.fetch = async () => {
        fetchCalled = true;
        return new Response('{}', { status: 200 });
      };
      const res = await handler(makePostRequest({
        serverUrl: 'http://public-mcp.example/mcp',
        toolName: 'search',
      }));
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /invalid serverUrl/i);
      assert.equal(resolverCalled, false, 'HTTP upstream validation must reject before DNS resolution');
      assert.equal(fetchCalled, false, 'HTTP upstream validation must reject before upstream fetch');
    });

    it('returns 200 with result on successful tool call', async () => {
      const callResult = { content: [{ type: 'text', text: 'Hello' }] };
      globalThis.fetch = makeMcpFetch({ callResult });
      const res = await handler(makePostRequest({
        serverUrl: 'https://mcp.example.com/mcp',
        toolName: 'search',
        toolArgs: { query: 'test' },
      }));
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.deepEqual(data.result, callResult);
    });

    it('preserves deep results and reserved property names from third-party servers', async () => {
      let deep = { leaf: true };
      for (let depth = 0; depth < 24; depth += 1) deep = { nested: deep };
      const callResult = {
        cause: 'domain-value',
        stack: 'domain-stack',
        stackTrace: ['domain-trace'],
        deep,
      };
      globalThis.fetch = makeMcpFetch({ callResult });

      const res = await handler(makePostRequest({
        serverUrl: 'https://mcp.example.com/mcp',
        toolName: 'foreign_tool',
      }));

      assert.equal(res.status, 200);
      assert.deepEqual((await res.json()).result, callResult);
    });

    it('returns 422 when tools/call returns non-ok status', async () => {
      globalThis.fetch = makeMcpFetch({ callStatus: 403 });
      const res = await handler(makePostRequest({
        serverUrl: 'https://mcp.example.com/mcp',
        toolName: 'search',
      }));
      assert.equal(res.status, 422);
    });

    it('returns 422 when tools/call returns JSON-RPC error', async () => {
      globalThis.fetch = async (url, opts) => {
        const body = JSON.parse(opts.body);
        if (body.method === 'tools/call') {
          return new Response(
            JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'Unknown tool' } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return makeMcpFetch()(url, opts);
      };
      const res = await handler(makePostRequest({
        serverUrl: 'https://mcp.example.com/mcp',
        toolName: 'nonexistent_tool',
      }));
      assert.equal(res.status, 422);
      const data = await res.json();
      assert.match(data.error, /Unknown tool/i);
    });

    it('returns 504 on a native fetch TimeoutError during tool call', async () => {
      globalThis.fetch = async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      };
      const res = await handler(makePostRequest({
        serverUrl: 'https://mcp.example.com/mcp',
        toolName: 'search',
      }));
      assert.equal(res.status, 504);
    });

    it('includes Cache-Control: no-store on success', async () => {
      globalThis.fetch = makeMcpFetch({ callResult: { content: [] } });
      const res = await handler(makePostRequest({
        serverUrl: 'https://mcp.example.com/mcp',
        toolName: 'search',
      }));
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('Cache-Control'), 'no-store');
    });
  });

  // ── SSE transport detection ───────────────────────────────────────────────

  describe('SSE transport routing', () => {
    it('uses SSE transport when URL path ends with /sse', async () => {
      let connectCalled = false;
      globalThis.fetch = async (url, opts) => {
        const u = typeof url === 'string' ? url : url.toString();
        // SSE connect — GET with Accept: text/event-stream
        if (opts?.headers?.['Accept']?.includes('text/event-stream') || !opts?.body) {
          connectCalled = true;
          // Return SSE stream with endpoint event then close
          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode('event: endpoint\ndata: /messages\n\n'));
              controller.close();
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      };
      // SSE transport returns 422 because the endpoint is /messages which resolves relative to the SSE URL domain
      // and the subsequent JSON-RPC calls over SSE will fail (no real SSE server)
      const res = await handler(makeGetRequest({ serverUrl: 'https://mcp.example.com/sse' }));
      assert.ok(connectCalled, 'Expected SSE connect to be called');
      // Result is 422 (stream closed before endpoint or RPC error) — not a node: DNS failure
      assert.ok([200, 422, 504].includes(res.status), `Unexpected status: ${res.status}`);
    });

    it('rejects and cancels a legacy SSE stream after its cumulative raw bytes exceed the cap', async () => {
      let cancelled = false;
      globalThis.fetch = async (_url, opts) => {
        if (!opts?.body) {
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(MCP_PROXY_RESPONSE_CAP_BYTES + 1));
            },
            cancel() {
              cancelled = true;
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }
        throw new Error('oversized legacy SSE must fail before an endpoint POST');
      };

      const res = await handler(makeGetRequest({ serverUrl: 'https://mcp.example.com/sse' }));

      assert.equal(res.status, 422);
      assert.equal((await res.json()).error, `MCP server response exceeds ${MCP_PROXY_RESPONSE_CAP_BYTES} bytes`);
      assert.equal(cancelled, true);
    });

    it('retains a terminal legacy SSE overflow that occurs after endpoint discovery', async () => {
      let endpointPosts = 0;
      globalThis.fetch = async (_url, opts) => {
        if (!opts?.body) {
          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode('event: endpoint\ndata: /messages\n\n'));
              controller.enqueue(new Uint8Array(MCP_PROXY_RESPONSE_CAP_BYTES + 1));
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }
        endpointPosts += 1;
        return new Response(null, { status: 202 });
      };

      const res = await handler(makeGetRequest({ serverUrl: 'https://mcp.example.com/sse' }));

      assert.equal(res.status, 422);
      assert.equal((await res.json()).error, `MCP server response exceeds ${MCP_PROXY_RESPONSE_CAP_BYTES} bytes`);
      assert.equal(endpointPosts, 0, 'a terminal stream error must reject before the next endpoint POST');
    });

    it('cancels ignored legacy SSE acknowledgement bodies', async () => {
      const encoder = new TextEncoder();
      let sseController;
      let cancelledAcks = 0;
      globalThis.fetch = async (_url, opts) => {
        if (!opts?.body) {
          const stream = new ReadableStream({
            start(controller) {
              sseController = controller;
              controller.enqueue(encoder.encode('event: endpoint\ndata: /messages\n\n'));
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }

        const body = JSON.parse(opts.body);
        if (body.id === 1) {
          sseController.enqueue(encoder.encode(`data: ${JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { protocolVersion: '2025-03-26', capabilities: {} },
          })}\n\n`));
        } else if (body.id === 2) {
          sseController.enqueue(encoder.encode(`data: ${JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            result: { tools: [] },
          })}\n\n`));
        }

        return new Response(new ReadableStream({
          cancel() {
            cancelledAcks += 1;
          },
        }), { status: 202 });
      };

      const res = await handler(makeGetRequest({ serverUrl: 'https://mcp.example.com/sse' }));

      assert.equal(res.status, 200);
      assert.equal(cancelledAcks, 3);
    });

    it('rejects an over-deep JSON message on legacy SSE', async () => {
      const encoder = new TextEncoder();
      let sseController;
      const deepResult = '{"nested":'.repeat(MAX_MCP_PROXY_JSON_DEPTH + 1)
        + 'true'
        + '}'.repeat(MAX_MCP_PROXY_JSON_DEPTH + 1);
      globalThis.fetch = async (_url, opts) => {
        if (!opts?.body) {
          const stream = new ReadableStream({
            start(controller) {
              sseController = controller;
              controller.enqueue(encoder.encode('event: endpoint\ndata: /messages\n\n'));
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }

        const body = JSON.parse(opts.body);
        if (body.id === 1) {
          sseController.enqueue(encoder.encode(`data: ${JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { protocolVersion: '2025-03-26', capabilities: {} },
          })}\n\n`));
        } else if (body.id === 2) {
          sseController.enqueue(encoder.encode(
            `data: {"jsonrpc":"2.0","id":2,"result":${deepResult}}\n\n`,
          ));
        }
        return new Response(null, { status: 202 });
      };

      const res = await handler(makeGetRequest({ serverUrl: 'https://mcp.example.com/sse' }));

      assert.equal(res.status, 422);
      assert.equal(
        (await res.json()).error,
        `MCP proxy JSON exceeds ${MAX_MCP_PROXY_JSON_DEPTH} nesting levels`,
      );
    });
  });

  // ── SSE SSRF protection ───────────────────────────────────────────────────

  describe('SSE endpoint SSRF protection', () => {
    async function expectRejectedEndpoint(endpointData, serverUrl = 'https://mcp.example.com/sse') {
      let postCount = 0;
      globalThis.fetch = async (_url, opts) => {
        // First call = SSE connect
        if (!opts?.body) {
          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(`event: endpoint\ndata: ${endpointData}\n\n`));
              controller.close();
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }
        postCount += 1;
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      };

      const res = await handler(makeGetRequest({ serverUrl }));
      assert.equal(res.status, 422);
      const data = await res.json();
      assert.match(data.error, /blocked|endpoint|origin|protocol|host/i);
      assert.equal(postCount, 0, 'rejected endpoint must not receive JSON-RPC POSTs');
    }

    it('rejects SSE endpoint event that redirects to private IP', async () => {
      globalThis.fetch = async (url, opts) => {
        const u = typeof url === 'string' ? url : url.toString();
        // First call = SSE connect
        if (!opts?.body) {
          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            start(controller) {
              // Malicious server tries to redirect to internal IP
              controller.enqueue(encoder.encode('event: endpoint\ndata: http://192.168.1.100/steal\n\n'));
              controller.close();
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      };
      const res = await handler(makeGetRequest({ serverUrl: 'https://mcp.example.com/sse' }));
      assert.equal(res.status, 422);
      const data = await res.json();
      assert.match(data.error, /blocked|SSRF|endpoint/i);
    });

    it('rejects SSE endpoint event that redirects to a different public hostname', async () => {
      await expectRejectedEndpoint('https://internal-service.corp/message');
    });

    it('rejects SSE endpoint event that changes the origin port', async () => {
      await expectRejectedEndpoint(
        'https://mcp.example.com:6379/message',
        'https://mcp.example.com:443/sse',
      );
    });

    it('rejects SSE endpoint event that downgrades HTTPS to HTTP on the same host', async () => {
      await expectRejectedEndpoint('http://mcp.example.com/message');
    });
  });

  // ── SSE response parsing ──────────────────────────────────────────────────

  describe('SSE content-type response parsing', () => {
    it('parses JSON-RPC result from SSE response body', async () => {
      const sseTools = [{ name: 'web_search', description: 'Search', inputSchema: {} }];
      globalThis.fetch = async (_url, opts) => {
        const body = opts?.body ? JSON.parse(opts.body) : {};
        if (body.method === 'initialize') {
          const sseData = `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: {} } })}\n\n`;
          return new Response(sseData, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        if (body.method === 'tools/list') {
          const sseData = `data: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: sseTools } })}\n\n`;
          return new Response(sseData, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      };
      const res = await handler(makeGetRequest({ serverUrl: 'https://mcp.example.com/mcp' }));
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.tools[0].name, 'web_search');
    });

    it('rejects oversized streamable HTTP SSE before parsing it', async () => {
      globalThis.fetch = async (_url, opts) => {
        const body = opts?.body ? JSON.parse(opts.body) : {};
        if (body.method === 'initialize') {
          const message = {
            jsonrpc: '2.0',
            id: body.id,
            result: {
              protocolVersion: '2025-03-26',
              capabilities: {},
              padding: 'x'.repeat(MCP_PROXY_RESPONSE_CAP_BYTES),
            },
          };
          return new Response(`data: ${JSON.stringify(message)}\n\n`, {
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }
        return makeMcpFetch({ tools: [] })(_url, opts);
      };

      const res = await handler(makeGetRequest({ serverUrl: 'https://mcp.example.com/mcp' }));

      assert.equal(res.status, 422);
      assert.equal((await res.json()).error, `MCP server response exceeds ${MCP_PROXY_RESPONSE_CAP_BYTES} bytes`);
    });
  });

  // ── Rate limit + audit log (issue #3805) ─────────────────────────────────
  //
  // Defense-in-depth additions to the proxy:
  //   1) Per-IP 30/min cap so even an authenticated Pro key cannot drive
  //      unbounded outbound traffic from the WM IP.
  //   2) Structured audit log per call recording who proxied to where and
  //      which header NAMES (not values) they forwarded — so an
  //      incident-response can reconstruct activity without leaking the
  //      Authorization / X-Api-Key secrets the proxy intentionally relays.

  describe('Rate limit (#3805)', () => {
    let savedRedisUrl;
    let savedRedisTok;
    let savedCfProofSecret;

    beforeEach(() => {
      savedRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
      savedRedisTok = process.env.UPSTASH_REDIS_REST_TOKEN;
      savedCfProofSecret = process.env.CF_EDGE_PROOF_SECRET;
    });

    afterEach(() => {
      if (savedRedisUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
      else process.env.UPSTASH_REDIS_REST_URL = savedRedisUrl;
      if (savedRedisTok === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
      else process.env.UPSTASH_REDIS_REST_TOKEN = savedRedisTok;
      if (savedCfProofSecret === undefined) delete process.env.CF_EDGE_PROOF_SECRET;
      else process.env.CF_EDGE_PROOF_SECRET = savedCfProofSecret;
    });

    it('returns 429 + JSON-RPC -32029 + Retry-After when rate-limited', async () => {
      process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
      process.env.UPSTASH_REDIS_REST_TOKEN = 'fake_token';
      process.env.CF_EDGE_PROOF_SECRET = 'edge-secret-xyz';

      // Mock Upstash REST — @upstash/ratelimit's sliding-window EVAL
      // returns `[remainingTokens, effectiveLimit]` per command, wrapped in
      // an auto-pipelining envelope `[{ result: [...] }]`. We force
      // remainingTokens=-1 to trigger success=false (→ 429).
      globalThis.fetch = async (url) => {
        const u = url.toString();
        if (u.includes('fake.upstash.io')) {
          return new Response(
            JSON.stringify([{ result: [-1, 30] }]),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response('{}', { status: 200 });
      };

      const ip = uniqueCallerIp();
      const res = await handler(makeGetRequest(
        { serverUrl: 'https://mcp.example.com/mcp' },
        'https://worldmonitor.app',
        { extra: { 'cf-connecting-ip': ip, 'x-wm-edge-proof': 'edge-secret-xyz' } },
      ));
      assert.equal(res.status, 429, 'must return HTTP 429 on rate-limit hit');
      assertNoStore(res, 'rate-limit error');
      assert.ok(res.headers.get('Retry-After'), 'must include Retry-After header');
      assert.ok(Number(res.headers.get('Retry-After')) >= 1, 'Retry-After must be >= 1s');
      const body = await res.json();
      assert.equal(body.error?.code, -32029, 'must return JSON-RPC -32029');
      assert.match(body.error.message, /rate limit/i);
    });

    it('rate-limit fail-opens when Upstash is unreachable (graceful degradation)', async () => {
      process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
      process.env.UPSTASH_REDIS_REST_TOKEN = 'fake_token';
      process.env.CF_EDGE_PROOF_SECRET = 'edge-secret-xyz';

      // Simulate Upstash hard-failure: scoped limiter should fail-open and
      // the request still completes. Mock fetch returns network error for
      // Upstash but normal MCP responses for the upstream MCP server.
      globalThis.fetch = async (url, opts) => {
        const u = url.toString();
        if (u.includes('fake.upstash.io')) throw new TypeError('fetch failed');
        return makeMcpFetch({ tools: [] })(url, opts);
      };

      const ip = uniqueCallerIp();
      const res = await handler(makeGetRequest(
        { serverUrl: 'https://mcp.example.com/mcp' },
        'https://worldmonitor.app',
        { extra: { 'cf-connecting-ip': ip, 'x-wm-edge-proof': 'edge-secret-xyz' } },
      ));
      assert.equal(res.status, 200, 'rate-limit must fail-open on Redis error');
    });

    it('uses cf-connecting-ip for scoped limiter only when Cloudflare proof is valid', async () => {
      process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
      process.env.UPSTASH_REDIS_REST_TOKEN = 'fake_token';
      process.env.CF_EDGE_PROOF_SECRET = 'edge-secret-xyz';
      const ip = uniqueCallerIp();
      const redisBodies = [];

      globalThis.fetch = async (url, opts) => {
        const u = url.toString();
        if (u.includes('fake.upstash.io')) {
          redisBodies.push(String(opts?.body ?? ''));
          return new Response(
            JSON.stringify([{ result: [29, 30] }]),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return makeMcpFetch({ tools: [] })(url, opts);
      };

      const res = await handler(makeGetRequest(
        { serverUrl: 'https://mcp.example.com/mcp' },
        'https://worldmonitor.app',
        { extra: { 'cf-connecting-ip': ip, 'x-wm-edge-proof': 'edge-secret-xyz' } },
      ));
      assert.equal(res.status, 200);
      assert.ok(redisBodies.some((body) => body.includes(`/api/mcp-proxy:${ip}`)), 'scoped limiter key should include the proofed CF client IP');
    });

    it('does not let missing Cloudflare proof rotate the MCP proxy scoped limiter key', async () => {
      process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
      process.env.UPSTASH_REDIS_REST_TOKEN = 'fake_token';
      process.env.CF_EDGE_PROOF_SECRET = 'edge-secret-xyz';
      const spoofedIp = uniqueCallerIp();
      const redisBodies = [];

      globalThis.fetch = async (url, opts) => {
        const u = url.toString();
        if (u.includes('fake.upstash.io')) {
          redisBodies.push(String(opts?.body ?? ''));
          return new Response(
            JSON.stringify([{ result: [29, 30] }]),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return makeMcpFetch({ tools: [] })(url, opts);
      };

      const res = await handler(makeGetRequest(
        { serverUrl: 'https://mcp.example.com/mcp' },
        'https://worldmonitor.app',
        { extra: { 'cf-connecting-ip': spoofedIp, 'x-real-ip': '192.0.2.5' } },
      ));
      assert.equal(res.status, 200);
      assert.ok(redisBodies.some((body) => body.includes('/api/mcp-proxy:192.0.2.5')), 'scoped limiter should fall back to x-real-ip without proof');
      assert.ok(!redisBodies.some((body) => body.includes(`/api/mcp-proxy:${spoofedIp}`)), 'spoofed cf-connecting-ip must not reach the scoped limiter key without proof');
    });
  });

  describe('Audit log (#3805)', () => {
    let logSpy;
    const originalLog = console.log;

    beforeEach(() => {
      logSpy = [];
      console.log = (...args) => { logSpy.push(args); };
    });

    afterEach(() => {
      console.log = originalLog;
    });

    function findProxyLog() {
      return logSpy.find((a) => a[0] === '[mcp-proxy]');
    }

    it('emits a structured audit log line on a successful GET', async () => {
      globalThis.fetch = makeMcpFetch({ tools: [] });
      const res = await handler(makeGetRequest(
        { serverUrl: 'https://mcp.example.com/mcp' },
        'https://worldmonitor.app',
        { extra: { 'cf-connecting-ip': uniqueCallerIp() } },
      ));
      assert.equal(res.status, 200);

      const log = findProxyLog();
      assert.ok(log, 'expected an [mcp-proxy] audit log line');
      const entry = log[1];
      assert.equal(entry.event, 'mcp_proxy_call');
      assert.equal(entry.target_host, 'mcp.example.com');
      assert.equal(entry.target_path, '/mcp');
      assert.equal(entry.method, 'GET');
      assert.equal(entry.status, 200);
      assert.ok(typeof entry.duration_ms === 'number');
      assert.ok(typeof entry.ts === 'string');
      assert.ok(Array.isArray(entry.header_names));
    });

    it('audit log contains header NAMES but never header VALUES (no secret leakage)', async () => {
      globalThis.fetch = makeMcpFetch({ tools: [] });
      const res = await handler(makeGetRequest(
        {
          serverUrl: 'https://mcp.example.com/mcp',
          headers: JSON.stringify({ Authorization: 'Bearer super-secret-token-XYZ', 'X-Api-Key': 'k_abc123' }),
        },
        'https://worldmonitor.app',
        { extra: { 'cf-connecting-ip': uniqueCallerIp() } },
      ));
      assert.equal(res.status, 200);

      const log = findProxyLog();
      assert.ok(log, 'expected an [mcp-proxy] audit log line');
      const entry = log[1];
      assert.deepEqual(entry.header_names.sort(), ['Authorization', 'X-Api-Key'].sort());

      // CRITICAL: the entire serialized log line must NOT contain the
      // secret values that the proxy intentionally forwards upstream.
      const serialized = JSON.stringify(log);
      assert.ok(!serialized.includes('super-secret-token-XYZ'), 'audit log MUST NOT contain Authorization value');
      assert.ok(!serialized.includes('k_abc123'), 'audit log MUST NOT contain X-Api-Key value');
      assert.ok(!serialized.includes('Bearer '), 'audit log MUST NOT contain Bearer prefix from a real header value');
    });

    it('audit log target_path does NOT include the query string (query may carry tokens)', async () => {
      globalThis.fetch = makeMcpFetch({ tools: [] });
      // Some MCP servers accept ?token=... in the URL — make sure that
      // never lands in the structured log.
      const res = await handler(makeGetRequest(
        { serverUrl: 'https://mcp.example.com/mcp?token=querystring-secret-ABCDEF' },
        'https://worldmonitor.app',
        { extra: { 'cf-connecting-ip': uniqueCallerIp() } },
      ));
      assert.equal(res.status, 200);

      const log = findProxyLog();
      assert.ok(log);
      const entry = log[1];
      assert.equal(entry.target_path, '/mcp', 'target_path must be pathname only');
      const serialized = JSON.stringify(log);
      assert.ok(!serialized.includes('querystring-secret-ABCDEF'), 'audit log MUST NOT capture query string secrets');
    });

    it('emits audit log with status: 429 on a rate-limit block', async () => {
      const savedRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
      const savedRedisTok = process.env.UPSTASH_REDIS_REST_TOKEN;
      const savedCfProofSecret = process.env.CF_EDGE_PROOF_SECRET;
      process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
      process.env.UPSTASH_REDIS_REST_TOKEN = 'fake_token';
      process.env.CF_EDGE_PROOF_SECRET = 'edge-secret-xyz';
      try {
        globalThis.fetch = async (url) => {
          const u = url.toString();
          if (u.includes('fake.upstash.io')) {
            return new Response(
              JSON.stringify([{ result: [-1, 30] }]),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          return new Response('{}', { status: 200 });
        };
        const res = await handler(makeGetRequest(
          { serverUrl: 'https://mcp.example.com/mcp' },
          'https://worldmonitor.app',
          { extra: { 'cf-connecting-ip': uniqueCallerIp(), 'x-wm-edge-proof': 'edge-secret-xyz' } },
        ));
        assert.equal(res.status, 429);
        const log = findProxyLog();
        assert.ok(log, 'must emit audit log on rate-limit block');
        assert.equal(log[1].status, 429);
        assert.equal(log[1].event, 'mcp_proxy_call');
      } finally {
        if (savedRedisUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
        else process.env.UPSTASH_REDIS_REST_URL = savedRedisUrl;
        if (savedRedisTok === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
        else process.env.UPSTASH_REDIS_REST_TOKEN = savedRedisTok;
        if (savedCfProofSecret === undefined) delete process.env.CF_EDGE_PROOF_SECRET;
        else process.env.CF_EDGE_PROOF_SECRET = savedCfProofSecret;
      }
    });

    it('emits audit log on validation failure (status: 400)', async () => {
      const res = await handler(makeGetRequest(
        { serverUrl: 'https://localhost/mcp' },
        'https://worldmonitor.app',
        { extra: { 'cf-connecting-ip': uniqueCallerIp(), 'x-real-ip': uniqueCallerIp() } },
      ));
      assert.equal(res.status, 400);
      const log = findProxyLog();
      assert.ok(log, 'must emit audit log even when SSRF validation rejects the URL');
      assert.equal(log[1].status, 400);
    });

    // TODO: rate-limit window-reset behavior is intentionally NOT tested —
    // it requires either real Redis or fake-time mocking of
    // @upstash/ratelimit's internal sliding-window math, which isn't worth
    // the test infrastructure cost. The 60s window is configured via the
    // RATE_LIMIT_WINDOW constant; the Upstash library handles expiry.
  });
});

// ---------------------------------------------------------------------------
// Observability. Before this, `/api/mcp-proxy` was invisible to BOTH first-party
// systems: `logProxyCall` is console.log (Vercel runtime logs are a live tail
// with no historical query), so the route had zero rows in Axiom `wm_api_usage`
// and its failure rate could not be asked about after the fact; and the
// top-level catch turned every handler fault into a 422/504 with no Sentry
// event. A 2026-09-03 triage could not measure a 3h production incident on this
// endpoint for exactly that reason.
//
// Axiom emission is driven behaviourally — `isUsageEnabled()` and the ingest
// token are both read at CALL time, so a per-test env flip is enough. The Sentry
// capture is pinned from source text instead: `_sentry-common.js` parses its DSN
// in a module-load IIFE, so enabling delivery would mean setting the DSN for the
// whole file and every existing test's fetch stub would start seeing envelope
// POSTs it does not expect. Same lever tests/rate-limit.test.mts uses.
// ---------------------------------------------------------------------------
describe('api/mcp-proxy — observability', () => {
  let obsHandler;
  const ORIGINAL_USAGE = process.env.USAGE_TELEMETRY;
  const ORIGINAL_AXIOM = process.env.AXIOM_API_TOKEN;

  beforeEach(async () => {
    process.env.USAGE_TELEMETRY = '1';
    process.env.AXIOM_API_TOKEN = 'test-axiom-token-not-a-real-secret';
    const mod = await import(`../api/mcp-proxy.ts?obs=${Date.now()}`);
    obsHandler = mod.default;
    setResolvedAddresses([PUBLIC_TEST_ADDRESS]);
  });

  afterEach(() => {
    if (ORIGINAL_USAGE === undefined) delete process.env.USAGE_TELEMETRY;
    else process.env.USAGE_TELEMETRY = ORIGINAL_USAGE;
    if (ORIGINAL_AXIOM === undefined) delete process.env.AXIOM_API_TOKEN;
    else process.env.AXIOM_API_TOKEN = ORIGINAL_AXIOM;
    globalThis.fetch = originalFetch;
  });

  /** Collect ctx.waitUntil promises so the test can await delivery. */
  function collectingCtx() {
    const pending = [];
    return { ctx: { waitUntil: (p) => pending.push(p) }, pending };
  }

  /** Intercept the Axiom ingest POST and return the rows it carried. */
  function stubAxiom(upstreamFetch = async () => new Response('{}', { status: 200 })) {
    const rows = [];
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('api.axiom.co')) {
        rows.push(...JSON.parse(init.body));
        return new Response('{}', { status: 200 });
      }
      return upstreamFetch(input, init);
    };
    return rows;
  }

  it('emits a wm_api_usage row for a rejected unauthenticated call', async () => {
    const rows = stubAxiom();
    const { ctx, pending } = collectingCtx();
    const res = await obsHandler(
      makeGetRequest({ serverUrl: 'https://mcp.example.com/mcp' }, 'https://worldmonitor.app', { authed: false }),
      ctx,
    );
    assert.equal(res.status, 401);
    await Promise.all(pending);
    assert.equal(rows.length, 1, 'exactly one usage row per proxied call');
    assert.equal(rows[0].route, '/api/mcp-proxy', 'route must be queryable by name');
    assert.equal(rows[0].status, 401);
    assert.equal(rows[0].reason, 'auth_401');
    assert.equal(rows[0].event_type, 'request');
    assert.equal(rows[0].domain, 'mcp', 'joins with the /mcp surface');
  });

  it('labels a disallowed origin as origin_403, not a generic failure', async () => {
    const rows = stubAxiom();
    const { ctx, pending } = collectingCtx();
    const res = await obsHandler(
      makeGetRequest({ serverUrl: 'https://mcp.example.com/mcp' }, 'https://evil.example.com', { authed: false }),
      ctx,
    );
    assert.equal(res.status, 403);
    await Promise.all(pending);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 403);
    assert.equal(rows[0].reason, 'origin_403');
  });

  it('does NOT emit for an OPTIONS preflight (a static 204 carries no signal)', async () => {
    const rows = stubAxiom();
    const { ctx, pending } = collectingCtx();
    const res = await obsHandler(makeOptionsRequest(), ctx);
    assert.equal(res.status, 204);
    await Promise.all(pending);
    assert.equal(rows.length, 0, 'preflights must not double the row volume');
  });

  it('emits nothing and still answers when the runtime passes no ctx', async () => {
    const rows = stubAxiom();
    const res = await obsHandler(
      makeGetRequest({ serverUrl: 'https://mcp.example.com/mcp' }, 'https://worldmonitor.app', { authed: false }),
    );
    assert.equal(res.status, 401, 'telemetry must never change the caller outcome');
    assert.equal(rows.length, 0, 'no ctx means no waitUntil to hang delivery on');
  });

  it('attributes an authenticated enterprise request instead of reporting anonymous traffic', async () => {
    const rows = stubAxiom(makeMcpFetch({ tools: [] }));
    const { ctx, pending } = collectingCtx();
    const res = await obsHandler(
      makeGetRequest({ serverUrl: 'https://mcp.example.com/mcp' }),
      ctx,
    );
    assert.equal(res.status, 200);
    await Promise.all(pending);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].auth_kind, 'enterprise_api_key');
    assert.equal(rows[0].customer_id, 'enterprise-unmapped');
    assert.equal(rows[0].plan_key, 'enterprise');
    assert.ok(rows[0].principal_id, 'enterprise key must have a hashed principal');
    assert.notEqual(rows[0].principal_id, ENTERPRISE_KEY, 'raw enterprise key must never enter telemetry');
  });

  it('maps each premium caller identity onto the shared usage identity contract', async () => {
    const { proxyUsageIdentityFor } = await import(`../api/mcp-proxy.ts?identity=${Date.now()}`);
    const request = makeGetRequest({ serverUrl: 'https://mcp.example.com/mcp' });

    assert.deepEqual(
      proxyUsageIdentityFor(request, { isPremium: true, userId: 'user_bearer', kind: 'bearer' }),
      {
        auth_kind: 'clerk_jwt',
        principal_id: 'user_bearer',
        customer_id: 'user_bearer',
        tier: 0,
        plan_key: null,
      },
    );
    assert.deepEqual(
      proxyUsageIdentityFor(request, { isPremium: true, userId: 'user_key', kind: 'user-api-key' }),
      {
        auth_kind: 'user_api_key',
        principal_id: 'user_key',
        customer_id: 'user_key',
        tier: 0,
        plan_key: null,
      },
    );
    assert.deepEqual(
      proxyUsageIdentityFor(request, { isPremium: true, userId: 'user_mcp', kind: 'internal-mcp' }),
      {
        auth_kind: 'mcp_oauth',
        principal_id: 'user_mcp',
        customer_id: 'user_mcp',
        tier: 0,
        plan_key: null,
      },
    );
  });

  it('downgrades expected upstream failures but keeps proxy defects at error level', async () => {
    const { McpProxyUpstreamError, proxyFailureFor } = await import(
      `../api/mcp-proxy.ts?failure=${Date.now()}`
    );

    assert.deepEqual(
      proxyFailureFor(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
      { isTimeout: true, level: 'warning' },
    );
    assert.deepEqual(
      proxyFailureFor(new McpProxyUpstreamError('Initialize failed: HTTP 401')),
      { isTimeout: false, level: 'warning' },
    );
    assert.deepEqual(
      proxyFailureFor(new Error('unexpected local invariant failure')),
      { isTimeout: false, level: 'error' },
    );
  });

  // Every value below must be a member of the RequestReason union in
  // server/_shared/usage.ts. api/mcp-proxy.ts is `@ts-nocheck`, so tsc will
  // NOT catch a typo against that union — a misspelled reason would ship a row
  // no Axiom query can ever match, which is the exact class of silent blindness
  // this whole change exists to remove.
  it('maps every terminal status onto a real RequestReason member', async () => {
    const mod = await import(`../api/mcp-proxy.ts?reason=${Date.now()}`);
    const { proxyReasonFor } = mod;
    assert.equal(proxyReasonFor(403), 'origin_403');
    assert.equal(proxyReasonFor(401), 'auth_401');
    assert.equal(proxyReasonFor(429), 'rate_limit_429');
    assert.equal(proxyReasonFor(405), 'method_not_allowed');
    assert.equal(proxyReasonFor(400), 'malformed_request');
    assert.equal(proxyReasonFor(413), 'malformed_request');
    // Reaching its natural outcome is 'ok' even when the upstream failed —
    // gateway convention (server/gateway.ts:2359,2395,2408). The status column
    // carries the failure; inventing a reason label would break that join.
    assert.equal(proxyReasonFor(200), 'ok');
    assert.equal(proxyReasonFor(504), 'ok');
    assert.equal(proxyReasonFor(422), 'ok');
  });

  it('the top-level catch reports to Sentry with the classified failure level', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../api/mcp-proxy.ts', import.meta.url), 'utf8');

    const catchAt = src.indexOf('const failure = proxyFailureFor(err);');
    assert.ok(catchAt > 0, 'the top-level catch still classifies failures');
    const tail = src.slice(catchAt, src.indexOf('logProxyCall({', catchAt));

    assert.match(tail, /captureSilentError\(err,/, 'a swallowed handler fault must not be silent');
    assert.match(tail, /step:\s*'proxy-dispatch'/);
    assert.match(
      tail,
      /level:\s*failure\.level/,
      'expected upstream failures are warnings while proxy defects remain errors',
    );
    // targetHost is caller-supplied. As a Sentry TAG it would let any caller
    // mint unbounded tag values; it belongs in extra.
    assert.match(tail, /extra:\s*\{[^}]*target_host/, 'target_host rides in extra');
    assert.doesNotMatch(
      tail.slice(tail.indexOf('tags:'), tail.indexOf('extra:')),
      /target_host/,
      'target_host must never become a Sentry tag',
    );
  });
});
