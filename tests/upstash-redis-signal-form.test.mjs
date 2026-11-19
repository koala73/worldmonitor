// @upstash/redis handles the two `signal` forms differently on abort:
// a FUNCTION signal rethrows, but a STATIC AbortSignal resolves a synthetic
// 200 `{ result: 'Aborted' }`. Behind a rate limiter that reads as an allow, so
// a static deadline would fail open without any error. Every client therefore
// takes its options from api/_upstash-redis-options.js, which this file pins.
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { upstashRedisOptions, upstashRetryBackoff } from '../api/_upstash-redis-options.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir) {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(rel);
    return /\.(?:[cm]?js|ts)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [rel] : [];
  });
}

describe('Upstash Redis clients', () => {
  const sites = ['api', 'server'].flatMap(sourceFiles).flatMap((file) => {
    const src = readFileSync(join(root, file), 'utf8');
    return [...src.matchAll(/new Redis\(([^)\n]*)/g)].map((match) => ({ file, arg: match[1] }));
  });

  it('finds the limiter and store clients this guard protects', () => {
    assert.ok(sites.length >= 10, `expected the rate-limit Redis clients, found ${sites.length}`);
  });

  it('build every client from upstashRedisOptions, never an inline options object', () => {
    for (const { file, arg } of sites) {
      assert.match(arg, /^upstashRedisOptions\(/, `${file}: new Redis(${arg}) bypasses api/_upstash-redis-options.js`);
    }
  });
});

describe('upstashRedisOptions', () => {
  const originalTestContext = process.env.NODE_TEST_CONTEXT;
  afterEach(() => {
    if (originalTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = originalTestContext;
  });

  it('passes the deadline as a factory that returns a fresh signal per call', () => {
    const { signal } = upstashRedisOptions('https://redis.test', 'token');
    assert.equal(typeof signal, 'function');
    const first = signal();
    assert.ok(first instanceof AbortSignal);
    assert.notEqual(signal(), first, 'a reused signal would stay aborted after the first timeout');
  });

  it('applies the requested deadline', async () => {
    const { signal } = upstashRedisOptions('https://redis.test', 'token', { timeoutMs: 5 });
    const s = signal();
    await new Promise((resolve) => s.addEventListener('abort', resolve, { once: true }));
    assert.equal(s.reason?.name, 'TimeoutError');
  });

  it('retries twice with backoff in production and not at all on request', () => {
    delete process.env.NODE_TEST_CONTEXT;
    const production = upstashRedisOptions('https://redis.test', 'token');
    assert.equal(production.retry.retries, 2);
    assert.equal(production.retry.backoff, upstashRetryBackoff);
    assert.equal(upstashRedisOptions('https://redis.test', 'token', { retry: false }).retry, false);
  });

  it('turns retries off under the node test runner', () => {
    process.env.NODE_TEST_CONTEXT = 'child-v8';
    assert.equal(upstashRedisOptions('https://redis.test', 'token').retry, false);
  });

  it('caps backoff at one second and jitters it between 50% and 100%', () => {
    for (const [attempt, base] of [[0, 100], [1, 200], [3, 800], [4, 1_000], [10, 1_000]]) {
      for (let i = 0; i < 50; i++) {
        const delay = upstashRetryBackoff(attempt);
        assert.ok(delay >= base / 2 && delay <= base, `attempt ${attempt}: ${delay}ms outside [${base / 2}, ${base}]`);
      }
    }
  });
});
