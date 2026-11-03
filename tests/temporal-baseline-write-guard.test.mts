// GHSA-gxj5-54wh-7vgr. Anonymous browser sessions must never supply values
// for shared temporal baselines. Server-owned v2 producers remain active.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';

import { validateGeneratedRequest } from '../server/request-validator.ts';
import { recordBaselineSnapshot } from '../server/worldmonitor/infrastructure/v1/record-baseline-snapshot.ts';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

const validRequest = {
  updates: [{
    type: 'military_flights',
    region: 'global',
    count: 42,
  }],
};

describe('recordBaselineSnapshot complete trust boundary', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach((key) => {
      if (!(key in originalEnv)) delete process.env[key];
    });
    Object.assign(process.env, originalEnv);
  });

  it('rejects every remote baseline write before Redis', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error('Redis must not be called');
    }) as typeof globalThis.fetch;

    await assert.rejects(
      recordBaselineSnapshot({} as never, validRequest as never),
      (error: unknown) => {
        assert.equal((error as { statusCode?: number }).statusCode, 403);
        assert.match((error as Error).message, /disabled/i);
        return true;
      },
    );
    assert.equal(fetchCalls, 0, 'a remote request must not reach Redis');
  });

  it('publishes global as the only valid region', () => {
    assert.deepEqual(
      validateGeneratedRequest('recordBaselineSnapshot', {
        updates: [{ ...validRequest.updates[0], region: 'attacker-chosen-region' }],
      }),
      [{
        field: 'updates[0].region',
        description: 'string must equal global',
      }],
    );
  });

  it('does not send browser observations to the shared baseline API', () => {
    const serviceSource = readFileSync(
      new URL('../src/services/temporal-baseline.ts', import.meta.url),
      'utf8',
    );
    const loaderSource = readFileSync(
      new URL('../src/app/data-loader.ts', import.meta.url),
      'utf8',
    );

    assert.doesNotMatch(serviceSource, /\.recordBaselineSnapshot\s*\(/);
    assert.doesNotMatch(loaderSource, /\bupdateAndCheck\s*\(/);
  });
});
