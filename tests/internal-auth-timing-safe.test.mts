import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { timingSafeEqual, authenticateInternalRequest } from '../server/_shared/internal-auth.ts';
import { timingSafeEqualSecret as apiTimingSafeEqual } from '../api/_crypto.js';

async function withDigestSpy<T>(fn: (calls: Array<{ algorithm: AlgorithmIdentifier; bytes: number }>) => Promise<T>): Promise<T> {
  const originalDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  const calls: Array<{ algorithm: AlgorithmIdentifier; bytes: number }> = [];
  const digestSpy = async (algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> => {
    calls.push({ algorithm, bytes: data.byteLength });
    return originalDigest(algorithm, data);
  };

  Object.defineProperty(globalThis.crypto.subtle, 'digest', {
    configurable: true,
    value: digestSpy,
  });

  try {
    return await fn(calls);
  } finally {
    Object.defineProperty(globalThis.crypto.subtle, 'digest', {
      configurable: true,
      value: originalDigest,
    });
  }
}

describe('internal auth timing-safe comparison (#4679)', () => {
  it('returns true only for exact matches', async () => {
    assert.equal(await timingSafeEqual('Bearer shared-secret', 'Bearer shared-secret'), true);
    assert.equal(await timingSafeEqual('Bearer shared-secret', 'Bearer wrong-secret'), false);
    assert.equal(await timingSafeEqual('short', 'a much longer candidate'), false);
  });

  it('hashes both inputs before returning false for unequal lengths', async () => {
    await withDigestSpy(async (calls) => {
      assert.equal(await timingSafeEqual('short', 'a much longer candidate'), false);
      assert.deepEqual(
        calls.map((call) => call.bytes),
        [5, 23],
        'unequal-length inputs must still exercise the fixed-digest path for both operands',
      );
    });
  });

  it('keeps authenticateInternalRequest fail-closed behavior', async () => {
    const prev = process.env.WM_TEST_INTERNAL_AUTH_SECRET;
    try {
      delete process.env.WM_TEST_INTERNAL_AUTH_SECRET;
      const missingSecret = await authenticateInternalRequest(
        new Request('https://worldmonitor.app/api/test', { headers: { Authorization: 'Bearer anything' } }),
        'WM_TEST_INTERNAL_AUTH_SECRET',
      );
      assert.equal(missingSecret?.status, 401);

      process.env.WM_TEST_INTERNAL_AUTH_SECRET = 'shared-secret';
      const wrong = await authenticateInternalRequest(
        new Request('https://worldmonitor.app/api/test', { headers: { Authorization: 'Bearer wrong-secret' } }),
        'WM_TEST_INTERNAL_AUTH_SECRET',
      );
      assert.equal(wrong?.status, 401);

      const ok = await authenticateInternalRequest(
        new Request('https://worldmonitor.app/api/test', { headers: { Authorization: 'Bearer shared-secret' } }),
        'WM_TEST_INTERNAL_AUTH_SECRET',
      );
      assert.equal(ok, null);
    } finally {
      if (prev === undefined) delete process.env.WM_TEST_INTERNAL_AUTH_SECRET;
      else process.env.WM_TEST_INTERNAL_AUTH_SECRET = prev;
    }
  });

  it('uses the same fixed-digest path for the api/cache-purge helper', async () => {
    await withDigestSpy(async (calls) => {
      assert.equal(await apiTimingSafeEqual('Bearer x', 'Bearer much-longer-secret'), false);
      assert.deepEqual(
        calls.map((call) => call.bytes),
        [8, 25],
        'cache-purge auth helper must not return before hashing unequal-length operands',
      );
    });
  });
});
