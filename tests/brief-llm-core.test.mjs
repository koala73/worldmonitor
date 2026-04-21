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

// Mirror impl (sync `node:crypto`) — kept inline so a drift between
// the Web Crypto implementation and this sentinel fails the parity
// test here first. Must include `description` to match v5 semantics.
function legacyHashBriefStory(story) {
  const material = [
    story.headline ?? '',
    story.source ?? '',
    story.threatLevel ?? '',
    story.category ?? '',
    story.country ?? '',
    story.description ?? '',
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

  it('description is part of cache identity (v5 regression guard)', async () => {
    // Pinned from PR #3269 review P1: adding `description` to the
    // analyst prompt without adding it to the hash caused same-story-
    // diff-description to collide on one cache entry, so callers got
    // prose grounded in a PREVIOUS caller's description.
    const withDescA = {
      ...FIXTURE,
      description: 'Tehran publicly reopened commercial shipping.',
    };
    const withDescB = {
      ...FIXTURE,
      description: 'Iran formally blockaded outbound tankers.',
    };
    const noDesc = { ...FIXTURE };

    const hashA = await hashBriefStory(withDescA);
    const hashB = await hashBriefStory(withDescB);
    const hashNone = await hashBriefStory(noDesc);

    assert.notEqual(hashA, hashB, 'different descriptions must produce different hashes');
    assert.notEqual(hashA, hashNone, 'description present vs absent must differ');
    assert.notEqual(hashB, hashNone);
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

describe('parseWhyMattersV2 — multi-sentence, analyst-path only', () => {
  it('lazy-loads', async () => {
    const mod = await import('../shared/brief-llm-core.js');
    assert.equal(typeof mod.parseWhyMattersV2, 'function');
  });

  it('accepts 2–3 sentences totalling 100–500 chars', async () => {
    const { parseWhyMattersV2 } = await import('../shared/brief-llm-core.js');
    const good =
      "Iran's closure of the Strait of Hormuz on April 21 halts roughly 20% of global seaborne oil. " +
      'The disruption forces an immediate repricing of sovereign risk across Gulf energy exporters. ' +
      'Watch IMF commentary in the next 48 hours for cascading guidance.';
    assert.ok(good.length >= 100 && good.length <= 500);
    assert.equal(parseWhyMattersV2(good), good);
  });

  it('rejects <100 chars (too terse for the analyst contract)', async () => {
    const { parseWhyMattersV2 } = await import('../shared/brief-llm-core.js');
    assert.equal(parseWhyMattersV2('Short.'), null);
    assert.equal(parseWhyMattersV2('x'.repeat(99)), null);
  });

  it('rejects >500 chars (runaway generation)', async () => {
    const { parseWhyMattersV2 } = await import('../shared/brief-llm-core.js');
    assert.equal(parseWhyMattersV2('a'.repeat(501)), null);
  });

  it('rejects preamble the system prompt banned', async () => {
    const { parseWhyMattersV2 } = await import('../shared/brief-llm-core.js');
    const cases = [
      'This matters because global energy markets depend on the Strait of Hormuz remaining open for transit and this is therefore a critical development.',
      'The importance of this development cannot be overstated given the potential for cascading economic impacts across multiple regions and industries.',
      'It is important to note that the ongoing situation in the Strait of Hormuz has implications that extend far beyond simple maritime concerns.',
      'Importantly, the developments in the Strait of Hormuz today signal a shift in regional dynamics that could reshape global energy markets for months.',
      'In summary, the current situation presents significant risks to global stability and requires careful monitoring of diplomatic and military channels.',
      'To summarize the situation, the Strait of Hormuz developments represent a critical juncture in regional power dynamics with broad implications.',
    ];
    for (const c of cases) {
      assert.ok(c.length >= 100 && c.length <= 500);
      assert.equal(parseWhyMattersV2(c), null, `should reject preamble: ${c.slice(0, 40)}…`);
    }
  });

  it('rejects markdown / leaked section labels the prompt told it to omit', async () => {
    const { parseWhyMattersV2 } = await import('../shared/brief-llm-core.js');
    const cases = [
      '# Situation\nIran closed the strait on April 21, halting 20% of seaborne oil. Analysis: sovereign risk repricing follows immediately for Gulf exporters.',
      '- Bullet one that should not open the response at all given the plain-prose rule in the system message.\n- Bullet two of the banned response.',
      '* Leading bullet with asterisk that should also trip the markdown rejection because analyst prose should be plain paragraphs across 2–3 sentences.',
      '1. Numbered point opening the response is equally banned by the system prompt requiring plain prose across two to three sentences with grounded references.',
      'SITUATION: Iran closed Hormuz today. ANALYSIS: cascading sovereign repricing follows. WATCH: IMF Gulf commentary in 48h. This mirrors the 2019 pattern.',
      'Analysis — the Strait closure triggers a cascading sovereign risk repricing across Gulf exporters with immediate effect on global markets and shipping lanes.',
    ];
    for (const c of cases) {
      assert.equal(parseWhyMattersV2(c), null, `should reject leaked label: ${c.slice(0, 40)}…`);
    }
  });

  it('still rejects the stub echo', async () => {
    const { parseWhyMattersV2 } = await import('../shared/brief-llm-core.js');
    const stub =
      'Story flagged by your sensitivity settings. Open for context. This stub is long enough to clear the 100-char floor but must still be rejected as non-enrichment output.';
    assert.equal(parseWhyMattersV2(stub), null);
  });

  it('strips surrounding smart-quotes before validation', async () => {
    const { parseWhyMattersV2 } = await import('../shared/brief-llm-core.js');
    const raw =
      '\u201CIran closed the Strait on April 21, halting 20% of seaborne oil. The disruption forces an immediate repricing of sovereign risk across Gulf exporters.\u201D';
    const out = parseWhyMattersV2(raw);
    assert.ok(out && !out.startsWith('\u201C'));
    assert.ok(out && !out.endsWith('\u201D'));
  });
});
