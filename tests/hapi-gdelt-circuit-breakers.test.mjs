/**
 * Regression tests for split GDELT circuit breakers (PR #879).
 *
 * Root cause: two instances of the shared-breaker anti-pattern fixed in the same
 * audit pass that caught the World Bank breaker bug (PR #877):
 *
 * gdeltBreaker was shared between fetchGdeltArticles (military/conflict
 *      queries, 10-min cache) and fetchPositiveGdeltArticles (peace/humanitarian queries,
 *      different topic set). Failures in one function silenced the other, and the 10-min
 *      cache stored whichever query ran last, poisoning the other function's results.
 *      Fix: positiveGdeltBreaker — dedicated breaker for the positive sentiment path.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const readSrc = (relPath) => readFileSync(resolve(root, relPath), 'utf-8');

// ============================================================
// 1. Static analysis: gdelt-intel.ts — split breakers per query type
// ============================================================

describe('gdelt-intel.ts — dedicated circuit breakers per GDELT query type', () => {
  const src = readSrc('src/services/gdelt-intel.ts');

  // Scoped function body slices
  const posStart = src.indexOf('export async function fetchPositiveGdeltArticles');
  assert.ok(posStart !== -1, 'fetchPositiveGdeltArticles not found in gdelt-intel.ts — was it renamed?');
  const posBody = src.slice(posStart, src.indexOf('\nexport ', posStart + 1));
  const regStart = src.indexOf('export async function fetchGdeltArticles');
  assert.ok(regStart !== -1, 'fetchGdeltArticles not found in gdelt-intel.ts — was it renamed?');
  const regBody = src.slice(regStart, src.indexOf('\nexport ', regStart + 1));

  it('has a dedicated positiveGdeltBreaker separate from gdeltBreaker', () => {
    assert.match(
      src,
      /\bpositiveGdeltBreaker\s*=\s*createCircuitBreaker/,
      'positiveGdeltBreaker must be a separate createCircuitBreaker instance',
    );
  });

  it('GDELT breakers have distinct names', () => {
    assert.match(
      src,
      /GDELT Intelligence/,
      'gdeltBreaker must have name "GDELT Intelligence"',
    );
    assert.match(
      src,
      /GDELT Positive/,
      'positiveGdeltBreaker must have name "GDELT Positive"',
    );
  });

  it('fetchGdeltArticles uses gdeltBreaker, NOT positiveGdeltBreaker', () => {
    assert.match(
      regBody,
      /gdeltBreaker\.execute/,
      'fetchGdeltArticles must use gdeltBreaker.execute',
    );
    assert.doesNotMatch(
      regBody,
      /positiveGdeltBreaker\.execute/,
      'fetchGdeltArticles must NOT use positiveGdeltBreaker',
    );
  });

  it('fetchPositiveGdeltArticles uses positiveGdeltBreaker, NOT gdeltBreaker', () => {
    assert.match(
      posBody,
      /positiveGdeltBreaker\.execute/,
      'fetchPositiveGdeltArticles must use positiveGdeltBreaker.execute',
    );
    // word-boundary prevents matching `positiveGdeltBreaker.execute`
    assert.doesNotMatch(
      posBody,
      /\bgdeltBreaker\.execute/,
      'fetchPositiveGdeltArticles must NOT use gdeltBreaker (only positiveGdeltBreaker)',
    );
  });
});

// ============================================================
// 2. Behavioral: circuit breaker isolation
// ============================================================

describe('CircuitBreaker isolation — GDELT split breaker independence', () => {
  const CIRCUIT_BREAKER_URL = pathToFileURL(
    resolve(root, 'src/utils/circuit-breaker.ts'),
  ).href;

  it('GDELT: positive breaker failure does not trip regular breaker', async () => {
    const { createCircuitBreaker, clearAllCircuitBreakers } = await import(
      `${CIRCUIT_BREAKER_URL}?t=${Date.now()}`
    );

    clearAllCircuitBreakers();

    try {
      const gdelt = createCircuitBreaker({ name: 'GDELT Intelligence', cacheTtlMs: 10 * 60 * 1000 });
      const positive = createCircuitBreaker({ name: 'GDELT Positive', cacheTtlMs: 10 * 60 * 1000 });

      const fallback = { articles: [], totalArticles: 0 };
      const alwaysFail = () => { throw new Error('GDELT API unavailable'); };

      // Force positive breaker into cooldown (2 failures)
      await positive.execute(alwaysFail, fallback); // failure 1
      await positive.execute(alwaysFail, fallback); // failure 2 → cooldown
      assert.equal(positive.isOnCooldown(), true, 'positive breaker should be on cooldown after 2 failures');

      // gdelt breaker must NOT be affected
      assert.equal(gdelt.isOnCooldown(), false, 'gdelt breaker must not be on cooldown when positive fails');

      // gdelt should still call through successfully
      const realArticles = { articles: [{ url: 'https://news.example/military', title: 'Conflict update' }], totalArticles: 1 };
      const result = await gdelt.execute(async () => realArticles, fallback);
      assert.deepEqual(result, realArticles, 'gdelt breaker should return live data unaffected by positive cooldown');
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('GDELT: regular and positive breakers cache different data independently', async () => {
    const { createCircuitBreaker, clearAllCircuitBreakers } = await import(
      `${CIRCUIT_BREAKER_URL}?t=${Date.now()}`
    );

    clearAllCircuitBreakers();

    try {
      const gdelt = createCircuitBreaker({ name: 'GDELT Intelligence', cacheTtlMs: 10 * 60 * 1000 });
      const positive = createCircuitBreaker({ name: 'GDELT Positive', cacheTtlMs: 10 * 60 * 1000 });

      const fallback = { articles: [], totalArticles: 0 };
      const militaryData = { articles: [{ url: 'https://news.example/military', title: 'Military operations' }], totalArticles: 1 };
      const peaceData    = { articles: [{ url: 'https://good.example/peace', title: 'Peace agreement' }], totalArticles: 1 };

      // Populate both caches with different data
      await gdelt.execute(async () => militaryData, fallback);
      await positive.execute(async () => peaceData, fallback);

      // Each must return its own cached value; pass fallback fn that would return wrong data
      const cachedGdelt    = await gdelt.execute(async () => fallback, fallback);
      const cachedPositive = await positive.execute(async () => fallback, fallback);

      assert.ok(
        cachedGdelt.articles[0]?.url.includes('military'),
        'gdelt cache must return military article URL, not peace article',
      );
      assert.ok(
        cachedPositive.articles[0]?.url.includes('peace'),
        'positive cache must return peace article URL, not military article',
      );
      assert.notEqual(
        cachedGdelt.articles[0]?.url,
        cachedPositive.articles[0]?.url,
        'Cached article URLs must be distinct per breaker (no cross-contamination)',
      );
    } finally {
      clearAllCircuitBreakers();
    }
  });
});
