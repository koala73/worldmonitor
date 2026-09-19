import assert from 'node:assert/strict';
import { after, it } from 'node:test';
import handler from '../api/symbol-search.ts';

process.env.WORLDMONITOR_VALID_KEYS = 'synthetic-search-key';
process.env.FINNHUB_API_KEY = 'synthetic-finnhub-key';
const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });

function request(query: string, ip = '192.0.2.1') {
  return new Request(`https://worldmonitor.app/api/symbol-search?q=${query}`, {
    headers: { 'X-WorldMonitor-Key': 'synthetic-search-key', 'x-real-ip': ip },
  });
}

it('fails closed without distributed admission', async () => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ result: [] }); };
  assert.equal((await handler(request('missing-budget'))).status, 503);
  assert.equal(calls, 0);
});

it('shares the cold-query budget across unique queries and callers, with cache hits still available', async () => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://quota-redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'synthetic-token';
  let admitted = 0;
  let providerCalls = 0;
  const identifiers = new Set<string>();
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (new URL(url).origin === 'https://quota-redis.test') {
      if (!init?.body) return Response.json({ result: url.includes('cached') ? JSON.stringify({ results: [] }) : null });
      const commands = JSON.parse(String(init.body));
      return Response.json(commands.map((command: unknown[]) => {
        if (JSON.stringify(command).includes('rl:symbol-search:finnhub')) {
          // Upstash's key is `<identifier>:<windowIndex>` (floor(now / 60s)). A run
          // that crossed a wall-clock minute saw two keys for the one shared bucket.
          identifiers.add(String(command[3]).replace(/:\d+$/, ''));
          return { result: [30 - ++admitted, 30] };
        }
        return { result: [500, 600] };
      }));
    }
    assert.ok(url.startsWith('https://finnhub.io/'));
    providerCalls++;
    return Response.json({ result: [] });
  };
  const results = await Promise.all(Array.from({ length: 35 }, (_, i) => handler(request(`unique-${i}`, `192.0.2.${i + 1}`))));
  assert.equal(results.filter(r => r.status === 200).length, 30);
  assert.equal(results.filter(r => r.status === 429).length, 5);
  assert.equal(providerCalls, 30);
  assert.equal(identifiers.size, 1, 'all callers must reserve the same bucket');
  assert.equal((await handler(request('cached'))).status, 200);
  assert.equal(providerCalls, 30);
});
