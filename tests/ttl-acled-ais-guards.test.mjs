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

describe('cache-only handlers read from seed keys', () => {
  it('climate anomalies is pure cache read (seed controls TTL)', () => {
    const src = readSrc('server/worldmonitor/climate/v1/list-climate-anomalies.ts');
    assert.match(src, /getCachedJson/,
      'Climate handler should use getCachedJson (seed-only)');
    assert.doesNotMatch(src, /cachedFetchJson/,
      'Climate handler should not call external APIs');
  });

  it('fire detections is pure cache read (seed controls TTL)', () => {
    const src = readSrc('server/worldmonitor/wildfire/v1/list-fire-detections.ts');
    assert.match(src, /getCachedJson/,
      'Fire handler should use getCachedJson (seed-only)');
    assert.doesNotMatch(src, /cachedFetchJson/,
      'Fire handler should not call external APIs');
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

  it('uses cachedFetchJson to check Redis cache before upstream API call', () => {
    assert.match(src, /cachedFetchJson\s*<.*>\s*\(cacheKey/,
      'Should use cachedFetchJson which handles cache check + coalescing');
    assert.ok(src.includes('fetch(`${ACLED_API_URL}'),
      'Should call ACLED API inside the fetcher');
  });

  it('uses 15-minute cache TTL', () => {
    assert.match(src, /ACLED_CACHE_TTL = 900/,
      'ACLED cache TTL should be 900s (15 minutes)');
  });

  it('returns empty array when API token is missing', () => {
    assert.match(src, /if \(!token\) return \[\]/,
      'Should gracefully degrade when ACLED_ACCESS_TOKEN is not set');
  });

  it('caches successful results via cachedFetchJson', () => {
    assert.match(src, /cachedFetchJson/,
      'Should use cachedFetchJson which writes to cache automatically on successful fetch');
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

  it('unrest handler is pure cache read (seed-only, no ACLED calls)', () => {
    const src = readSrc('server/worldmonitor/unrest/v1/list-unrest-events.ts');
    assert.match(src, /getCachedJson/,
      'Unrest handler should use getCachedJson (seed-only)');
    assert.doesNotMatch(src, /cachedFetchJson/,
      'Unrest handler should not call external APIs');
  });

  it('risk scores handler imports fetchAcledCached', () => {
    const src = readSrc('server/worldmonitor/intelligence/v1/get-risk-scores.ts');
    assert.match(src, /fetchAcledCached/,
      'Risk scores handler should use shared ACLED fetch');
  });

  it('no handler has its own ACLED_API_URL constant', () => {
    const conflict = readSrc('server/worldmonitor/conflict/v1/list-acled-events.ts');
    const riskScores = readSrc('server/worldmonitor/intelligence/v1/get-risk-scores.ts');
    for (const [name, src] of [['conflict', conflict], ['risk-scores', riskScores]]) {
      assert.doesNotMatch(src, /ACLED_API_URL/,
        `${name} handler should not define its own ACLED_API_URL`);
    }
  });
});

// ========================================================================
// 3. Maritime AIS visibility guard
// ========================================================================

describe('maritime AIS visibility guard (SmartPollLoop)', () => {
  const src = readSrc('src/services/maritime/index.ts');

  it('uses startSmartPollLoop for polling', () => {
    assert.match(src, /startSmartPollLoop/,
      'Should use startSmartPollLoop for AIS polling');
  });

  it('pauses entirely when hidden via pauseWhenHidden option', () => {
    assert.match(src, /pauseWhenHidden:\s*true/,
      'Should set pauseWhenHidden: true to stop relay traffic in background tabs');
  });

  it('refreshes on tab becoming visible', () => {
    assert.match(src, /refreshOnVisible:\s*true/,
      'Should set refreshOnVisible: true to fetch fresh data when tab returns');
  });

  it('passes AbortSignal through to pollSnapshot', () => {
    // pollSnapshot should accept a signal parameter
    const pollFn = src.slice(src.indexOf('async function pollSnapshot'));
    assert.match(pollFn, /signal\?\.aborted/,
      'pollSnapshot should check signal.aborted');
  });

  it('stops poll loop on disconnect', () => {
    const disconnectIdx = src.indexOf('function disconnectAisStream');
    const disconnectFn = src.slice(disconnectIdx, disconnectIdx + 300);
    assert.match(disconnectFn, /pollLoop\?\.stop\(\)/,
      'disconnectAisStream should stop the SmartPollLoop');
  });
});
