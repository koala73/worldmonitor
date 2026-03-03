/**
 * Regression tests for Tech Readiness Index "No data available" bug.
 *
 * Root cause: a single shared `wbBreaker` was used for all 4 World Bank
 * indicator RPC calls (IT.NET.USER.ZS, IT.CEL.SETS.P2, IT.NET.BBND.P2,
 * GB.XPD.RSDV.GD.ZS). This caused:
 *   1. Cache poisoning  — last parallel call's result overwrote cache;
 *      subsequent refreshes returned wrong indicator data for all 4 calls.
 *   2. Cascading failures — 2 failures in any one indicator tripped the
 *      breaker and silenced all 4, returning emptyWbFallback ({ data: [] }).
 *   3. Persistent empty data — server returning { data: [] } during a
 *      transient WB API hiccup caused recordSuccess({ data: [] }), which
 *      persisted to IndexedDB as "breaker:World Bank". On next page load
 *      hydratePersistentCache restored { data: [] }, and all 4 calls
 *      returned empty → allCountries was empty → scores = [] → panel showed
 *      "No data available".
 *
 * Fix: replace single wbBreaker with getWbBreaker(indicatorCode) map,
 * identical to the existing getFredBreaker(seriesId) pattern.
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
// 1. Static analysis: source structure guarantees
// ============================================================

describe('economic/index.ts — per-indicator World Bank circuit breakers', () => {
  const src = readSrc('src/services/economic/index.ts');

  it('does NOT have a single shared wbBreaker', () => {
    // The old bug: `const wbBreaker = createCircuitBreaker<...>({ name: 'World Bank', ... })`
    assert.doesNotMatch(
      src,
      /\bconst\s+wbBreaker\s*=/,
      'Single shared wbBreaker must not exist — use getWbBreaker(indicatorCode) instead',
    );
  });

  it('has a wbBreakers Map for per-indicator instances', () => {
    assert.match(
      src,
      /\bwbBreakers\s*=\s*new\s+Map/,
      'wbBreakers Map must exist to store per-indicator circuit breakers',
    );
  });

  it('has a getWbBreaker(indicatorCode) factory function', () => {
    assert.match(
      src,
      /function\s+getWbBreaker\s*\(\s*indicatorCode/,
      'getWbBreaker(indicatorCode) factory function must exist',
    );
  });

  it('getIndicatorData calls getWbBreaker(indicator) not a shared breaker', () => {
    assert.match(
      src,
      /getWbBreaker\s*\(\s*indicator\s*\)\s*\.execute/,
      'getIndicatorData must use getWbBreaker(indicator).execute, not a shared wbBreaker',
    );
  });

  it('per-indicator breaker names include the indicator code', () => {
    // name: `WB:${indicatorCode}` — ensures distinct IndexedDB keys per indicator
    assert.match(
      src,
      /name\s*:\s*`WB:\$\{indicatorCode\}`/,
      'Breaker name must embed indicatorCode (e.g. "WB:IT.NET.USER.ZS") for unique IndexedDB persistence',
    );
  });

  it('mirrors getFredBreaker pattern (consistency check)', () => {
    // getFredBreaker already uses this pattern correctly — wbBreaker must follow suit
    assert.match(src, /getFredBreaker\s*\(/, 'getFredBreaker pattern must still exist as reference');
    assert.match(src, /getWbBreaker\s*\(/, 'getWbBreaker must mirror getFredBreaker');

    // Both should use a Map
    const fredBreakerSection = src.slice(
      src.indexOf('fredBreakers'),
      src.indexOf('fredBreakers') + 300,
    );
    const wbBreakerSection = src.slice(
      src.indexOf('wbBreakers'),
      src.indexOf('wbBreakers') + 300,
    );
    assert.match(fredBreakerSection, /new\s+Map/, 'fredBreakers uses Map');
    assert.match(wbBreakerSection, /new\s+Map/, 'wbBreakers uses Map');
  });
});

// ============================================================
// 2. Behavioral: circuit breaker isolation
// ============================================================

describe('CircuitBreaker isolation — independent per-indicator instances', () => {
  const CIRCUIT_BREAKER_URL = pathToFileURL(
    resolve(root, 'src/utils/circuit-breaker.ts'),
  ).href;

  it('two breakers with different names are independent (failure in one does not trip the other)', async () => {
    const { createCircuitBreaker, clearAllCircuitBreakers } = await import(
      `${CIRCUIT_BREAKER_URL}?t=${Date.now()}`
    );

    clearAllCircuitBreakers();

    const breakerA = createCircuitBreaker({ name: 'WB:IT.NET.USER.ZS', cacheTtlMs: 30 * 60 * 1000 });
    const breakerB = createCircuitBreaker({ name: 'WB:IT.CEL.SETS.P2', cacheTtlMs: 30 * 60 * 1000 });

    const fallback = { data: [], pagination: undefined };
    let callCount = 0;

    // Force breakerA into cooldown (2 failures = maxFailures)
    const alwaysFail = () => { callCount++; throw new Error('World Bank unavailable'); };
    await breakerA.execute(alwaysFail, fallback); // failure 1
    await breakerA.execute(alwaysFail, fallback); // failure 2 → cooldown
    assert.equal(breakerA.isOnCooldown(), true, 'breakerA should be on cooldown after 2 failures');

    // breakerB must NOT be affected
    assert.equal(breakerB.isOnCooldown(), false, 'breakerB must not be on cooldown when breakerA fails');

    // breakerB should still call through successfully
    const goodData = { data: [{ countryCode: 'USA', countryName: 'United States', indicatorCode: 'IT.CEL.SETS.P2', indicatorName: 'Mobile', year: 2023, value: 120 }], pagination: undefined };
    const result = await breakerB.execute(async () => goodData, fallback);
    assert.deepEqual(result, goodData, 'breakerB should return live data unaffected by breakerA cooldown');

    clearAllCircuitBreakers();
  });

  it('two breakers with different names cache independently (no cross-indicator cache poisoning)', async () => {
    const { createCircuitBreaker, clearAllCircuitBreakers } = await import(
      `${CIRCUIT_BREAKER_URL}?t=${Date.now()}`
    );

    clearAllCircuitBreakers();

    const breakerA = createCircuitBreaker({ name: 'WB:IT.NET.USER.ZS', cacheTtlMs: 30 * 60 * 1000 });
    const breakerB = createCircuitBreaker({ name: 'WB:IT.CEL.SETS.P2', cacheTtlMs: 30 * 60 * 1000 });

    const fallback = { data: [], pagination: undefined };
    const internetData = { data: [{ countryCode: 'USA', indicatorCode: 'IT.NET.USER.ZS', year: 2023, value: 90 }], pagination: undefined };
    const mobileData   = { data: [{ countryCode: 'USA', indicatorCode: 'IT.CEL.SETS.P2', year: 2023, value: 120 }], pagination: undefined };

    // Populate both caches with different data
    await breakerA.execute(async () => internetData, fallback);
    await breakerB.execute(async () => mobileData, fallback);

    // Each must return its own cached value, not the other's
    const cachedA = await breakerA.execute(async () => fallback, fallback);
    const cachedB = await breakerB.execute(async () => fallback, fallback);

    assert.equal(cachedA.data[0]?.indicatorCode, 'IT.NET.USER.ZS',
      'breakerA cache must return internet data, not mobile data');
    assert.equal(cachedB.data[0]?.indicatorCode, 'IT.CEL.SETS.P2',
      'breakerB cache must return mobile data, not internet data');
    assert.notEqual(cachedA.data[0]?.value, cachedB.data[0]?.value,
      'Cached values must be independent per indicator');

    clearAllCircuitBreakers();
  });

  it('empty server response does not poison the cache for other indicators', async () => {
    const { createCircuitBreaker, clearAllCircuitBreakers } = await import(
      `${CIRCUIT_BREAKER_URL}?t=${Date.now()}`
    );

    clearAllCircuitBreakers();

    const breakerA = createCircuitBreaker({ name: 'WB:IT.NET.USER.ZS', cacheTtlMs: 30 * 60 * 1000 });
    const breakerB = createCircuitBreaker({ name: 'WB:IT.CEL.SETS.P2', cacheTtlMs: 30 * 60 * 1000 });

    const fallback = { data: [], pagination: undefined };
    const emptyResponse = { data: [], pagination: undefined }; // what server returns on WB API hiccup
    const goodData = { data: [{ countryCode: 'DEU', indicatorCode: 'IT.CEL.SETS.P2', year: 2023, value: 130 }], pagination: undefined };

    // breakerA caches empty data (the bug scenario: server had a hiccup)
    await breakerA.execute(async () => emptyResponse, fallback);
    const cachedA = breakerA.getCached();
    assert.deepEqual(cachedA?.data, [], 'breakerA caches empty array from server hiccup');

    // breakerB must not be affected — should fetch fresh data
    const resultB = await breakerB.execute(async () => goodData, fallback);
    assert.equal(resultB.data.length, 1, 'breakerB returns real data unaffected by breakerA empty cache');
    assert.equal(resultB.data[0]?.indicatorCode, 'IT.CEL.SETS.P2');

    clearAllCircuitBreakers();
  });
});

// ============================================================
// 3. getTechReadinessRankings: non-empty result requires at least partial data
// ============================================================

describe('getTechReadinessRankings — result is empty only when ALL indicators return no data', () => {
  const src = readSrc('src/services/economic/index.ts');

  it('allCountries union covers data from all 4 indicators', () => {
    // The function must collect country codes from ALL 4 indicator responses
    // by iterating over latestByCountry from each
    const fnStart = src.indexOf('export async function getTechReadinessRankings');
    const fnEnd = src.indexOf('\nexport ', fnStart + 1);
    const fnBody = src.slice(fnStart, fnEnd !== -1 ? fnEnd : fnStart + 3000);

    assert.match(fnBody, /allCountries\s*=\s*new\s+Set/,
      'Must build allCountries Set from all indicator responses');
    assert.match(fnBody, /internet.*mobile.*broadband.*rdSpend|Promise\.all/,
      'Must fetch all 4 indicators in parallel');
    assert.match(fnBody, /latestByCountry/,
      'Must use latestByCountry from each indicator response');
  });

  it('uses 4 distinct indicator codes', () => {
    // If these change, the panel will silently break
    assert.match(src, /'IT\.NET\.USER\.ZS'/, 'Internet Users indicator must be present');
    assert.match(src, /'IT\.CEL\.SETS\.P2'/, 'Mobile Subscriptions indicator must be present');
    assert.match(src, /'IT\.NET\.BBND\.P2'/, 'Fixed Broadband indicator must be present');
    assert.match(src, /'GB\.XPD\.RSDV\.GD\.ZS'/, 'R&D Expenditure indicator must be present');
  });
});
