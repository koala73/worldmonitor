import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveR2StorageConfig,
  getR2JsonObject,
  putR2JsonObject,
  withSettleTimeout,
  __setS3ClientForTests,
  __setR2S3TimeoutForTests,
} from '../scripts/_r2-storage.mjs';

describe('resolveR2StorageConfig default profile', () => {
  it('resolves CLOUDFLARE_R2_* S3 credentials and derives the R2 endpoint and trace prefix', () => {
    const config = resolveR2StorageConfig({
      CLOUDFLARE_R2_ACCOUNT_ID: 'r2-account',
      CLOUDFLARE_R2_TRACE_BUCKET: 'worldmonitor-data',
      CLOUDFLARE_R2_ACCESS_KEY_ID: 'r2-key',
      CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'r2-secret',
    });

    assert.deepEqual(config, {
      mode: 's3',
      accountId: 'r2-account',
      bucket: 'worldmonitor-data',
      endpoint: 'https://r2-account.r2.cloudflarestorage.com',
      region: 'auto',
      credentials: {
        accessKeyId: 'r2-key',
        secretAccessKey: 'r2-secret',
      },
      forcePathStyle: true,
      basePrefix: 'seed-data/forecast-traces',
    });
  });

  it('honors optional CLOUDFLARE_R2_ENDPOINT and CLOUDFLARE_R2_TRACE_PREFIX', () => {
    const config = resolveR2StorageConfig({
      CLOUDFLARE_R2_ACCOUNT_ID: 'r2-account',
      CLOUDFLARE_R2_ENDPOINT: 'https://r2.example.test',
      CLOUDFLARE_R2_BUCKET: 'worldmonitor-data',
      CLOUDFLARE_R2_ACCESS_KEY_ID: 'r2-key',
      CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'r2-secret',
      CLOUDFLARE_R2_TRACE_PREFIX: '/custom/traces/',
    });

    assert.equal(config?.endpoint, 'https://r2.example.test');
    assert.equal(config?.basePrefix, 'custom/traces');
  });

  it('returns null when required S3/API credentials are missing and rejects the retired bootstrap profile', () => {
    assert.equal(
      resolveR2StorageConfig({
        CLOUDFLARE_R2_ACCOUNT_ID: 'r2-account',
        CLOUDFLARE_R2_BUCKET: 'worldmonitor-data',
      }),
      null,
    );
    assert.throws(
      () => resolveR2StorageConfig({}, { profile: 'bootstrap' }),
      /Unknown R2 storage profile: bootstrap/,
    );
  });
});

// s3-mode config (mode !== 'api' → S3-SDK branch). getR2StorageClient returns
// the injected fake client, so no real network / credentials are touched.
const S3_CONFIG = { mode: 's3', bucket: 'test-bucket', endpoint: 'https://x.r2', region: 'auto', credentials: { accessKeyId: 'k', secretAccessKey: 's' }, forcePathStyle: true };

const hang = () => new Promise(() => {});

afterEach(() => {
  __setS3ClientForTests(null);
  __setR2S3TimeoutForTests(null);
});

// ── withSettleTimeout helper ────────────────────────────────────────────────
describe('withSettleTimeout', () => {
  it('resolves with the value when the promise settles in time', async () => {
    const v = await withSettleTimeout(Promise.resolve(42), 1000, 'x');
    assert.equal(v, 42);
  });

  it('rejects with a "timed out" error when the promise never settles', async () => {
    await assert.rejects(() => withSettleTimeout(hang(), 20, 'x'), /timed out after 20ms/);
  });

  it('propagates the underlying rejection unchanged', async () => {
    await assert.rejects(() => withSettleTimeout(Promise.reject(new Error('boom')), 1000, 'x'), /boom/);
  });
});

// ── getR2JsonObject (S3 mode) — issue #4786 regression ──────────────────────
describe('getR2JsonObject s3-mode does not hang on a stalled read', () => {
  it('reproduces the exit-13 bug: a never-settling transformToString() now REJECTS instead of hanging', async () => {
    __setR2S3TimeoutForTests(10);
    // Pre-fix: `await response.Body.transformToString()` never settled → the
    // top-level await drained the loop → Node exit 13. Now it must reject.
    __setS3ClientForTests({ send: async () => ({ Body: { transformToString: hang } }) });
    await assert.rejects(() => getR2JsonObject(S3_CONFIG, 'k'), /timed out/);
  });

  it('rejects when client.send() itself never settles', async () => {
    __setR2S3TimeoutForTests(10);
    __setS3ClientForTests({ send: hang });
    await assert.rejects(() => getR2JsonObject(S3_CONFIG, 'k'), /timed out/);
  });

  it('still returns the parsed object on the happy path (wrapper is transparent)', async () => {
    __setS3ClientForTests({ send: async () => ({ Body: { transformToString: async () => JSON.stringify({ ok: 1 }) } }) });
    assert.deepEqual(await getR2JsonObject(S3_CONFIG, 'k'), { ok: 1 });
  });

  it('still maps NoSuchKey / 404 to null', async () => {
    __setS3ClientForTests({ send: async () => { throw Object.assign(new Error('missing'), { name: 'NoSuchKey' }); } });
    assert.equal(await getR2JsonObject(S3_CONFIG, 'k'), null);
  });

  it('returns null when the object body is empty', async () => {
    __setS3ClientForTests({ send: async () => ({ Body: { transformToString: async () => '' } }) });
    assert.equal(await getR2JsonObject(S3_CONFIG, 'k'), null);
  });
});

// ── putR2JsonObject (S3 mode) ───────────────────────────────────────────────
describe('putR2JsonObject s3-mode does not hang on a stalled write', () => {
  it('rejects when client.send() never settles instead of hanging the run', async () => {
    __setR2S3TimeoutForTests(10);
    __setS3ClientForTests({ send: hang });
    await assert.rejects(() => putR2JsonObject(S3_CONFIG, 'k', { a: 1 }), /timed out/);
  });

  it('still resolves with byte count on the happy path', async () => {
    __setS3ClientForTests({ send: async () => ({}) });
    const res = await putR2JsonObject(S3_CONFIG, 'k', { a: 1 });
    assert.equal(res.bucket, 'test-bucket');
    assert.ok(res.bytes > 0);
  });
});

it('retries SDK transient codes and nested causes under the single outer budget', async t => {
  const timer = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => ms <= 1_000
    ? timer(callback, 0, ...args) : timer(callback, ms, ...args));
  for (const error of [
    Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' }),
    Object.assign(new Error('write failed'), { code: 'EPIPE' }),
    new Error('wrapped', { cause: Object.assign(new Error('connect failed'), { code: 'ETIMEDOUT' }) }),
  ]) {
    let calls = 0;
    __setS3ClientForTests({ send: async () => {
      if (++calls === 1) throw error;
      return {};
    } });
    await putR2JsonObject(S3_CONFIG, 'fixture.json', { ok: true });
    assert.equal(calls, 2);
  }
});
