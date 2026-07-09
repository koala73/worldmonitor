import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function source(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

describe('ACLED resolution-feed seed contract (#5076)', () => {
  const conflictSeed = source('scripts/seed-conflict-intel.mjs');
  const unrestSeed = source('scripts/seed-unrest-events.mjs');
  const resolutionSpec = source('scripts/_forecast-resolution.mjs');

  it('routes conflict hard counts to a long-window resolution key, not the map display key', () => {
    assert.match(resolutionSpec, /CONFLICT_COUNT_SOURCE_FEED\s*=\s*'conflict:acled-resolution:v1:all:0:0'/);
    assert.doesNotMatch(resolutionSpec, /CONFLICT_COUNT_SOURCE_FEED\s*=\s*'conflict:acled:v1:all:0:0'/);
  });

  it('routes unrest hard counts to a long-window resolution key, not the canonical display feed', () => {
    assert.match(resolutionSpec, /UNREST_COUNT_SOURCE_FEED\s*=\s*'unrest:events-resolution:v1'/);
    assert.doesNotMatch(resolutionSpec, /UNREST_COUNT_SOURCE_FEED\s*=\s*'unrest:events:v1'/);
  });

  it('conflict seeder keeps the capped display payload but also publishes a paginated 60d resolution feed', () => {
    assert.match(conflictSeed, /ACLED_CACHE_KEY\s*=\s*'conflict:acled:v1:all:0:0'/);
    assert.match(conflictSeed, /ACLED_DISPLAY_LOOKBACK_DAYS\s*=\s*30/);
    assert.match(conflictSeed, /ACLED_DISPLAY_LIMIT\s*=\s*500/);
    assert.match(conflictSeed, /ACLED_RESOLUTION_CACHE_KEY\s*=\s*'conflict:acled-resolution:v1:all:0:0'/);
    assert.match(conflictSeed, /ACLED_RESOLUTION_LOOKBACK_DAYS\s*=\s*60/);
    assert.match(conflictSeed, /ACLED_RESOLUTION_PAGE_LIMIT\s*=\s*5000/);
    assert.match(conflictSeed, /ACLED_RESOLUTION_MAX_PAGES\s*=\s*(?:[1-9]\d+)/);
    assert.match(conflictSeed, /writeExtraKeyWithMeta\(\s*ACLED_RESOLUTION_CACHE_KEY/);
    assert.match(conflictSeed, /ACLED_RESOLUTION_CACHE_KEY,[\s\S]*clusters:\s*\[\],[\s\S]*acResolution\.pagination/);
  });

  it('unrest seeder keeps the canonical display feed but also publishes a paginated 60d ACLED resolution feed', () => {
    assert.match(unrestSeed, /CANONICAL_KEY\s*=\s*'unrest:events:v1'/);
    assert.match(unrestSeed, /ACLED_DISPLAY_LOOKBACK_DAYS\s*=\s*30/);
    assert.match(unrestSeed, /ACLED_DISPLAY_LIMIT\s*=\s*500/);
    assert.match(unrestSeed, /UNREST_RESOLUTION_CACHE_KEY\s*=\s*'unrest:events-resolution:v1'/);
    assert.match(unrestSeed, /UNREST_RESOLUTION_LOOKBACK_DAYS\s*=\s*60/);
    assert.match(unrestSeed, /UNREST_RESOLUTION_PAGE_LIMIT\s*=\s*5000/);
    assert.match(unrestSeed, /UNREST_RESOLUTION_MAX_PAGES\s*=\s*(?:[1-9]\d+)/);
    assert.match(unrestSeed, /writeExtraKeyWithMeta\(\s*UNREST_RESOLUTION_CACHE_KEY/);
  });
});
