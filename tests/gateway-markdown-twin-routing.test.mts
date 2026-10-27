import { afterEach, beforeEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDomainGateway } from '../server/gateway.ts';
import { __resetRateLimitForTest } from '../server/_shared/rate-limit.ts';
import { __resetRateLimitForTest as __resetLegacyRateLimitForTest } from '../api/_rate-limit.js';
import { isPageTwinSibling } from '../api/_md-url-twin.ts';
import mdTwinHandler from '../api/md-twin.ts';
import notFoundHandler from '../api/not-found.ts';
import middleware from '../middleware';
import { createRedisFetch } from './helpers/fake-upstash-redis.mts';

const TWIN_TEST_KEY = 'markdown-twin-test-operator-key';
const CALLER_IP = '198.51.100.7';
// What Vercel reports as the peer when a function fetches its own hostname.
const EGRESS_IP = '203.0.113.50';
const FACT = '/api/news/v1/search-fact-checks';
const PREMIUM = '/api/market/v1/get-insider-transactions';
const NO_STORE = '/api/resilience/v1/get-runtime-manifest';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv();
});

// A PUBLIC_NO_AUTH_RPC_PATHS route answers a keyless caller; every other
// route needs a credential, which a twin never forwards.
const PUBLIC_ROUTE = '/api/news/v1/search-claim-headlines';

function makeGateway(onRpcDispatch: () => void) {
  const rpc = async () => {
    onRpcDispatch();
    return Response.json({ source: 'rpc' });
  };
  return createDomainGateway([
    { method: 'GET', path: '/api/forecast/v1/get-forecast-scorecard', handler: rpc },
    { method: 'GET', path: '/api/v2/shipping/get-port-congestion', handler: rpc },
    { method: 'GET', path: '/api/seismology/v1/list-earthquakes', handler: rpc },
    { method: 'GET', path: PUBLIC_ROUTE, handler: rpc },
    {
      method: 'GET',
      path: '/api/news/v1/search-fact-checks',
      handler: async () => new Response(null, { status: 308, headers: { location: '/api/news/v1/no-such-rpc' } }),
    },
  ]);
}

// Public routes carry fail-closed per-IP limits, so the limiter needs a Redis
// that admits; anything else that reaches the network is counted.
function countNetworkFetches(): { count: number } {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  __resetRateLimitForTest();
  const redis = createRedisFetch({});
  const counter = { count: 0 };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname === 'redis.example') {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      const cmds = Array.isArray(body?.[0]) ? body : body ? [body] : [];
      if (cmds.some((c: unknown[]) => /^evalsha$/i.test(String(c[0])))) {
        return Response.json(cmds.map((c: unknown[]) => {
          const tokens = Number(c[3 + Number(c[2])]);
          return { result: [tokens - 1, tokens] };
        }));
      }
      return redis.fetchImpl(input, init);
    }
    counter.count += 1;
    return Response.json({ source: 'network' });
  }) as typeof fetch;
  return counter;
}

const keylessBrowser = { 'User-Agent': BROWSER_UA, Origin: 'https://www.worldmonitor.app' };

describe('dynamic API gateway markdown twins', () => {
  it('serves a public route twin from its sibling, dispatched in-process', async () => {
    let rpcDispatches = 0;
    const gateway = makeGateway(() => {
      rpcDispatches += 1;
    });
    const network = countNetworkFetches();

    const res = await gateway(new Request(`https://worldmonitor.app${PUBLIC_ROUTE}.md?q=x`, { headers: keylessBrowser }));

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/markdown/);
    assert.equal(rpcDispatches, 1, 'the sibling route answers exactly once');
    assert.equal(network.count, 0, 'the sibling is never fetched over HTTP');
    const body = await res.text();
    assert.match(body, /^# /m);
    assert.match(body, /"source": "rpc"/);
  });

  for (const markdownPath of [
    '/api/forecast/v1/get-forecast-scorecard.md',
    '/api/v2/shipping/get-port-congestion.md',
  ]) {
    it(`routes ${markdownPath} through the sibling's own auth gate, not the RPC table`, async () => {
      let rpcDispatches = 0;
      const gateway = makeGateway(() => {
        rpcDispatches += 1;
      });
      const network = countNetworkFetches();

      const direct = await gateway(new Request(`https://worldmonitor.app${markdownPath.slice(0, -3)}`, { headers: keylessBrowser }));
      const res = await gateway(new Request(`https://worldmonitor.app${markdownPath}`, { headers: keylessBrowser }));

      assert.equal(direct.status, 401, 'a keyless direct call needs a credential');
      assert.equal(res.status, 401, 'so does its twin');
      assert.match(res.headers.get('content-type') ?? '', /text\/markdown/);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(rpcDispatches, 0, 'the .md segment is never dispatched as an RPC name');
      assert.equal(network.count, 0);
    });
  }

  it('answers 404 for a twin whose sibling or redirect target is not a route of this gateway', async () => {
    let rpcDispatches = 0;
    const gateway = makeGateway(() => {
      rpcDispatches += 1;
    });
    const network = countNetworkFetches();

    for (const path of ['/api/news/v1/no-such-rpc.md', '/api/news/v1/search-fact-checks.md?query=x']) {
      const res = await gateway(new Request(`https://worldmonitor.app${path}`, { headers: keylessBrowser }));
      assert.equal(res.status, 404, path);
      assert.equal(res.headers.get('cache-control'), 'no-store');
    }
    assert.equal(rpcDispatches, 0);
    assert.equal(network.count, 0);
  });

  it('keeps the unsuffixed API path on the normal RPC route', async () => {
    let rpcDispatches = 0;
    const gateway = makeGateway(() => {
      rpcDispatches += 1;
    });

    process.env.WORLDMONITOR_VALID_KEYS = TWIN_TEST_KEY;
    const res = await gateway(new Request(
      'https://worldmonitor.app/api/seismology/v1/list-earthquakes',
      { headers: { 'X-WorldMonitor-Key': TWIN_TEST_KEY } },
    ));

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { source: 'rpc' });
    assert.equal(rpcDispatches, 1);
  });
});

// External report (2026-10-28): the gateway answered every GET/HEAD
// /api/**/*.md before its own gates and the twin re-fetched the sibling over
// HTTP with no caller identity. Every limiter then charged the shared platform
// egress IP, twins answered `ACAO: *` to any Origin, and a no-store route came
// back `public, max-age=3600`. These pin the fixed contract: the sibling runs
// through the same gateway in-process, carrying the caller's network identity
// and Origin and never a credential.
describe('gateway markdown twins run every gate the direct route runs', () => {
  let upstreamSpend = 0;
  let limiterKeys: string[] = [];
  let egressFetches = 0;
  let seenByHandler: Record<string, string>[] = [];

  const gateway = createDomainGateway([
    {
      method: 'GET',
      path: FACT,
      handler: async (req: Request) => {
        upstreamSpend += 1;
        seenByHandler.push(Object.fromEntries(req.headers.entries()));
        return new Response(JSON.stringify({ query: new URL(req.url).searchParams.get('query'), claims: [] }), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      },
    },
    { method: 'GET', path: PREMIUM, handler: async () => Response.json({ premium: true }) },
    { method: 'GET', path: NO_STORE, handler: async () => Response.json({ manifest: 1 }) },
  ]);

  beforeEach(() => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    delete process.env.VERCEL_ENV;
    delete process.env.WORLDMONITOR_VALID_KEYS;
    delete process.env.CF_EDGE_PROOF_SECRET;
    __resetRateLimitForTest();
    upstreamSpend = 0;
    limiterKeys = [];
    egressFetches = 0;
    seenByHandler = [];
    const redis = createRedisFetch({});
    const counts = new Map<string, number>();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.hostname === 'redis.example') {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        const cmds = Array.isArray(body?.[0]) ? body : body ? [body] : [];
        if (cmds.some((c: unknown[]) => /^evalsha$/i.test(String(c[0])))) {
          return Response.json(cmds.map((c: unknown[]) => {
            if (!/^evalsha$/i.test(String(c[0]))) return { result: null };
            const numKeys = Number(c[2]);
            const keys = c.slice(3, 3 + numKeys).map(String);
            const tokens = Number(c[3 + numKeys]);
            limiterKeys.push(keys[0]!);
            const n = (counts.get(keys[0]!) ?? 0) + 1;
            counts.set(keys[0]!, n);
            return { result: [tokens - n, tokens] };
          }));
        }
        return redis.fetchImpl(input, init);
      }
      if (url.hostname === 'www.worldmonitor.app') {
        // The pre-fix sibling hop: a platform egress peer, no caller headers.
        egressFetches += 1;
        const headers = new Headers(init?.headers);
        headers.set('x-real-ip', EGRESS_IP);
        return gateway(new Request(url, { method: init?.method ?? 'GET', headers }));
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    __resetRateLimitForTest();
  });

  const call = (path: string, extra: Record<string, string> = {}) =>
    gateway(new Request(`https://www.worldmonitor.app${path}`, {
      headers: { 'User-Agent': BROWSER_UA, 'x-real-ip': CALLER_IP, ...extra },
    }));

  it('charges the caller: an exhausted 20/min fact-check budget 429s the .md twin too', async () => {
    for (let i = 0; i < 20; i += 1) {
      assert.equal((await call(`${FACT}?query=claim-${i}`)).status, 200);
    }
    assert.equal((await call(`${FACT}?query=claim-20`)).status, 429, 'direct route is exhausted for the caller');
    const spendBefore = upstreamSpend;

    const md = await call(`${FACT}.md?query=fresh-claim`);
    assert.equal(md.status, 429, 'the twin inherits the caller bucket');
    assert.equal(md.headers.get('cache-control'), 'no-store');
    assert.equal(upstreamSpend, spendBefore, 'no extra upstream call through the twin');
    assert.equal(egressFetches, 0, 'the sibling never leaves the process');
    assert.deepEqual(limiterKeys.filter((key) => key.includes(EGRESS_IP)), [], 'no limiter key names an egress IP');
  });

  it('keys the limiters on the caller for a successful twin', async () => {
    const md = await call(`${FACT}.md?query=first`);
    assert.equal(md.status, 200);
    assert.ok(limiterKeys.length >= 1, 'the endpoint limiter ran');
    for (const key of limiterKeys) assert.ok(key.includes(CALLER_IP), `${key} names the caller`);
  });

  it('keeps an independent caller unaffected by another caller exhausting the twin', async () => {
    for (let i = 0; i < 21; i += 1) await call(`${FACT}.md?query=burst-${i}`);
    const other = await gateway(new Request(`https://www.worldmonitor.app${FACT}.md?query=mine`, {
      headers: { 'User-Agent': BROWSER_UA, 'x-real-ip': '192.0.2.44' },
    }));
    assert.equal(other.status, 200, 'twin buckets are per caller, not one shared egress bucket');
  });

  it('refuses a disallowed Origin with 403 and never answers ACAO: *', async () => {
    const evil = { Origin: 'https://evil.example' };
    const direct = await call(`${FACT}?query=x`, evil);
    assert.equal(direct.status, 403);

    const md = await call(`${FACT}.md?query=x`, evil);
    assert.equal(md.status, 403);
    assert.notEqual(md.headers.get('access-control-allow-origin'), '*');
    assert.equal(upstreamSpend, 0);
  });

  it('echoes an allowed Origin like the direct route instead of ACAO: *', async () => {
    const origin = { Origin: 'https://www.worldmonitor.app' };
    const md = await call(`${FACT}.md?query=x`, origin);
    assert.equal(md.status, 200);
    assert.equal(md.headers.get('access-control-allow-origin'), 'https://www.worldmonitor.app');
    assert.match(md.headers.get('vary') ?? '', /origin/i);
  });

  it('inherits no-store from the sibling instead of public, max-age=3600', async () => {
    const direct = await call(NO_STORE);
    assert.equal(direct.headers.get('cache-control'), 'no-store', 'the direct route is no-store');
    const md = await call(`${NO_STORE}.md`);
    assert.equal(md.status, 200);
    assert.equal(md.headers.get('cache-control'), 'no-store', 'the twin inherits no-store');
    assert.equal(md.headers.get('cdn-cache-control'), null);
  });

  it('keeps a publicly cacheable sibling lifetime instead of stretching it to an hour', async () => {
    const direct = await call(`${FACT}?query=a`);
    const md = await call(`${FACT}.md?query=a`);
    assert.equal(md.status, 200);
    assert.match(direct.headers.get('cache-control') ?? '', /^public, /);
    assert.equal(md.headers.get('cache-control'), direct.headers.get('cache-control'));
  });

  it('keeps a premium route 401 via .md and never forwards a credential', async () => {
    process.env.WORLDMONITOR_VALID_KEYS = TWIN_TEST_KEY;
    const credentials = {
      Authorization: `Bearer ${TWIN_TEST_KEY}`,
      'X-WorldMonitor-Key': TWIN_TEST_KEY,
      'X-Api-Key': TWIN_TEST_KEY,
      Cookie: 'wm-session=abc',
    };
    const direct = await call(`${PREMIUM}?symbol=AAPL`, { 'X-WorldMonitor-Key': TWIN_TEST_KEY });
    assert.equal(direct.status, 200, 'the key is valid on the direct route');

    const md = await call(`${PREMIUM}.md?symbol=AAPL`, credentials);
    assert.equal(md.status, 401);
    assert.equal(md.headers.get('cache-control'), 'no-store');

    const publicMd = await call(`${FACT}.md?query=y`, credentials);
    assert.equal(publicMd.status, 200);
    const seen = seenByHandler.at(-1)!;
    for (const name of ['authorization', 'x-worldmonitor-key', 'x-api-key', 'cookie']) {
      assert.equal(seen[name], undefined, `${name} must not reach the sibling`);
    }
    assert.equal(seen['x-real-ip'], CALLER_IP, 'the caller network identity is carried');
  });
});

describe('middleware bot gate on /api/**/*.md twins', () => {
  const call = (path: string, ua: string, method = 'GET') =>
    middleware(new Request(`https://www.worldmonitor.app${path}`, { method, headers: ua ? { 'user-agent': ua } : {} }));

  for (const ua of ['curl/8.7.1', 'python-requests/2.31', '']) {
    it(`403s ${ua || 'an empty UA'} on a gateway twin exactly as on the direct route`, () => {
      const direct = call(FACT, ua);
      const md = call(`${FACT}.md`, ua);
      assert.ok(direct instanceof Response && direct.status === 403);
      assert.ok(md instanceof Response, 'the twin is gated');
      assert.equal(md.status, 403);
    });
  }

  for (const ua of [
    'Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)',
    'Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
    'anthropic-ai/1.0',
    'Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
    'Google-Extended',
    'CCBot/2.0 (https://commoncrawl.org/faq/)',
    'Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)',
    'Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)',
    'Claude-User/1.0',
    'Mozilla/5.0 (compatible; Applebot-Extended/0.1)',
  ]) {
    it(`lets AI crawler ${ua.slice(0, 40)} read a twin`, () => {
      assert.equal(call(`${FACT}.md`, ua), undefined);
    });
  }

  it('keeps public bot-gate bypasses public on their twin', () => {
    assert.equal(call('/api/health.md', 'curl/8.7.1'), undefined);
    assert.equal(call('/api/download.md', 'curl/8.7.1'), undefined);
  });

  it('does not extend the crawler allowance to other methods', () => {
    const res = call(`${FACT}.md`, 'CCBot/2.0 (https://commoncrawl.org/faq/)', 'POST');
    assert.ok(res instanceof Response);
    assert.equal(res.status, 403);
  });
});

describe('legacy /api/*.md twins (api/not-found.ts)', () => {
  let siblingFetches: string[] = [];
  let limiterKeys: string[] = [];
  let exhausted = new Set<string>();

  beforeEach(() => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    delete process.env.CF_EDGE_PROOF_SECRET;
    __resetLegacyRateLimitForTest();
    siblingFetches = [];
    limiterKeys = [];
    exhausted = new Set();
    const redis = createRedisFetch({});
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.hostname === 'redis.example') {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        const cmds = Array.isArray(body?.[0]) ? body : body ? [body] : [];
        if (cmds.some((c: unknown[]) => /^evalsha$/i.test(String(c[0])))) {
          return Response.json(cmds.map((c: unknown[]) => {
            if (!/^evalsha$/i.test(String(c[0]))) return { result: null };
            const key = String(c[3]);
            const tokens = Number(c[3 + Number(c[2])]);
            limiterKeys.push(key);
            return { result: [[...exhausted].some((ip) => key.includes(ip)) ? -1 : tokens - 1, tokens] };
          }));
        }
        return redis.fetchImpl(input, init);
      }
      siblingFetches.push(url.pathname);
      return Response.json({ ok: true });
    }) as typeof fetch;
  });

  afterEach(() => {
    __resetLegacyRateLimitForTest();
  });

  const call = (path: string, extra: Record<string, string> = {}) =>
    notFoundHandler(new Request(`https://www.worldmonitor.app${path}`, {
      headers: { 'User-Agent': BROWSER_UA, 'x-real-ip': CALLER_IP, ...extra },
    }));

  it('charges the caller before the sibling hop', async () => {
    const res = await call('/api/health.md');
    assert.equal(res.status, 200);
    assert.deepEqual(siblingFetches, ['/api/health']);
    assert.ok(limiterKeys.some((key) => key.includes(CALLER_IP)), `caller charged: ${limiterKeys.join(', ')}`);
  });

  it('429s an exhausted caller without making the hop', async () => {
    exhausted.add(CALLER_IP);
    const res = await call('/api/health.md');
    assert.equal(res.status, 429);
    assert.deepEqual(siblingFetches, []);
  });

  it('serves no twin for a legacy route outside the public allowlist', async () => {
    for (const path of ['/api/bootstrap.md', '/api/reverse-geocode.md', '/api/youtube/live.md']) {
      const res = await call(`${path}?lat=1&lon=2`);
      assert.equal(res.status, 404, path);
      assert.equal(res.headers.get('cache-control'), 'no-store');
    }
    assert.deepEqual(siblingFetches, []);
  });

  it('refuses a disallowed Origin and drops ACAO: *', async () => {
    const res = await call('/api/health.md', { Origin: 'https://evil.example' });
    assert.equal(res.status, 403);
    assert.deepEqual(siblingFetches, []);
    const ok = await call('/api/health.md');
    assert.notEqual(ok.headers.get('access-control-allow-origin'), '*');
  });
});

describe('page twins (api/md-twin.ts) never hop into an API function', () => {
  let siblingFetches: string[] = [];

  beforeEach(() => {
    siblingFetches = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      siblingFetches.push(new URL(String(input instanceof Request ? input.url : input)).pathname);
      return new Response('<html><head><title>x</title></head><body><main><h1>x</h1></main></body></html>', {
        headers: { 'content-type': 'text/html' },
      });
    }) as typeof fetch;
  });

  for (const query of [
    '/api/news/v1/search-fact-checks.md',
    'api/health.md',
    '%61pi/news/v1/search-fact-checks.md',
    // Encoded dot segments: the URL parser collapses `%2e%2e` onto `/api/`.
    'x/%2e%2e/api/news/v1/search-fact-checks.md',
    'x/%2E%2e/api/news/v1/search-fact-checks.md',
    'x/%252e%252e/api/news/v1/search-fact-checks.md',
    'x/%25252e%25252e/api/news/v1/search-fact-checks.md',
    'x/.%2e/ask.md',
    'ask.md',
    'ASK.md',
    'mcp.md',
    'oauth/token.md',
  ]) {
    it(`404s /api/md-twin?path=${query} without a sibling fetch`, async () => {
      const res = await mdTwinHandler(new Request(
        `https://www.worldmonitor.app/api/md-twin?path=${encodeURIComponent(query)}&query=x`,
      ));
      assert.equal(res.status, 404);
      assert.deepEqual(siblingFetches, []);
    });
  }

  it('does not follow a page redirect into /api/', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
      siblingFetches.push(path);
      return new Response(null, { status: 308, headers: { location: '/api/news/v1/search-fact-checks?query=x' } });
    }) as typeof fetch;
    const res = await mdTwinHandler(new Request('https://www.worldmonitor.app/api/md-twin?path=some-page.md'));
    assert.equal(res.status, 404);
    assert.deepEqual(siblingFetches, ['/some-page']);
  });

  it('keeps a page twin publicly cacheable when the page itself is private, no-cache', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      siblingFetches.push(new URL(String(input instanceof Request ? input.url : input)).pathname);
      return new Response('<html><head><title>x</title></head><body><main><h1>x</h1></main></body></html>', {
        headers: { 'content-type': 'text/html', 'cache-control': 'private, no-cache, must-revalidate' },
      });
    }) as typeof fetch;
    const res = await mdTwinHandler(new Request('https://www.worldmonitor.app/api/md-twin?path=dashboard.md'));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=3600');
  });

  it('still serves an ordinary page twin', async () => {
    const res = await mdTwinHandler(new Request('https://www.worldmonitor.app/api/md-twin?path=pricing.md'));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=3600');
    assert.equal(siblingFetches[0], '/pricing');
  });

  it('covers every vercel.json rewrite whose destination is an API function', () => {
    const vercel = JSON.parse(readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../vercel.json'),
      'utf-8',
    )) as { rewrites: Array<{ source: string; destination: string }> };
    const apiRewrites = vercel.rewrites.filter((rule) =>
      rule.destination.startsWith('/api/') && !rule.destination.startsWith('/api/md-twin'));
    assert.ok(apiRewrites.length > 5);
    for (const { source } of apiRewrites) {
      const literal = source.split('/:')[0]!;
      assert.equal(isPageTwinSibling(literal), false, `${source} rewrites into /api/ and must not be a page twin sibling`);
      assert.equal(isPageTwinSibling(`${literal}/`), false, `${source}/ must not be a page twin sibling`);
    }
    assert.equal(isPageTwinSibling('/x/%2e%2e/api/health'), false);
    assert.equal(isPageTwinSibling('/x/%252e%252e/api/health'), false);
    assert.equal(isPageTwinSibling('/pricing'), true);
    assert.equal(isPageTwinSibling('/countries/iran/'), true);
  });
});
