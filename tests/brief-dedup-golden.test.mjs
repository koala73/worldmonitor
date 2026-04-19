/**
 * Golden-pair canary for brief-dedup — 20 canonical pairs with
 * expected same-event / different-event classifications.
 *
 * This variant uses a MOCKED embedder: vectors are crafted so the
 * expected clustering decision is structurally forced. That
 * validates the plumbing (cosine threshold + entity veto) for the
 * pairs we care about.
 *
 * The LIVE-embedder variant runs in the nightly CI workflow
 * (.github/workflows/dedup-golden-pairs.yml) — it calls real
 * OpenRouter and is the true signal for embedding drift.
 *
 * Run: node --test tests/brief-dedup-golden.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { deduplicateStories } from '../scripts/lib/brief-dedup.mjs';
import { normalizeForEmbedding } from '../scripts/lib/brief-embedding.mjs';

// ── Fixture vocabulary ─────────────────────────────────────────────────

// Four orthogonal basis directions for distinct event-families.
const DIR = {
  HORMUZ: [1, 0, 0, 0, 0, 0],
  IRAN_STRIKE: [0, 1, 0, 0, 0, 0],
  US_POLITICS: [0, 0, 1, 0, 0, 0],
  ECONOMY: [0, 0, 0, 1, 0, 0],
  NATURAL: [0, 0, 0, 0, 1, 0],
  MYANMAR: [0, 0, 0, 0, 0, 1],
};

function near(dir, epsilon = 0.05) {
  // Same direction, cosine ≈ 1 - epsilon² / 2 ≈ 0.998 for epsilon=0.05.
  return dir.map((v) => v * (1 - epsilon));
}

function blend(a, b, aWeight = 0.7) {
  // Produce an intermediate vector that's between two directions.
  const out = a.map((v, i) => aWeight * v + (1 - aWeight) * b[i]);
  const norm = Math.sqrt(out.reduce((acc, v) => acc + v * v, 0));
  return out.map((v) => v / norm);
}

// ── Golden-pair fixture (20 pairs) ────────────────────────────────────
//
// Each entry: { a, b, expect: 'merge' | 'split', tag }
// Title-level normalization happens inside the orchestrator; the
// vector table is keyed on the normalised title so the mock returns
// the correct vector regardless of the input's casing / suffix.

const PAIRS = [
  // ── Same-event pairs (merge) ─────────────────────────────────────────
  { tag: 'hormuz variant A', a: 'Iran closes Strait of Hormuz', b: 'Iran shuts Strait of Hormuz', aVec: DIR.HORMUZ, bVec: near(DIR.HORMUZ), expect: 'merge' },
  { tag: 'hormuz variant B', a: 'Tehran moves to close Hormuz', b: 'Hormuz closure looms after Iran warning', aVec: near(DIR.HORMUZ, 0.04), bVec: near(DIR.HORMUZ, 0.06), expect: 'merge' },
  { tag: 'jet downed variant', a: 'US fighter jet shot down over Iran', b: 'American aircraft downed in Iran strike', aVec: DIR.IRAN_STRIKE, bVec: near(DIR.IRAN_STRIKE), expect: 'merge' },
  { tag: 'jet search variant', a: 'Search underway for US pilot downed in Iran', b: 'Crew hunt continues after Iran jet downing', aVec: near(DIR.IRAN_STRIKE, 0.04), bVec: near(DIR.IRAN_STRIKE, 0.06), expect: 'merge' },
  { tag: 'trump speech wire', a: 'Trump addresses nation after Iran escalation', b: 'Trump speech: US response to Iran', aVec: DIR.US_POLITICS, bVec: near(DIR.US_POLITICS), expect: 'merge' },
  { tag: 'oil spike wire', a: 'Brent oil spot price soars to $141', b: 'Oil prices jump past $140 on supply fears', aVec: DIR.ECONOMY, bVec: near(DIR.ECONOMY), expect: 'merge' },
  { tag: 'myanmar coup wire', a: 'Myanmar coup leader elected president', b: 'Myanmar junta chief confirmed as head of state', aVec: DIR.MYANMAR, bVec: near(DIR.MYANMAR), expect: 'merge' },
  { tag: 'natural disaster wire', a: 'Magnitude 7.2 earthquake strikes Taiwan', b: 'Strong earthquake hits Taiwan, tsunami warning issued', aVec: DIR.NATURAL, bVec: near(DIR.NATURAL), expect: 'merge' },
  { tag: 'source suffix differs', a: 'Iran closes Hormuz - Reuters', b: 'Iran closes Hormuz - AP News', aVec: DIR.HORMUZ, bVec: DIR.HORMUZ, expect: 'merge' },
  { tag: 'wording minor', a: 'Iran closes Hormuz', b: 'Iran closes Strait of Hormuz', aVec: DIR.HORMUZ, bVec: near(DIR.HORMUZ, 0.02), expect: 'merge' },

  // ── Different-event pairs (split) ────────────────────────────────────
  { tag: 'hormuz vs jet strike', a: 'Iran closes Strait of Hormuz', b: 'US fighter jet shot down over Iran', aVec: DIR.HORMUZ, bVec: DIR.IRAN_STRIKE, expect: 'split' },
  { tag: 'oil vs coup', a: 'Brent oil spot price soars to $141', b: 'Myanmar coup leader elected president', aVec: DIR.ECONOMY, bVec: DIR.MYANMAR, expect: 'split' },
  { tag: 'trump vs earthquake', a: 'Trump addresses nation', b: 'Magnitude 7.2 earthquake strikes Taiwan', aVec: DIR.US_POLITICS, bVec: DIR.NATURAL, expect: 'split' },
  { tag: 'bridge headline trap', a: 'Iran tensions rise as Trump weighs response', b: 'Trump signs executive order on domestic policy', aVec: blend(DIR.US_POLITICS, DIR.IRAN_STRIKE, 0.25), bVec: DIR.US_POLITICS, expect: 'split' },
  // Talks ≠ market reaction — the PR #3195 false-positive case.
  { tag: 'iran talks vs oil reaction', a: 'Iran nuclear talks resume', b: 'Oil prices rise on Iran nuclear talks optimism', aVec: blend(DIR.IRAN_STRIKE, DIR.US_POLITICS, 0.7), bVec: blend(DIR.ECONOMY, DIR.IRAN_STRIKE, 0.8), expect: 'split' },

  // ── Entity-veto canonical cases (split) ──────────────────────────────
  // Same venue token, different protagonists — veto fires even if
  // cosine is high.
  { tag: 'biden xi vs biden putin', a: 'Biden meets Xi in Tokyo', b: 'Biden meets Putin in Tokyo', aVec: near(DIR.US_POLITICS), bVec: near(DIR.US_POLITICS, 0.02), expect: 'split' },
  // Different target cities (Kyiv vs Odesa grain port) = different
  // events even though both are "Russia attacks Ukraine". A good
  // embedder places them in adjacent-but-distinct regions of the
  // space; we model that as a 0.5 blend away from a shared basis.
  { tag: 'russia kyiv vs russia odesa', a: 'Russia missile attack hits Kyiv', b: 'Russia attack disrupts Odesa grain', aVec: blend(DIR.IRAN_STRIKE, DIR.ECONOMY, 0.85), bVec: blend(DIR.IRAN_STRIKE, DIR.ECONOMY, 0.3), expect: 'split' },

  // ── Different-event edge cases (split) ───────────────────────────────
  // PR #3195 reviewer-flagged case: French + Lebanon shared, verbs
  // diverge (killed vs arrives). Real embedder places them far
  // apart; model that as two different basis blends.
  { tag: 'french soldier vs envoy in lebanon', a: 'French soldier killed in Lebanon', b: 'French envoy arrives in Lebanon', aVec: DIR.IRAN_STRIKE, bVec: DIR.US_POLITICS, expect: 'split' },
  { tag: 'hormuz vs economy', a: 'Iran closes Hormuz', b: 'Brent oil spot price soars to $141', aVec: DIR.HORMUZ, bVec: DIR.ECONOMY, expect: 'split' },
  { tag: 'myanmar vs taiwan earthquake', a: 'Myanmar coup leader elected', b: 'Magnitude 7.2 earthquake strikes Taiwan', aVec: DIR.MYANMAR, bVec: DIR.NATURAL, expect: 'split' },
];

// ── Harness ────────────────────────────────────────────────────────────

function story(title, score, hash) {
  return { title, currentScore: score, mentionCount: 1, sources: [], severity: 'critical', hash };
}

async function classifyPair(pair) {
  const stories = [story(pair.a, 90, 'a'), story(pair.b, 80, 'b')];
  const vecByTitle = new Map([
    [normalizeForEmbedding(pair.a), pair.aVec],
    [normalizeForEmbedding(pair.b), pair.bVec],
  ]);
  async function embedBatch(normalizedTitles) {
    return normalizedTitles.map((t) => vecByTitle.get(t));
  }
  const out = await deduplicateStories(stories, {
    env: { DIGEST_DEDUP_MODE: 'embed', DIGEST_DEDUP_COSINE_THRESHOLD: '0.7' },
    embedBatch,
    redisPipeline: async () => null,
  });
  return out.length === 1 ? 'merge' : 'split';
}

// ── Test body ──────────────────────────────────────────────────────────

describe('brief-dedup golden pairs (mocked embedder)', () => {
  it('has 20 pairs covering merge + split + entity-veto cases', () => {
    assert.equal(PAIRS.length, 20);
    const mergeCount = PAIRS.filter((p) => p.expect === 'merge').length;
    const splitCount = PAIRS.filter((p) => p.expect === 'split').length;
    assert.equal(mergeCount, 10, '10 merge pairs');
    assert.equal(splitCount, 10, '10 split pairs');
  });

  for (const pair of PAIRS) {
    it(`${pair.tag}: expects ${pair.expect}`, async () => {
      const got = await classifyPair(pair);
      assert.equal(
        got,
        pair.expect,
        `Pair "${pair.tag}" (a="${pair.a}", b="${pair.b}") classified as ${got}, expected ${pair.expect}`,
      );
    });
  }
});
