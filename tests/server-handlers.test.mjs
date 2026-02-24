/**
 * Tests for server handler correctness after PR #106 review fixes.
 *
 * These tests verify:
 * - Humanitarian summary handler rejects unmapped country codes
 * - Humanitarian summary returns ISO-2 country_code (not ISO-3)
 * - Hardcoded political context is removed from LLM prompts
 * - Headline deduplication logic works correctly
 * - Cache key builder produces deterministic output
 * - Vessel snapshot handler has cache + in-flight dedup
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deduplicateHeadlines } from '../server/worldmonitor/news/v1/dedup.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// Helper to read a source file relative to project root
const readSrc = (relPath) => readFileSync(resolve(root, relPath), 'utf-8');

// ========================================================================
// 1. Humanitarian summary: country fallback + ISO-2 contract
// ========================================================================

describe('getHumanitarianSummary handler', () => {
  const src = readSrc('server/worldmonitor/conflict/v1/get-humanitarian-summary.ts');

  it('returns undefined when country has no ISO3 mapping (BLOCKING-1)', () => {
    // Must have early return when no ISO3 mapping (before HAPI fetch)
    assert.match(src, /if\s*\(\s*!iso3\s*\)\s*return\s+undefined/,
      'Should return undefined when no ISO3 mapping exists');
    // The countryCode branch must NOT fall back to Object.values(byCountry)[0]
    // Extract only the "if (countryCode)" block for picking entry and verify no fallback
    const pickSection = src.slice(
      src.indexOf('// Pick the right country entry'),
      src.indexOf('if (!entry) return undefined;'),
    );
    // Inside the countryCode branch, should NOT have Object.values(byCountry)[0] as fallback
    const countryCodeBranch = pickSection.slice(0, pickSection.indexOf('} else {'));
    assert.doesNotMatch(countryCodeBranch, /Object\.values\(byCountry\)\[0\]/,
      'countryCode branch should not fallback to first entry');
  });

  it('returns ISO-2 country_code per proto contract (BLOCKING-2)', () => {
    // Must NOT return ISO2_TO_ISO3[...] as countryCode
    assert.doesNotMatch(src, /countryCode:\s*ISO2_TO_ISO3/,
      'Should not return ISO-3 code in countryCode field');
    // Should return the original countryCode (uppercased)
    assert.match(src, /countryCode:\s*countryCode.*\.toUpperCase\(\)/,
      'Should return original ISO-2 countryCode uppercased');
  });

  it('uses renamed conflict-event proto fields (MEDIUM-1)', () => {
    assert.match(src, /conflictEventsTotal/,
      'Should use conflictEventsTotal field');
    assert.match(src, /conflictPoliticalViolenceEvents/,
      'Should use conflictPoliticalViolenceEvents field');
    assert.match(src, /conflictFatalities/,
      'Should use conflictFatalities field');
    assert.match(src, /referencePeriod/,
      'Should use referencePeriod field');
    assert.match(src, /conflictDemonstrations/,
      'Should use conflictDemonstrations field');
    // Old field names must not appear
    assert.doesNotMatch(src, /populationAffected/,
      'Should not reference old populationAffected field');
    assert.doesNotMatch(src, /peopleInNeed/,
      'Should not reference old peopleInNeed field');
  });
});

// ========================================================================
// 2. Humanitarian summary proto: field semantics
// ========================================================================

describe('humanitarian_summary.proto', () => {
  const proto = readSrc('proto/worldmonitor/conflict/v1/humanitarian_summary.proto');

  it('has conflict-event field names instead of humanitarian field names', () => {
    assert.match(proto, /conflict_events_total/);
    assert.match(proto, /conflict_political_violence_events/);
    assert.match(proto, /conflict_fatalities/);
    assert.match(proto, /reference_period/);
    assert.match(proto, /conflict_demonstrations/);
    // Old names removed
    assert.doesNotMatch(proto, /population_affected/);
    assert.doesNotMatch(proto, /people_in_need/);
    assert.doesNotMatch(proto, /internally_displaced/);
    assert.doesNotMatch(proto, /food_insecurity_level/);
    assert.doesNotMatch(proto, /water_access_pct/);
  });

  it('declares country_code as ISO-2', () => {
    assert.match(proto, /ISO 3166-1 alpha-2/);
  });
});

// ========================================================================
// 3. Hardcoded political context removed (LOW-1)
// ========================================================================

describe('LLM prompt political context (LOW-1)', () => {
  const src = readSrc('server/worldmonitor/news/v1/_shared.ts');

  it('does not contain hardcoded "Donald Trump" reference', () => {
    assert.doesNotMatch(src, /Donald Trump/,
      'Should not contain hardcoded political figure name');
  });

  it('uses date-based dynamic context instead', () => {
    assert.match(src, /Provide geopolitical context appropriate for the current date/,
      'Should instruct LLM to use current-date context');
  });
});

// ========================================================================
// 4. Headline deduplication (ported logic test)
// ========================================================================

describe('headline deduplication', () => {
  // Imports the real deduplicateHeadlines from dedup.mjs (shared with _shared.ts)

  it('removes near-duplicate headlines', () => {
    const headlines = [
      'Russia launches missile strike on Ukrainian energy infrastructure targets',
      'Russia launches missile strike on Ukrainian energy infrastructure overnight',
      'EU approves new sanctions package against Russia',
    ];
    // Words >= 4 chars for headline 1: russia, launches, missile, strike, ukrainian, energy, infrastructure, targets (8)
    // Words >= 4 chars for headline 2: russia, launches, missile, strike, ukrainian, energy, infrastructure, overnight (8)
    // Intersection: 7/8 = 0.875 > 0.6 threshold
    const result = deduplicateHeadlines(headlines);
    assert.equal(result.length, 2, 'Should deduplicate near-identical headlines');
    assert.equal(result[0], headlines[0], 'Should keep the first occurrence');
    assert.equal(result[1], headlines[2], 'Should keep the dissimilar headline');
  });

  it('keeps all unique headlines', () => {
    const headlines = [
      'Tech stocks rally on AI optimism',
      'Federal Reserve holds interest rates steady',
      'New climate report warns of tipping points',
    ];
    const result = deduplicateHeadlines(headlines);
    assert.equal(result.length, 3, 'All unique headlines should be kept');
  });

  it('handles empty input', () => {
    assert.deepEqual(deduplicateHeadlines([]), []);
  });

  it('handles single headline', () => {
    const result = deduplicateHeadlines(['Single headline here']);
    assert.equal(result.length, 1);
  });
});

// ========================================================================
// 5. Cache key builder (determinism test)
// ========================================================================

describe('getCacheKey determinism', () => {
  const src = readSrc('server/worldmonitor/news/v1/_shared.ts');

  it('getCacheKey function exists and builds versioned keys', () => {
    assert.match(src, /export function getCacheKey\(/,
      'getCacheKey should be exported');
    assert.match(src, /CACHE_VERSION/,
      'Should use CACHE_VERSION for cache key prefixing');
    // Verify it includes mode in the key
    assert.match(src, /`summary:\$\{CACHE_VERSION\}:\$\{mode\}/,
      'Cache key should include mode');
  });

  it('handles translate mode separately', () => {
    assert.match(src, /if\s*\(mode\s*===\s*'translate'\)/,
      'Should have separate key format for translate mode');
  });
});

// ========================================================================
// 6. Vessel snapshot caching (structural verification)
// ========================================================================

describe('getVesselSnapshot caching (HIGH-1)', () => {
  const src = readSrc('server/worldmonitor/maritime/v1/get-vessel-snapshot.ts');

  it('has in-memory cache variables at module scope', () => {
    assert.match(src, /let cachedSnapshot/);
    assert.match(src, /let cacheTimestamp/);
    assert.match(src, /let inFlightRequest/);
  });

  it('has 10-second TTL cache', () => {
    assert.match(src, /SNAPSHOT_CACHE_TTL_MS\s*=\s*10[_]?000/,
      'TTL should be 10 seconds (10000ms)');
  });

  it('checks cache before calling relay', () => {
    // fetchVesselSnapshot should check cachedSnapshot before fetchVesselSnapshotFromRelay
    const cacheCheckIdx = src.indexOf('cachedSnapshot && (now - cacheTimestamp)');
    const relayCallIdx = src.indexOf('fetchVesselSnapshotFromRelay()');
    assert.ok(cacheCheckIdx > -1, 'Should check cache');
    assert.ok(relayCallIdx > -1, 'Should have relay fetch function');
    assert.ok(cacheCheckIdx < relayCallIdx,
      'Cache check should come before relay call');
  });

  it('has in-flight dedup via shared promise', () => {
    assert.match(src, /if\s*\(inFlightRequest\)/,
      'Should check for in-flight request');
    assert.match(src, /inFlightRequest\s*=\s*fetchVesselSnapshotFromRelay/,
      'Should assign in-flight promise');
    assert.match(src, /inFlightRequest\s*=\s*null/,
      'Should clear in-flight promise in finally block');
  });

  it('serves stale snapshot when relay fetch fails', () => {
    assert.match(src, /return\s+result\s*\?\?\s*cachedSnapshot/,
      'Should return stale cached snapshot when fresh relay fetch fails');
  });

  // NOTE: Full integration test (mocking fetch, verifying cache hits) requires
  // a TypeScript-capable test runner. This structural test verifies the pattern.
});
