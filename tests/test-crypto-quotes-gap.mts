import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { listCryptoQuotes } from '../server/worldmonitor/market/v1/list-crypto-quotes';
import { createMarketServiceRoutes, type MarketServiceHandler } from '../src/generated/server/worldmonitor/market/v1/service_server';
import { fetchCoinGeckoMarkets } from '../server/worldmonitor/market/v1/_shared';
import { GENERATED_MESSAGE_RULES } from '../src/generated/server/request_validation';

const SEED = {
  quotes: [
    { name: 'Bitcoin', symbol: 'BTC', price: 66000, change: 1.5, sparkline: [1] },
    { name: 'Ethereum', symbol: 'ETH', price: 3200, change: -0.5, sparkline: [2] },
    { name: 'Solana', symbol: 'SOL', price: 150, change: 3.2, sparkline: [3] },
  ],
};

const ORIGINAL_ENV = {
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  LOCAL_API_MODE: process.env.LOCAL_API_MODE,
  WS_RELAY_URL: process.env.WS_RELAY_URL,
};
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_WARN = console.warn;
const ORIGINAL_ERROR = console.error;

function configureRemoteRedis(): void {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  delete process.env.LOCAL_API_MODE;
}

function restoreEnv(name: keyof typeof ORIGINAL_ENV): void {
  const value = ORIGINAL_ENV[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  console.warn = ORIGINAL_WARN;
  console.error = ORIGINAL_ERROR;
  restoreEnv('UPSTASH_REDIS_REST_URL');
  restoreEnv('UPSTASH_REDIS_REST_TOKEN');
  restoreEnv('LOCAL_API_MODE');
  restoreEnv('WS_RELAY_URL');
});

/**
 * Stub fetch so:
 *  - `GET /get/...` for the seed key resolves from `seed` (encodeURIComponent
 *    key); any other GET key resolves as an Upstash "key absent" response.
 *  - CoinGecko/CoinPaprika provider calls resolve from `provider` (keyed).
 *  - Relay `/crypto-quotes` calls resolve from `relay`.
 *  - Redis POST (SET, negative/positive cache write) is recorded in `writes`.
 */
interface FetchPlan {
  seed?: unknown;
  redisFailure?: 'seed' | 'gap';
  provider?: Record<string, unknown[]>;
  relay?: { quotes?: Array<{ id?: string; name?: string; symbol?: string; price?: number; change?: number; sparkline?: number[] }> } | null;
}

function stubFetch(plan: FetchPlan): { calls: string[]; writes: Array<{ url: string; body: string }> } {
  const calls: string[] = [];
  const writes: Array<{ url: string; body: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (init?.method === 'POST' && init.body) {
      writes.push({ url, body: String(init.body) });
      return new Response(JSON.stringify({ result: 'OK' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/get/')) {
      const isSeed = url.includes(encodeURIComponent('market:crypto:v1'));
      if ((plan.redisFailure === 'seed' && isSeed) || (plan.redisFailure === 'gap' && !isSeed)) {
        return new Response('unavailable', { status: 503 });
      }
      if (plan.seed && url.includes(encodeURIComponent('market:crypto:v1'))) {
        return new Response(JSON.stringify({ result: JSON.stringify(plan.seed) }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('api.coingecko.com') || url.includes('pro-api.coingecko.com')) {
      return new Response(JSON.stringify(plan.provider?.coingecko ?? []), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('api.coinpaprika.com')) {
      const tickerId = url.split('/tickers/')[1]?.split('?')[0];
      const found = (plan.provider?.coinpaprika ?? []).find(
        (t) => t.id === decodeURIComponent(tickerId ?? ''),
      );
      return new Response(JSON.stringify(found ?? { error: 'not found' }), {
        status: found ? 200 : 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/crypto-quotes')) {
      return new Response(JSON.stringify(plan.relay ?? { quotes: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { calls, writes };
}

function ctx() {
  return { request: new Request('http://local'), headers: {}, pathParams: {} };
}

describe('listCryptoQuotes parameterized gap resolution (#6306)', () => {
  it('empty ids returns the seeded default set, no upstream call', async () => {
    configureRemoteRedis();
    const { calls, writes } = stubFetch({ seed: SEED, provider: {} });
    console.warn = () => {};

    const out = await listCryptoQuotes(ctx(), { ids: [] });

    assert.equal(out.quotes.length, 3, 'all seed defaults returned');
    assert.equal(out.unresolvedIds.length, 0);
    assert.equal(out.provider, 'seed');
    assert.ok(
      calls.every((c) => !c.includes('coingecko') && !c.includes('coinpaprika') && !c.includes('crypto-quotes')),
      `no provider fetch (calls: ${calls.join(', ')})`,
    );
    assert.equal(writes.length, 0, 'no Redis negative-cache write on a clean default');
  });

  it('request ids fully inside the seed: seed-only, no provider fetch, provider=seed', async () => {
    configureRemoteRedis();
    const { calls } = stubFetch({ seed: SEED, provider: {} });
    console.warn = () => {};

    const out = await listCryptoQuotes(ctx(), { ids: ['bitcoin', 'solana'] });

    assert.equal(out.provider, 'seed');
    assert.equal(out.unresolvedIds.length, 0);
    assert.deepEqual(
      out.quotes.map((q) => q.symbol),
      ['BTC', 'SOL'],
      'request order preserved (seed hits in the requested order)',
    );
    assert.ok(
      calls.every((c) => !c.includes('coingecko') && !c.includes('coinpaprika') && !c.includes('crypto-quotes')),
      `seed-only request must not fetch a provider (calls: ${calls.join(', ')})`,
    );
  });

  it('duplicate + case-insensitive ids resolve once in first-seen order', async () => {
    configureRemoteRedis();
    stubFetch({ seed: SEED, provider: {} });
    console.warn = () => {};

    const out = await listCryptoQuotes(ctx(), { ids: ['SOLANA', 'solana', 'BITCOIN'] });

    assert.deepEqual(out.quotes.map((q) => q.symbol), ['SOL', 'BTC']);
    assert.equal(out.unresolvedIds.length, 0);
  });

  it('gap-only request fetches ONLY the missing id from the provider', async () => {
    configureRemoteRedis();
    const { calls } = stubFetch({
      seed: SEED,
      provider: {
        coingecko: [
          { id: 'dogecoin', name: 'Dogecoin', symbol: 'doge', current_price: 0.16, price_change_percentage_24h: 4.2, sparkline_in_7d: { price: [1, 2] } },
        ],
      },
      relay: null,
    });
    console.warn = () => {};

    const out = await listCryptoQuotes(ctx(), { ids: ['dogecoin'] });

    assert.equal(out.provider, 'upstream');
    assert.equal(out.unresolvedIds.length, 0);
    assert.equal(out.quotes.length, 1);
    assert.equal(out.quotes[0].symbol, 'DOGE');
    assert.ok(
      calls.some((c) => c.includes('api.coingecko.com') || c.includes('pro-api.coingecko.com')),
      'gap id must be fetched from CoinGecko',
    );
    assert.ok(calls.every((c) => !c.includes('coinpaprika')), 'CoinPaprika must not be called on a CoinGecko success');
  });

  it('mixed request: seed hits + gap merged in request order', async () => {
    configureRemoteRedis();
    const { calls } = stubFetch({
      seed: SEED,
      provider: {
        coingecko: [
          { id: 'dogecoin', name: 'Dogecoin', symbol: 'doge', current_price: 0.16, price_change_percentage_24h: 4.2, sparkline_in_7d: { price: [1, 2] } },
        ],
      },
      relay: null,
    });
    console.warn = () => {};

    const out = await listCryptoQuotes(ctx(), { ids: ['dogecoin', 'bitcoin', 'ethereum'] });

    assert.equal(out.provider, 'mixed');
    assert.equal(out.unresolvedIds.length, 0);
    assert.deepEqual(
      out.quotes.map((q) => q.symbol),
      ['DOGE', 'BTC', 'ETH'],
      'request order (dogecoin, bitcoin, ethereum) preserved across seed+gap',
    );
    assert.ok(calls.some((c) => c.includes('coingecko')), 'gap (dogecoin) must be fetched, not the seed hits');
    assert.ok(calls.some((c) => c.includes('/get/')), 'seed hits served from Redis');
  });

  it('provider failure: seed hits returned, gap surfaced in unresolved_ids, provider=degraded; a definitive empty result gets only a short 120s negative cache', async () => {
    configureRemoteRedis();
    const { writes } = stubFetch({
      seed: SEED,
      provider: {},
      relay: null,
    });
    console.warn = () => {};

    const out = await listCryptoQuotes(ctx(), { ids: ['bitcoin', 'zzz-unknown'] });

    assert.equal(out.provider, 'degraded');
    assert.deepEqual(out.quotes.map((q) => q.symbol), ['BTC'], 'seed hit still returned');
    assert.deepEqual(out.unresolvedIds, ['zzz-unknown'], 'gap surfaced explicitly — never silently dropped');
    // A definitive empty provider result is cached as a short 120s negative
    // (NEG_SENTINEL), NOT as a positive 600s `{}` entry — the gap must be
    // retried soon after a miss, never stuck empty for the full TTL.
    const negWrites = writes.filter((w) => w.body.includes('__WM_NEG__') && w.body.includes('"EX","120"'));
    assert.equal(negWrites.length, 1, 'exactly one short negative write for the unresolved gap set');
    assert.equal(
      writes.some((w) => w.body.includes('market:crypto:gap:v2:') && w.body.endsWith('"EX","600"')),
      false,
      'an empty provider result must NOT be cached as a 600s positive entry',
    );
  });

  it('a provider miss is relayed; relay resolves it', async () => {
    configureRemoteRedis();
    process.env.WS_RELAY_URL = 'https://relay.example.test';
    const { calls } = stubFetch({
      seed: SEED,
      provider: { coingecko: [], coinpaprika: [] },
      relay: {
        quotes: [{ id: 'chainlink', name: 'Chainlink', symbol: 'link', price: 18, change: 0.5, sparkline: [] }],
      },
    });
    console.warn = () => {};

    const out = await listCryptoQuotes(ctx(), { ids: ['chainlink'] });

    assert.equal(out.provider, 'upstream');
    assert.equal(out.unresolvedIds.length, 0);
    assert.equal(out.quotes[0].symbol, 'LINK');
    assert.ok(calls.some((c) => c.includes('/crypto-quotes')), 'relay consulted after providers fail');
  });

  it('a transient provider error (throws) is NOT cached; after the short backoff the next request retries, and no negative entry is written', async () => {
    configureRemoteRedis();
    const writes: Array<{ url: string; body: string }> = [];
    let coinGeckoOk = true;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST' && init.body) {
        writes.push({ url, body: String(init.body) });
        return new Response(JSON.stringify({ result: 'OK' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/get/')) {
        if (url.includes(encodeURIComponent('market:crypto:v1'))) {
          return new Response(JSON.stringify({ result: JSON.stringify(SEED) }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('coingecko')) {
        if (!coinGeckoOk) {
          throw new Error('CoinGecko upstream 500');
        }
        return new Response(
          JSON.stringify([{ id: 'dogecoin', name: 'Dogecoin', symbol: 'doge', current_price: 0.16, price_change_percentage_24h: 4.2, price_change_percentage_7d_in_currency: 1, sparkline_in_7d: { price: [1, 2] } }]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ quotes: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    // First request: provider throws → gap unresolved, no cache write of any kind.
    coinGeckoOk = false;
    const out1 = await listCryptoQuotes(ctx(), { ids: ['dogecoin'] });
    assert.equal(out1.provider, 'degraded');
    assert.deepEqual(out1.unresolvedIds, ['dogecoin']);
    assert.equal(
      writes.filter((w) => w.body.includes('market:crypto:gap:v2:')).length,
      0,
      'a throwing provider must NOT write a positive OR negative cache entry',
    );

    // Advance past the short (3s) isolate-local unavailable backoff, then let
    // the provider recover. The next request retries the provider and resolves.
    const { __clearLocalUnavailableBackoffForTests } = await import('../server/_shared/redis');
    __clearLocalUnavailableBackoffForTests();
    coinGeckoOk = true;
    const out2 = await listCryptoQuotes(ctx(), { ids: ['dogecoin'] });
    assert.equal(out2.provider, 'upstream');
    assert.equal(out2.unresolvedIds.length, 0);
    assert.equal(out2.quotes[0].symbol, 'DOGE');
  });

  it('over-cap ids resolve in order and list overflow in unresolved_ids (defense-in-depth for direct calls)', async () => {
    configureRemoteRedis();
    const ids = Array.from({ length: 30 }, (_, i) => `id-${i}`);
    ids[0] = 'bitcoin';
    ids[1] = 'solana';
    stubFetch({ seed: SEED, provider: {}, relay: null });
    console.warn = () => {};

    const out = await listCryptoQuotes(ctx(), { ids });

    assert.equal(out.quotes.length, 2, 'first 25 accepted, both seed hits within them returned');
    // 5 overflow + 23 gap ids (25 accepted − 2 seed hits).
    assert.equal(out.unresolvedIds.length, 28);
    assert.deepEqual(out.unresolvedIds.slice(0, 5), ['id-25', 'id-26', 'id-27', 'id-28', 'id-29']);
  });

  it('two identical gap requests reuse the Redis cache — provider called once', async () => {
    configureRemoteRedis();
    let coingeckoCalls = 0;
    const gapCache = new Map<string, Record<string, unknown>>();
    globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (_init?.method === 'POST' && _init.body) {
        const [command, key, value] = JSON.parse(String(_init.body));
        if (command === 'SET') gapCache.set(key, JSON.parse(value));
        return new Response(JSON.stringify({ result: 'OK' }));
      }
      if (url.includes('/get/')) {
        const key = decodeURIComponent((url.match(/\/get\/([^/?]+)/) ?? [])[1] ?? '');
        if (key === 'market:crypto:v1') {
          return new Response(JSON.stringify({ result: JSON.stringify(SEED) }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (key.startsWith('market:crypto:gap:v2:')) {
          const cached = gapCache.get(key);
          if (cached) {
            return new Response(JSON.stringify({ result: JSON.stringify(cached) }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          return new Response(JSON.stringify({}), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('coingecko')) {
        coingeckoCalls += 1;
        return new Response(
          JSON.stringify([{ id: 'dogecoin', name: 'Dogecoin', symbol: 'doge', current_price: 0.16, price_change_percentage_24h: 4.2, sparkline_in_7d: { price: [1, 2] } }]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/crypto-quotes')) {
        return new Response(JSON.stringify({ quotes: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    const out1 = await listCryptoQuotes(ctx(), { ids: ['dogecoin'] });
    const out2 = await listCryptoQuotes(ctx(), { ids: ['dogecoin'] });

    assert.equal(coingeckoCalls, 1, 'provider fetched exactly once across two identical gap requests');
    assert.equal(out1.quotes[0].symbol, 'DOGE');
    assert.equal(out2.quotes[0].symbol, 'DOGE');
    assert.equal(out2.unresolvedIds.length, 0);
  });

  it('the generated request validator caps ids at 25 (proto max_items)', () => {
    const rules = GENERATED_MESSAGE_RULES as Record<string, { fields: Record<string, { repeatedMaxItems?: number }> }>;
    const rule = rules['worldmonitor.market.v1.ListCryptoQuotesRequest'];
    assert.ok(rule, 'ListCryptoQuotesRequest must have a generated validation rule');
    assert.equal(rule.fields.ids?.repeatedMaxItems, 25);
  });
});

describe('crypto quote provider boundary', () => {
  it('splits comma-bearing repeated parameters before applying the 25-ID bound', async () => {
    configureRemoteRedis();
    const ids = Array.from({ length: 30 }, (_, i) => `bounded-coin-${i}`);
    const { calls } = stubFetch({ seed: SEED });
    console.warn = () => {};
    const route = createMarketServiceRoutes({ listCryptoQuotes } as MarketServiceHandler)
      .find(route => route.path === '/api/market/v1/list-crypto-quotes')!;
    const url = new URL('https://worldmonitor.app/api/market/v1/list-crypto-quotes');
    url.searchParams.append('ids', ids.join(','));
    url.searchParams.append('ids', ids[0]);
    const response = await route.handler(new Request(url));
    assert.equal(response.status, 200);
    const gecko = new URL(calls.find(url => url.includes('coingecko'))!);
    assert.deepEqual(gecko.searchParams.get('ids')!.split(','), ids.slice(0, 25));
    const result = await response.json();
    assert.deepEqual(result.unresolvedIds.slice(0, 5), ids.slice(25));
  });

  it('rejects query delimiters and overlong IDs without treating them as a default request', async () => {
    configureRemoteRedis();
    const { calls } = stubFetch({ seed: SEED });
    console.warn = () => {};
    const out = await listCryptoQuotes(ctx(), { ids: ['bitcoin&per_page=250', 'ethereum#fragment', 'x'.repeat(1000)] });
    assert.deepEqual(out.quotes, []);
    assert.equal(out.provider, 'degraded');
    assert.equal(out.unresolvedIds.length, 3);
    assert.ok(out.unresolvedIds.every(id => id.length <= 64));
    assert.ok(calls.every(url => !url.includes('coingecko') && !url.includes('coinpaprika') && !url.includes('/crypto-quotes')));
  });

  for (const redisFailure of ['seed', 'gap'] as const) {
    it(`${redisFailure} cache failure prevents provider and relay work`, async () => {
      configureRemoteRedis();
      process.env.WS_RELAY_URL = 'https://relay.example.test';
      const { calls, writes } = stubFetch({ seed: SEED, redisFailure });
      const warnings: unknown[][] = [];
      console.warn = (...args) => { warnings.push(args); };
      console.error = () => {};
      const out = await listCryptoQuotes(ctx(), { ids: ['bitcoin', `outage-${redisFailure}`] });
      assert.equal(out.provider, 'degraded');
      assert.deepEqual(out.quotes.map(quote => quote.symbol), redisFailure === 'seed' ? [] : ['BTC']);
      assert.ok(calls.every(url => !url.includes('coingecko') && !url.includes('coinpaprika') && !url.includes('/crypto-quotes')));
      assert.equal(writes.length, 0);
      if (redisFailure === 'seed') {
        assert.ok(warnings.some(args => args[0] === '[redis] getCachedJson failed:'));
      }
    });
  }

  it('uses fixed-size gap cache keys and encodes upstream IDs as a single parameter', async () => {
    configureRemoteRedis();
    const { calls } = stubFetch({ seed: SEED });
    console.warn = () => {};
    await listCryptoQuotes(ctx(), { ids: ['key-bound-coin'] });
    const gapRead = calls.find(url => decodeURIComponent(url).includes('market:crypto:gap:'))!;
    assert.match(decodeURIComponent(gapRead), /market:crypto:gap:v2:[a-f0-9]{64}$/);
    await fetchCoinGeckoMarkets(['id&vs_currency=eur#fragment']);
    const upstream = new URL(calls.filter(url => url.includes('coingecko')).at(-1)!);
    assert.equal(upstream.searchParams.get('ids'), 'id&vs_currency=eur#fragment');
    assert.equal(upstream.searchParams.get('vs_currency'), 'usd');
    assert.equal(upstream.hash, '');
  });
});
