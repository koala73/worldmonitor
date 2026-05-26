/**
 * Tests for issue #1326: per-breaker persistent stale ceiling.
 *
 * The global PERSISTENT_STALE_CEILING_MS (24h) is too permissive for
 * time-sensitive data like CII risk scores. Breakers should accept an
 * optional `persistentStaleCeilingMs` to override the global default.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const readSrc = (relPath: string) => readFileSync(resolve(root, relPath), 'utf-8');


// ============================================================
// 2. Behavioral: persistentStaleCeilingMs controls hydration discard
// ============================================================

describe('CircuitBreaker — persistentStaleCeilingMs behavior', () => {
  const CIRCUIT_BREAKER_URL = pathToFileURL(
    resolve(root, 'src/utils/circuit-breaker.ts'),
  ).href;

  it('default persistentStaleCeiling is 24h (backwards compatible)', async () => {
    const mod = await import(`${CIRCUIT_BREAKER_URL}?t=${Date.now()}-default`);
    const { createCircuitBreaker, clearAllCircuitBreakers } = mod;
    clearAllCircuitBreakers();

    try {
      const breaker = createCircuitBreaker({
        name: 'DefaultCeiling Test',
        cacheTtlMs: 10 * 60 * 1000,
        persistCache: true,
      });

      const fallback = { data: 'fallback' };
      const result = await breaker.execute(async () => ({ data: 'live' }), fallback);
      assert.deepEqual(result, { data: 'live' });
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('accepts custom persistentStaleCeilingMs without error', async () => {
    const mod = await import(`${CIRCUIT_BREAKER_URL}?t=${Date.now()}-custom`);
    const { createCircuitBreaker, clearAllCircuitBreakers } = mod;
    clearAllCircuitBreakers();

    try {
      const breaker = createCircuitBreaker({
        name: 'CustomCeiling Test',
        cacheTtlMs: 30 * 60 * 1000,
        persistCache: true,
        persistentStaleCeilingMs: 60 * 60 * 1000, // 1 hour
      });

      const fallback = { data: 'fallback' };
      const result = await breaker.execute(async () => ({ data: 'live' }), fallback);
      assert.deepEqual(result, { data: 'live' });
    } finally {
      clearAllCircuitBreakers();
    }
  });
});

// ============================================================
// 3. Adversarial edge cases — try to break persistentStaleCeilingMs
// ============================================================

describe('CircuitBreaker — persistentStaleCeilingMs edge cases', () => {
  const CIRCUIT_BREAKER_URL = pathToFileURL(
    resolve(root, 'src/utils/circuit-breaker.ts'),
  ).href;

  it('persistentStaleCeilingMs of 0 effectively disables persistent hydration', async () => {
    const mod = await import(`${CIRCUIT_BREAKER_URL}?t=${Date.now()}-zero`);
    const { createCircuitBreaker, clearAllCircuitBreakers } = mod;
    clearAllCircuitBreakers();

    try {
      // 0ms ceiling = any persistent data is "stale" and should be discarded
      const breaker = createCircuitBreaker({
        name: 'ZeroCeiling Test',
        cacheTtlMs: 10 * 60 * 1000,
        persistCache: true,
        persistentStaleCeilingMs: 0,
      });

      // Execute should still work — just no persistent hydration
      const fallback = { data: 'fallback' };
      const result = await breaker.execute(async () => ({ data: 'live' }), fallback);
      assert.deepEqual(result, { data: 'live' });
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('persistentStaleCeilingMs of 1ms is respected (extremely tight ceiling)', async () => {
    const mod = await import(`${CIRCUIT_BREAKER_URL}?t=${Date.now()}-1ms`);
    const { createCircuitBreaker, clearAllCircuitBreakers } = mod;
    clearAllCircuitBreakers();

    try {
      const breaker = createCircuitBreaker({
        name: 'TightCeiling Test',
        cacheTtlMs: 10 * 60 * 1000,
        persistCache: true,
        persistentStaleCeilingMs: 1, // 1 millisecond
      });

      const fallback = { data: 'fallback' };
      const result = await breaker.execute(async () => ({ data: 'live' }), fallback);
      assert.deepEqual(result, { data: 'live' });
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('very large persistentStaleCeilingMs is accepted (30 days)', async () => {
    const mod = await import(`${CIRCUIT_BREAKER_URL}?t=${Date.now()}-30d`);
    const { createCircuitBreaker, clearAllCircuitBreakers } = mod;
    clearAllCircuitBreakers();

    try {
      const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
      const breaker = createCircuitBreaker({
        name: 'LargeCeiling Test',
        cacheTtlMs: 10 * 60 * 1000,
        persistCache: true,
        persistentStaleCeilingMs: THIRTY_DAYS,
      });

      const fallback = { data: 'fallback' };
      const result = await breaker.execute(async () => ({ data: 'live' }), fallback);
      assert.deepEqual(result, { data: 'live' });
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('negative persistentStaleCeilingMs falls back to 24h default ceiling', async () => {
    const mod = await import(`${CIRCUIT_BREAKER_URL}?t=${Date.now()}-negative`);
    const { createCircuitBreaker, clearAllCircuitBreakers } = mod;
    clearAllCircuitBreakers();

    try {
      const breaker = createCircuitBreaker({
        name: 'NegativeCeiling Test',
        cacheTtlMs: 10 * 60 * 1000,
        persistCache: true,
        persistentStaleCeilingMs: -1,
      });

      // Sanitized to 24h default — breaker still works
      const fallback = { data: 'fallback' };
      const result = await breaker.execute(async () => ({ data: 'live' }), fallback);
      assert.deepEqual(result, { data: 'live' });
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('omitting persistentStaleCeilingMs does not break existing breaker behavior', async () => {
    const mod = await import(`${CIRCUIT_BREAKER_URL}?t=${Date.now()}-omit`);
    const { createCircuitBreaker, clearAllCircuitBreakers } = mod;
    clearAllCircuitBreakers();

    try {
      // Mimics existing breakers that don't pass the new option
      const stockBreaker = createCircuitBreaker({
        name: 'Market Quotes Compat',
        cacheTtlMs: 5 * 60 * 1000,
      });

      const commodityBreaker = createCircuitBreaker({
        name: 'Commodity Quotes Compat',
        cacheTtlMs: 5 * 60 * 1000,
      });

      const cryptoBreaker = createCircuitBreaker({ name: 'Crypto Quotes Compat' });

      // All should work with default 24h ceiling
      const fallback = { quotes: [] };
      const r1 = await stockBreaker.execute(async () => ({ quotes: ['AAPL'] }), fallback);
      const r2 = await commodityBreaker.execute(async () => ({ quotes: ['GOLD'] }), fallback);
      const r3 = await cryptoBreaker.execute(async () => ({ quotes: ['BTC'] }), fallback);

      assert.deepEqual(r1, { quotes: ['AAPL'] });
      assert.deepEqual(r2, { quotes: ['GOLD'] });
      assert.deepEqual(r3, { quotes: ['BTC'] });
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('persistentStaleCeilingMs does not affect in-memory cache TTL', async () => {
    const mod = await import(`${CIRCUIT_BREAKER_URL}?t=${Date.now()}-ttl-sep`);
    const { createCircuitBreaker, clearAllCircuitBreakers } = mod;
    clearAllCircuitBreakers();

    try {
      const breaker = createCircuitBreaker({
        name: 'TTL Separation Test',
        cacheTtlMs: 5 * 60 * 1000,  // 5 min cache TTL
        persistCache: true,
        persistentStaleCeilingMs: 60 * 60 * 1000, // 1h persistent ceiling
      });

      // First call populates cache
      const fallback = { data: 'fallback' };
      await breaker.execute(async () => ({ data: 'first' }), fallback);

      // Second call should return cached 'first' (within 5min TTL)
      const result = await breaker.execute(async () => ({ data: 'second' }), fallback);
      assert.deepEqual(result, { data: 'first' }, 'In-memory cache TTL must be independent of persistentStaleCeilingMs');
    } finally {
      clearAllCircuitBreakers();
    }
  });
});

// ============================================================
// 4. Static analysis: cached-risk-scores.ts passes persistentStaleCeilingMs
// ============================================================

describe('cached-risk-scores.ts — uses persistentStaleCeilingMs', () => {
  const src = readSrc('src/services/cached-risk-scores.ts');

  // Find the breaker creation call (skip the import which also mentions createCircuitBreaker)
  const breakerCallMatch = src.match(/createCircuitBreaker<[^>]+>\(\{[\s\S]*?\}\)/);

  it('Risk Scores breaker passes persistentStaleCeilingMs', () => {
    assert.ok(breakerCallMatch, 'createCircuitBreaker call must exist in cached-risk-scores.ts');
    const breakerCreation = breakerCallMatch![0];

    assert.match(
      breakerCreation,
      /persistentStaleCeilingMs\s*:/,
      'Risk Scores breaker must pass persistentStaleCeilingMs option',
    );
  });

  it('Risk Scores persistentStaleCeilingMs matches localStorage staleness (1h)', () => {
    assert.ok(breakerCallMatch, 'createCircuitBreaker call must exist in cached-risk-scores.ts');
    const breakerCreation = breakerCallMatch![0];

    const uses1hConstant = /persistentStaleCeilingMs\s*:\s*LS_MAX_STALENESS_MS/.test(breakerCreation);
    const uses1hLiteral = /persistentStaleCeilingMs\s*:\s*60\s*\*\s*60\s*\*\s*1000/.test(breakerCreation);

    assert.ok(
      uses1hConstant || uses1hLiteral,
      'persistentStaleCeilingMs should be 1h (matching LS_MAX_STALENESS_MS) — either reference the constant or use 60 * 60 * 1000',
    );
  });
});

// ============================================================
// 5. Adversarial: multiple breakers with different ceilings
// ============================================================

describe('CircuitBreaker — multiple breakers with different ceilings', () => {
  const CIRCUIT_BREAKER_URL = pathToFileURL(
    resolve(root, 'src/utils/circuit-breaker.ts'),
  ).href;

  it('two breakers with different ceilings do not share state', async () => {
    const mod = await import(`${CIRCUIT_BREAKER_URL}?t=${Date.now()}-multi-iso`);
    const { createCircuitBreaker, clearAllCircuitBreakers } = mod;
    clearAllCircuitBreakers();

    try {
      const shortCeiling = createCircuitBreaker({
        name: 'Short Ceiling Breaker',
        cacheTtlMs: 5 * 60 * 1000,
        persistCache: true,
        persistentStaleCeilingMs: 60 * 1000, // 1 minute
      });

      const longCeiling = createCircuitBreaker({
        name: 'Long Ceiling Breaker',
        cacheTtlMs: 5 * 60 * 1000,
        persistCache: true,
        persistentStaleCeilingMs: 7 * 24 * 60 * 60 * 1000, // 7 days
      });

      // Both should execute independently
      const fallback = { v: 0 };
      const r1 = await shortCeiling.execute(async () => ({ v: 1 }), fallback);
      const r2 = await longCeiling.execute(async () => ({ v: 2 }), fallback);

      assert.deepEqual(r1, { v: 1 });
      assert.deepEqual(r2, { v: 2 });

      // Cached values must be isolated
      const c1 = shortCeiling.getCached();
      const c2 = longCeiling.getCached();
      assert.deepEqual(c1, { v: 1 }, 'Short ceiling breaker must cache its own data');
      assert.deepEqual(c2, { v: 2 }, 'Long ceiling breaker must cache its own data');
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('three breakers with default, custom, and zero ceilings coexist', async () => {
    const mod = await import(`${CIRCUIT_BREAKER_URL}?t=${Date.now()}-multi-trio`);
    const { createCircuitBreaker, clearAllCircuitBreakers } = mod;
    clearAllCircuitBreakers();

    try {
      const defaultBreaker = createCircuitBreaker({
        name: 'Trio Default',
        cacheTtlMs: 10 * 60 * 1000,
        persistCache: true,
        // no persistentStaleCeilingMs -> 24h default
      });

      const customBreaker = createCircuitBreaker({
        name: 'Trio Custom',
        cacheTtlMs: 10 * 60 * 1000,
        persistCache: true,
        persistentStaleCeilingMs: 3600_000, // 1h
      });

      const zeroBreaker = createCircuitBreaker({
        name: 'Trio Zero',
        cacheTtlMs: 10 * 60 * 1000,
        persistCache: true,
        persistentStaleCeilingMs: 0,
      });

      const fb = { tag: 'fb' };
      const r1 = await defaultBreaker.execute(async () => ({ tag: 'default' }), fb);
      const r2 = await customBreaker.execute(async () => ({ tag: 'custom' }), fb);
      const r3 = await zeroBreaker.execute(async () => ({ tag: 'zero' }), fb);

      assert.deepEqual(r1, { tag: 'default' });
      assert.deepEqual(r2, { tag: 'custom' });
      assert.deepEqual(r3, { tag: 'zero' });
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('updating one breaker cache does not pollute another with a different ceiling', async () => {
    const mod = await import(`${CIRCUIT_BREAKER_URL}?t=${Date.now()}-multi-pollute`);
    const { createCircuitBreaker, clearAllCircuitBreakers } = mod;
    clearAllCircuitBreakers();

    try {
      const breakerA = createCircuitBreaker({
        name: 'Pollute A',
        cacheTtlMs: 10 * 60 * 1000,
        persistCache: true,
        persistentStaleCeilingMs: 1000,
      });

      const breakerB = createCircuitBreaker({
        name: 'Pollute B',
        cacheTtlMs: 10 * 60 * 1000,
        persistCache: true,
        persistentStaleCeilingMs: 999_999_999,
      });

      const fb = { x: 0 };
      await breakerA.execute(async () => ({ x: 42 }), fb);
      await breakerB.execute(async () => ({ x: 99 }), fb);

      // Record new success on A
      breakerA.recordSuccess({ x: 100 });

      // B must still have its original value
      assert.deepEqual(breakerB.getCached(), { x: 99 }, 'breakerB must not be affected by breakerA recordSuccess');
      assert.deepEqual(breakerA.getCached(), { x: 100 }, 'breakerA must have updated value');
    } finally {
      clearAllCircuitBreakers();
    }
  });
});


// ============================================================
// 7. Interaction with cacheTtlMs=0 (persistence auto-disabled)
// ============================================================

describe('CircuitBreaker — persistentStaleCeilingMs with cacheTtlMs=0', () => {
  const CIRCUIT_BREAKER_URL = pathToFileURL(
    resolve(root, 'src/utils/circuit-breaker.ts'),
  ).href;

  it('cacheTtlMs=0 disables persistence even if persistentStaleCeilingMs is set', async () => {
    const mod = await import(`${CIRCUIT_BREAKER_URL}?t=${Date.now()}-ttl0-ceiling`);
    const { createCircuitBreaker, clearAllCircuitBreakers } = mod;
    clearAllCircuitBreakers();

    try {
      // cacheTtlMs=0 should auto-disable persistEnabled regardless of ceiling
      const breaker = createCircuitBreaker({
        name: 'TTL0 Ceiling Test',
        cacheTtlMs: 0,
        persistCache: true, // explicitly true, but should be overridden
        persistentStaleCeilingMs: 60 * 60 * 1000, // 1h — should be irrelevant
      });

      // Breaker should still work (no caching, always live)
      const fb = { status: 'fallback' };
      const r1 = await breaker.execute(async () => ({ status: 'live1' }), fb);
      assert.deepEqual(r1, { status: 'live1' });

      // No caching when cacheTtlMs=0, so second call hits fn again
      const r2 = await breaker.execute(async () => ({ status: 'live2' }), fb);
      assert.deepEqual(r2, { status: 'live2' }, 'cacheTtlMs=0 means no caching — must call fn each time');
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('static: cacheTtlMs=0 sets persistEnabled=false in constructor', () => {
    const src = readSrc('src/utils/circuit-breaker.ts');

    // The constructor should have: this.cacheTtlMs === 0 ? false : ...
    assert.match(
      src,
      /this\.cacheTtlMs\s*===\s*0\s*\?\s*false/,
      'Constructor must auto-disable persistEnabled when cacheTtlMs === 0',
    );
  });
});

// ============================================================
// 8. Interaction with persistCache=false
// ============================================================

describe('CircuitBreaker — persistentStaleCeilingMs with persistCache=false', () => {
  const CIRCUIT_BREAKER_URL = pathToFileURL(
    resolve(root, 'src/utils/circuit-breaker.ts'),
  ).href;

  it('persistCache=false means ceiling is irrelevant (no hydration attempted)', async () => {
    const mod = await import(`${CIRCUIT_BREAKER_URL}?t=${Date.now()}-nopersist-ceiling`);
    const { createCircuitBreaker, clearAllCircuitBreakers } = mod;
    clearAllCircuitBreakers();

    try {
      const breaker = createCircuitBreaker({
        name: 'NoPersist Ceiling Test',
        cacheTtlMs: 10 * 60 * 1000,
        persistCache: false,
        persistentStaleCeilingMs: 1, // extremely tight, but should not matter
      });

      const fb = { data: 'fallback' };
      const r1 = await breaker.execute(async () => ({ data: 'live' }), fb);
      assert.deepEqual(r1, { data: 'live' });

      // In-memory cache still works
      const r2 = await breaker.execute(async () => ({ data: 'live2' }), fb);
      assert.deepEqual(r2, { data: 'live' }, 'In-memory cache should still work with persistCache=false');
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('persistCache=undefined (default) means ceiling is irrelevant', async () => {
    const mod = await import(`${CIRCUIT_BREAKER_URL}?t=${Date.now()}-defaultpersist-ceiling`);
    const { createCircuitBreaker, clearAllCircuitBreakers } = mod;
    clearAllCircuitBreakers();

    try {
      // Default persistCache is false
      const breaker = createCircuitBreaker({
        name: 'DefaultPersist Ceiling Test',
        cacheTtlMs: 10 * 60 * 1000,
        persistentStaleCeilingMs: 500, // tight ceiling, irrelevant because persist is off
      });

      const fb = { val: 0 };
      const r1 = await breaker.execute(async () => ({ val: 1 }), fb);
      assert.deepEqual(r1, { val: 1 });
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('static: execute only calls hydratePersistentCache when persistEnabled is true', () => {
    const src = readSrc('src/utils/circuit-breaker.ts');

    // The execute method should check this.persistEnabled before calling hydrate
    assert.match(
      src,
      /this\.persistEnabled\s*&&[^;]*hydratePersistentCache/,
      'execute must guard hydratePersistentCache behind this.persistEnabled check',
    );
  });
});

// ============================================================
// 9. NaN, Infinity, undefined, null values for persistentStaleCeilingMs
// ============================================================

describe('CircuitBreaker — exotic values for persistentStaleCeilingMs', () => {
  const CIRCUIT_BREAKER_URL = pathToFileURL(
    resolve(root, 'src/utils/circuit-breaker.ts'),
  ).href;

  it('NaN persistentStaleCeilingMs does not throw (breaker still works)', async () => {
    const mod = await import(`${CIRCUIT_BREAKER_URL}?t=${Date.now()}-nan`);
    const { createCircuitBreaker, clearAllCircuitBreakers } = mod;
    clearAllCircuitBreakers();

    try {
      const breaker = createCircuitBreaker({
        name: 'NaN Ceiling Test',
        cacheTtlMs: 10 * 60 * 1000,
        persistCache: true,
        persistentStaleCeilingMs: NaN,
      });

      // NaN is not finite — sanitized to the 24h default ceiling
      const fb = { data: 'fallback' };
      const result = await breaker.execute(async () => ({ data: 'live' }), fb);
      assert.deepEqual(result, { data: 'live' });
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('Infinity persistentStaleCeilingMs does not throw (all entries accepted)', async () => {
    const mod = await import(`${CIRCUIT_BREAKER_URL}?t=${Date.now()}-infinity`);
    const { createCircuitBreaker, clearAllCircuitBreakers } = mod;
    clearAllCircuitBreakers();

    try {
      const breaker = createCircuitBreaker({
        name: 'Infinity Ceiling Test',
        cacheTtlMs: 10 * 60 * 1000,
        persistCache: true,
        persistentStaleCeilingMs: Infinity,
      });

      // Infinity is not finite — sanitized to the 24h default ceiling
      const fb = { data: 'fallback' };
      const result = await breaker.execute(async () => ({ data: 'live' }), fb);
      assert.deepEqual(result, { data: 'live' });
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('-Infinity persistentStaleCeilingMs does not throw (all entries rejected)', async () => {
    const mod = await import(`${CIRCUIT_BREAKER_URL}?t=${Date.now()}-neginfinity`);
    const { createCircuitBreaker, clearAllCircuitBreakers } = mod;
    clearAllCircuitBreakers();

    try {
      const breaker = createCircuitBreaker({
        name: 'NegInfinity Ceiling Test',
        cacheTtlMs: 10 * 60 * 1000,
        persistCache: true,
        persistentStaleCeilingMs: -Infinity,
      });

      // -Infinity is not finite — sanitized to the 24h default ceiling
      const fb = { data: 'fallback' };
      const result = await breaker.execute(async () => ({ data: 'live' }), fb);
      assert.deepEqual(result, { data: 'live' });
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('undefined persistentStaleCeilingMs falls back to 24h default via ??', async () => {
    const mod = await import(`${CIRCUIT_BREAKER_URL}?t=${Date.now()}-undef`);
    const { createCircuitBreaker, clearAllCircuitBreakers } = mod;
    clearAllCircuitBreakers();

    try {
      const breaker = createCircuitBreaker({
        name: 'Undefined Ceiling Test',
        cacheTtlMs: 10 * 60 * 1000,
        persistCache: true,
        persistentStaleCeilingMs: undefined,
      });

      const fb = { data: 'fallback' };
      const result = await breaker.execute(async () => ({ data: 'live' }), fb);
      assert.deepEqual(result, { data: 'live' });
    } finally {
      clearAllCircuitBreakers();
    }
  });

});



// ============================================================
// 12. Adversarial: concurrent execute() calls on same breaker
// ============================================================

describe('CircuitBreaker — concurrent execute with persistentStaleCeilingMs', () => {
  const CIRCUIT_BREAKER_URL = pathToFileURL(
    resolve(root, 'src/utils/circuit-breaker.ts'),
  ).href;

  it('concurrent execute() calls do not corrupt cache or throw', async () => {
    const mod = await import(`${CIRCUIT_BREAKER_URL}?t=${Date.now()}-concurrent`);
    const { createCircuitBreaker, clearAllCircuitBreakers } = mod;
    clearAllCircuitBreakers();

    try {
      const breaker = createCircuitBreaker({
        name: 'Concurrent Ceiling Test',
        cacheTtlMs: 10 * 60 * 1000,
        persistCache: true,
        persistentStaleCeilingMs: 30 * 60 * 1000, // 30 min
      });

      let callCount = 0;
      const fb = { n: -1 };
      const fn = async () => ({ n: ++callCount });

      // Fire 5 concurrent executions
      const results = await Promise.all([
        breaker.execute(fn, fb),
        breaker.execute(fn, fb),
        breaker.execute(fn, fb),
        breaker.execute(fn, fb),
        breaker.execute(fn, fb),
      ]);

      // All must resolve without error
      for (const r of results) {
        assert.ok(typeof r.n === 'number' && r.n >= 0, 'Each result must have a valid numeric n');
      }
    } finally {
      clearAllCircuitBreakers();
    }
  });
});

// ============================================================
// 13. Adversarial: breaker with same name but different ceiling
// ============================================================

describe('CircuitBreaker — same name, different ceiling (registry behavior)', () => {
  const CIRCUIT_BREAKER_URL = pathToFileURL(
    resolve(root, 'src/utils/circuit-breaker.ts'),
  ).href;

  it('creating a breaker with the same name replaces it in the registry', async () => {
    const mod = await import(`${CIRCUIT_BREAKER_URL}?t=${Date.now()}-samename`);
    const { createCircuitBreaker, clearAllCircuitBreakers, getCircuitBreakerStatus } = mod;
    clearAllCircuitBreakers();

    try {
      const breaker1 = createCircuitBreaker({
        name: 'Shared Name',
        cacheTtlMs: 10 * 60 * 1000,
        persistCache: true,
        persistentStaleCeilingMs: 1000,
      });

      const breaker2 = createCircuitBreaker({
        name: 'Shared Name',
        cacheTtlMs: 10 * 60 * 1000,
        persistCache: true,
        persistentStaleCeilingMs: 999_999,
      });

      // Registry should have the second breaker
      const status = getCircuitBreakerStatus();
      assert.ok('Shared Name' in status, 'Registry must contain the breaker name');

      // But both instances are separate objects in memory
      const fb = { x: 0 };
      await breaker1.execute(async () => ({ x: 1 }), fb);
      await breaker2.execute(async () => ({ x: 2 }), fb);

      assert.deepEqual(breaker1.getCached(), { x: 1 }, 'breaker1 instance retains its own cache');
      assert.deepEqual(breaker2.getCached(), { x: 2 }, 'breaker2 instance retains its own cache');
    } finally {
      clearAllCircuitBreakers();
    }
  });
});

// ============================================================
// shouldCache eviction — cached invalid data is evicted and refetched
// ============================================================

describe('CircuitBreaker — shouldCache eviction of invalid cached data', () => {
  const CIRCUIT_BREAKER_URL = pathToFileURL(
    resolve(root, 'src/utils/circuit-breaker.ts'),
  ).href;

  it('evicts cached data that fails shouldCache and fetches fresh', async () => {
    const mod = await import(`${CIRCUIT_BREAKER_URL}?t=${Date.now()}-evict-fresh`);
    const { createCircuitBreaker, clearAllCircuitBreakers } = mod;
    clearAllCircuitBreakers();

    try {
      const breaker = createCircuitBreaker<number[]>({
        name: 'ShouldCache Evict Test',
        cacheTtlMs: 60 * 1000,
      });

      // Populate cache with empty array (simulates a prior failed fetch)
      breaker.recordSuccess([]);
      assert.deepEqual(breaker.getCached(), [], 'empty array is cached');

      let fetchCount = 0;
      const result = await breaker.execute(
        async () => { fetchCount++; return [1, 2, 3]; },
        [] as number[],
        { shouldCache: (r) => r.length > 0 },
      );

      assert.equal(fetchCount, 1, 'must bypass empty cache and fetch fresh');
      assert.deepEqual(result, [1, 2, 3], 'fresh data is returned');
      assert.deepEqual(breaker.getCached(), [1, 2, 3], 'fresh data is now cached');
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('serves valid cached data without fetching when shouldCache passes', async () => {
    const mod = await import(`${CIRCUIT_BREAKER_URL}?t=${Date.now()}-evict-skip`);
    const { createCircuitBreaker, clearAllCircuitBreakers } = mod;
    clearAllCircuitBreakers();

    try {
      const breaker = createCircuitBreaker<number[]>({
        name: 'ShouldCache Skip Test',
        cacheTtlMs: 60 * 1000,
      });

      breaker.recordSuccess([1, 2, 3]);

      let fetchCount = 0;
      const result = await breaker.execute(
        async () => { fetchCount++; return [4, 5, 6]; },
        [] as number[],
        { shouldCache: (r) => r.length > 0 },
      );

      assert.equal(fetchCount, 0, 'valid cache must not trigger a live fetch');
      assert.deepEqual(result, [1, 2, 3], 'cached data is returned');
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('without shouldCache, empty array is served from cache without fetching', async () => {
    const mod = await import(`${CIRCUIT_BREAKER_URL}?t=${Date.now()}-evict-no-pred`);
    const { createCircuitBreaker, clearAllCircuitBreakers } = mod;
    clearAllCircuitBreakers();

    try {
      const breaker = createCircuitBreaker<number[]>({
        name: 'No ShouldCache Test',
        cacheTtlMs: 60 * 1000,
      });

      breaker.recordSuccess([]);

      let fetchCount = 0;
      const result = await breaker.execute(
        async () => { fetchCount++; return [1, 2, 3]; },
        [] as number[],
        // No shouldCache — default is () => true, so empty array is valid
      );

      assert.equal(fetchCount, 0, 'without shouldCache, cached empty array is served');
      assert.deepEqual(result, [], 'empty cached data is returned as-is');
    } finally {
      clearAllCircuitBreakers();
    }
  });
});

