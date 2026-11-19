/**
 * Gateway-level tests for POST /api/feedback/v1/submit-report (#8721).
 *
 * Agents without a key are the reporters we most want, so the route is
 * public-no-auth (threat model Decision 1). These drive the real edge entry:
 * body cap, gateway, generated validator, handler, shared admission, and the
 * Convex call, with Redis and Convex faked at the fetch boundary.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { installRedis } from './helpers/fake-upstash-redis.mts';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const URL_ = 'https://api.worldmonitor.app/api/feedback/v1/submit-report';
const CONVEX = 'https://synthetic.convex.site';

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

type ConvexCall = { path: string; body: Record<string, unknown> };

async function load() {
  const [{ default: entry }, { PUBLIC_NO_AUTH_RPC_PATHS }, { PREMIUM_RPC_PATHS }] = await Promise.all([
    import('../api/feedback/v1/[rpc].ts'),
    import('../server/gateway.ts'),
    import('../src/shared/premium-paths.ts'),
  ]);
  delete process.env.WORLDMONITOR_VALID_KEYS;
  process.env.USAGE_UA_PEPPER = 'synthetic-pepper';
  process.env.CONVEX_SITE_URL = CONVEX;
  process.env.CONVEX_SERVER_SHARED_SECRET = 'synthetic-secret';
  const redis = installRedis({});
  const convexCalls: ConvexCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(CONVEX)) {
      const path = new URL(url).pathname;
      convexCalls.push({ path, body: JSON.parse(String(init?.body)) });
      if (path === '/api/internal-find-feedback-retry') return Response.json({ found: null });
      return Response.json({ reportId: 'report_1', status: 'received', retried: false });
    }
    return redis.fetchImpl(input, init);
  }) as typeof fetch;
  return { entry, PUBLIC_NO_AUTH_RPC_PATHS, PREMIUM_RPC_PATHS, convexCalls };
}

function post(body: string, headers: Record<string, string> = {}) {
  return new Request(URL_, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-real-ip': '203.0.113.7', 'User-Agent': 'agent/1.0', ...headers },
    body,
  });
}

const valid = { kind: 'bug', surface: 'get_market_data', summary: 'Quotes are empty for AAPL' };

describe('feedback gateway public access', { concurrency: 1 }, () => {
  it('is public-no-auth and not premium', async () => {
    const { PUBLIC_NO_AUTH_RPC_PATHS, PREMIUM_RPC_PATHS } = await load();
    assert.equal(PUBLIC_NO_AUTH_RPC_PATHS.has('/api/feedback/v1/submit-report'), true);
    assert.equal(PREMIUM_RPC_PATHS.has('/api/feedback/v1/submit-report'), false);
  });

  it('stores an anonymous report and returns its id', async () => {
    const { entry, convexCalls } = await load();
    const res = await entry(post(JSON.stringify(valid)));
    const text = await res.text();
    assert.equal(res.status, 200, text);
    assert.deepEqual(JSON.parse(text), { reportId: 'report_1', status: 'received', advisoryUrl: '', notice: '' });
    assert.deepEqual(convexCalls.map((c) => c.path), ['/api/internal-find-feedback-retry', '/api/internal-submit-feedback']);
  });

  it('ignores identity fields in the body: REST callers are always anonymous', async () => {
    const { entry, convexCalls } = await load();
    const res = await entry(post(JSON.stringify({ ...valid, principalId: 'user_victim', authKind: 'keyed' }), {
      'X-WorldMonitor-Key': 'wm_not_a_real_key_000000',
    }));
    assert.equal(res.status, 200, await res.text());
    const stored = convexCalls[1]!.body;
    assert.equal(stored.authKind, 'anonymous');
    assert.equal(stored.principalId, undefined);
    assert.match(String(stored.reporterKey), /^ip:[0-9a-f]{64}$/);
  });

  it('rejects a body over 24 KB with 413 before any work, with or without Content-Length', async () => {
    const { entry, convexCalls } = await load();
    const big = JSON.stringify({ ...valid, actual: 'x'.repeat(25 * 1024) });
    const declared = await entry(post(big));
    assert.equal(declared.status, 413);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big));
        controller.close();
      },
    });
    const undeclared = new Request(URL_, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-real-ip': '203.0.113.7' },
      body: stream,
      // @ts-expect-error Node requires duplex for a streamed request body.
      duplex: 'half',
    });
    assert.equal(undeclared.headers.get('content-length'), null);
    assert.equal((await entry(undeclared)).status, 413);
    assert.equal(convexCalls.length, 0);
  });

  it('gives a browser caller CORS headers on the 413', async () => {
    const { entry } = await load();
    const big = JSON.stringify({ ...valid, actual: 'x'.repeat(25 * 1024) });
    const res = await entry(post(big, { Origin: 'https://www.worldmonitor.app' }));
    assert.equal(res.status, 413);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://www.worldmonitor.app');
  });

  it('answers a body that fails mid-read with 400, not an unhandled 500', async () => {
    const { entry, convexCalls } = await load();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"kind":'));
        controller.error(new Error('client aborted'));
      },
    });
    const aborted = new Request(URL_, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-real-ip': '203.0.113.7' },
      body: stream,
      // @ts-expect-error Node requires duplex for a streamed request body.
      duplex: 'half',
    });
    const res = await entry(aborted);
    assert.equal(res.status, 400);
    assert.equal(convexCalls.length, 0);
  });

  it('accepts the largest valid CJK report under the cap', async () => {
    const { entry } = await load();
    const res = await entry(post(JSON.stringify({
      kind: 'data_quality',
      summary: '界'.repeat(300),
      expected: '界'.repeat(2000),
      actual: '界'.repeat(2000),
    })));
    assert.equal(res.status, 200, await res.text());
  });

  it('names the invalid field with 400 and does not store', async () => {
    const { entry, convexCalls } = await load();
    const res = await entry(post(JSON.stringify({ ...valid, kind: 'praise' })));
    assert.equal(res.status, 400);
    assert.match(await res.text(), /kind/);
    assert.equal(convexCalls.length, 0);
  });

  it('a security report that fails with 503 still carries the advisory URL', async () => {
    const { entry } = await load();
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith('/api/internal-submit-feedback')) return new Response('down', { status: 500 });
      return inner(input, init);
    }) as typeof fetch;
    const res = await entry(post(JSON.stringify({ ...valid, kind: 'security' })));
    assert.equal(res.status, 503);
    const text = await res.text();
    assert.ok(text.includes('https://github.com/koala73/worldmonitor/security/advisories/new'), text);
  });

  it('a security report response carries the advisory URL', async () => {
    const { entry } = await load();
    const res = await entry(post(JSON.stringify({ ...valid, kind: 'security' })));
    const body = await res.json() as { advisoryUrl?: string; notice?: string };
    assert.equal(body.advisoryUrl, 'https://github.com/koala73/worldmonitor/security/advisories/new');
    assert.match(body.notice ?? '', /exploit details/);
  });
});
