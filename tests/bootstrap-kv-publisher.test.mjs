import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_KV_VALUE_BYTES,
  putKvJsonValue,
  resolveKvStorageConfig,
} from '../scripts/_kv-storage.mjs';
import {
  publishBootstrapTier,
} from '../scripts/publish-bootstrap-tiers.mjs';
import { BOOTSTRAP_TIER_ENVELOPE_SCHEMA_VERSION } from '../shared/bootstrap-tier-envelope.js';

const TEST_ENV = {
  UPSTASH_REDIS_REST_URL: 'https://redis.example.test',
  UPSTASH_REDIS_REST_TOKEN: 'redis-token',
};
const KV_ENV = {
  KV_BOOTSTRAP_ACCOUNT_ID: 'acct123',
  KV_BOOTSTRAP_NAMESPACE_ID: 'ns456',
  KV_BOOTSTRAP_WRITE_TOKEN: 'kv-token',
};

function pipelineResponse(results, status = 200) {
  return new Response(JSON.stringify(results), { status, headers: { 'Content-Type': 'application/json' } });
}
const raw = (value) => ({ result: JSON.stringify(value) });

// A publishBootstrapTier call with Redis and KV writers stubbed so tests can
// verify the required KV primary write contract without network I/O.
async function runPublish(overrides = {}) {
  const captured = { kv: null };
  const result = await publishBootstrapTier('fast', {
    env: { ...TEST_ENV, ...KV_ENV },
    now: () => 1_721_000_000_000,
    resolveRegistry: () => ({ fast: { example: 'example:key' } }),
    fetchFn: async () => pipelineResponse([raw({ answer: 42 })]),
    resolveKvStorage: () => ({ accountId: 'a', namespaceId: 'n', token: 't' }),
    putKv: async (config, key, envelope) => {
      captured.kv = { config, key, envelope };
      return { key, bytes: 20 };
    },
    ...overrides,
  });
  return { result, captured };
}

describe('resolveKvStorageConfig', () => {
  it('returns config when the three fields are present', () => {
    assert.deepEqual(resolveKvStorageConfig(KV_ENV), {
      accountId: 'acct123', namespaceId: 'ns456', token: 'kv-token',
    });
  });

  it('falls back to the R2 account id', () => {
    const cfg = resolveKvStorageConfig({
      CLOUDFLARE_R2_ACCOUNT_ID: 'r2acct',
      KV_BOOTSTRAP_NAMESPACE_ID: 'ns', KV_BOOTSTRAP_WRITE_TOKEN: 't',
    });
    assert.equal(cfg.accountId, 'r2acct');
  });

  it('returns null when unconfigured', () => {
    assert.equal(resolveKvStorageConfig({}), null);
    assert.equal(resolveKvStorageConfig({ KV_BOOTSTRAP_NAMESPACE_ID: 'ns' }), null); // token missing
  });
});

describe('putKvJsonValue', () => {
  it('PUTs the serialized value to the namespace values endpoint with the bearer token', async () => {
    let seen;
    const fetchFn = async (url, init) => { seen = { url, init }; return new Response('{}', { status: 200 }); };
    const value = { generatedAt: 1, tier: 'fast', payload: { data: {}, missing: [] } };

    const out = await putKvJsonValue({ accountId: 'A', namespaceId: 'N', token: 'T' }, 'fast', value, { fetchFn });

    assert.equal(seen.init.method, 'PUT');
    assert.equal(seen.url, 'https://api.cloudflare.com/client/v4/accounts/A/storage/kv/namespaces/N/values/fast');
    assert.equal(seen.init.headers.Authorization, 'Bearer T');
    assert.equal(seen.init.headers['User-Agent'], 'WorldMonitor Bootstrap Publisher/1.0');
    assert.equal(seen.init.body, JSON.stringify(value), 'writes the exact serialized envelope');
    assert.equal(out.bytes, Buffer.byteLength(JSON.stringify(value), 'utf8'));
  });

  it('refuses a value over the 25 MiB cap BEFORE any network call (#5311 discipline)', async () => {
    let called = false;
    const fetchFn = async () => { called = true; return new Response('{}'); };
    const huge = { blob: 'x'.repeat(MAX_KV_VALUE_BYTES + 10) };

    await assert.rejects(
      putKvJsonValue({ accountId: 'A', namespaceId: 'N', token: 'T' }, 'slow', huge, { fetchFn }),
      /over the .*25 MiB.* cap — refusing to write/,
    );
    assert.equal(called, false, 'the guard fires before the fetch');
  });

  it('throws on a non-2xx KV response', async () => {
    const fetchFn = async () => new Response('bad namespace', { status: 404 });
    await assert.rejects(
      putKvJsonValue({ accountId: 'A', namespaceId: 'N', token: 'T' }, 'fast', { a: 1 }, { fetchFn }),
      /KV write 'fast' failed: HTTP 404/,
    );
  });

  it('aborts a KV write that exceeds its deadline', async () => {
    const fetchFn = async (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    await assert.rejects(
      putKvJsonValue(
        { accountId: 'A', namespaceId: 'N', token: 'T' },
        'fast',
        { a: 1 },
        { fetchFn, timeoutMs: 5 },
      ),
      { name: 'AbortError' },
    );
  });
});

describe('publishBootstrapTier — required KV primary sink', () => {
  it('writes the versioned envelope to KV keyed by bare <tier> and returns the primary byte count', async () => {
    const { result, captured } = await runPublish();
    assert.equal(captured.kv.key, 'fast', 'KV key is the bare tier so the Worker reads env.KV.get(tier)');
    assert.deepEqual(captured.kv.envelope, {
      schemaVersion: BOOTSTRAP_TIER_ENVELOPE_SCHEMA_VERSION,
      generatedAt: 1_721_000_000_000,
      tier: 'fast',
      payload: { data: { example: { answer: 42 } }, missing: [] },
    });
    assert.equal(result.bytes, 20);
    assert.equal(Object.hasOwn(result, 'kv'), false);
  });

  it('throws loudly when KV credentials are missing without touching Redis or KV', async () => {
    let redisCalled = false;
    let kvCalled = false;
    await assert.rejects(
      runPublish({
        env: TEST_ENV,
        resolveKvStorage: resolveKvStorageConfig,
        fetchFn: async () => { redisCalled = true; return pipelineResponse([raw({ answer: 42 })]); },
        putKv: async () => { kvCalled = true; return { key: 'fast', bytes: 1 }; },
      }),
      /Bootstrap publisher KV credentials are missing/,
    );
    assert.equal(redisCalled, false);
    assert.equal(kvCalled, false);
  });

  it('propagates KV write failures loudly instead of swallowing them', async () => {
    await assert.rejects(
      runPublish({
        putKv: async () => { throw new Error('kv down'); },
      }),
      /kv down/,
    );
  });

  it('propagates default putKvJsonValue HTTP failures and forwards kvFetchFn', async () => {
    let seenUrl;
    await assert.rejects(
      publishBootstrapTier('fast', {
        env: { ...TEST_ENV, ...KV_ENV },
        now: () => 1_721_000_000_000,
        resolveRegistry: () => ({ fast: { example: 'example:key' } }),
        fetchFn: async () => pipelineResponse([raw({ answer: 42 })]),
        kvFetchFn: async (url) => {
          seenUrl = url;
          return new Response('quota exceeded', { status: 503 });
        },
      }),
      /KV write 'fast' failed: HTTP 503/,
    );
    assert.equal(
      seenUrl,
      'https://api.cloudflare.com/client/v4/accounts/acct123/storage/kv/namespaces/ns456/values/fast',
    );
  });

  it('never attempts a KV write when Redis assembly fails', async () => {
    let kvCalled = false;
    await assert.rejects(
      runPublish({
        fetchFn: async () => pipelineResponse([], 503),
        putKv: async () => { kvCalled = true; return { key: 'fast', bytes: 1 }; },
      }),
      /pipeline/i,
    );
    assert.equal(kvCalled, false);
  });
});
