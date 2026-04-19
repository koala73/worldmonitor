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

import {
  deduplicateStories,
  deduplicateStoriesJaccard,
} from '../scripts/lib/brief-dedup.mjs';
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

    // Jaccard output is the ground truth under fallback.
    const expected = deduplicateStoriesJaccard(stories);
    assert.equal(out.length, expected.length);
    assert.ok(
      collector.lines.some((l) => l.level === 'warn' && l.line.includes('falling back to Jaccard')),
    );
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

    assert.equal(out.length, deduplicateStoriesJaccard(stories).length);
    assert.ok(collector.lines.some((l) => l.level === 'warn'));
  });
});

// ── Scenario 4 — shadow mode ──────────────────────────────────────────────────

describe('Scenario 4 — shadow mode runs both, ships Jaccard', () => {
  it('logs disagreements, writes archive, returns Jaccard output', async () => {
    // Embed path merges aggressively (near-parallel vectors). Jaccard
    // keeps them separate (different content words). Disagreement on
    // the two stories guaranteed.
    const stories = [
      story('Breaking: Iran strike on Israel', 90, 1, 's0'),
      story('Tel Aviv responds to Tehran', 85, 1, 's1'),
    ];
    const vecByTitle = new Map([
      [normalizeForEmbedding(stories[0].title), [1, 0, 0]],
      [normalizeForEmbedding(stories[1].title), [0.99, Math.sqrt(1 - 0.99 * 0.99), 0]],
    ]);
    const embedder = stubEmbedder(vecByTitle);

    const pipelineCalls = [];
    async function pipeline(commands) {
      pipelineCalls.push(commands);
      return commands.map(() => ({ result: 'OK' }));
    }

    const collector = lineCollector();
    const out = await deduplicateStories(stories, {
      env: { DIGEST_DEDUP_MODE: 'shadow', DIGEST_DEDUP_COSINE_THRESHOLD: '0.5' },
      embedBatch: embedder.embedBatch,
      redisPipeline: pipeline,
      ...collector,
    });

    // Shadow ships Jaccard output (user-visible behaviour unchanged).
    const jaccardExpected = deduplicateStoriesJaccard(stories);
    assert.equal(out.length, jaccardExpected.length);

    // Shadow archive written — the SETEX command targets the versioned
    // per-run key.
    const setCommands = pipelineCalls.flat().filter((c) => c[0] === 'SET');
    const archiveWrite = setCommands.find((c) => typeof c[1] === 'string' && c[1].startsWith('brief:dedup:shadow:v1:'));
    assert.ok(archiveWrite, 'shadow archive SET was written with the versioned prefix');
    // The archive TTL matches 21 days (SHADOW_ARCHIVE_TTL_SECONDS).
    assert.equal(archiveWrite[3], 'EX');
    assert.equal(archiveWrite[4], String(21 * 24 * 60 * 60));

    // Disagreement log line emitted.
    assert.ok(collector.lines.some((l) => l.line.includes('mode=shadow')));
    assert.ok(collector.lines.some((l) => l.line.includes('disagreements=')));
  });
});

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

// ── Scenario 8 — remote-embed-disabled bypass ─────────────────────────────────

describe('Scenario 8 — kill switch hard-disables the embed path', () => {
  it('MODE=embed + REMOTE_EMBED_ENABLED=0 never calls the embedder', async () => {
    let called = 0;
    const trap = async () => {
      called++;
      throw new Error('should not be called');
    };
    const stories = [story('x', 10, 1, 'x')];
    await deduplicateStories(stories, {
      env: { DIGEST_DEDUP_MODE: 'embed', DIGEST_DEDUP_REMOTE_EMBED_ENABLED: '0' },
      embedBatch: trap,
      redisPipeline: noopPipeline,
    });
    assert.equal(called, 0);
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
    assert.ok(locations.includes('hormuz'));
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
