/**
 * Embedding-dedup integration tests against a deterministic stub
 * embedder — no network. Covers the 9 scenarios enumerated in
 * docs/plans/2026-04-19-001-feat-embedding-based-story-dedup-plan.md:
 *
 *   1. Happy path
 *   2. Cold-cache timeout → Jaccard fallback
 *   3. Provider outage → Jaccard fallback
 *   4. Shadow mode
 *   5. Entity veto fires
 *   6. Complete-link non-chaining
 *   7. Cluster-level fixture
 *   8. Remote-embed-disabled bypass
 *   9. Permutation-invariance property test
 *
 * The live-embedder golden-pair validator lives in a separate nightly
 * CI job (.github/workflows/dedup-golden-pairs.yml) — it's NOT run
 * from the brief cron and NOT in this file.
 *
 * Run: node --test tests/brief-dedup-embedding.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { deduplicateStories } from '../scripts/lib/brief-dedup.mjs';
import { deduplicateStoriesJaccard } from '../scripts/lib/brief-dedup-jaccard.mjs';
import {
  EmbeddingProviderError,
  EmbeddingTimeoutError,
  cosineSimilarity,
  normalizeForEmbedding,
} from '../scripts/lib/brief-embedding.mjs';
import {
  completeLinkCluster,
  extractEntities,
  shouldVeto,
  singleLinkCluster,
} from '../scripts/lib/brief-dedup-embed.mjs';

// ── Fixture helpers ───────────────────────────────────────────────────────────

function story(title, score = 10, mentions = 1, hash = undefined) {
  return {
    title,
    currentScore: score,
    mentionCount: mentions,
    sources: [],
    severity: 'critical',
    hash: hash ?? `h-${title.slice(0, 16).replace(/\W+/g, '-')}`,
  };
}

// Orchestrator env that turns on the embed path without shadow-archive
// dependencies.
const EMBED_MODE = { DIGEST_DEDUP_MODE: 'embed', DIGEST_DEDUP_COSINE_THRESHOLD: '0.5' };

/**
 * Build a stub embedBatch that looks up each normalised title in a
 * provided map. Captures call count for assertion-based tests. Any
 * title missing from the map is embedded as the zero vector — which
 * will fail cosine similarity > 0, so the test will notice.
 */
function stubEmbedder(vectorByNormalizedTitle) {
  const calls = [];
  async function embedBatch(normalizedTitles) {
    calls.push(normalizedTitles.slice());
    return normalizedTitles.map((t) => {
      const v = vectorByNormalizedTitle.get(t);
      if (!v) throw new Error(`stubEmbedder: no vector for "${t}"`);
      return v;
    });
  }
  return { embedBatch, calls };
}

function noopPipeline() {
  return null;
}

/**
 * Captures log lines emitted by the orchestrator so tests can assert
 * on observability output without swallowing real console output.
 */
function lineCollector() {
  const lines = [];
  return {
    lines,
    log: (line) => lines.push({ level: 'log', line }),
    warn: (line) => lines.push({ level: 'warn', line }),
  };
}

// ── Scenario 1 — Happy path ───────────────────────────────────────────────────

describe('Scenario 1 — happy path: embed clusters near-duplicates', () => {
  it('merges two near-duplicate stories into one cluster when embed mode is on', async () => {
    const titles = [
      'iran closes strait of hormuz',
      'iran shuts strait of hormuz',
      'myanmar coup leader elected president',
    ];
    // Near-parallel vectors for 0/1 (cos ≈ 0.95), orthogonal for 2.
    const vecByTitle = new Map([
      [titles[0], [1, 0, 0]],
      [titles[1], [0.95, Math.sqrt(1 - 0.95 * 0.95), 0]],
      [titles[2], [0, 0, 1]],
    ]);
    const embedder = stubEmbedder(vecByTitle);
    const collector = lineCollector();

    const stories = [
      story('Iran closes Strait of Hormuz', 90, 1, 'h0'),
      story('Iran shuts Strait of Hormuz', 85, 1, 'h1'),
      story('Myanmar coup leader elected president', 80, 1, 'h2'),
    ];
    const out = await deduplicateStories(stories, {
      env: EMBED_MODE,
      embedBatch: embedder.embedBatch,
      redisPipeline: noopPipeline,
      ...collector,
    });

    assert.equal(embedder.calls.length, 1, 'exactly one batched embedBatch call');
    assert.equal(out.length, 2, 'two clusters (merged pair + singleton)');

    const merged = out.find((c) => c.mergedHashes.length === 2);
    assert.ok(merged, 'one cluster contains the two Hormuz variants');
    assert.deepEqual(new Set(merged.mergedHashes), new Set(['h0', 'h1']));
    assert.equal(merged.mentionCount, 2);

    const singleton = out.find((c) => c.mergedHashes.length === 1);
    assert.ok(singleton);
    assert.equal(singleton.mergedHashes[0], 'h2');

    // Structured log line emitted.
    assert.ok(collector.lines.some((l) => l.line.includes('mode=embed')));
    assert.ok(collector.lines.some((l) => l.line.includes('fallback=false')));
  });
});

// ── Scenario 2 — timeout ──────────────────────────────────────────────────────

describe('Scenario 2 — cold-cache timeout collapses to Jaccard', () => {
  it('EmbeddingTimeoutError falls back to Jaccard for the whole batch', async () => {
    const throwingEmbedder = async () => {
      throw new EmbeddingTimeoutError();
    };
    const stories = [
      story('Iran closes Strait of Hormuz', 90, 1, 'h0'),
      story('Iran shuts Strait of Hormuz', 85, 1, 'h1'),
    ];
    const collector = lineCollector();

    const out = await deduplicateStories(stories, {
      env: EMBED_MODE,
      embedBatch: throwingEmbedder,
      redisPipeline: noopPipeline,
      ...collector,
    });

    // Jaccard output is the ground truth under fallback — deep-equal
    // cluster shape, not just length, so a regression that preserves
    // count but changes membership or representative can't slip.
    const expected = deduplicateStoriesJaccard(stories);
    assert.equal(out.length, expected.length);
    for (let i = 0; i < out.length; i++) {
      assert.equal(out[i].hash, expected[i].hash);
      assert.deepEqual(out[i].mergedHashes, expected[i].mergedHashes);
      assert.equal(out[i].mentionCount, expected[i].mentionCount);
    }
    // Fallback warn line must carry a filterable reason= field.
    const fallbackWarn = collector.lines.find(
      (l) => l.level === 'warn' && l.line.includes('falling back to Jaccard'),
    );
    assert.ok(fallbackWarn, 'warn line on fallback');
    assert.match(fallbackWarn.line, /reason=EmbeddingTimeoutError\b/);
  });
});

// ── Scenario 3 — provider outage ──────────────────────────────────────────────

describe('Scenario 3 — provider outage collapses to Jaccard', () => {
  it('EmbeddingProviderError (HTTP 503) falls back', async () => {
    const throwingEmbedder = async () => {
      throw new EmbeddingProviderError('OpenRouter returned HTTP 503', { status: 503 });
    };
    const stories = [story('a', 10, 1, 'a1'), story('b', 10, 1, 'b1')];
    const collector = lineCollector();

    const out = await deduplicateStories(stories, {
      env: EMBED_MODE,
      embedBatch: throwingEmbedder,
      redisPipeline: noopPipeline,
      ...collector,
    });

    const expected = deduplicateStoriesJaccard(stories);
    assert.equal(out.length, expected.length);
    for (let i = 0; i < out.length; i++) {
      assert.equal(out[i].hash, expected[i].hash);
      assert.deepEqual(out[i].mergedHashes, expected[i].mergedHashes);
      assert.equal(out[i].mentionCount, expected[i].mentionCount);
    }
    const fallbackWarn = collector.lines.find((l) => l.level === 'warn');
    assert.ok(fallbackWarn, 'warn line on fallback');
    assert.match(fallbackWarn.line, /reason=EmbeddingProviderError\b/);
  });
});

// ── Scenario 4 / 8 — shadow mode and remote-embed kill switch were
// removed when the rollout was simplified to "ship embed directly".
// MODE=jaccard is the only rollback path; covered in
// tests/brief-dedup-jaccard.test.mjs.

// ── Scenario 5 — entity veto ──────────────────────────────────────────────────

describe('Scenario 5 — entity veto blocks same-location, different-actor merges', () => {
  it('shouldVeto fires on canonical Biden/Xi vs Biden/Putin case', () => {
    assert.equal(
      shouldVeto('Biden meets Xi in Tokyo', 'Biden meets Putin in Tokyo'),
      true,
    );
  });

  it('defers to cosine on Iran/Tehran + Hormuz (documented heuristic limitation)', () => {
    // Capital-country coreference is not resolved in v1. The plan's
    // original spec claimed the veto would fire here via "unique
    // actors {Iran} vs {Tehran}", but the classification rule is:
    //   - Iran → actor (country, not in gazetteer)
    //   - Tehran → location (capital city IS in the gazetteer)
    //   - Hormuz → location
    // With the two anchors on different sides of the actor/location
    // boundary, there's no symmetric "unique actor on each side"
    // signal and the veto can't conclude. Behaviour falls through
    // to cosine — which on real text may merge (false positive)
    // or split (false negative) depending on wording. Accepted for
    // v1 as the documented limitation; a name-normaliser is the
    // future fix.
    assert.equal(
      shouldVeto('Iran closes Hormuz', 'Tehran shuts Hormuz'),
      false,
    );
  });

  it('shouldVeto does NOT fire when actors fully match', () => {
    assert.equal(shouldVeto('Trump meets Xi', 'Trump Xi summit'), false);
  });

  it('shouldVeto defers to cosine when proper-noun sets are empty on both sides', () => {
    assert.equal(shouldVeto('the meeting concludes', 'the meeting ends'), false);
  });

  it('veto blocks cluster admission end-to-end', async () => {
    // High cosine (0.99) but disagreeing actors → veto fires and
    // the stories stay in separate clusters.
    const stories = [
      story('Biden meets Xi in Tokyo', 90, 1, 'xi'),
      story('Biden meets Putin in Tokyo', 85, 1, 'putin'),
    ];
    const vecByTitle = new Map([
      [normalizeForEmbedding(stories[0].title), [1, 0, 0]],
      [normalizeForEmbedding(stories[1].title), [0.99, Math.sqrt(1 - 0.99 * 0.99), 0]],
    ]);
    const embedder = stubEmbedder(vecByTitle);

    const out = await deduplicateStories(stories, {
      env: EMBED_MODE,
      embedBatch: embedder.embedBatch,
      redisPipeline: noopPipeline,
    });

    assert.equal(out.length, 2, 'veto keeps the two titles in separate clusters');
  });

  it('DIGEST_DEDUP_ENTITY_VETO_ENABLED=0 disables the veto at runtime', async () => {
    const stories = [
      story('Biden meets Xi in Tokyo', 90, 1, 'xi'),
      story('Biden meets Putin in Tokyo', 85, 1, 'putin'),
    ];
    const vecByTitle = new Map([
      [normalizeForEmbedding(stories[0].title), [1, 0, 0]],
      [normalizeForEmbedding(stories[1].title), [0.99, Math.sqrt(1 - 0.99 * 0.99), 0]],
    ]);
    const embedder = stubEmbedder(vecByTitle);

    const out = await deduplicateStories(stories, {
      env: { ...EMBED_MODE, DIGEST_DEDUP_ENTITY_VETO_ENABLED: '0' },
      embedBatch: embedder.embedBatch,
      redisPipeline: noopPipeline,
    });

    assert.equal(out.length, 1, 'without the veto, cosine alone merges the two titles');
  });
});

// ── Scenario 6 — complete-link non-chaining ───────────────────────────────────

describe('Scenario 6 — complete-link blocks transitive chaining', () => {
  it('A~B=0.65, B~C=0.65, A~C=0.30 → {A,B} and {C}, NOT {A,B,C}', () => {
    // Constructed so pairwise cosines are exact (see plan for derivation).
    const a = [1, 0, 0, 0];
    const b = [0.65, Math.sqrt(1 - 0.65 * 0.65), 0, 0];
    // c must satisfy: a·c = 0.30, b·c = 0.65, |c| = 1.
    // Solving: cx=0.30; cy=(0.65 - 0.65*0.30)/sqrt(1-0.4225) = 0.4550/0.7599 = 0.599;
    // cz = sqrt(1 - 0.09 - 0.359) = sqrt(0.551) = 0.7423
    const cx = 0.3;
    const cy = (0.65 - 0.65 * 0.3) / Math.sqrt(1 - 0.65 * 0.65);
    const cz = Math.sqrt(1 - cx * cx - cy * cy);
    const c = [cx, cy, cz, 0];

    // Sanity-check the construction so a regression in the derivation
    // can't mask a real bug.
    assert.ok(Math.abs(cosineSimilarity(a, b) - 0.65) < 1e-6);
    assert.ok(Math.abs(cosineSimilarity(b, c) - 0.65) < 1e-6);
    assert.ok(Math.abs(cosineSimilarity(a, c) - 0.3) < 1e-6);

    const items = [
      { title: 'A', embedding: a },
      { title: 'B', embedding: b },
      { title: 'C', embedding: c },
    ];
    const { clusters } = completeLinkCluster(items, { cosineThreshold: 0.5 });

    // {A,B} should be one cluster, {C} separate — not {A,B,C}.
    assert.equal(clusters.length, 2);
    const abCluster = clusters.find((cl) => cl.length === 2);
    const cCluster = clusters.find((cl) => cl.length === 1);
    assert.ok(abCluster && cCluster, 'two clusters: the A+B pair and the C singleton');
    assert.ok(abCluster.includes(0) && abCluster.includes(1));
    assert.ok(cCluster.includes(2));
  });
});

// ── Scenario 7 — cluster-level fixture ────────────────────────────────────────

describe('Scenario 7 — cluster-level fixture', () => {
  it('10-story fixture clusters into the expected shape', async () => {
    // Four real wire-headline clusters plus two singletons = 6 clusters.
    // Vectors are hand-crafted so only intended-cluster pairs clear 0.5.
    const e1 = [1, 0, 0, 0, 0, 0];
    const e2 = [0, 1, 0, 0, 0, 0];
    const e3 = [0, 0, 1, 0, 0, 0];
    const e4 = [0, 0, 0, 1, 0, 0];
    const e5 = [0, 0, 0, 0, 1, 0];
    const e6 = [0, 0, 0, 0, 0, 1];

    function near(axis, epsilon = 0.03) {
      // Same-direction vector at cosine > 0.99 to `axis` basis.
      const out = axis.slice();
      return out.map((v) => v * (1 - epsilon));
    }

    const fixtures = [
      { title: 'Iran closes Strait of Hormuz', hash: 'a1', v: e1, expectCluster: 'A' },
      { title: 'Iran shuts Strait of Hormuz', hash: 'a2', v: near(e1), expectCluster: 'A' },
      { title: 'US fighter jet downed over Iran', hash: 'b1', v: e2, expectCluster: 'B' },
      { title: 'American aircraft shot down in Iran', hash: 'b2', v: near(e2), expectCluster: 'B' },
      { title: 'Myanmar coup leader sworn in', hash: 'c1', v: e3, expectCluster: 'C' },
      { title: 'Myanmar junta chief takes office', hash: 'c2', v: near(e3), expectCluster: 'C' },
      { title: 'Brent crude tops $140', hash: 'd1', v: e4, expectCluster: 'D' },
      { title: 'Oil price surges past $140', hash: 'd2', v: near(e4), expectCluster: 'D' },
      { title: 'Singleton 1', hash: 's1', v: e5, expectCluster: 'E' },
      { title: 'Singleton 2', hash: 's2', v: e6, expectCluster: 'F' },
    ];
    const stories = fixtures.map((f) =>
      story(f.title, 100 - fixtures.indexOf(f), 1, f.hash),
    );
    const vecByTitle = new Map(
      fixtures.map((f) => [normalizeForEmbedding(f.title), f.v]),
    );
    const embedder = stubEmbedder(vecByTitle);

    const out = await deduplicateStories(stories, {
      env: EMBED_MODE,
      embedBatch: embedder.embedBatch,
      redisPipeline: noopPipeline,
    });

    // 6 clusters total: 4 pairs + 2 singletons.
    assert.equal(out.length, 6);

    // Each expected pair's hashes should land in the same cluster.
    const pairs = [['a1', 'a2'], ['b1', 'b2'], ['c1', 'c2'], ['d1', 'd2']];
    for (const [x, y] of pairs) {
      const cluster = out.find((c) => c.mergedHashes.includes(x));
      assert.ok(cluster?.mergedHashes.includes(y), `${x} and ${y} should cluster together`);
    }
    // Singletons stay alone.
    const s1 = out.find((c) => c.mergedHashes.includes('s1'));
    const s2 = out.find((c) => c.mergedHashes.includes('s2'));
    assert.equal(s1.mergedHashes.length, 1);
    assert.equal(s2.mergedHashes.length, 1);
  });
});

// ── Scenario 9 — permutation-invariance property test ────────────────────────

describe('Scenario 9 — permutation-invariance', () => {
  it('10 random input orders of the same 15-story set produce identical clusters', async () => {
    // Construct 15 stories in 5 clusters of 3. Each cluster shares a
    // near-unit basis vector; clusters are pairwise orthogonal.
    const N_CLUSTERS = 5;
    const PER_CLUSTER = 3;
    const fixtures = [];
    for (let c = 0; c < N_CLUSTERS; c++) {
      const basis = Array.from({ length: N_CLUSTERS }, (_, i) => (i === c ? 1 : 0));
      for (let k = 0; k < PER_CLUSTER; k++) {
        const jitter = basis.map((v, i) => (i === c ? v - k * 0.002 : v));
        fixtures.push({
          title: `Cluster ${c} item ${k}`,
          hash: `c${c}-k${k}`,
          v: jitter,
          score: 100 - (c * PER_CLUSTER + k),
        });
      }
    }
    const stories = fixtures.map((f) => story(f.title, f.score, 1, f.hash));
    const vecByTitle = new Map(
      fixtures.map((f) => [normalizeForEmbedding(f.title), f.v]),
    );

    function sigFor(out) {
      // Canonical representation: each cluster as a sorted hash list,
      // overall list sorted.
      return out.map((c) => [...c.mergedHashes].sort()).map((l) => l.join(',')).sort().join('|');
    }

    // Baseline run on the canonical input order.
    const baseline = await deduplicateStories(stories, {
      env: EMBED_MODE,
      embedBatch: stubEmbedder(vecByTitle).embedBatch,
      redisPipeline: noopPipeline,
    });
    const baselineSig = sigFor(baseline);

    // Ten random permutations — each must produce the IDENTICAL cluster set.
    let seed = 42;
    function rand() {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    }
    for (let run = 0; run < 10; run++) {
      const shuffled = [...stories];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const out = await deduplicateStories(shuffled, {
        env: EMBED_MODE,
        embedBatch: stubEmbedder(vecByTitle).embedBatch,
        redisPipeline: noopPipeline,
      });
      assert.equal(
        sigFor(out),
        baselineSig,
        `permutation ${run} produced a different cluster set`,
      );
    }
  });
});

// ── Entity extraction unit tests ──────────────────────────────────────────────

describe('extractEntities', () => {
  it('classifies country name as actor, strait as location', () => {
    // Per plan intent: countries are geopolitical actors ("Iran does X"),
    // physical geography is the venue.
    const { locations, actors } = extractEntities('Iran closes Strait of Hormuz');
    assert.ok(actors.includes('iran'));
    // Multi-word match finds "strait of hormuz", NOT the single-token
    // fallback "hormuz" — the full phrase is in the gazetteer.
    assert.ok(
      locations.includes('strait of hormuz') || locations.includes('hormuz'),
      'hormuz location must be detected (as phrase or single token)',
    );
    assert.ok(!locations.includes('iran'));
  });

  it('classifies city as location, person as actor', () => {
    const { locations, actors } = extractEntities('Biden meets Xi in Tokyo');
    assert.ok(locations.includes('tokyo'));
    assert.ok(actors.includes('biden'));
    assert.ok(actors.includes('xi'));
  });

  it('skips common capitalized sentence-starters', () => {
    const { locations, actors } = extractEntities('The meeting begins');
    assert.equal(locations.length, 0);
    assert.equal(actors.length, 0);
  });

  it('keeps sentence-start proper nouns', () => {
    const { actors } = extractEntities('Trump to visit Japan');
    assert.ok(actors.includes('trump'));
    // Japan is a country → actor, not location
    assert.ok(actors.includes('japan'));
  });

  // Regression: multi-word gazetteer entries are matched as whole
  // phrases. An earlier implementation split on whitespace and only
  // checked single tokens, so "Red Sea", "South China Sea", "New York",
  // etc. silently fell through to the actor bucket and disabled the
  // veto for a whole class of real headlines.
  it('matches multi-word location: Red Sea', () => {
    const { locations, actors } = extractEntities('Houthis strike ship in Red Sea');
    assert.ok(locations.includes('red sea'));
    assert.ok(!actors.includes('red'));
    assert.ok(!actors.includes('sea'));
    assert.ok(actors.includes('houthis'));
  });

  it('matches multi-word location: South China Sea', () => {
    const { locations } = extractEntities('Tensions flare in South China Sea');
    assert.ok(locations.includes('south china sea'));
  });

  it('matches multi-word location with lowercase connector: Strait of Hormuz', () => {
    const { locations } = extractEntities('Iran closes Strait of Hormuz');
    assert.ok(locations.includes('strait of hormuz'));
  });

  it('matches multi-word city: Abu Dhabi', () => {
    const { locations } = extractEntities('Summit held in Abu Dhabi');
    assert.ok(locations.includes('abu dhabi'));
  });

  it('matches multi-word city: New York', () => {
    const { locations } = extractEntities('UN meeting in New York');
    assert.ok(locations.includes('new york'));
  });

  // Veto end-to-end: reproducer from the P1 finding. Two Red-Sea
  // headlines share a location and disagree on the actor — veto
  // MUST fire (otherwise the main anti-overmerge guard is off for
  // bodies-of-water / region headlines).
  it('shouldVeto: Houthis vs US on Red Sea — location phrase match fires the veto', () => {
    assert.equal(
      shouldVeto('Houthis strike ship in Red Sea', 'US escorts convoy in Red Sea'),
      true,
    );
  });
});

// ── Single-link clustering ───────────────────────────────────────────────────

describe('singleLinkCluster', () => {
  // Derived from a real production case (2026-04-20-1532 brief, US
  // Navy ship-seizure coverage): 4 wire stories about the same event
  // where pairwise cosines chain through a strong intermediate (story
  // 5 with cos ≥ 0.63 to every other) but one outlier pair (1↔8) is
  // 0.500. Complete-link refuses to merge all 4 because of the outlier;
  // single-link chains them via the bridge.
  it('chains 4 items through a strong intermediate when one pair is weak', () => {
    // Construct 4 unit vectors so cosines are exact:
    //   5 = [1, 0, 0]
    //   1 ≈ strong link to 5 (~0.65), weak to 8
    //   8 ≈ strong link to 5 (~0.70), weak to 1
    //   10 ≈ strong link to 5 (~0.66), weak to 8
    // Constructing this in 3D isn't straightforward; easier to just
    // hand-craft vectors that give the required pairwise matrix.
    const v5 = [1, 0, 0, 0];
    const v1 = [0.65, Math.sqrt(1 - 0.65 * 0.65), 0, 0];
    const v8 = [0.70, 0.0, Math.sqrt(1 - 0.70 * 0.70), 0];
    const v10 = [0.66, Math.sqrt(1 - 0.66 * 0.66) * 0.3, 0, Math.sqrt(1 - 0.66 * 0.66 - (Math.sqrt(1 - 0.66 * 0.66) * 0.3) ** 2)];
    const items = [
      { title: 's1', embedding: v1 },
      { title: 's5', embedding: v5 },
      { title: 's8', embedding: v8 },
      { title: 's10', embedding: v10 },
    ];

    // Complete-link at 0.55 splits at least one story out because the
    // weak 1↔8 / 8↔10 pairs fail the "every pair" rule.
    const complete = completeLinkCluster(items, { cosineThreshold: 0.55 });
    assert.ok(complete.clusters.length >= 2, 'complete-link fails to merge all 4');

    // Single-link at 0.55 chains them through story 5 (strong link
    // to each of 1, 8, 10).
    const single = singleLinkCluster(items, { cosineThreshold: 0.55 });
    assert.equal(single.clusters.length, 1, 'single-link unions all 4 via the bridge');
    assert.deepEqual([...single.clusters[0]].sort(), [0, 1, 2, 3]);
  });

  it('respects veto: pairs that satisfy cosine but fail shouldVeto do NOT union', () => {
    // Two items with high cosine but the veto fires on the pair
    // shape (shared location, disagreeing actors).
    const items = [
      { title: 'Biden meets Xi in Tokyo', embedding: [1, 0, 0] },
      { title: 'Biden meets Putin in Tokyo', embedding: [0.99, Math.sqrt(1 - 0.99 * 0.99), 0] },
    ];
    const vetoFn = (a, b) => shouldVeto(a.title, b.title);
    const out = singleLinkCluster(items, { cosineThreshold: 0.5, vetoFn });
    assert.equal(out.clusters.length, 2, 'veto keeps the two titles separate');
    assert.equal(out.vetoFires, 1);
  });

  it('permutation-invariant: random input orders yield the same cluster set', () => {
    // Single-link is order-independent by construction (union-find
    // doesn't care which pair is visited first). Property test.
    const N = 12;
    const items = [];
    for (let c = 0; c < 3; c++) {
      const basis = Array.from({ length: 3 }, (_, i) => (i === c ? 1 : 0));
      for (let k = 0; k < 4; k++) {
        const jitter = basis.map((v, i) => (i === c ? v - k * 0.002 : v));
        items.push({ title: `c${c}-k${k}`, embedding: jitter, _hash: `c${c}k${k}` });
      }
    }
    const baseline = singleLinkCluster(items, { cosineThreshold: 0.9 }).clusters;
    const baselineSig = baseline
      .map((c) => c.map((i) => items[i]._hash).sort().join(','))
      .sort()
      .join('|');

    let seed = 17;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let r = 0; r < 5; r++) {
      const shuffled = [...items];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const run = singleLinkCluster(shuffled, { cosineThreshold: 0.9 }).clusters;
      const sig = run
        .map((c) => c.map((i) => shuffled[i]._hash).sort().join(','))
        .sort()
        .join('|');
      assert.equal(sig, baselineSig, `shuffle ${r} produced a different cluster set`);
    }
  });

  it('empty input returns empty clusters without exploding', () => {
    const out = singleLinkCluster([], { cosineThreshold: 0.5 });
    assert.deepEqual(out.clusters, []);
    assert.equal(out.vetoFires, 0);
  });
});

// ── Orchestrator clustering-algorithm dispatch ────────────────────────────────

describe('readOrchestratorConfig — DIGEST_DEDUP_CLUSTERING', () => {
  it('defaults to single-link when DIGEST_DEDUP_CLUSTERING is unset', async () => {
    const { readOrchestratorConfig } = await import('../scripts/lib/brief-dedup.mjs');
    const cfg = readOrchestratorConfig({});
    assert.equal(cfg.clustering, 'single');
  });
  it('honours DIGEST_DEDUP_CLUSTERING=complete (kill switch)', async () => {
    const { readOrchestratorConfig } = await import('../scripts/lib/brief-dedup.mjs');
    const cfg = readOrchestratorConfig({ DIGEST_DEDUP_CLUSTERING: 'complete' });
    assert.equal(cfg.clustering, 'complete');
  });
  it('unrecognised values fall back to single (default, safe)', async () => {
    const { readOrchestratorConfig } = await import('../scripts/lib/brief-dedup.mjs');
    const cfg = readOrchestratorConfig({ DIGEST_DEDUP_CLUSTERING: 'average' });
    assert.equal(cfg.clustering, 'single');
  });
  it('structured log line includes clustering=<algo>', async () => {
    const { deduplicateStories } = await import('../scripts/lib/brief-dedup.mjs');
    const stories = [story('x', 10, 1, 'x1'), story('y', 10, 1, 'y1')];
    const vec = new Map([
      [normalizeForEmbedding('x'), [1, 0, 0]],
      [normalizeForEmbedding('y'), [0.99, Math.sqrt(1 - 0.99 * 0.99), 0]],
    ]);
    const { embedBatch } = stubEmbedder(vec);
    const lines = [];
    await deduplicateStories(stories, {
      env: { DIGEST_DEDUP_MODE: 'embed', DIGEST_DEDUP_COSINE_THRESHOLD: '0.5' },
      embedBatch,
      redisPipeline: async () => [],
      log: (l) => lines.push(l),
    });
    assert.ok(lines.some((l) => /clustering=(single|complete)/.test(l)), 'log line must mention clustering algorithm');
  });
});

// ── Cosine helper ─────────────────────────────────────────────────────────────

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    assert.equal(cosineSimilarity([1, 2, 3], [1, 2, 3]), 1);
  });
  it('returns 0 for orthogonal vectors', () => {
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  });
  it('handles a zero vector without throwing', () => {
    assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
  });
});
