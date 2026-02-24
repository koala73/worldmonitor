/**
 * Tests for infrastructure cost optimizations — Round 2 (PR #275).
 *
 * Covers:
 * - TTL alignment (climate 30min→3h, fire 30min→1h)
 * - ACLED shared cache layer (deduplicates 3 upstream calls)
 * - Maritime AIS visibility guard (pause polling when tab hidden)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const readSrc = (relPath) => readFileSync(resolve(root, relPath), 'utf-8');

// ========================================================================
// 1. TTL alignment
// ========================================================================

describe('cache TTL alignment with upstream refresh rates', () => {
  it('climate anomalies uses 3h TTL (ERA5 has 2-7 day lag)', () => {
    const src = readSrc('server/worldmonitor/climate/v1/list-climate-anomalies.ts');
    assert.match(src, /REDIS_CACHE_TTL = 10800/,
      'Climate cache TTL should be 10800s (3 hours)');
  });

  it('fire detections uses 1h TTL (FIRMS NRT updates every ~3h)', () => {
    const src = readSrc('server/worldmonitor/wildfire/v1/list-fire-detections.ts');
    assert.match(src, /REDIS_CACHE_TTL = 3600/,
      'Fire cache TTL should be 3600s (1 hour)');
  });
});

// ========================================================================
// 2. ACLED shared cache layer
// ========================================================================

describe('ACLED shared cache layer', () => {
  const src = readSrc('server/_shared/acled.ts');

  it('exports fetchAcledCached function', () => {
    assert.match(src, /export async function fetchAcledCached/,
      'Should export shared cached fetch function');
  });

  it('derives cache key from query parameters', () => {
    assert.match(src, /acled:shared:\$\{opts\.eventTypes\}:\$\{opts\.startDate\}:\$\{opts\.endDate\}/,
      'Cache key should include event types, start date, end date');
  });

  it('checks Redis cache before upstream API call', () => {
    const cacheCheckIdx = src.indexOf('getCachedJson(cacheKey)');
    const fetchIdx = src.indexOf('fetch(`${ACLED_API_URL}');
    assert.ok(cacheCheckIdx > -1, 'Should check Redis cache');
    assert.ok(fetchIdx > -1, 'Should call ACLED API');
    assert.ok(cacheCheckIdx < fetchIdx,
      'Cache check should come before upstream fetch');
  });

  it('uses 15-minute cache TTL', () => {
    assert.match(src, /ACLED_CACHE_TTL = 900/,
      'ACLED cache TTL should be 900s (15 minutes)');
  });

  it('returns empty array when API token is missing', () => {
    assert.match(src, /if \(!token\) return \[\]/,
      'Should gracefully degrade when ACLED_ACCESS_TOKEN is not set');
  });

  it('writes to cache on successful fetch', () => {
    assert.match(src, /setCachedJson\(cacheKey, events, ACLED_CACHE_TTL\)/,
      'Should cache successful results');
  });

  it('caches empty successful responses to avoid repeated cache misses', () => {
    assert.doesNotMatch(src, /if\s*\(events\.length\s*>\s*0\)\s*\{[\s\S]*setCachedJson\(cacheKey, events, ACLED_CACHE_TTL\)/,
      'Should cache empty arrays too (negative caching)');
  });
});

describe('ACLED consumers use shared cache layer', () => {
  it('conflict handler imports fetchAcledCached', () => {
    const src = readSrc('server/worldmonitor/conflict/v1/list-acled-events.ts');
    assert.match(src, /fetchAcledCached/,
      'Conflict handler should use shared ACLED fetch');
  });

  it('unrest handler imports fetchAcledCached', () => {
    const src = readSrc('server/worldmonitor/unrest/v1/list-unrest-events.ts');
    assert.match(src, /fetchAcledCached/,
      'Unrest handler should use shared ACLED fetch');
  });

  it('risk scores handler imports fetchAcledCached', () => {
    const src = readSrc('server/worldmonitor/intelligence/v1/get-risk-scores.ts');
    assert.match(src, /fetchAcledCached/,
      'Risk scores handler should use shared ACLED fetch');
  });

  it('no handler has its own ACLED_API_URL constant', () => {
    const conflict = readSrc('server/worldmonitor/conflict/v1/list-acled-events.ts');
    const unrest = readSrc('server/worldmonitor/unrest/v1/list-unrest-events.ts');
    const riskScores = readSrc('server/worldmonitor/intelligence/v1/get-risk-scores.ts');
    for (const [name, src] of [['conflict', conflict], ['unrest', unrest], ['risk-scores', riskScores]]) {
      assert.doesNotMatch(src, /ACLED_API_URL/,
        `${name} handler should not define its own ACLED_API_URL`);
    }
  });
});

// ========================================================================
// 3. Maritime AIS visibility guard
// ========================================================================

describe('maritime AIS visibility guard', () => {
  const src = readSrc('src/services/maritime/index.ts');

  it('skips polling when document is hidden', () => {
    assert.match(src, /document\.hidden/,
      'Should check document.hidden');
    // The guard should be in pollSnapshot
    const pollFn = src.slice(src.indexOf('async function pollSnapshot'));
    const hiddenGuard = pollFn.indexOf('document.hidden');
    assert.ok(hiddenGuard > -1 && hiddenGuard < 400,
      'document.hidden check should be near the top of pollSnapshot');
  });

  it('has pausePolling function that clears interval', () => {
    assert.match(src, /function pausePolling\(\)/,
      'Should define pausePolling');
    const pauseFn = src.slice(src.indexOf('function pausePolling'), src.indexOf('function pausePolling') + 200);
    assert.match(pauseFn, /clearInterval\(pollInterval\)/,
      'pausePolling should clear the poll interval');
  });

  it('has resumePolling function that restarts polling without overlap', () => {
    assert.match(src, /function resumePolling\(\)/,
      'Should define resumePolling');
    const resumeIdx = src.indexOf('function resumePolling');
    const resumeFn = src.slice(resumeIdx, resumeIdx + 400);
    assert.match(resumeFn, /if \(!inFlight\)/,
      'resumePolling should guard against overlapping polls');
    assert.match(resumeFn, /pollSnapshot\(false\)/,
      'resumePolling should trigger a non-forced poll');
  });

  it('registers visibilitychange listener', () => {
    assert.match(src, /document\.addEventListener\('visibilitychange'/,
      'Should listen for visibilitychange events');
  });

  it('calls pausePolling on hidden and resumePolling on visible', () => {
    const listenerBlock = src.slice(
      src.indexOf("document.addEventListener('visibilitychange'"),
      src.indexOf("document.addEventListener('visibilitychange'") + 300,
    );
    assert.match(listenerBlock, /document\.hidden/,
      'Listener should check document.hidden');
    assert.match(listenerBlock, /pausePolling\(\)/,
      'Should call pausePolling when hidden');
    assert.match(listenerBlock, /resumePolling\(\)/,
      'Should call resumePolling when visible');
  });
});
