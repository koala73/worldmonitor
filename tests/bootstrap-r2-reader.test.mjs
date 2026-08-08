import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BOOTSTRAP_R2_HEALTH_TIMEOUT_MS,
  BOOTSTRAP_R2_PROBE_CEILING_MS,
  BOOTSTRAP_R2_TIMEOUT_MS_FAST,
  BOOTSTRAP_R2_TIMEOUT_MS_SLOW,
  bootstrapR2ServingTimeoutMs,
  readBootstrapTierObject,
} from '../api/_bootstrap-r2.js';

const NOW = Date.UTC(2026, 6, 14, 12);
const MINUTE_MS = 60_000;
const TEST_ENV = {
  R2_ACCOUNT_ID: 'account-id',
  R2_BOOTSTRAP_BUCKET: 'worldmonitor-bootstrap',
  R2_BOOTSTRAP_READ_KEY_ID: 'read-key-id',
  R2_BOOTSTRAP_READ_SECRET: 'read-secret',
};

function response(status, body) {
  return new Response(body == null ? null : JSON.stringify(body), { status });
}

function validEnvelope(tier = 'fast', generatedAt = NOW) {
  return {
    generatedAt,
    tier,
    payload: { data: { example: { value: 1 } }, missing: [] },
  };
}

function readerOptions(fetchResponse, overrides = {}) {
  return {
    timeoutMs: 100,
    nowMs: NOW,
    env: TEST_ENV,
    awsClientFactory: () => ({ fetch: async () => fetchResponse }),
    ...overrides,
  };
}

function assertDuration(result) {
  assert.equal(typeof result.durationMs, 'number');
  assert.ok(Number.isFinite(result.durationMs));
  assert.ok(result.durationMs >= 0);
}

describe('bootstrap R2 timeout contracts', () => {
  it('keeps serving timeouts unavailable until U3a records measured per-tier values', () => {
    assert.equal(BOOTSTRAP_R2_TIMEOUT_MS_FAST, null);
    assert.equal(BOOTSTRAP_R2_TIMEOUT_MS_SLOW, null);
    assert.throws(() => bootstrapR2ServingTimeoutMs('fast'), /U3a.*fast/i);
    assert.throws(() => bootstrapR2ServingTimeoutMs('slow'), /U3a.*slow/i);
  });

  it('keeps shadow and health budgets independent from serving budgets', () => {
    assert.equal(BOOTSTRAP_R2_PROBE_CEILING_MS, 5_000);
    assert.equal(BOOTSTRAP_R2_HEALTH_TIMEOUT_MS, 2_000);
  });
});

describe('readBootstrapTierObject', () => {
  it('returns the exact payload and generatedAt for a valid object', async () => {
    const envelope = validEnvelope();
    const result = await readBootstrapTierObject(
      'fast',
      readerOptions(response(200, envelope)),
    );

    assert.deepEqual(result, {
      status: 'ok',
      payload: envelope.payload,
      generatedAt: NOW,
      durationMs: result.durationMs,
    });
    assertDuration(result);
  });

  it('returns unreadable for a 403 without throwing', async () => {
    const result = await readBootstrapTierObject('fast', readerOptions(response(403)));
    assert.equal(result.status, 'fallback');
    assert.equal(result.reason, 'unreadable');
    assertDuration(result);
  });

  it('returns missing for a 404 without conflating it with an infrastructure fault', async () => {
    const result = await readBootstrapTierObject('slow', readerOptions(response(404)));
    assert.equal(result.status, 'fallback');
    assert.equal(result.reason, 'missing');
    assertDuration(result);
  });

  it('returns unreadable for a network failure without throwing', async () => {
    const result = await readBootstrapTierObject('fast', readerOptions(null, {
      awsClientFactory: () => ({ fetch: async () => { throw new Error('network down'); } }),
    }));
    assert.equal(result.status, 'fallback');
    assert.equal(result.reason, 'unreadable');
    assertDuration(result);
  });

  it('returns timeout promptly when the caller-supplied signal expires', async () => {
    const timeoutMs = 10;
    const startedAt = performance.now();
    const result = await readBootstrapTierObject('fast', readerOptions(null, {
      timeoutMs,
      awsClientFactory: () => ({
        fetch: async (_url, { signal }) => await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
      }),
    }));

    assert.equal(result.status, 'fallback');
    assert.equal(result.reason, 'timeout');
    assertDuration(result);
    assert.ok(performance.now() - startedAt < 500, 'reader should not hang beyond its timeout');
  });

  it('returns timeout when the response body stalls after headers arrive', async () => {
    const result = await readBootstrapTierObject('fast', readerOptions(null, {
      timeoutMs: 10,
      awsClientFactory: () => ({
        fetch: async (_url, { signal }) => ({
          status: 200,
          ok: true,
          json: async () => await new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
        }),
      }),
    }));

    assert.equal(result.status, 'fallback');
    assert.equal(result.reason, 'timeout');
    assertDuration(result);
  });

  it('returns invalid for malformed JSON', async () => {
    const result = await readBootstrapTierObject(
      'fast',
      readerOptions(new Response('{"truncated":', { status: 200 })),
    );
    assert.equal(result.status, 'fallback');
    assert.equal(result.reason, 'invalid');
    assertDuration(result);
  });

  for (const [name, mutate] of [
    ['wrong tier', envelope => { envelope.tier = 'slow'; }],
    ['non-integer generatedAt', envelope => { envelope.generatedAt = NOW + 0.5; }],
    ['generatedAt over five minutes in the future', envelope => { envelope.generatedAt = NOW + 5 * MINUTE_MS + 1; }],
    ['array payload', envelope => { envelope.payload = []; }],
    ['array payload.data', envelope => { envelope.payload.data = []; }],
    ['non-array payload.missing', envelope => { envelope.payload.missing = {}; }],
  ]) {
    it(`returns invalid for ${name}`, async () => {
      const envelope = validEnvelope();
      mutate(envelope);
      const result = await readBootstrapTierObject(
        'fast',
        readerOptions(response(200, envelope)),
      );
      assert.equal(result.status, 'fallback');
      assert.equal(result.reason, 'invalid');
      assertDuration(result);
    });
  }

  it('returns stale past the tier max age but accepts the exact boundary', async () => {
    const staleFast = await readBootstrapTierObject(
      'fast',
      readerOptions(response(200, validEnvelope('fast', NOW - 15 * MINUTE_MS - 1))),
    );
    assert.equal(staleFast.status, 'fallback');
    assert.equal(staleFast.reason, 'stale');

    const freshFast = await readBootstrapTierObject(
      'fast',
      readerOptions(response(200, validEnvelope('fast', NOW - 15 * MINUTE_MS))),
    );
    assert.equal(freshFast.status, 'ok');

    const staleSlow = await readBootstrapTierObject(
      'slow',
      readerOptions(response(200, validEnvelope('slow', NOW - 60 * MINUTE_MS - 1))),
    );
    assert.equal(staleSlow.status, 'fallback');
    assert.equal(staleSlow.reason, 'stale');

    const freshSlow = await readBootstrapTierObject(
      'slow',
      readerOptions(response(200, validEnvelope('slow', NOW - 60 * MINUTE_MS))),
    );
    assert.equal(freshSlow.status, 'ok');
  });

  it('builds a read-only signed GET client from only the bootstrap read credentials', async () => {
    let clientConfig;
    let request;
    const result = await readBootstrapTierObject('fast', readerOptions(response(200, validEnvelope()), {
      awsClientFactory: config => {
        clientConfig = config;
        return {
          fetch: async (url, init) => {
            request = { url, init };
            return response(200, validEnvelope());
          },
        };
      },
    }));

    assert.equal(result.status, 'ok');
    assert.deepEqual(clientConfig, {
      accessKeyId: 'read-key-id',
      secretAccessKey: 'read-secret',
      service: 's3',
      region: 'auto',
      retries: 0,
    });
    assert.equal(
      request.url,
      'https://account-id.r2.cloudflarestorage.com/worldmonitor-bootstrap/fast.json',
    );
    assert.equal(request.init.method, 'GET');
    assert.equal(request.init.headers['User-Agent'], 'WorldMonitor Bootstrap/1.0');
    assert.ok(request.init.signal instanceof AbortSignal);
    assert.equal(JSON.stringify(result).includes('read-key-id'), false);
    assert.equal(JSON.stringify(result).includes('read-secret'), false);
  });

  it('signs the real GET with aws4fetch using the read-only key', async () => {
    const originalFetch = globalThis.fetch;
    let signedRequest;
    globalThis.fetch = async input => {
      signedRequest = input;
      return response(200, validEnvelope());
    };

    try {
      const result = await readBootstrapTierObject('fast', {
        timeoutMs: 100,
        nowMs: NOW,
        env: TEST_ENV,
      });
      assert.equal(result.status, 'ok');
      assert.ok(signedRequest instanceof Request);
      assert.equal(signedRequest.method, 'GET');
      assert.match(signedRequest.headers.get('authorization'), /Credential=read-key-id\//);
      assert.equal(signedRequest.headers.get('user-agent'), 'WorldMonitor Bootstrap/1.0');
      assert.equal(signedRequest.headers.get('authorization').includes('read-secret'), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses an explicit R2 endpoint without duplicating slashes', async () => {
    let requestedUrl;
    const result = await readBootstrapTierObject('slow', readerOptions(response(200, validEnvelope('slow')), {
      env: { ...TEST_ENV, R2_ENDPOINT: 'https://custom.example.test/' },
      awsClientFactory: () => ({
        fetch: async url => {
          requestedUrl = url;
          return response(200, validEnvelope('slow'));
        },
      }),
    }));

    assert.equal(result.status, 'ok');
    assert.equal(requestedUrl, 'https://custom.example.test/worldmonitor-bootstrap/slow.json');
  });

  it('returns unreadable when scoped credentials are absent', async () => {
    const result = await readBootstrapTierObject('fast', readerOptions(null, { env: {} }));
    assert.equal(result.status, 'fallback');
    assert.equal(result.reason, 'unreadable');
    assertDuration(result);
  });
});
