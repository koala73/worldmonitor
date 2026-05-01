import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { migrateDisabledFeedsV2 } from '../src/utils/cloud-prefs-migrations';

const F = (...names: string[]) => names.map((name) => ({ name }));

describe('cloud-prefs schema-2 migration: re-enable fully-disabled categories', () => {
  // The poisoned-state shape that triggered this migration: free-tier v1
  // alphabetical-slice cap auto-disabled every source past position 80
  // alphabetically, leaving entire late-alphabet categories with 100% of
  // their feeds in `disabledFeeds`.
  const FEEDS = {
    layoffs: F('Layoffs.fyi', 'TechCrunch Layoffs', 'Layoffs News'),
    ipo: F('IPO News', 'Renaissance IPO', 'Tech IPO News'),
    funding: F('SEC Filings', 'VC News', 'Seed & Pre-Seed', 'Startup Funding'),
    producthunt: F('Product Hunt'),
    politics: F('BBC World', 'Reuters World', 'AP News'), // healthy, must not be touched
  };

  it('returns blob unchanged when disabledFeeds key is missing', () => {
    const blob = { 'worldmonitor-panels': '{"foo":1}' };
    const result = migrateDisabledFeedsV2(blob, FEEDS);
    assert.equal(result, blob, 'unchanged blob must be returned by reference (no copy)');
  });

  it('returns blob unchanged when disabledFeeds is not a string', () => {
    const blob = { 'worldmonitor-disabled-feeds': 42 as unknown as string };
    const result = migrateDisabledFeedsV2(blob, FEEDS);
    assert.equal(result, blob);
  });

  it('returns blob unchanged when disabledFeeds is malformed JSON', () => {
    const blob = { 'worldmonitor-disabled-feeds': 'not json {' };
    const result = migrateDisabledFeedsV2(blob, FEEDS);
    assert.equal(result, blob);
  });

  it('returns blob unchanged when disabledFeeds is an empty array', () => {
    const blob = { 'worldmonitor-disabled-feeds': '[]' };
    const result = migrateDisabledFeedsV2(blob, FEEDS);
    assert.equal(result, blob);
  });

  it('returns blob unchanged when no category is 100% disabled', () => {
    // Partial disable in two categories — explicit user prefs, must be preserved.
    const blob = {
      'worldmonitor-disabled-feeds': JSON.stringify(['Layoffs.fyi', 'IPO News']),
    };
    const result = migrateDisabledFeedsV2(blob, FEEDS);
    assert.equal(result, blob, 'partial disabling is a real user pref — must not be touched');
  });

  it('REGRESSION: re-enables sources from a 100%-disabled late-alphabet category', () => {
    // The exact production shape: `producthunt` has 1 feed, `Product Hunt`,
    // which alphabetically lands after position 80 → got disabled by v1
    // cap → now the entire panel reads "All sources disabled".
    const blob = {
      'worldmonitor-disabled-feeds': JSON.stringify(['Product Hunt']),
      'worldmonitor-panels': '{"keep":"this"}',
    };
    const result = migrateDisabledFeedsV2(blob, FEEDS);
    const newDisabled = JSON.parse(result['worldmonitor-disabled-feeds'] as string);
    assert.deepEqual(newDisabled, [], 'Product Hunt must be removed from disabled');
    assert.equal(result['worldmonitor-panels'], '{"keep":"this"}', 'other blob keys must be preserved');
  });

  it('REGRESSION: production-shape — multiple late-alphabet categories all recovered at once', () => {
    // Mirror the user-reported state: layoffs (3), ipo (3), funding (4),
    // producthunt (1) — 11 source names total, all in the disabled set.
    const allDisabled = [
      'Layoffs.fyi', 'TechCrunch Layoffs', 'Layoffs News',
      'IPO News', 'Renaissance IPO', 'Tech IPO News',
      'SEC Filings', 'VC News', 'Seed & Pre-Seed', 'Startup Funding',
      'Product Hunt',
    ];
    const blob = { 'worldmonitor-disabled-feeds': JSON.stringify(allDisabled) };
    const result = migrateDisabledFeedsV2(blob, FEEDS);
    const newDisabled = JSON.parse(result['worldmonitor-disabled-feeds'] as string);
    assert.deepEqual(newDisabled, [], 'all 11 entries must be recovered');
  });

  it('REGRESSION: preserves explicit single-source disabling (the heuristic\'s safety property)', () => {
    // User explicitly disabled CNN. Migration must NOT undo this — a real
    // pref (single source, not a 100%-disabled category).
    const blob = {
      'worldmonitor-disabled-feeds': JSON.stringify([
        'BBC World',  // 1 of 3 in `politics` → not 100%
        'Layoffs.fyi', 'TechCrunch Layoffs', 'Layoffs News',  // 100% of layoffs → recover
      ]),
    };
    const result = migrateDisabledFeedsV2(blob, FEEDS);
    const newDisabled = new Set(JSON.parse(result['worldmonitor-disabled-feeds'] as string));
    assert.ok(newDisabled.has('BBC World'), 'explicit single disable must be preserved');
    assert.equal(newDisabled.has('Layoffs.fyi'), false);
    assert.equal(newDisabled.has('TechCrunch Layoffs'), false);
    assert.equal(newDisabled.has('Layoffs News'), false);
  });

  it('returns a NEW object on mutation (does not mutate input)', () => {
    const blob = {
      'worldmonitor-disabled-feeds': JSON.stringify(['Product Hunt']),
    };
    const inputJson = blob['worldmonitor-disabled-feeds'];
    const result = migrateDisabledFeedsV2(blob, FEEDS);
    assert.notEqual(result, blob, 'result must be a new object on mutation');
    assert.equal(blob['worldmonitor-disabled-feeds'], inputJson, 'input blob must not be mutated');
  });

  it('handles non-string entries in the disabledFeeds array defensively', () => {
    // Malformed cloud data — an entry that's not a string. Skip it instead
    // of throwing; recover whatever else is recoverable.
    const blob = {
      'worldmonitor-disabled-feeds': JSON.stringify([
        null,
        42,
        'Product Hunt',
        { weird: 'object' },
      ]),
    };
    const result = migrateDisabledFeedsV2(blob, FEEDS);
    const newDisabled = JSON.parse(result['worldmonitor-disabled-feeds'] as string);
    // Product Hunt is recovered; the malformed entries pass through untouched.
    // (We don't try to clean them — that's not this migration's job.)
    assert.equal(newDisabled.includes('Product Hunt'), false);
  });
});
