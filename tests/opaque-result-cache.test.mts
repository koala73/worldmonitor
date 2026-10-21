import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { OpaqueResultCache } from '../src/services/opaque-result-cache.ts';

function keySequence(...keys: string[]): () => string {
  let index = 0;
  return () => {
    const key = keys[index];
    index += 1;
    if (key === undefined) throw new Error('Test key sequence exhausted');
    return key;
  };
}

describe('OpaqueResultCache', () => {
  it('issues unique, opaque, cryptographically-shaped default keys', () => {
    const cache = new OpaqueResultCache<{ secret: string }>({ maxEntries: 4, ttlMs: 1_000 });
    const value = { secret: 'classified-payload' };

    const first = cache.issue(value);
    const second = cache.issue({ secret: 'another-payload' });

    assert.match(first, /^sr_[a-f0-9]{32}$/);
    assert.match(second, /^sr_[a-f0-9]{32}$/);
    assert.notEqual(first, second);
    assert.equal(first.includes(value.secret), false);
    assert.strictEqual(cache.get(first), value);
  });

  it('expires entries at the TTL boundary and prunes them from size', () => {
    let now = 1_000;
    const cache = new OpaqueResultCache<string>({
      maxEntries: 4,
      ttlMs: 100,
      now: () => now,
      createKey: keySequence('first', 'second'),
    });

    const first = cache.issue('alpha');
    now = 1_050;
    const second = cache.issue('beta');
    now = 1_099;
    assert.equal(cache.get(first), 'alpha');
    assert.equal(cache.get(second), 'beta');

    now = 1_100;
    assert.equal(cache.get(first), null);
    assert.equal(cache.get(second), 'beta');
    assert.equal(cache.size, 1);

    now = 1_150;
    assert.equal(cache.size, 0);
    assert.equal(cache.get(second), null);
  });

  it('evicts the oldest issued entry when capacity is reached', () => {
    const cache = new OpaqueResultCache<string>({
      maxEntries: 2,
      ttlMs: 1_000,
      createKey: keySequence('first', 'second', 'third'),
    });

    const first = cache.issue('alpha');
    const second = cache.issue('beta');
    assert.equal(cache.get(first), 'alpha');
    const third = cache.issue('gamma');

    assert.equal(cache.size, 2);
    assert.equal(cache.get(first), null);
    assert.equal(cache.get(second), 'beta');
    assert.equal(cache.get(third), 'gamma');
  });

  it('keeps capability storage isolated across cache instances', () => {
    const firstCache = new OpaqueResultCache<string>({
      maxEntries: 2,
      ttlMs: 1_000,
      createKey: () => 'first-cache-key',
    });
    const secondCache = new OpaqueResultCache<string>({
      maxEntries: 2,
      ttlMs: 1_000,
      createKey: () => 'second-cache-key',
    });

    const firstKey = firstCache.issue('first-value');
    const secondKey = secondCache.issue('second-value');

    assert.equal(firstCache.get(firstKey), 'first-value');
    assert.equal(firstCache.get(secondKey), null);
    assert.equal(secondCache.get(firstKey), null);
    assert.equal(secondCache.get(secondKey), 'second-value');
  });

  it('provides get-and-delete primitives for rejecting replayed capabilities', () => {
    const cache = new OpaqueResultCache<{ id: number }>({
      maxEntries: 2,
      ttlMs: 1_000,
      createKey: () => 'single-use-key',
    });
    const value = { id: 42 };
    const key = cache.issue(value);

    assert.strictEqual(cache.get(key), value);
    assert.strictEqual(cache.get(key), value, 'get does not consume before validation');
    cache.delete(key);
    assert.equal(cache.get(key), null, 'a caller can consume the capability before side effects');
    assert.equal(cache.size, 0);
  });

  it('retries generated-key collisions and accepts the first unique key', () => {
    const cache = new OpaqueResultCache<string>({
      maxEntries: 3,
      ttlMs: 1_000,
      createKey: keySequence('duplicate', 'duplicate', 'unique'),
    });

    assert.equal(cache.issue('first'), 'duplicate');
    assert.equal(cache.issue('second'), 'unique');
    assert.equal(cache.get('duplicate'), 'first');
    assert.equal(cache.get('unique'), 'second');
  });

  it('fails closed after the bounded collision retry budget is exhausted', () => {
    let calls = 0;
    const cache = new OpaqueResultCache<string>({
      maxEntries: 3,
      ttlMs: 1_000,
      createKey: () => {
        calls += 1;
        return 'duplicate';
      },
    });

    cache.issue('first');
    assert.throws(() => cache.issue('second'), /Could not issue a unique result key/);
    assert.equal(calls, 6, 'one initial generation plus four retries are attempted for the collision');
    assert.equal(cache.size, 1);
    assert.equal(cache.get('duplicate'), 'first');
  });

  it('clears all entries without preventing future issuance', () => {
    const cache = new OpaqueResultCache<string>({
      maxEntries: 3,
      ttlMs: 1_000,
      createKey: keySequence('first', 'second', 'third'),
    });
    const first = cache.issue('alpha');
    const second = cache.issue('beta');

    cache.clear();

    assert.equal(cache.size, 0);
    assert.equal(cache.get(first), null);
    assert.equal(cache.get(second), null);
    const third = cache.issue('gamma');
    assert.equal(third, 'third');
    assert.equal(cache.get(third), 'gamma');
  });
});
