// U7 — always-free tool subset (R7, R9, R15).
//
// This unit deliberately narrows an invariant the server previously held:
// "everything that returns DATA requires credentials". The guards below are
// the ones that keep the narrowing honest:
//
//   - the roster is a single source (the registry's own `_freeTier` flag), so
//     the advertisement and the authorisation cannot drift;
//   - a `free` principal reaching a NON-free tool is refused in dispatch, not
//     just in the handler, so the promotion and the authorisation are not the
//     same line of code;
//   - a free-tier tool must reach no credentialed downstream, because a `free`
//     context has nothing honest to sign;
//   - the free-tier ceiling fails CLOSED, unlike the discovery limiter beside
//     it whose fail-open is justified only by carrying no data.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Ratelimit } from '@upstash/ratelimit';

import { TOOL_REGISTRY, TOOL_LIST_RESPONSE } from '../api/mcp/registry/index.ts';
import { buildAuthHeaders } from '../api/mcp/auth.ts';
import { setUsageContext, createMcpUsage } from '../api/mcp/usage.ts';
import { principalIdForLog } from '../api/mcp/telemetry.ts';
import { dispatchToolsCall } from '../api/mcp/dispatch.ts';
import { mcpHandler } from '../api/mcp/handler.ts';

const freeTools = TOOL_REGISTRY.filter((t) => t._freeTier === true);
const ORIGINAL_SLIDING_WINDOW = Ratelimit.slidingWindow;
let limiterImportNonce = 0;

async function withFreeTierLimiterStub({ success = true, throws = false, reason }, fn) {
  const savedUrl = process.env.UPSTASH_REDIS_REST_URL;
  const savedToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const calls = [];
  process.env.UPSTASH_REDIS_REST_URL = 'https://stub.upstash.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'stub-token';
  Ratelimit.slidingWindow = (tokens, window) => () => ({
    async limit(_ctx, key) {
      calls.push({ key, tokens, window });
      if (throws) throw new Error('upstash unreachable');
      return {
        success,
        ...(reason === undefined ? {} : { reason }),
        limit: tokens,
        remaining: success ? tokens - 1 : 0,
        reset: Date.now() + 60_000,
        pending: Promise.resolve(),
      };
    },
  });
  try {
    limiterImportNonce += 1;
    const mod = await import(`../api/mcp/auth.ts?free-tier=${limiterImportNonce}-${Date.now()}`);
    return await fn(mod, calls);
  } finally {
    Ratelimit.slidingWindow = ORIGINAL_SLIDING_WINDOW;
    if (savedUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = savedUrl;
    if (savedToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = savedToken;
  }
}

describe('free-tier roster', () => {
  it('is non-empty and declared on the registry entries themselves', () => {
    assert.ok(freeTools.length > 0, 'at least one tool must be free-tier');
    assert.ok(freeTools.some((t) => t.name === 'get_sources'));
  });

  it('reaches no credentialed downstream — every free tool declares no API path', () => {
    // A free-tier tool runs with a `free` context that cannot sign. Declaring
    // an _apiPaths entry means it fetches a gated endpoint, which would throw
    // at runtime for exactly the callers this tier exists to serve.
    for (const t of freeTools) {
      assert.deepEqual(
        t._apiPaths ?? [],
        [],
        `${t.name} is free-tier but declares a downstream API path`,
      );
    }
  });

  it('advertises the full access class while preserving free for anonymous tools', () => {
    for (const tool of TOOL_LIST_RESPONSE) {
      const internal = TOOL_REGISTRY.find((candidate) => candidate.name === tool.name);
      assert.ok(internal, `${tool.name} must exist in the registry`);
      const marker = tool._meta?.['worldmonitor/access'];
      const expected = internal._freeTier === true
        ? 'free'
        : internal._execute === undefined || internal.name === 'describe_tool'
          ? 'free-account'
          : 'subscription';
      assert.equal(marker, expected, `${tool.name} must advertise ${expected} access`);
    }
  });

  it('derives the advertisement from the same flag the server authorises on', () => {
    // Not two lists: the wire marker and the roster must be the same source.
    const advertised = TOOL_LIST_RESPONSE
      .filter((t) => t._meta?.['worldmonitor/access'] === 'free')
      .map((t) => t.name)
      .sort();
    assert.deepEqual(advertised, freeTools.map((t) => t.name).sort());
  });
});

describe('free principal — credential handling', () => {
  it('refuses to sign: buildAuthHeaders throws rather than minting a signature', async () => {
    await assert.rejects(
      () => buildAuthHeaders({ kind: 'free' }, 'GET', 'https://example.test/api/x', null),
      /free-tier context has no credentials/,
      'a free context must never be HMAC-signed as pro',
    );
  });

  it('reports as anonymous in usage telemetry, never as enterprise', () => {
    const usage = createMcpUsage();
    setUsageContext(usage, { kind: 'free' });
    assert.equal(usage.authKind, 'anon', 'free traffic must not be labelled enterprise_api_key');
    assert.equal(usage.customerId, null);
    assert.equal(usage.principalId, null);
  });

  it('logs no phantom principal', () => {
    assert.equal(principalIdForLog({ kind: 'free' }), 'anon');
  });
});

describe('dispatch refuses a free principal on a gated tool', () => {
  const call = (toolName) => dispatchToolsCall(
    new Request('https://worldmonitor.app/mcp', { method: 'POST' }),
    { kind: 'free' },
    { redisPipeline: async () => { throw new Error('quota must not be reached'); } },
    { id: 1, params: { name: toolName, arguments: {} } },
    {},
  );

  it('serves a tool that IS on the roster', async () => {
    const res = await call('get_sources');
    const body = await res.json();
    assert.ok(!body.error, `get_sources must be servable to a free caller: ${JSON.stringify(body.error)}`);
  });

  for (const context of [
    { kind: 'pro', userId: 'user_pro', mcpTokenId: 'token_pro' },
    { kind: 'user_key', userId: 'user_key_owner', apiKey: `wm_${'ab12'.repeat(10)}` },
  ]) {
    it(`does not reserve daily quota for a free-tier tool used by ${context.kind}`, async () => {
      let quotaCalls = 0;
      const res = await dispatchToolsCall(
        new Request('https://worldmonitor.app/mcp', { method: 'POST' }),
        context,
        {
          redisPipeline: async () => {
            quotaCalls += 1;
            throw new Error('free-tier tools must not reach daily quota');
          },
        },
        { id: 71, params: { name: 'get_sources', arguments: {} } },
        {},
      );
      const body = await res.json();
      assert.equal(body.error, undefined, JSON.stringify(body.error));
      assert.equal(body.id, 71);
      assert.equal(quotaCalls, 0, 'free-tier tools are quota-exempt for credentialed callers too');
    });
  }

  it('refuses a gated tool even though the caller reached dispatch', async () => {
    // The handler only mints a `free` context after matching `_freeTier`, so
    // this state should be unreachable — which is exactly why it is guarded.
    // If the handler's matching is ever widened by mistake, this is the layer
    // that stops an anonymous caller reading gated data for free.
    const res = await call('get_conflict_events');
    const body = await res.json();
    assert.ok(body.error, 'a gated tool must not be served to a free principal');
    assert.equal(body.error.code, -32001);
  });

  it('refuses every non-roster tool, not just the sampled one', async () => {
    const gated = TOOL_REGISTRY.filter((t) => t._freeTier !== true).slice(0, 12);
    for (const t of gated) {
      const res = await call(t.name);
      const body = await res.json();
      assert.ok(body.error, `${t.name} must be refused for a free principal`);
    }
  });
});

describe('free-tier ceiling fails closed', () => {
  const req = new Request('https://worldmonitor.app/mcp', {
    method: 'POST',
    headers: { 'x-forwarded-for': '203.0.113.7' },
  });

  it('allows a verified under-limit decision and uses the trusted per-IP key', async () => {
    await withFreeTierLimiterStub({ success: true }, async (auth, calls) => {
      const res = await auth.applyFreeTierLimit(req, {}, 71);
      assert.equal(res, null);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0], {
        key: 'rl:mcp:free:ip:unknown',
        tokens: 10,
        window: '60 s',
      });
    });
  });

  it('fails closed when Cloudflare client identity arrives without transit proof', async () => {
    const savedProof = process.env.CF_EDGE_PROOF_SECRET;
    delete process.env.CF_EDGE_PROOF_SECRET;
    const originalConsoleError = console.error;
    const logLines = [];
    console.error = (...args) => logLines.push(args.join(' '));
    try {
      await withFreeTierLimiterStub({ success: true }, async (auth, calls) => {
        const request = () => new Request('https://worldmonitor.app/mcp', {
          headers: {
            'cf-connecting-ip': '203.0.113.9',
            'x-real-ip': '104.16.0.1',
          },
        });
        const res = await auth.applyFreeTierLimit(request(), {}, 76);
        assert.equal(res?.status, 503);
        assert.equal(res.headers.get('X-RateLimit-Mode'), 'degraded');
        const body = await res.json();
        assert.equal(body.id, 76);
        assert.equal(body.error?.code, -32603);
        assert.equal((await auth.applyFreeTierLimit(request(), {}, 77))?.status, 503);
        assert.equal(calls.length, 0, 'a shared Cloudflare-PoP bucket must never be consumed');
        assert.equal(
          logLines.filter((line) => line.includes('mcpFreeTierRateLimit:edge-proof')).length,
          1,
          'caller-controlled proof failures must not amplify provider logs',
        );
      });
    } finally {
      console.error = originalConsoleError;
      if (savedProof === undefined) delete process.env.CF_EDGE_PROOF_SECRET;
      else process.env.CF_EDGE_PROOF_SECRET = savedProof;
    }
  });

  it('uses the proven Cloudflare client IP when the edge proof matches', async () => {
    const savedProof = process.env.CF_EDGE_PROOF_SECRET;
    process.env.CF_EDGE_PROOF_SECRET = 'free-tier-edge-proof';
    try {
      await withFreeTierLimiterStub({ success: true }, async (auth, calls) => {
        const res = await auth.applyFreeTierLimit(new Request('https://worldmonitor.app/mcp', {
          headers: {
            'cf-connecting-ip': '203.0.113.10',
            'x-real-ip': '104.16.0.1',
            'x-wm-edge-proof': 'free-tier-edge-proof',
          },
        }), {}, 77);
        assert.equal(res, null);
        assert.equal(calls[0]?.key, 'rl:mcp:free:ip:203.0.113.10');
      });
    } finally {
      if (savedProof === undefined) delete process.env.CF_EDGE_PROOF_SECRET;
      else process.env.CF_EDGE_PROOF_SECRET = savedProof;
    }
  });

  it('returns a correlated degraded 503 when no limiter is configured', async () => {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    try {
      const res = await mcpHandler(new Request('https://worldmonitor.app/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 72,
          method: 'tools/call',
          params: { name: 'get_sources', arguments: {} },
        }),
      }));
      assert.ok(res, 'an unconfigured limiter must refuse, not return null');
      assert.equal(res.status, 503);
      assert.equal(res.headers.get('X-RateLimit-Mode'), 'degraded');
      assert.equal(res.headers.get('Retry-After'), '5');
      const body = await res.json();
      assert.equal(body.id, 72, 'limiter denials must preserve the request JSON-RPC id');
      assert.equal(body.error.code, -32603);
      assert.match(body.error.message, /temporarily unavailable/i);
    } finally {
      if (url) process.env.UPSTASH_REDIS_REST_URL = url;
      if (token) process.env.UPSTASH_REDIS_REST_TOKEN = token;
    }
  });

  it('returns a correlated 429 only for a real exhausted bucket', async () => {
    await withFreeTierLimiterStub({ success: false }, async (auth, calls) => {
      const res = await auth.applyFreeTierLimit(req, {}, 'free-limit-73');
      assert.equal(res?.status, 429);
      assert.equal(res.headers.get('X-RateLimit-Mode'), null);
      assert.ok(Number(res.headers.get('Retry-After')) >= 1);
      const body = await res.json();
      assert.equal(body.id, 'free-limit-73');
      assert.equal(body.error?.code, -32029);
      assert.match(body.error?.message ?? '', /Free-tier rate limit/);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].tokens, 10);
      assert.equal(calls[0].window, '60 s');
    });
  });

  it('returns a correlated degraded 503 when the limiter throws', async () => {
    await withFreeTierLimiterStub({ throws: true }, async (auth, calls) => {
      const res = await auth.applyFreeTierLimit(req, {}, 74);
      assert.equal(res?.status, 503);
      assert.equal(res.headers.get('X-RateLimit-Mode'), 'degraded');
      assert.equal(res.headers.get('Retry-After'), '5');
      const body = await res.json();
      assert.equal(body.id, 74);
      assert.equal(body.error?.code, -32603);
      assert.match(body.error?.message ?? '', /temporarily unavailable/i);
      assert.equal(calls.length, 1);
    });
  });

  it('returns a correlated degraded 503 when Upstash resolves a timeout', async () => {
    await withFreeTierLimiterStub({ reason: 'timeout' }, async (auth, calls) => {
      const res = await auth.applyFreeTierLimit(req, {}, 75);
      assert.equal(res?.status, 503);
      assert.equal(res.headers.get('X-RateLimit-Mode'), 'degraded');
      assert.equal(res.headers.get('Retry-After'), '5');
      const body = await res.json();
      assert.equal(body.id, 75);
      assert.equal(body.error?.code, -32603);
      assert.match(body.error?.message ?? '', /temporarily unavailable/i);
      assert.equal(calls.length, 1);
    });
  });

  it('classifies a limiter outage separately from an exhausted bucket in usage telemetry', async () => {
    const { mcpReasonFor } = await import('../api/mcp/usage.ts');
    assert.equal(mcpReasonFor('limit', 429), 'rate_limit_429');
    assert.equal(mcpReasonFor('limit', 503), 'rate_limit_degraded');
  });

  it('is a tighter budget than the 60/min discovery limiter it sits beside', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../api/mcp/auth.ts', import.meta.url), 'utf8'));
    const match = source.match(/FREE_TIER_LIMIT_PER_MINUTE\s*=\s*(\d+)/);
    assert.ok(match, 'the free-tier budget must be a named constant');
    assert.ok(Number(match[1]) < 60, 'free data calls must be bounded tighter than metadata discovery');
  });
});
