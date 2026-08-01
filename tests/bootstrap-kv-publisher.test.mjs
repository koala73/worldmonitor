import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_KV_VALUE_BYTES,
  putKvJsonValue,
  resolveKvStorageConfig,
} from '../scripts/_kv-storage.mjs';
import {
  publishBootstrapTier,
  publishTierToKv,
} from '../scripts/publish-bootstrap-tiers.mjs';

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

// A publishBootstrapTier call with everything but the storage writers stubbed, so a test can
// capture exactly what the R2 and KV writers each receive.
async function runPublish(overrides = {}) {
  const captured = { r2: null, kv: null };
  const result = await publishBootstrapTier('fast', {
    env: { ...TEST_ENV, ...KV_ENV },
    now: () => 1_721_000_000_000,
    resolveRegistry: () => ({ fast: { example: 'example:key' } }),
    fetchFn: async () => pipelineResponse([raw({ answer: 42 })]),
    resolveStorage: () => ({ mode: 's3' }),
    putObject: async (_s, key, envelope) => { captured.r2 = { key, envelope }; return { bytes: 10 }; },
    resolveKvStorage: () => ({ accountId: 'a', namespaceId: 'n', token: 't' }),
    putKv: async (_c, key, envelope) => { captured.kv = { key, envelope }; return { bytes: 20 }; },
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

  it('returns null when unconfigured (so the publisher skips KV gracefully)', () => {
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

describe('publishTierToKv (best-effort wrapper)', () => {
  const envelope = { generatedAt: 1, tier: 'fast', payload: { data: {}, missing: [] } };

  it('skips silently when KV is unconfigured', async () => {
    assert.deepEqual(await publishTierToKv('fast', envelope, { resolveKvStorage: () => null }), { skipped: true });
  });

  it('returns ok with bytes on success', async () => {
    const out = await publishTierToKv('fast', envelope, {
      resolveKvStorage: () => ({ accountId: 'a', namespaceId: 'n', token: 't' }),
      putKv: async () => ({ bytes: 128 }),
    });
    assert.deepEqual(out, { ok: true, bytes: 128 });
  });

  it('never throws on failure — logs loudly and returns ok:false', async () => {
    const logs = [];
    const out = await publishTierToKv('fast', envelope, {
      resolveKvStorage: () => ({ accountId: 'a', namespaceId: 'n', token: 't' }),
      putKv: async () => { throw new Error('kv boom'); },
      logger: { error: (m) => logs.push(m) },
    });
    assert.equal(out.ok, false);
    assert.match(out.error, /kv boom/);
    assert.ok(logs.some((l) => /\[bootstrap-kv\] tier=fast/.test(l)), 'failure is logged loudly');
  });
});

describe('publishBootstrapTier — KV parity', () => {
  it('writes the SAME envelope to KV and R2, R2 keyed by <tier>.json, KV by bare <tier>', async () => {
    const { result, captured } = await runPublish();
    assert.deepEqual(captured.kv.envelope, captured.r2.envelope, 'KV must get the identical envelope');
    assert.equal(captured.r2.key, 'fast.json');
    assert.equal(captured.kv.key, 'fast', 'KV key is the bare tier so the Worker reads env.KV.get(tier)');
    assert.equal(result.kv.ok, true);
  });

  it('a KV failure never aborts the canonical R2 publish', async () => {
    const logs = [];
    const { result } = await runPublish({
      putKv: async () => { throw new Error('kv down'); },
      logger: { error: (m) => logs.push(m) },
    });
    assert.equal(result.bytes, 10, 'R2 write still succeeded');
    assert.equal(result.kv.ok, false);
    assert.ok(logs.some((l) => /bootstrap-kv/.test(l)));
  });

  it('never attempts the best-effort KV mirror when the canonical R2 write fails', async () => {
    let kvCalled = false;
    await assert.rejects(
      runPublish({
        putObject: async () => { throw new Error('r2 down'); },
        putKv: async () => { kvCalled = true; return { bytes: 1 }; },
      }),
      /r2 down/,
    );
    assert.equal(kvCalled, false);
  });

  it('skips KV entirely when unconfigured, leaving the R2-only path intact', async () => {
    const { result } = await runPublish({ resolveKvStorage: () => null });
    assert.deepEqual(result.kv, { skipped: true });
    assert.equal(result.bytes, 10);
  });
});
