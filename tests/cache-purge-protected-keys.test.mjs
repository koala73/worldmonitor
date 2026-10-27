/**
 * /api/cache-purge is a relay-secret ops tool for refreshing caches. OAuth and
 * connector auth state lives in the same Redis, and deleting it is a token
 * revocation, not a cache refresh. Neither explicit keys nor patterns may
 * reach it.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

const SECRET = 'relay-secret-for-test';
const ENV_KEYS = ['RELAY_SHARED_SECRET', 'VERCEL_ENV', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const originalFetch = globalThis.fetch;

before(() => {
  process.env.RELAY_SHARED_SECRET = SECRET;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  delete process.env.VERCEL_ENV;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith('https://redis.test/scan/')) {
      return Response.json({ result: ['0', ['oauth:token:abc', 'mcp-grant:n1', 'oauth-cache:keep']] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
});

after(() => {
  globalThis.fetch = originalFetch;
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const { default: handler } = await import('../api/cache-purge.js');

function purge(body) {
  return handler(new Request('https://api.worldmonitor.app/api/cache-purge', {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, dryRun: true }),
  }));
}

describe('cache-purge protects auth state', () => {
  it('protects foreign preview auth state through explicit keys and wildcard scans during production execution', async () => {
    const protectedKeys = ['oauth:token:abc', 'webhook:sub:x', 'internal-mcp-replay:x', 'desktop-auth:x', 'rl:x']
      .map(key => `preview:deadbeef:${key}`);
    const safe = 'preview:deadbeef:news:digest';
    const commands = [];
    const saved = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (String(input).includes('/scan/')) return Response.json({ result: ['0', [...protectedKeys, safe]] });
      commands.push(...JSON.parse(init.body));
      return Response.json([{ result: 1 }]);
    };
    try {
      for (const body of [{ keys: protectedKeys }, { patterns: ['preview:*'] }]) {
        const response = await handler(new Request('https://worldmonitor.app/api/cache-purge', {
          method: 'POST', headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        }));
        assert.equal(response.status, 200);
      }
      assert.deepEqual(commands, [['DEL', safe]]);
    } finally { globalThis.fetch = saved; }
  });
  it('keeps foreign preview durable data out of wildcard purges during production execution', async () => {
    const durable = ['military:bases:x', 'conflict:iran-events:x', 'conflict:ucdp-events:x']
      .map(key => `preview:deadbeef:${key}`);
    const safe = 'preview:deadbeef:news:digest';
    const commands = [];
    const saved = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (String(input).includes('/scan/')) return Response.json({ result: ['0', [...durable, safe]] });
      commands.push(...JSON.parse(init.body));
      return Response.json([{ result: 1 }]);
    };
    try {
      const response = await handler(new Request('https://worldmonitor.app/api/cache-purge', {
        method: 'POST', headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ patterns: ['preview:*'] }),
      }));
      assert.equal(response.status, 200);
      assert.deepEqual(commands, [['DEL', safe]]);
    } finally { globalThis.fetch = saved; }
  });
  it('drops OAuth and connector auth keys from an explicit key list', async () => {
    const res = await purge({
      keys: [
        'oauth:token:abc', 'oauth:refresh:def', 'oauth:client:c1', 'mcp-grant:n1',
        'wm:slack:oauth:s1', 'wm:discord:oauth:s2', 'rl:mcp:1',
        'internal-mcp-replay:v1:deadbeef', 'webhook:sub:wh_abc:v1', 'webhook:owner:0123:v1',
        'desktop-auth:code:0123abcd',
        'news:digest:v1', 'entitlements:user_1',
      ],
    });
    assert.equal(res.status, 200);
    const { keys } = await res.json();
    assert.deepEqual(keys.sort(), ['entitlements:user_1', 'news:digest:v1']);
  });

  it('drops them from pattern matches too', async () => {
    const res = await purge({ patterns: ['o*'] });
    assert.equal(res.status, 200);
    const { keys } = await res.json();
    assert.deepEqual(keys, ['oauth-cache:keep']);
  });

  // Replay nonces and shipping webhook records share the Redis with the
  // caches. Purging the first re-opens the signed-request replay window;
  // purging the second deletes customers' subscriptions and signing secrets.
  it('never deletes internal-MCP replay nonces or shipping webhook records, even by broad pattern', async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.startsWith('https://redis.test/scan/')) {
        return Response.json({ result: ['0', [
          'internal-mcp-replay:v1:deadbeef', 'webhook:sub:wh_abc:v1', 'webhook:owner:0123:v1', 'webhooks-cache:keep',
        ]] });
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    try {
      const res = await purge({ patterns: ['w*', 'internal-*'] });
      assert.equal(res.status, 200);
      const { keys } = await res.json();
      assert.deepEqual(keys, ['webhooks-cache:keep']);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});
