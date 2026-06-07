import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const REDIS_MODULE_URL = pathToFileURL(resolve(root, 'server/_shared/redis.ts')).href;

function withEnv(overrides) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return () => {
    for (const [key, value] of previous.entries()) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

async function importRedisFresh() {
  return import(`${REDIS_MODULE_URL}?t=${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

describe('getHashFieldsBatch', () => {
  it('preserves empty-string hash values (regression for falsy-check bug)', async () => {
    // The bug: `if (values[i])` treats '' as falsy and drops it.
    // Empty string is a legitimate Redis hash value and must be preserved.
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://mock.upstash.invalid',
      UPSTASH_REDIS_REST_TOKEN: 'mock-token',
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      return {
        ok: true,
        async json() {
          // Return: one pipeline step with HMGET result containing a valid empty string
          // Upstash pipeline response format: [{ result: [...] }]
          return [{ result: ['hello', '', 'world'] }];
        },
      };
    }
    try {
      const { getHashFieldsBatch } = await importRedisFresh();
      const result = await getHashFieldsBatch('test-key', ['field_a', 'field_b', 'field_c'], true);
      // Empty string must NOT be dropped
      assert.equal(result.get('field_a'), 'hello', 'field_a should be hello');
      assert.equal(result.get('field_b'), '', 'field_b should be empty string (not dropped)');
      assert.equal(result.get('field_c'), 'world', 'field_c should be world');
      assert.equal(result.size, 3, 'all three fields must be present');
    } finally {
      globalThis.fetch = origFetch;
      restoreEnv();
    }
  });

  it('skips null values but preserves empty strings', async () => {
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://mock.upstash.invalid',
      UPSTASH_REDIS_REST_TOKEN: 'mock-token',
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      return {
        ok: true,
        async json() {
          return [{ result: ['present', null, ''] }];
        },
      };
    };
    try {
      const { getHashFieldsBatch } = await importRedisFresh();
      const result = await getHashFieldsBatch('test-key', ['f1', 'f2', 'f3'], true);
      // f1: non-empty string -> present
      assert.equal(result.get('f1'), 'present');
      // f2: null -> must be skipped (null is not a value)
      assert.equal(result.has('f2'), false, 'null should be skipped');
      // f3: empty string -> must be preserved (fix for falsy-check bug)
      assert.equal(result.has('f3'), true, 'empty string must be preserved');
      assert.equal(result.get('f3'), '', 'empty string must round-trip correctly');
    } finally {
      globalThis.fetch = origFetch;
      restoreEnv();
    }
  });

  it('returns empty map when fields array is empty', async () => {
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://mock.upstash.invalid',
      UPSTASH_REDIS_REST_TOKEN: 'mock-token',
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('fetch should not be called for empty fields');
    };
    try {
      const { getHashFieldsBatch } = await importRedisFresh();
      const result = await getHashFieldsBatch('test-key', [], true);
      assert.equal(result.size, 0);
    } finally {
      globalThis.fetch = origFetch;
      restoreEnv();
    }
  });
});