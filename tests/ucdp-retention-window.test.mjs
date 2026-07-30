import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const root = resolve(import.meta.dirname, '..');

function readRepoFile(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

describe('UCDP retained window is intentionally smaller than CII classification window', () => {
  it('keeps the CII scorer on a two-year UCDP classification window', () => {
    const scorer = readRepoFile('server/worldmonitor/intelligence/v1/get-risk-scores.ts');

    assert.match(
      scorer,
      /const UCDP_CLASSIFICATION_WINDOW_MS = 2 \* 365 \* 24 \* 60 \* 60 \* 1000;/,
      'CII scoring must continue to classify UCDP over the two-year heuristic window',
    );
  });

  it('guards the intentionally capped one-year Redis writer window', () => {
    const standaloneSeed = readRepoFile('scripts/seed-ucdp-events.mjs');
    const relay = readRepoFile('scripts/ais-relay.cjs');

    assert.match(
      standaloneSeed,
      /const MAX_PAGES = 6;/,
      'standalone UCDP seed page cap changed; update this guard and public docs deliberately',
    );
    assert.match(
      standaloneSeed,
      /const MAX_EVENTS = 2000;/,
      'standalone UCDP seed event cap changed; update this guard and public docs deliberately',
    );
    assert.match(
      standaloneSeed,
      /const TRAILING_WINDOW_MS = 365 \* 24 \* 60 \* 60 \* 1000;/,
      'standalone UCDP seed retention changed; align with scorer or document the smaller window',
    );
    assert.match(
      relay,
      /const UCDP_MAX_PAGES = 6;/,
      'relay Redis UCDP seed page cap changed; update this guard and public docs deliberately',
    );
    assert.match(
      relay,
      /const UCDP_MAX_EVENTS = 2000;/,
      'relay Redis UCDP seed event cap changed; update this guard and public docs deliberately',
    );
    assert.match(
      relay,
      /const UCDP_TRAILING_WINDOW_MS = 365 \* 24 \* 60 \* 60 \* 1000;/,
      'relay UCDP retention changed; align with scorer or document the smaller window',
    );
  });

  it('documents the relay reader page cap separately from Redis writer retention', () => {
    const relay = readRepoFile('scripts/ais-relay.cjs');
    const methodology = readRepoFile('docs/methodology/cii-risk-scores.mdx');
    const changelog = readRepoFile('docs/changelog.mdx');

    assert.match(
      relay,
      /const UCDP_RELAY_MAX_PAGES = 12;/,
      'public relay UCDP reader page cap changed; update docs deliberately',
    );
    for (const doc of [methodology, changelog]) {
      assert.match(doc, /newest six UCDP pages/);
      assert.match(doc, /2,000 mapped events/);
      assert.match(doc, /365-day/);
      assert.match(doc, /12 pages/);
      assert.match(doc, /production API-volume and Redis-payload safeguards/);
    }
  });
});
