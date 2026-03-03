/**
 * Regression tests for HAPI per-country and GDELT split circuit breakers (PR #879).
 *
 * Root cause: two instances of the shared-breaker anti-pattern fixed in the same
 * audit pass that caught the World Bank breaker bug (PR #877):
 *
 *   1. hapiBreaker — single shared breaker used in a Promise.allSettled loop over
 *      20 countries. 2 failures in any country tripped the breaker for ALL countries,
 *      and the last country's result overwrote the cache for every other country.
 *      Fix: getHapiBreaker(iso2) Map — one breaker per ISO2 country code.
 *
 *   2. gdeltBreaker — one breaker shared between fetchGdeltArticles (military/conflict
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

// Shared URL for dynamic imports in behavioral tests
const CIRCUIT_BREAKER_URL = pathToFileURL(
  resolve(root, 'src/utils/circuit-breaker.ts'),
).href;

// ============================================================
// 1. Static analysis: conflict/index.ts — per-country HAPI breakers
// ============================================================

describe('conflict/index.ts — per-country HAPI circuit breakers', () => {
  const src = readSrc('src/services/conflict/index.ts');

  // Scoped function body slice — guard against rename/removal silently broadening scope
  const fnStart = src.indexOf('export async function fetchHapiSummary');
  assert.ok(fnStart !== -1, 'fetchHapiSummary must exist in conflict/index.ts');
  const fnBody = src.slice(fnStart, src.indexOf('\nexport ', fnStart + 1));

  it('does NOT have a single shared hapiBreaker', () => {
    assert.doesNotMatch(
      src,
      /\bconst\s+hapiBreaker\s*=/,
      'Single shared hapiBreaker must not exist — use getHapiBreaker(iso2) instead',
    );
  });

  it('has a hapiBreakers Map for per-country instances', () => {
    // Check src directly — pattern is specific enough to avoid false positives
    assert.match(
      src,
      /\bhapiBreakers\s*=\s*new\s+Map/,
      'hapiBreakers Map must exist to store per-country circuit breakers',
    );
  });

  it('has a getHapiBreaker(iso2) factory function', () => {
    assert.match(
      src,
      /function\s+getHapiBreaker\s*\(\s*iso2/,
      'getHapiBreaker(iso2) factory function must exist',
    );
  });

  it('fetchHapiSummary calls getHapiBreaker(iso2).execute not a shared breaker', () => {
    assert.match(
      fnBody,
      /getHapiBreaker\s*\(\s*iso2\s*\)\s*\.execute/,
      'fetchHapiSummary must use getHapiBreaker(iso2).execute, not a shared hapiBreaker',
    );
  });

  it('per-country breaker names embed iso2', () => {
    // Check src directly — template literal is specific enough without window slicing
    assert.match(
      src,
      /name\s*:\s*`HDX HAPI:\$\{iso2\}`/,
      'Breaker name must embed iso2 (e.g. "HDX HAPI:US") for unique IndexedDB persistence per country',
    );
  });
});

// ============================================================
// 2. Static analysis: gdelt-intel.ts — split breakers per query type
// ============================================================

describe('gdelt-intel.ts — dedicated circuit breakers per GDELT query type', () => {
  const src = readSrc('src/services/gdelt-intel.ts');

  // Scoped function body slices — guard against rename/removal silently broadening scope
  const posStart = src.indexOf('export async function fetchPositiveGdeltArticles');
  assert.ok(posStart !== -1, 'fetchPositiveGdeltArticles must exist in gdelt-intel.ts');
  const posBody = src.slice(posStart, src.indexOf('\nexport ', posStart + 1));

  const regStart = src.indexOf('export async function fetchGdeltArticles');
  assert.ok(regStart !== -1, 'fetchGdeltArticles must exist in gdelt-intel.ts');
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
    // \b word-boundary ensures `positiveGdeltBreaker.execute` (uppercase G) is not matched
    assert.doesNotMatch(
      posBody,
      /\bgdeltBreaker\.execute/,
      'fetchPositiveGdeltArticles must NOT use gdeltBreaker (only positiveGdeltBreaker)',
    );
  });
});

// ============================================================
// 3. Behavioral: circuit breaker isolation
// ============================================================

describe('CircuitBreaker isolation — HAPI per-country independence', () => {
  it('HAPI: failure in one country does not trip another', async () => {
    const { createCircuitBreaker, clearAllCircuitBreakers } = await import(
      `${CIRCUIT_BREAKER_URL}?t=${Date.now()}`
    );

    clearAllCircuitBreakers();
    try {
      const breakerUS = createCircuitBreaker({ name: 'HDX HAPI:US', cacheTtlMs: 30 * 60 * 1000 });
      const breakerRU = createCircuitBreaker({ name: 'HDX HAPI:RU', cacheTtlMs: 30 * 60 * 1000 });

      const fallback = { summary: null };
      const alwaysFail = () => { throw new Error('HDX HAPI unavailable'); };

      // Default maxFailures is 2 — force breakerUS into cooldown
      await breakerUS.execute(alwaysFail, fallback); // failure 1
      await breakerUS.execute(alwaysFail, fallback); // failure 2 → cooldown
      assert.equal(breakerUS.isOnCooldown(), true, 'breakerUS should be on cooldown after 2 failures');

      // breakerRU must NOT be affected
      assert.equal(breakerRU.isOnCooldown(), false, 'breakerRU must not be on cooldown when breakerUS fails');

      // breakerRU should still call through successfully
      const goodData = { summary: { countryCode: 'RU', conflictEvents: 12, displacedPersons: 5000 } };
      const result = await breakerRU.execute(async () => goodData, fallback);
      assert.deepEqual(result, goodData, 'breakerRU should return live data unaffected by breakerUS cooldown');
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('HAPI: different countries cache independently (no cross-country poisoning)', async () => {
    const { createCircuitBreaker, clearAllCircuitBreakers } = await import(
      `${CIRCUIT_BREAKER_URL}?t=${Date.now()}`
    );

    clearAllCircuitBreakers();
    try {
      const breakerUS = createCircuitBreaker({ name: 'HDX HAPI:US', cacheTtlMs: 30 * 60 * 1000 });
      const breakerRU = createCircuitBreaker({ name: 'HDX HAPI:RU', cacheTtlMs: 30 * 60 * 1000 });

      const fallback = { summary: null };
      const usData = { summary: { countryCode: 'US', conflictEvents: 3, displacedPersons: 100 } };
      const ruData = { summary: { countryCode: 'RU', conflictEvents: 47, displacedPersons: 120000 } };

      // Populate both caches with different data
      await breakerUS.execute(async () => usData, fallback);
      await breakerRU.execute(async () => ruData, fallback);

      // Each must return its own cached value; pass a fallback fn that would return wrong data
      const cachedUS = await breakerUS.execute(async () => fallback, fallback);
      const cachedRU = await breakerRU.execute(async () => fallback, fallback);

      assert.equal(cachedUS.summary?.countryCode, 'US',
        'breakerUS cache must return US data, not RU data');
      assert.equal(cachedRU.summary?.countryCode, 'RU',
        'breakerRU cache must return RU data, not US data');
      assert.notEqual(cachedUS.summary?.conflictEvents, cachedRU.summary?.conflictEvents,
        'Cached conflict event counts must be independent per country');
    } finally {
      clearAllCircuitBreakers();
    }
  });
});

describe('CircuitBreaker isolation — GDELT split breaker independence', () => {
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

      // Default maxFailures is 2 — force positive breaker into cooldown
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
