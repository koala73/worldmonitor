/**
 * DELETE /api/v2/shipping/webhooks/{subscriberId} — the unsubscribe route the
 * Zapier REST-hook triggers call from performUnsubscribe. Drives the legacy
 * edge handler end to end against a stubbed Upstash REST pipeline: owner
 * isolation, compare-and-delete of the record plus both indexes and the
 * worker's delivery state, and the GET status read exposing the event fields.
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const SUB = 'wh_0123456789abcdef01234567';
const URL_FOR = (id) => `https://worldmonitor.app/api/v2/shipping/webhooks/${id}`;

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function stubUpstash(store) {
  const pipelines = [];
  globalThis.fetch = async (url, init) => {
    if (!init || !init.body) {
      // getCachedJson reads through the plain REST path: GET /get/<key>.
      const key = decodeURIComponent(String(url).split('/get/')[1] ?? '');
      return new Response(JSON.stringify({ result: store.has(key) ? store.get(key) : null }), { status: 200 });
    }
    const commands = JSON.parse(init.body);
    pipelines.push(commands);
    const results = commands.map((command) => {
      const [verb, ...args] = command;
      if (verb === 'GET') return { result: store.has(args[0]) ? store.get(args[0]) : null };
      if (verb === 'EVAL') {
        const [script, keyCount, ...rest] = args;
        const keys = rest.slice(0, Number(keyCount));
        const argv = rest.slice(Number(keyCount));
        assert.match(script, /DEL/, 'only the delete script is expected');
        if (store.get(keys[0]) !== argv[0]) return { result: 0 };
        store.delete(keys[0]);
        store.get(keys[1])?.delete(argv[1]);
        store.get(keys[2])?.delete(argv[1]);
        store.delete(keys[3]);
        return { result: 1 };
      }
      throw new Error(`unexpected command ${verb}`);
    });
    return new Response(JSON.stringify(results), { status: 200 });
  };
  return pipelines;
}

describe('DELETE /api/v2/shipping/webhooks/{subscriberId}', () => {
  let handler;
  let ownerTag;
  let store;

  beforeEach(async () => {
    process.env.WORLDMONITOR_VALID_KEYS = 'pro-test-key,other-tenant-key';
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
    ownerTag = await sha256Hex('pro-test-key');
    const record = {
      subscriberId: SUB,
      ownerTag,
      callbackUrl: 'https://hooks.zapier.com/hooks/standard/1/abc/',
      chokepointIds: ['hormuz_strait'],
      alertThreshold: 50,
      minLiveSignal: 15,
      eventType: 'chokepoint.disruption',
      createdAt: '2026-10-17T12:00:00.000Z',
      active: true,
      secret: 'f'.repeat(64),
    };
    store = new Map([
      [`webhook:sub:${SUB}:v1`, JSON.stringify(record)],
      [`webhook:owner:${ownerTag}:v1`, new Set([SUB])],
      ['webhook:all:v1', new Set([SUB, 'wh_other'])],
      [`webhook:state:${SUB}:v1`, 'hash'],
    ]);
    ({ default: handler } = await import('../api/v2/shipping/webhooks/[subscriberId].ts'));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  const request = (method, id = SUB, key = 'pro-test-key') => new Request(URL_FOR(id), {
    method,
    headers: key ? { 'X-WorldMonitor-Key': key } : {},
  });

  it('removes the record, both index entries and the delivery state for the owner', async () => {
    const pipelines = stubUpstash(store);
    const res = await handler(request('DELETE'));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.subscriberId, SUB);
    assert.equal(body.deleted, true);
    assert.equal(store.has(`webhook:sub:${SUB}:v1`), false, 'record deleted');
    assert.equal(store.get(`webhook:owner:${ownerTag}:v1`).has(SUB), false, 'owner index pruned');
    assert.deepEqual([...store.get('webhook:all:v1')], ['wh_other'], 'global index pruned, other subscribers kept');
    assert.equal(store.has(`webhook:state:${SUB}:v1`), false, 'worker state dropped so a re-registration starts armed');
    const evalCall = pipelines.flat().find((c) => c[0] === 'EVAL');
    assert.equal(evalCall[2], '4');
    assert.equal(res.headers.get('Access-Control-Allow-Methods'), 'GET, DELETE, OPTIONS');
  });

  it('refuses another tenant with 403 and deletes nothing', async () => {
    stubUpstash(store);
    const res = await handler(request('DELETE', SUB, 'other-tenant-key'));
    assert.equal(res.status, 403);
    assert.equal(store.has(`webhook:sub:${SUB}:v1`), true);
  });

  it('answers 404 for an unknown or already-removed subscription (idempotent for Zapier)', async () => {
    stubUpstash(store);
    assert.equal((await handler(request('DELETE', 'wh_ffffffffffffffffffffffff'))).status, 404);
    assert.equal((await handler(request('DELETE'))).status, 200);
    assert.equal((await handler(request('DELETE'))).status, 404);
  });

  it('retries when the worker rewrote the record between the read and the delete', async () => {
    const key = `webhook:sub:${SUB}:v1`;
    let evals = 0;
    const pipelines = stubUpstash(store);
    const inner = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const commands = init?.body ? JSON.parse(init.body) : [];
      if (commands[0]?.[0] === 'EVAL' && (evals += 1) === 1) {
        // The worker's counter write lands after our GET: the bytes no longer match.
        store.set(key, store.get(key).replace('"active":true', '"active":true,"lastDeliveryAt":"x"'));
      }
      return inner(url, init);
    };
    const res = await handler(request('DELETE'));
    assert.equal(res.status, 200);
    assert.equal(evals, 2);
    assert.equal(store.has(key), false);
    assert.equal(pipelines.filter(([[verb]]) => verb === 'GET').length, 2, 'the retry re-reads the record');
  });

  it('answers 409 when the record keeps changing on every attempt', async () => {
    const raw = store.get(`webhook:sub:${SUB}:v1`);
    let reads = 0;
    globalThis.fetch = async (_url, init) => {
      const commands = JSON.parse(init.body);
      const results = commands.map(([verb]) => {
        if (verb === 'GET') {
          reads += 1;
          return { result: raw };
        }
        // The worker rewrote the record after our read: compare-and-delete fails.
        return { result: 0 };
      });
      return new Response(JSON.stringify(results), { status: 200 });
    };
    const res = await handler(request('DELETE'));
    assert.equal(res.status, 409);
    assert.equal(reads, 3);
  });

  it('still rejects callers without an API key and unsupported methods', async () => {
    stubUpstash(store);
    assert.equal((await handler(request('DELETE', SUB, null))).status, 401);
    assert.equal((await handler(request('PUT'))).status, 405);
  });

  it('GET reports the event type and scope fields alongside the delivery counters', async () => {
    stubUpstash(store);
    const res = await handler(request('GET'));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.eventType, 'chokepoint.disruption');
    assert.deepEqual(body.countries, []);
    assert.equal(body.minLiveSignal, 15);
    assert.equal(body.failureCount, 0);
    assert.equal('secret' in body, false);
  });
});
