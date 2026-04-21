/**
 * Pinned regression tests for shared/brief-llm-core.js.
 *
 * The module replaces the pre-extract sync `hashBriefStory` (which used
 * `node:crypto.createHash`) with a Web Crypto `crypto.subtle.digest`
 * implementation. A drift in either the hash algorithm, the joining
 * delimiter ('||'), or the field ordering would silently invalidate
 * every cached `brief:llm:whymatters:*` entry at deploy time.
 *
 * These fixtures were captured from the pre-extract implementation and
 * pinned here so any future refactor must ship a cache-version bump
 * alongside.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  WHY_MATTERS_SYSTEM,
  buildWhyMattersUserPrompt,
  hashBriefStory,
  parseWhyMatters,
} from '../shared/brief-llm-core.js';

// Pre-extract sync impl, kept inline so the parity test can't drift from
// what the cron used to emit.
function legacyHashBriefStory(story) {
  const material = [
    story.headline ?? '',
    story.source ?? '',
    story.threatLevel ?? '',
    story.category ?? '',
    story.country ?? '',
  ].join('||');
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

const FIXTURE = {
  headline: 'Iran closes Strait of Hormuz',
  source: 'Reuters',
  threatLevel: 'critical',
  category: 'Geopolitical Risk',
  country: 'IR',
};

describe('hashBriefStory — Web Crypto parity with legacy node:crypto', () => {
  it('returns the exact hash the pre-extract implementation emitted', async () => {
    const expected = legacyHashBriefStory(FIXTURE);
    const actual = await hashBriefStory(FIXTURE);
    assert.equal(actual, expected);
  });

  it('is 16 hex chars, case-insensitive match', async () => {
    const h = await hashBriefStory(FIXTURE);
    assert.equal(h.length, 16);
    assert.match(h, /^[0-9a-f]{16}$/);
  });

  it('is stable across multiple invocations', async () => {
    const a = await hashBriefStory(FIXTURE);
    const b = await hashBriefStory(FIXTURE);
    const c = await hashBriefStory(FIXTURE);
    assert.equal(a, b);
    assert.equal(b, c);
  });

  it('differs when any hash-material field differs', async () => {
    const baseline = await hashBriefStory(FIXTURE);
    for (const field of ['headline', 'source', 'threatLevel', 'category', 'country']) {
      const mutated = { ...FIXTURE, [field]: `${FIXTURE[field]}!` };
      const h = await hashBriefStory(mutated);
      assert.notEqual(h, baseline, `${field} must be part of the cache identity`);
    }
  });

  it('treats missing fields as empty strings (backcompat)', async () => {
    const partial = { headline: FIXTURE.headline };
    const expected = legacyHashBriefStory(partial);
    const actual = await hashBriefStory(partial);
    assert.equal(actual, expected);
  });
});

describe('WHY_MATTERS_SYSTEM — pinned editorial voice', () => {
  it('is a non-empty string with the one-sentence contract wording', () => {
    assert.equal(typeof WHY_MATTERS_SYSTEM, 'string');
    assert.ok(WHY_MATTERS_SYSTEM.length > 100);
    assert.match(WHY_MATTERS_SYSTEM, /ONE concise sentence \(18–30 words\)/);
    assert.match(WHY_MATTERS_SYSTEM, /One sentence only\.$/);
  });
});

describe('buildWhyMattersUserPrompt — shape', () => {
  it('emits the exact 5-line format pinned by the cache-identity contract', () => {
    const { system, user } = buildWhyMattersUserPrompt(FIXTURE);
    assert.equal(system, WHY_MATTERS_SYSTEM);
    assert.equal(
      user,
      [
        'Headline: Iran closes Strait of Hormuz',
        'Source: Reuters',
        'Severity: critical',
        'Category: Geopolitical Risk',
        'Country: IR',
        '',
        'One editorial sentence on why this matters:',
      ].join('\n'),
    );
  });
});

describe('parseWhyMatters — pure sentence validator', () => {
  it('rejects non-strings, empty, whitespace-only', () => {
    assert.equal(parseWhyMatters(null), null);
    assert.equal(parseWhyMatters(undefined), null);
    assert.equal(parseWhyMatters(42), null);
    assert.equal(parseWhyMatters(''), null);
    assert.equal(parseWhyMatters('   '), null);
  });

  it('rejects too-short (<30) and too-long (>400)', () => {
    assert.equal(parseWhyMatters('Too brief.'), null);
    assert.equal(parseWhyMatters('x'.repeat(401)), null);
  });

  it('strips smart-quotes and takes the first sentence', () => {
    const input = '"Closure would spike oil markets and force a naval response." Secondary clause.';
    const out = parseWhyMatters(input);
    assert.equal(out, 'Closure would spike oil markets and force a naval response.');
  });

  it('rejects the stub echo', () => {
    const stub = 'Story flagged by your sensitivity settings. Open for context.';
    assert.equal(parseWhyMatters(stub), null);
  });

  it('preserves a valid one-sentence output verbatim', () => {
    const s = 'Closure of the Strait of Hormuz would spike global oil prices and force a US naval response.';
    assert.equal(parseWhyMatters(s), s);
  });
});
