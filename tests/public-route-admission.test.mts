// Anonymous and token-gated standalone routes charge their limit before any
// Redis read, origin fetch or render, and a refusal is never CDN-cacheable.
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const REDIS = 'https://redis.test';
const ENV = {
  UPSTASH_REDIS_REST_URL: REDIS,
  UPSTASH_REDIS_REST_TOKEN: 'tok',
  BRIEF_URL_SIGNING_SECRET: 'brief-secret',
  MCP_PRO_GRANT_HMAC_SECRET: 'grant-secret-grant-secret-grant-secret',
};
const saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
Object.assign(process.env, ENV);

// @ts-expect-error — JS module, no declaration file
const { __resetRateLimitForTest } = await import('../api/_rate-limit.js');
const { signBriefToken } = await import('../server/_shared/brief-url.ts');
const { signGrant } = await import('../api/_mcp-grant-hmac.ts');

const SLOT = '2026-04-17-0800';
const briefToken = await signBriefToken('user_test', SLOT, ENV.BRIEF_URL_SIGNING_SECRET);
const grant = await signGrant({ userId: 'user_test', nonce: 'n1', exp: Date.now() + 60_000 });

const ROUTES = [
  { file: 'correlation-runtime-mode.js', url: '/api/correlation-runtime-mode', scope: 'correlation-runtime-mode' },
  { file: 'md-twin.ts', url: '/api/md-twin?path=pricing-plans', scope: 'md-twin' },
  { file: 'brief/public/[hash].ts', url: '/api/brief/public/abcdefghijkl', scope: 'brief-public', html: true },
  {
    file: 'brief/carousel/[userId]/[issueDate]/[page].ts',
    url: `/api/brief/carousel/user_test/${SLOT}/0?t=${briefToken}`,
    scope: 'brief-carousel',
    key: `user_test:${SLOT}`,
  },
  {
    file: 'oauth/authorize-pro.ts',
    url: `/api/oauth/authorize-pro?nonce=n1&grant=${encodeURIComponent(grant)}`,
    scope: 'oauth-authorize-pro',
    key: 'user:user_test',
    html: true,
    failClosed: true,
  },
];

const originalFetch = globalThis.fetch;
let limiterMode: 'allow' | 'deny' | 'outage' = 'allow';
let limiterBodies: string[] = [];
let backend: string[] = [];

beforeEach(() => {
  __resetRateLimitForTest();
  limiterMode = 'allow';
  limiterBodies = [];
  backend = [];
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    // @vercel/og loads its wasm with fetch on import; that is not a backend call.
    if (url.startsWith('file:') || url.startsWith('data:')) return originalFetch(input, init);
    const body = typeof init?.body === 'string' ? init.body : '';
    if (url.startsWith(REDIS) && body.includes('"rl:')) {
      limiterBodies.push(body);
      if (limiterMode === 'outage') throw new Error('limiter unavailable');
      // Sliding-window reply is [remainingTokens, effectiveLimit]; success = remaining >= 0.
      const result = limiterMode === 'deny' ? [-1, 60] : [59, 60];
      const parsed = JSON.parse(body);
      return Array.isArray(parsed[0]) ? Response.json(parsed.map(() => ({ result }))) : Response.json({ result });
    }
    backend.push(url);
    return Response.json({ result: null });
  };
});

after(() => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function call(route: (typeof ROUTES)[number]): Promise<Response> {
  const { default: handler } = await import(`../api/${route.file}`);
  return handler(new Request(`https://www.worldmonitor.app${route.url}`), { waitUntil() {} });
}

for (const route of ROUTES) {
  describe(`api/${route.file}`, () => {
    it('charges its own scope', async () => {
      const response = await call(route);
      assert.notEqual(response.status, 429);
      assert.ok(
        limiterBodies.some((b) => b.includes(`rl:${route.scope}`) && (!route.key || b.includes(route.key))),
        limiterBodies.join('\n'),
      );
    });

    it('a caller over the budget gets an uncacheable 429 and no backend call runs', async () => {
      limiterMode = 'deny';
      const response = await call(route);
      assert.equal(response.status, 429);
      assert.ok(response.headers.get('Retry-After'));
      assert.match(response.headers.get('Cache-Control') ?? '', /no-store/);
      if (route.html) assert.match(response.headers.get('Content-Type') ?? '', /text\/html/);
      assert.deepEqual(backend, []);
    });

    if (route.failClosed) {
      it('a limiter outage fails closed before any backend call', async () => {
        limiterMode = 'outage';
        const response = await call(route);
        assert.equal(response.status, 503);
        assert.deepEqual(backend, []);
      });
    } else {
      it('a limiter outage lets the caller through', async () => {
        limiterMode = 'outage';
        const response = await call(route);
        assert.notEqual(response.status, 429);
        assert.equal(response.headers.get('X-RateLimit-Mode'), null);
      });
    }
  });
}
