/**
 * Tests for server handler correctness after PR #106 review fixes.
 *
 * These tests verify:
 * - Humanitarian summary aggregation rejects unmapped country codes
 * - Humanitarian summary aggregation returns ISO-2 country_code (not ISO-3)
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
import { aggregateHapiConflictEvents } from '../scripts/_conflict-hapi.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// Helper to read a source file relative to project root
const readSrc = (relPath) => readFileSync(resolve(root, relPath), 'utf-8');

// ========================================================================
// 1. Humanitarian summary: country fallback + ISO-2 contract
// ========================================================================

describe('aggregateHapiConflictEvents (scripts/_conflict-hapi.mjs)', () => {
  // #5554: server/worldmonitor/conflict/v1/get-humanitarian-summary.ts no longer
  // fetches HAPI at all — it's a cache-only read of what this seeder writes (HDX's
  // app_identifier rate limiting is per-identifier, so a per-request RPC fetch would
  // stack uncoordinated traffic on top of the seeder's bulk refresh). The
  // BLOCKING-1/BLOCKING-2/MEDIUM-1 guards below (originally PR #106, against the old
  // RPC-handler implementation) moved here with the fetch/aggregation logic itself.
  it('rejects unmapped and out-of-scope ISO3 rows and returns the ISO2 proto contract', () => {
    const updatedAt = Date.parse('2026-07-29T00:00:00Z');
    const result = aggregateHapiConflictEvents([
      {
        location_code: 'ZZZ',
        location_name: 'Unknown',
        reference_period_start: '2026-07-01',
        admin_level: 0,
        event_type: 'political_violence',
        events: 500,
        fatalities: 500,
      },
      {
        location_code: 'USA',
        location_name: 'United States',
        reference_period_start: '2026-07-01',
        admin_level: 0,
        event_type: 'political_violence',
        events: 250,
        fatalities: 250,
      },
      {
        location_code: 'SDN',
        location_name: 'Sudan',
        reference_period_start: '2026-07-01',
        admin_level: 0,
        event_type: 'political_violence',
        events: 12,
        fatalities: 3,
      },
    ], { nowMs: updatedAt, countryCodes: ['SD'] });

    assert.deepEqual(result, {
      SD: {
        summary: {
          countryCode: 'SD',
          countryName: 'Sudan',
          conflictEventsTotal: 12,
          conflictPoliticalViolenceEvents: 12,
          conflictFatalities: 3,
          referencePeriod: '2026-07-01',
          conflictDemonstrations: 0,
          updatedAt,
        },
      },
    });
    assert.equal('populationAffected' in result.SD.summary, false);
    assert.equal('peopleInNeed' in result.SD.summary, false);
  });
});

describe('headline deduplication', () => {
  // Imports the real deduplicateHeadlines from dedup.mjs (shared with _shared.ts)

  it('removes near-duplicate headlines', () => {
    const headlines = [
      'Russia launches missile strike on Ukrainian energy infrastructure targets',
      'Russia launches missile strike on Ukrainian energy infrastructure overnight',
      'EU approves new sanctions package against Russia',
    ];
    // #4919: similarity now comes from shared/story-identity.js (dual-view
    // cosine >= STORY_SIMILARITY_THRESHOLD) — a one-token tail swap on an
    // otherwise identical headline is squarely inside the edit-variant
    // class it must merge.
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

// ========================================================================
// Architectural guards. These assert the ABSENCE of a call, which no test that
// runs the handler can observe — everything else this file used to pin (proto
// field names, cache-Map declarations, NOT_FOUND literals, the summary
// cache-key shape) restated a line of source. Cache-key behaviour has its own
// executable suite in tests/summary-cache-key.test.mts.
// ========================================================================

describe('handler and prompt guards', () => {
  it('serves humanitarian summaries from cache and never calls HAPI directly', () => {
    // #5554: HAPI rate-limits per identifier, so every direct-fetch call site
    // shares one throttle bucket. The RPC handler must read what the seeder
    // wrote rather than adding a second caller.
    const src = readSrc('server/worldmonitor/conflict/v1/get-humanitarian-summary.ts');
    assert.doesNotMatch(src, /hapi\.humdata\.org/);
    assert.match(src, /getCachedJson\(/);
  });

  it('keeps named political figures out of the LLM prompt', () => {
    // A hardcoded name dates the prompt and biases summaries; the prompt asks
    // for context appropriate to the current date instead.
    const src = readSrc('server/worldmonitor/news/v1/_shared.ts');
    assert.doesNotMatch(src, /Donald Trump/);
  });
});
