import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { parseSlug } from '../scripts/seed-prediction-market-resolutions.mjs';

// ── parseSlug ─────────────────────────────────────────────────────────────

describe('parseSlug', () => {
  it('parses a polymarket slug', () => {
    const result = parseSlug('polymarket:will-x-happen');
    assert.deepEqual(result, { source: 'polymarket', id: 'will-x-happen' });
  });

  it('parses a kalshi slug preserving dashes in the ticker', () => {
    const result = parseSlug('kalshi:FED-25DEC');
    assert.deepEqual(result, { source: 'kalshi', id: 'FED-25DEC' });
  });

  it('returns null for null/undefined input', () => {
    assert.equal(parseSlug(null), null);
    assert.equal(parseSlug(undefined), null);
  });

  it('returns null for a slug with no colon separator', () => {
    assert.equal(parseSlug('someslug'), null);
  });

  it('returns null for an empty string', () => {
    assert.equal(parseSlug(''), null);
  });

  it('handles slugs with colons in the id part (multi-segment)', () => {
    // e.g. a hypothetical 'polymarket:us:election:2026'
    const result = parseSlug('polymarket:us:election:2026');
    assert.deepEqual(result, { source: 'polymarket', id: 'us:election:2026' });
  });
});
