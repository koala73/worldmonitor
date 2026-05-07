// Regression tests for composeBriefFromDigestStories — the live path
// that maps the digest accumulator's per-variant story pool (same
// pool the email digest reads) into a BriefEnvelope.
//
// Why these tests exist: Phase 3a originally composed from
// news:insights:v1 (a global 8-story summary). The email, however,
// reads from digest:accumulator:v1:{variant}:{lang} (30+ stories).
// The result was a brief whose stories had nothing to do with the
// email a user had just received. These tests lock the mapping so a
// future "clever" change can't regress the brief away from the
// email's story pool.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { composeBriefFromDigestStories, stripHeadlineSuffix } from '../scripts/lib/brief-compose.mjs';
import { materializeCluster } from '../scripts/lib/brief-dedup-jaccard.mjs';

const NOW = 1_745_000_000_000; // 2026-04-18 ish, deterministic

function rule(overrides = {}) {
  return {
    userId: 'user_abc',
    variant: 'full',
    enabled: true,
    digestMode: 'daily',
    sensitivity: 'all',
    aiDigestEnabled: true,
    digestTimezone: 'UTC',
    updatedAt: NOW,
    ...overrides,
  };
}

function digestStory(overrides = {}) {
  return {
    hash: 'abc123',
    title: 'Iran threatens to close Strait of Hormuz',
    link: 'https://example.com/hormuz',
    severity: 'critical',
    currentScore: 100,
    mentionCount: 5,
    phase: 'developing',
    sources: ['Guardian', 'Al Jazeera'],
    ...overrides,
  };
}

describe('composeBriefFromDigestStories', () => {
  it('returns null for empty input (caller falls back)', () => {
    assert.equal(composeBriefFromDigestStories(rule(), [], { clusters: 0, multiSource: 0 }, { nowMs: NOW }), null);
    assert.equal(composeBriefFromDigestStories(rule(), null, { clusters: 0, multiSource: 0 }, { nowMs: NOW }), null);
  });

  it('maps digest story title → brief headline and description', () => {
    const env = composeBriefFromDigestStories(
      rule(),
      [digestStory()],
      { clusters: 12, multiSource: 3 },
      { nowMs: NOW },
    );
    assert.ok(env, 'expected an envelope');
    assert.equal(env.data.stories.length, 1);
    const s = env.data.stories[0];
    assert.equal(s.headline, 'Iran threatens to close Strait of Hormuz');
    // Baseline description is the (cleaned) headline — the LLM
    // enrichBriefEnvelopeWithLLM pass substitutes a proper
    // generate-story-description sentence on top of this.
    assert.equal(s.description, 'Iran threatens to close Strait of Hormuz');
  });

  it('plumbs digest story link through as BriefStory.sourceUrl', () => {
    const env = composeBriefFromDigestStories(
      rule(),
      [digestStory({ link: 'https://example.com/hormuz?ref=rss' })],
      { clusters: 0, multiSource: 0 },
      { nowMs: NOW },
    );
    assert.ok(env, 'expected an envelope');
    assert.equal(env.data.stories[0].sourceUrl, 'https://example.com/hormuz?ref=rss');
  });

  it('drops stories that have no valid link (envelope v2 requires sourceUrl)', () => {
    const env = composeBriefFromDigestStories(
      rule(),
      [
        digestStory({ link: '', title: 'A' }),
        digestStory({ link: 'javascript:alert(1)', title: 'B', hash: 'b' }),
        digestStory({ link: 'https://example.com/c', title: 'C', hash: 'c' }),
      ],
      { clusters: 0, multiSource: 0 },
      { nowMs: NOW },
    );
    assert.equal(env.data.stories.length, 1);
    assert.equal(env.data.stories[0].headline, 'C');
  });

  it('strips a trailing " - <publisher>" suffix from RSS headlines', () => {
    const env = composeBriefFromDigestStories(
      rule(),
      [digestStory({
        title: 'Iranian gunboats fire on tanker in Strait of Hormuz - AP News',
        sources: ['AP News'],
      })],
      { clusters: 0, multiSource: 0 },
      { nowMs: NOW },
    );
    assert.equal(
      env.data.stories[0].headline,
      'Iranian gunboats fire on tanker in Strait of Hormuz',
    );
  });
});

describe('stripHeadlineSuffix', () => {
  it('strips " - Publisher" when the publisher matches the source', () => {
    assert.equal(stripHeadlineSuffix('Story body - AP News', 'AP News'), 'Story body');
  });
  it('strips " | Publisher" and " — Publisher" variants', () => {
    assert.equal(stripHeadlineSuffix('Story body | Reuters', 'Reuters'), 'Story body');
    assert.equal(stripHeadlineSuffix('Story body \u2014 BBC', 'BBC'), 'Story body');
    assert.equal(stripHeadlineSuffix('Story body \u2013 BBC', 'BBC'), 'Story body');
  });
  it('is case-insensitive on the publisher match', () => {
    assert.equal(stripHeadlineSuffix('Story body - ap news', 'AP News'), 'Story body');
  });
  it('leaves the title alone when the tail is not just the publisher', () => {
    assert.equal(
      stripHeadlineSuffix('Story - AP News analysis', 'AP News'),
      'Story - AP News analysis',
    );
  });
  it('leaves the title alone when there is no matching separator', () => {
    const title = 'Headline with no suffix';
    assert.equal(stripHeadlineSuffix(title, 'AP News'), title);
  });
  it('handles missing / empty inputs without throwing', () => {
    assert.equal(stripHeadlineSuffix('', 'AP News'), '');
    assert.equal(stripHeadlineSuffix('Headline', ''), 'Headline');
    // @ts-expect-error testing unexpected input
    assert.equal(stripHeadlineSuffix(undefined, 'AP News'), '');
  });
});

describe('composeBriefFromDigestStories — continued', () => {

  it('uses first sources[] entry as the brief source', () => {
    const env = composeBriefFromDigestStories(
      rule(),
      [digestStory({ sources: ['Reuters', 'AP'] })],
      { clusters: 0, multiSource: 0 },
      { nowMs: NOW },
    );
    assert.equal(env.data.stories[0].source, 'Reuters');
  });

  it('falls back to "Multiple wires" when sources[] is empty', () => {
    const env = composeBriefFromDigestStories(
      rule(),
      [digestStory({ sources: [] })],
      { clusters: 0, multiSource: 0 },
      { nowMs: NOW },
    );
    assert.equal(env.data.stories[0].source, 'Multiple wires');
  });

  it('respects sensitivity=critical by dropping non-critical stories', () => {
    const env = composeBriefFromDigestStories(
      rule({ sensitivity: 'critical' }),
      [
        digestStory({ severity: 'critical', title: 'A' }),
        digestStory({ severity: 'high', title: 'B', hash: 'b' }),
        digestStory({ severity: 'medium', title: 'C', hash: 'c' }),
      ],
      { clusters: 0, multiSource: 0 },
      { nowMs: NOW },
    );
    assert.equal(env.data.stories.length, 1);
    assert.equal(env.data.stories[0].headline, 'A');
  });

  it('respects sensitivity=high (critical + high pass, medium drops)', () => {
    const env = composeBriefFromDigestStories(
      rule({ sensitivity: 'high' }),
      [
        digestStory({ severity: 'critical', title: 'A' }),
        digestStory({ severity: 'high', title: 'B', hash: 'b' }),
        digestStory({ severity: 'medium', title: 'C', hash: 'c' }),
      ],
      { clusters: 0, multiSource: 0 },
      { nowMs: NOW },
    );
    assert.equal(env.data.stories.length, 2);
    assert.deepEqual(env.data.stories.map((s) => s.headline), ['A', 'B']);
  });

  it('caps at 12 stories per brief by default (env-tunable via DIGEST_MAX_STORIES_PER_USER)', () => {
    // Default kept at 12. Offline sweep harness against 2026-04-24
    // production replay showed cap=16 dropped visible_quality from
    // 0.916 → 0.716 at the active 0.45 threshold (positions 13-16
    // are mostly singletons or "should-separate" members at this
    // threshold, so they dilute without helping adjacency). The
    // constant is env-tunable so a Railway flip can experiment with
    // cap values once new sweep evidence justifies them.
    // Vary sources so U5's source-topic cap (default 2 per source+category)
    // doesn't dominate the maxStories cap we're testing here.
    const many = Array.from({ length: 30 }, (_, i) =>
      digestStory({ hash: `h${i}`, title: `Story ${i}`, sources: [`Source${i}`] }),
    );
    const env = composeBriefFromDigestStories(
      rule(),
      many,
      { clusters: 30, multiSource: 15 },
      { nowMs: NOW },
    );
    assert.equal(env.data.stories.length, 12);
  });

  it('maps unknown severity to null → story is dropped', () => {
    const env = composeBriefFromDigestStories(
      rule(),
      [
        digestStory({ severity: 'unknown', title: 'drop me' }),
        digestStory({ severity: 'critical', title: 'keep me', hash: 'k' }),
      ],
      { clusters: 0, multiSource: 0 },
      { nowMs: NOW },
    );
    assert.equal(env.data.stories.length, 1);
    assert.equal(env.data.stories[0].headline, 'keep me');
  });

  it('aliases upstream "moderate" severity to "medium"', () => {
    const env = composeBriefFromDigestStories(
      rule({ sensitivity: 'all' }),
      [digestStory({ severity: 'moderate', title: 'mod' })],
      { clusters: 0, multiSource: 0 },
      { nowMs: NOW },
    );
    assert.equal(env.data.stories[0].threatLevel, 'medium');
  });

  it('defaults category to "General" and country to "Global" when the digest track omits them', () => {
    const env = composeBriefFromDigestStories(
      rule(),
      [digestStory()],
      { clusters: 0, multiSource: 0 },
      { nowMs: NOW },
    );
    const s = env.data.stories[0];
    assert.equal(s.category, 'General');
    assert.equal(s.country, 'Global');
  });

  it('passes insightsNumbers through to the stats page', () => {
    const env = composeBriefFromDigestStories(
      rule(),
      [digestStory()],
      { clusters: 277, multiSource: 22 },
      { nowMs: NOW },
    );
    // numbers live on the digest branch of the envelope. Shape is
    // deliberately validated here so the assembler can't silently
    // drop them.
    assert.equal(env.data.digest.numbers.clusters, 277);
    assert.equal(env.data.digest.numbers.multiSource, 22);
  });

  it('returns deterministic envelope for same input (safe to retry)', () => {
    const input = [digestStory()];
    const a = composeBriefFromDigestStories(rule(), input, { clusters: 1, multiSource: 0 }, { nowMs: NOW });
    const b = composeBriefFromDigestStories(rule(), input, { clusters: 1, multiSource: 0 }, { nowMs: NOW });
    assert.deepEqual(a, b);
  });

  // ── Description plumbing (U4) ────────────────────────────────────────────

  it('forwards real RSS description when present on the digest story', () => {
    const realBody = 'Mojtaba Khamenei, 56, was seriously wounded in an attack this week and has delegated authority to the Revolutionary Guards, multiple regional sources told News24.';
    const env = composeBriefFromDigestStories(
      rule(),
      [digestStory({
        title: "Iran's new supreme leader seriously wounded, delegates power to Revolutionary Guards",
        description: realBody,
      })],
      { clusters: 1, multiSource: 0 },
      { nowMs: NOW },
    );
    assert.ok(env);
    const s = env.data.stories[0];
    // Real RSS body grounds the description card; LLM grounding now
    // operates over article-named actors instead of parametric priors.
    assert.ok(s.description.includes('Mojtaba'), 'brief description should carry the article-named actor when upstream persists it');
    assert.notStrictEqual(
      s.description,
      "Iran's new supreme leader seriously wounded, delegates power to Revolutionary Guards",
      'brief description must not fall back to headline when upstream has a real body',
    );
  });

  it('falls back to cleaned headline when digest story has no description (R6)', () => {
    const env = composeBriefFromDigestStories(
      rule(),
      [digestStory({ description: '' })],
      { clusters: 0, multiSource: 0 },
      { nowMs: NOW },
    );
    assert.ok(env);
    assert.equal(
      env.data.stories[0].description,
      'Iran threatens to close Strait of Hormuz',
      'empty description must preserve today behavior — cleaned headline baseline',
    );
  });

  it('treats whitespace-only description as empty (falls back to headline)', () => {
    const env = composeBriefFromDigestStories(
      rule(),
      [digestStory({ description: '   \n  ' })],
      { clusters: 0, multiSource: 0 },
      { nowMs: NOW },
    );
    assert.ok(env);
    assert.equal(env.data.stories[0].description, 'Iran threatens to close Strait of Hormuz');
  });

  describe('undefined sensitivity defaults to "high" (NOT "all")', () => {
    // PR #3387 review (P2): the previous `?? 'all'` default would
    // silently widen to {medium, low} for any non-prefiltered caller
    // with undefined sensitivity, while operator telemetry labeled the
    // attempt as 'high' (matching buildDigest's default). The two
    // defaults must agree to keep the per-attempt log accurate and to
    // prevent unintended severity widening through this entry point.
    function ruleWithoutSensitivity() {
      const r = rule();
      delete r.sensitivity;
      return r;
    }

    it('admits critical and high stories when sensitivity is undefined', () => {
      const env = composeBriefFromDigestStories(
        ruleWithoutSensitivity(),
        [
          digestStory({ hash: 'a', title: 'Critical event', severity: 'critical' }),
          digestStory({ hash: 'b', title: 'High event', severity: 'high' }),
        ],
        { clusters: 0, multiSource: 0 },
        { nowMs: NOW },
      );
      assert.ok(env);
      assert.equal(env.data.stories.length, 2);
    });

    it('drops medium and low stories when sensitivity is undefined', () => {
      const env = composeBriefFromDigestStories(
        ruleWithoutSensitivity(),
        [
          digestStory({ hash: 'a', title: 'Medium event', severity: 'medium' }),
          digestStory({ hash: 'b', title: 'Low event', severity: 'low' }),
        ],
        { clusters: 0, multiSource: 0 },
        { nowMs: NOW },
      );
      // No critical/high stories survive → composer returns null per
      // the empty-survivor contract (caller falls back to next variant).
      assert.equal(env, null);
    });

    it('emits onDrop reason=severity for medium/low when sensitivity is undefined', () => {
      // Locks in alignment with the per-attempt telemetry: if compose
      // were to default to 'all' again, medium/low would NOT fire a
      // severity drop and the log would silently misreport the filter.
      const tally = { severity: 0, headline: 0, url: 0, shape: 0, cap: 0 };
      composeBriefFromDigestStories(
        ruleWithoutSensitivity(),
        [
          digestStory({ hash: 'a', title: 'Medium', severity: 'medium' }),
          digestStory({ hash: 'b', title: 'Low', severity: 'low' }),
        ],
        { clusters: 0, multiSource: 0 },
        { nowMs: NOW, onDrop: (ev) => { tally[ev.reason]++; } },
      );
      assert.equal(tally.severity, 2);
    });
  });
});

// ── synthesis splice (Codex Round-3 plan, Step 3) ─────────────────────────

describe('composeBriefFromDigestStories — synthesis splice', () => {
  it('substitutes envelope.digest.lead/threads/signals/publicLead from synthesis', () => {
    const env = composeBriefFromDigestStories(
      rule(),
      [digestStory({ hash: 'h1', title: 'Story 1' }), digestStory({ hash: 'h2', title: 'Story 2' })],
      { clusters: 12, multiSource: 3 },
      {
        nowMs: NOW,
        synthesis: {
          lead: 'A canonical executive lead from the orchestration layer that exceeds the 40-char floor.',
          threads: [{ tag: 'Energy', teaser: 'Hormuz tensions resurface today.' }],
          signals: ['Watch for naval redeployment in the Gulf.'],
          publicLead: 'A non-personalised lead suitable for the share-URL surface.',
        },
      },
    );
    assert.ok(env);
    assert.match(env.data.digest.lead, /A canonical executive lead/);
    assert.equal(env.data.digest.threads.length, 1);
    assert.equal(env.data.digest.threads[0].tag, 'Energy');
    assert.deepEqual(env.data.digest.signals, ['Watch for naval redeployment in the Gulf.']);
    assert.match(env.data.digest.publicLead, /share-URL surface/);
  });

  it('falls back to stub lead when synthesis is omitted (legacy callers)', () => {
    const env = composeBriefFromDigestStories(
      rule(),
      [digestStory({ hash: 'h1' })],
      { clusters: 0, multiSource: 0 },
      { nowMs: NOW },  // no synthesis arg
    );
    assert.ok(env);
    // Stub lead from assembleStubbedBriefEnvelope: "Today's brief surfaces N threads…"
    assert.match(env.data.digest.lead, /Today's brief surfaces/);
    // publicLead absent on the stub path — the renderer's public-mode
    // fail-safe omits the pull-quote rather than leaking personalised lead.
    assert.equal(env.data.digest.publicLead, undefined);
  });

  it('partial synthesis (only lead) does not clobber threads/signals stubs', () => {
    const env = composeBriefFromDigestStories(
      rule(),
      [digestStory({ hash: 'h1', title: 'X', sources: ['Reuters'] })],
      { clusters: 0, multiSource: 0 },
      {
        nowMs: NOW,
        synthesis: {
          lead: 'Custom lead at least forty characters long for validator pass-through.',
          // threads + signals omitted — must keep the stub defaults.
        },
      },
    );
    assert.ok(env);
    assert.match(env.data.digest.lead, /Custom lead/);
    // Threads default from deriveThreadsFromStories (stub path).
    assert.ok(env.data.digest.threads.length >= 1);
  });

  it('rankedStoryHashes re-orders the surfaced pool BEFORE the cap is applied', () => {
    // Vary sources so U5's source-topic cap (default 2) doesn't drop the
    // 3rd story — this test verifies ranking, not the per-pair cap.
    const stories = [
      digestStory({ hash: 'aaaa1111', title: 'First by digest order', sources: ['SrcA'] }),
      digestStory({ hash: 'bbbb2222', title: 'Second by digest order', sources: ['SrcB'] }),
      digestStory({ hash: 'cccc3333', title: 'Third by digest order', sources: ['SrcC'] }),
    ];
    const env = composeBriefFromDigestStories(
      rule(),
      stories,
      { clusters: 0, multiSource: 0 },
      {
        nowMs: NOW,
        synthesis: {
          lead: 'Editorial lead at least forty characters long for validator pass-through.',
          // Re-rank: third story should lead, then first, then second.
          rankedStoryHashes: ['cccc3333', 'aaaa1111', 'bbbb2222'],
        },
      },
    );
    assert.ok(env);
    assert.equal(env.data.stories[0].headline, 'Third by digest order');
    assert.equal(env.data.stories[1].headline, 'First by digest order');
    assert.equal(env.data.stories[2].headline, 'Second by digest order');
  });

  it('rankedStoryHashes matches by short-hash prefix (model emits 8-char prefixes)', () => {
    const stories = [
      digestStory({ hash: 'longhash1234567890abc', title: 'First' }),
      digestStory({ hash: 'otherhashfullsuffix', title: 'Second' }),
    ];
    const env = composeBriefFromDigestStories(
      rule(),
      stories,
      { clusters: 0, multiSource: 0 },
      {
        nowMs: NOW,
        synthesis: {
          lead: 'Editorial lead at least forty characters long for validator pass-through.',
          // Model emits 8-char prefixes; helper must prefix-match the
          // story's full hash.
          rankedStoryHashes: ['otherhash', 'longhash'],
        },
      },
    );
    assert.ok(env);
    assert.equal(env.data.stories[0].headline, 'Second');
    assert.equal(env.data.stories[1].headline, 'First');
  });

  it('stories not present in rankedStoryHashes go after, in original order', () => {
    // Vary sources so U5's source-topic cap (default 2) doesn't drop the
    // 3rd story — this test verifies ranking-then-original-order, not the
    // per-pair cap.
    const stories = [
      digestStory({ hash: 'unranked-A', title: 'Unranked A', sources: ['SrcA'] }),
      digestStory({ hash: 'ranked-B', title: 'Ranked B', sources: ['SrcB'] }),
      digestStory({ hash: 'unranked-C', title: 'Unranked C', sources: ['SrcC'] }),
    ];
    const env = composeBriefFromDigestStories(
      rule(),
      stories,
      { clusters: 0, multiSource: 0 },
      {
        nowMs: NOW,
        synthesis: {
          lead: 'Editorial lead at least forty characters long for validator pass-through.',
          rankedStoryHashes: ['ranked-B'],
        },
      },
    );
    assert.ok(env);
    assert.equal(env.data.stories[0].headline, 'Ranked B');
    // A and C keep their original relative order (A then C).
    assert.equal(env.data.stories[1].headline, 'Unranked A');
    assert.equal(env.data.stories[2].headline, 'Unranked C');
  });
});

// ── Sprint 1 / U3 — stable clusterId wiring (canonical cluster-rep hash) ──
//
// Covers the U3 invariant: every BriefStory carries a clusterId derived
// from `mergedHashes[0]` (the canonical cluster-rep hash from
// materializeCluster). Replaces U1's transitional placeholder which
// sourced from the per-story `raw.hash` directly. For singletons the
// values coincide; for multi-story clusters all members must share ONE
// shared clusterId.

describe('Sprint 1 U3 — stable clusterId wiring through compose path', () => {
  it('singleton cluster: clusterId equals the story\'s own hash', () => {
    const env = composeBriefFromDigestStories(
      rule(),
      [digestStory({ hash: 'singleton-hash-1' })],
      { clusters: 0, multiSource: 0 },
      { nowMs: NOW },
    );
    assert.ok(env);
    assert.equal(env.data.stories.length, 1);
    assert.equal(
      env.data.stories[0].clusterId,
      'singleton-hash-1',
      'singleton clusterId must equal the story\'s own hash',
    );
  });

  it('multi-story cluster: all members share ONE clusterId matching mergedHashes[0]', () => {
    // Simulate a cluster post-materialiseCluster: a representative story
    // carries the canonical mergedHashes[] of all members. The compose
    // path receives a SINGLE rep per cluster, but the rep's mergedHashes
    // array drives the clusterId so a downstream split (if introduced)
    // would still collapse to the same identity.
    const rep = materializeCluster([
      { hash: 'h-A', currentScore: 100, mentionCount: 5 },
      { hash: 'h-B', currentScore: 90, mentionCount: 3 },
      { hash: 'h-C', currentScore: 80, mentionCount: 1 },
    ]);
    assert.ok(Array.isArray(rep.mergedHashes), 'rep must carry mergedHashes');
    assert.equal(rep.mergedHashes.length, 3);
    const env = composeBriefFromDigestStories(
      rule(),
      [{ ...rep, title: 'Cluster headline', link: 'https://example.com/x', severity: 'critical', sources: ['Reuters'] }],
      { clusters: 1, multiSource: 1 },
      { nowMs: NOW },
    );
    assert.ok(env);
    assert.equal(env.data.stories.length, 1);
    assert.equal(
      env.data.stories[0].clusterId,
      rep.mergedHashes[0],
      'multi-story cluster: clusterId must equal mergedHashes[0]',
    );
    // Discriminator: it must NOT equal one of the non-rep member hashes.
    assert.notEqual(env.data.stories[0].clusterId, 'h-B');
    assert.notEqual(env.data.stories[0].clusterId, 'h-C');
  });

  it('idempotency: same upstream cluster across two cron ticks → identical clusterId', () => {
    // Two ticks, same cluster membership. The rep's mergedHashes[0] is
    // determined by materializeCluster's deterministic sort
    // (currentScore desc → mentionCount desc → hash asc tiebreak). The
    // input order is varied to prove the determinism does not depend on
    // caller-side iteration order.
    const tick1Items = [
      { hash: 'aaa', currentScore: 100, mentionCount: 5 },
      { hash: 'bbb', currentScore: 100, mentionCount: 5 },
      { hash: 'ccc', currentScore: 100, mentionCount: 5 },
    ];
    const tick2Items = [...tick1Items].reverse(); // intentional shuffle
    const rep1 = materializeCluster(tick1Items);
    const rep2 = materializeCluster(tick2Items);
    const env1 = composeBriefFromDigestStories(
      rule(),
      [{ ...rep1, title: 'X', link: 'https://example.com/x', severity: 'critical' }],
      { clusters: 1, multiSource: 1 },
      { nowMs: NOW },
    );
    const env2 = composeBriefFromDigestStories(
      rule(),
      [{ ...rep2, title: 'X', link: 'https://example.com/x', severity: 'critical' }],
      { clusters: 1, multiSource: 1 },
      { nowMs: NOW + 30 * 60 * 1000 }, // next cron tick (30 min later)
    );
    assert.ok(env1 && env2);
    assert.equal(
      env1.data.stories[0].clusterId,
      env2.data.stories[0].clusterId,
      'same cluster across two ticks must produce identical clusterId',
    );
  });

  it('different upstream clusters never share a clusterId', () => {
    const repA = materializeCluster([
      { hash: 'cluster-a-1', currentScore: 100, mentionCount: 5 },
      { hash: 'cluster-a-2', currentScore: 90, mentionCount: 3 },
    ]);
    const repB = materializeCluster([
      { hash: 'cluster-b-1', currentScore: 100, mentionCount: 5 },
      { hash: 'cluster-b-2', currentScore: 90, mentionCount: 3 },
    ]);
    const env = composeBriefFromDigestStories(
      rule(),
      [
        { ...repA, title: 'Story A', link: 'https://example.com/a', severity: 'critical', sources: ['SrcA'] },
        { ...repB, title: 'Story B', link: 'https://example.com/b', severity: 'critical', sources: ['SrcB'] },
      ],
      { clusters: 2, multiSource: 2 },
      { nowMs: NOW },
    );
    assert.ok(env);
    assert.equal(env.data.stories.length, 2);
    assert.notEqual(
      env.data.stories[0].clusterId,
      env.data.stories[1].clusterId,
      'distinct upstream clusters must surface distinct clusterIds',
    );
  });

  it('every BriefStory in a v4 envelope has a non-empty clusterId (happy path)', () => {
    const env = composeBriefFromDigestStories(
      rule(),
      [
        digestStory({ hash: 'h1', title: 'A', sources: ['SrcA'] }),
        digestStory({ hash: 'h2', title: 'B', sources: ['SrcB'] }),
        digestStory({ hash: 'h3', title: 'C', sources: ['SrcC'] }),
      ],
      { clusters: 3, multiSource: 0 },
      { nowMs: NOW },
    );
    assert.ok(env);
    for (const s of env.data.stories) {
      assert.ok(typeof s.clusterId === 'string' && s.clusterId.length > 0, `clusterId must be non-empty (got ${JSON.stringify(s.clusterId)})`);
    }
  });

  it('integration: full chain materializeCluster → compose → assertBriefEnvelope passes', async () => {
    // Exercises the real chain without mocking. assertBriefEnvelope is
    // the v4 contract enforcer; running it on a real composed envelope
    // proves U3 wiring lands clusterId where U1's read-side validator
    // expects it.
    const { assertBriefEnvelope } = await import('../server/_shared/brief-render.js');
    const repAlpha = materializeCluster([
      { hash: 'alpha-1', currentScore: 100, mentionCount: 5 },
      { hash: 'alpha-2', currentScore: 80, mentionCount: 2 },
    ]);
    const repBeta = materializeCluster([
      { hash: 'beta-1', currentScore: 70, mentionCount: 4 },
    ]);
    const env = composeBriefFromDigestStories(
      rule(),
      [
        { ...repAlpha, title: 'Alpha cluster', link: 'https://example.com/alpha', severity: 'critical', sources: ['SrcA'] },
        { ...repBeta,  title: 'Beta singleton', link: 'https://example.com/beta', severity: 'high', sources: ['SrcB'] },
      ],
      { clusters: 2, multiSource: 1 },
      { nowMs: NOW },
    );
    assert.ok(env);
    // Round-trips through the v4 contract enforcer (throws on missing/empty clusterId).
    assertBriefEnvelope(env);
    // Singleton matches own hash; multi-story matches mergedHashes[0].
    const byHeadline = Object.fromEntries(env.data.stories.map((s) => [s.headline, s]));
    assert.equal(byHeadline['Alpha cluster'].clusterId, repAlpha.mergedHashes[0]);
    assert.equal(byHeadline['Beta singleton'].clusterId, 'beta-1');
  });

  it('falls back to raw.hash when mergedHashes is absent (back-compat with non-clustered producers)', () => {
    // The news:insights:v1 path (composeBriefForRule) does not run
    // through materializeCluster; stories arrive without mergedHashes.
    // The clusterId source must gracefully fall back to raw.hash so
    // every BriefStory still carries a non-empty clusterId.
    const env = composeBriefFromDigestStories(
      rule(),
      [digestStory({ hash: 'plain-hash-no-merge' })], // no mergedHashes
      { clusters: 0, multiSource: 0 },
      { nowMs: NOW },
    );
    assert.ok(env);
    assert.equal(env.data.stories[0].clusterId, 'plain-hash-no-merge');
  });
});

// ── Sprint 1 / U3 — materializeCluster determinism guarantee ─────────────
//
// U3 requires deterministic rep selection so the same cluster across two
// cron ticks produces an identical clusterId regardless of input order.
// The pre-U3 sort had two keys (currentScore desc, mentionCount desc); a
// hash tiebreak was added to make the result independent of TimSort's
// stability + caller iteration order.

describe('Sprint 1 U3 — materializeCluster determinism', () => {
  it('breaks fully-tied items by hash ascending (stable across input orderings)', () => {
    // Three items with identical score AND mentionCount. Pre-tiebreak
    // implementation would return whichever was first in the input
    // array; with the hash tiebreak it's always the lexicographically
    // smallest hash.
    const items = [
      { hash: 'zzz', currentScore: 50, mentionCount: 3 },
      { hash: 'aaa', currentScore: 50, mentionCount: 3 },
      { hash: 'mmm', currentScore: 50, mentionCount: 3 },
    ];
    const rep = materializeCluster(items);
    assert.equal(rep.hash, 'aaa', 'fully-tied items must resolve by hash ASC');
    // Reverse the input order — same answer.
    const repReversed = materializeCluster([...items].reverse());
    assert.equal(repReversed.hash, 'aaa');
    // Shuffle — same answer.
    const repShuffled = materializeCluster([items[2], items[0], items[1]]);
    assert.equal(repShuffled.hash, 'aaa');
  });

  it('mergedHashes[0] is stable under input reordering (the U3 wire-through invariant)', () => {
    const items = [
      { hash: 'h-x', currentScore: 100, mentionCount: 5 },
      { hash: 'h-y', currentScore: 100, mentionCount: 5 },
      { hash: 'h-z', currentScore: 100, mentionCount: 5 },
    ];
    const r1 = materializeCluster(items);
    const r2 = materializeCluster([...items].reverse());
    const r3 = materializeCluster([items[2], items[0], items[1]]);
    assert.equal(r1.mergedHashes[0], r2.mergedHashes[0]);
    assert.equal(r1.mergedHashes[0], r3.mergedHashes[0]);
    // And it's the smallest hash (lexicographic tiebreak).
    assert.equal(r1.mergedHashes[0], 'h-x');
  });

  it('preserves score-desc as primary key (no regression)', () => {
    const rep = materializeCluster([
      { hash: 'low',  currentScore: 10,  mentionCount: 1 },
      { hash: 'high', currentScore: 100, mentionCount: 1 },
      { hash: 'mid',  currentScore: 50,  mentionCount: 1 },
    ]);
    assert.equal(rep.hash, 'high');
    assert.deepEqual(rep.mergedHashes, ['high', 'mid', 'low']);
  });

  it('preserves mentionCount-desc as secondary key (no regression)', () => {
    const rep = materializeCluster([
      { hash: 'few',  currentScore: 50, mentionCount: 1 },
      { hash: 'lots', currentScore: 50, mentionCount: 10 },
      { hash: 'mid',  currentScore: 50, mentionCount: 5 },
    ]);
    assert.equal(rep.hash, 'lots');
    assert.deepEqual(rep.mergedHashes, ['lots', 'mid', 'few']);
  });
});

// ── Sprint 1 / U7 — digest projection invariant: digest.cards ⊆ brief.cards ──
//
// CANONICAL INVARIANT RATIONALE (single source of truth — JSDoc and code
// comments elsewhere should reference this header rather than re-state it):
//
//   For any single user-slot send under option (a), the set of clusterIds
//   surfaced by the digest channel formatter (email plain-text + email HTML
//   + Telegram + Slack + Discord + webhook bodies — all of which today read
//   from the same `stories` array passed to `formatDigest`/`formatDigestHtml`
//   in `scripts/seed-digest-notifications.mjs:1789-1791`) MUST be a structural
//   subset of the clusterIds present on the canonical brief envelope's
//   `BriefStory[]`.
//
//     set(digestCardClusterIds) ⊆ set(briefStoryClusterIds)
//
// What fires when this invariant breaks: U4's delivered-log writer (Sprint 1
// Phase 2) keys on `digest:sent:v1:${userId}:${channel}:${ruleId}:${clusterId}`.
// A digest card whose clusterId is NOT in the brief envelope cannot be matched
// by anything reading from the magazine side — the cooldown evaluator (U5),
// the replay harness (U6), and any future "story X went to user Y at time T"
// reverse-lookup all walk via brief envelopes. An orphan digest clusterId is
// invisible to every observer that uses the brief as canonical, so its
// delivery is unaccounted for and its re-air the next tick is undetectable.
// In Sprint 2's enforce mode, an orphan would also bypass the cooldown gate,
// which is a silent suppression-bypass, not a visible bug.
//
// Why U2's option (a) makes this invariant universal (was previously per-rule):
// pre-U2 the brief envelope and the channel body could legitimately reference
// different rules' pools. Post-U2 (`scripts/lib/digest-orchestration-helpers.mjs`
// `selectCanonicalSendRule`), the canonical winner rule's pool feeds BOTH
// surfaces, so the invariant holds for every user.
//
// Why this test uses Option (C) — fixture unit test against `composeBriefFrom-
// DigestStories` rather than driving the live `formatDigest`/`formatDigestHtml`
// functions: those formatters emit text/HTML strings that do NOT carry
// clusterId in any structured form (they're string templates). Extracting a
// "card-list projection" from inline send-loop body construction would touch
// U4/U5 implementation territory, which is out of U7 scope. Instead, this
// test exercises the REAL chain (`materializeCluster` → `digestStoryToUpstream-
// TopStory` → `filterTopStories` → `assertBriefEnvelope`) on the brief side,
// and uses a small local helper (`projectDigestEmitClusterIds`) that mirrors
// the canonical clusterId-derivation logic from `scripts/lib/brief-compose.mjs`
// `digestStoryToUpstreamTopStory:316-329` — the SAME `mergedHashes[0] ?? hash`
// fallback the live pipeline uses. If the live derivation diverges from the
// projection (or vice-versa), the U3 idempotency test in this same file
// catches it via the integration test against `assertBriefEnvelope`.
//
// Pragmatic note matching U2's source-text-guard precedent (test header in
// `tests/digest-orchestration-helpers.test.mjs:574-589`): the worldmonitor
// test suite has NO harness for mocking Upstash + Convex relay + Resend
// together. A full integration test of the live cron's send loop would
// require all three. Option (C) gives deterministic invariant coverage on
// the structurally important path without that harness — and the error-path
// test below ensures a future regression that re-introduces orphan emission
// will fail loudly with an actionable message.

describe('Sprint 1 U7 — digest projection invariant: digest.cards ⊆ brief.cards', () => {
  /**
   * Mirror of the canonical clusterId derivation in
   * `scripts/lib/brief-compose.mjs::digestStoryToUpstreamTopStory` (lines
   * 316-329). Returns the clusterId a digest card would need to match in
   * the brief envelope's `BriefStory.clusterId` set.
   *
   * Source preference (top wins) — must stay in lockstep with the live
   * derivation. If the live code changes, this helper changes; the U3
   * integration test in this same file is the cross-check.
   *
   *   1. mergedHashes[0]   — canonical materializeCluster path
   *   2. hash              — back-compat for non-clustered producers
   *   3. `url:${sourceUrl}`— last-ditch fallback (matches shared/brief-filter.js;
   *                          covers paths that omit hash entirely, e.g. news:
   *                          insights ingestion)
   *
   * Codex PR #3614 P2 — pre-fix this helper threw on the 3rd-level
   * fallback case ("test should never reach this"), leaving the
   * url:${sourceUrl} branch uncovered by the U7 invariant. Now mirrors
   * the live filter's full three-tier logic so a future producer that
   * triggers level-3 in production is structurally testable.
   *
   * @param {object} digestStory
   * @returns {string}
   */
  function projectDigestEmitClusterId(digestStory) {
    if (Array.isArray(digestStory?.mergedHashes)
      && digestStory.mergedHashes.length > 0
      && typeof digestStory.mergedHashes[0] === 'string'
      && digestStory.mergedHashes[0].length > 0) {
      return digestStory.mergedHashes[0];
    }
    if (typeof digestStory?.hash === 'string' && digestStory.hash.length > 0) {
      return digestStory.hash;
    }
    if (typeof digestStory?.sourceUrl === 'string' && digestStory.sourceUrl.length > 0) {
      return `url:${digestStory.sourceUrl}`;
    }
    throw new Error(
      `projectDigestEmitClusterId: digest story has no mergedHashes[0], hash, or sourceUrl; ` +
      `cannot derive clusterId for invariant check. Story: ${JSON.stringify(digestStory)}`,
    );
  }

  /**
   * Project the digest emit clusterIds from the same `stories` array that
   * `formatDigest`/`formatDigestHtml` would consume. This is the OUT-of-the-
   * envelope side of the invariant — the IN-side comes from the composed
   * brief envelope's `data.stories[].clusterId` field.
   *
   * @param {Array<object>} digestStories
   * @returns {Set<string>}
   */
  function projectDigestEmitClusterIds(digestStories) {
    const set = new Set();
    for (const s of digestStories ?? []) set.add(projectDigestEmitClusterId(s));
    return set;
  }

  /**
   * Pull the set of clusterIds out of a composed brief envelope.
   * @param {object} envelope
   * @returns {Set<string>}
   */
  function envelopeClusterIds(envelope) {
    const set = new Set();
    for (const s of envelope?.data?.stories ?? []) {
      if (typeof s?.clusterId === 'string' && s.clusterId.length > 0) set.add(s.clusterId);
    }
    return set;
  }

  /**
   * Apply the invariant. Throws an Error naming the orphan clusterId(s) on
   * violation — the message is the canonical operator-facing diagnostic for
   * a regression in this contract.
   *
   * @param {Set<string>} digestEmitIds
   * @param {Set<string>} briefIds
   */
  function assertDigestSubsetOfBrief(digestEmitIds, briefIds) {
    const orphans = [];
    for (const id of digestEmitIds) {
      if (!briefIds.has(id)) orphans.push(id);
    }
    if (orphans.length > 0) {
      throw new Error(
        `digest projection invariant violated: ${orphans.length} digest card clusterId(s) ` +
        `not present in brief envelope. orphans=[${orphans.map((o) => JSON.stringify(o)).join(', ')}]. ` +
        `consequence: U4 delivered-log keys for these clusters are unmatchable from the magazine ` +
        `side; cooldown evaluator and replay harness will treat each delivery as orphaned. ` +
        `briefClusterIds=[${[...briefIds].map((b) => JSON.stringify(b)).join(', ')}]`,
      );
    }
  }

  // ── Happy path: 5-cluster digest pool → every digest clusterId in brief ──

  it('5-cluster digest pool: every digest card clusterId is in the brief envelope', () => {
    // Vary sources to avoid the source-topic cap (default 2 per source+
    // category) — we want the brief envelope to surface all 5 clusters so
    // the invariant test exercises the structural-subset path, not the
    // brief filter dropping siblings.
    const digestStories = [
      digestStory({ hash: 'cluster-1', title: 'Story 1', sources: ['Reuters'] }),
      digestStory({ hash: 'cluster-2', title: 'Story 2', sources: ['AP'] }),
      digestStory({ hash: 'cluster-3', title: 'Story 3', sources: ['BBC'] }),
      digestStory({ hash: 'cluster-4', title: 'Story 4', sources: ['Bloomberg'] }),
      digestStory({ hash: 'cluster-5', title: 'Story 5', sources: ['Guardian'] }),
    ];
    const env = composeBriefFromDigestStories(
      rule(),
      digestStories,
      { clusters: 5, multiSource: 0 },
      { nowMs: NOW },
    );
    assert.ok(env, 'expected composed envelope');
    assert.equal(env.data.stories.length, 5, '5-cluster pool must yield 5 brief stories');

    const digestEmitIds = projectDigestEmitClusterIds(digestStories);
    const briefIds = envelopeClusterIds(env);
    assertDigestSubsetOfBrief(digestEmitIds, briefIds);
    assert.equal(digestEmitIds.size, 5);
    assert.equal(briefIds.size, 5);
  });

  // ── Edge: empty pool → trivially holds ──

  it('empty digest pool: invariant trivially holds (no cards on either side)', () => {
    const env = composeBriefFromDigestStories(rule(), [], { clusters: 0, multiSource: 0 }, { nowMs: NOW });
    assert.equal(env, null, 'empty pool must produce null envelope (caller skips send)');
    const digestEmitIds = projectDigestEmitClusterIds([]);
    // No brief envelope → empty brief id set. Invariant on the empty set is
    // vacuously true. The send loop's `if (!storyListPlain) continue;` guard
    // (seed-digest-notifications.mjs:1790) ensures no channel body is emitted
    // when there's nothing to send.
    assertDigestSubsetOfBrief(digestEmitIds, new Set());
    assert.equal(digestEmitIds.size, 0);
  });

  // ── Edge: rep-hash duplicates collapse to unique clusterIds ──

  it('multi-story clusters collapse: 3 reps each carrying mergedHashes → 3 unique clusterIds, all in brief', () => {
    // Three multi-story clusters, each with 3 members. The digest emit set
    // is one entry per rep (3 clusterIds), and the brief envelope also
    // surfaces one BriefStory per rep with the same shared clusterId per
    // cluster. No member-hash leaks into either side.
    const repA = materializeCluster([
      { hash: 'A1', currentScore: 100, mentionCount: 5 },
      { hash: 'A2', currentScore: 90, mentionCount: 3 },
      { hash: 'A3', currentScore: 80, mentionCount: 1 },
    ]);
    const repB = materializeCluster([
      { hash: 'B1', currentScore: 100, mentionCount: 5 },
      { hash: 'B2', currentScore: 95, mentionCount: 4 },
    ]);
    const repC = materializeCluster([
      { hash: 'C1', currentScore: 100, mentionCount: 5 },
    ]); // singleton — mergedHashes[0] === hash
    const digestStories = [
      { ...repA, title: 'Cluster A', link: 'https://example.com/a', severity: 'critical', sources: ['SrcA'] },
      { ...repB, title: 'Cluster B', link: 'https://example.com/b', severity: 'high', sources: ['SrcB'] },
      { ...repC, title: 'Cluster C', link: 'https://example.com/c', severity: 'critical', sources: ['SrcC'] },
    ];
    const env = composeBriefFromDigestStories(
      rule(),
      digestStories,
      { clusters: 3, multiSource: 2 },
      { nowMs: NOW },
    );
    assert.ok(env);
    const digestEmitIds = projectDigestEmitClusterIds(digestStories);
    const briefIds = envelopeClusterIds(env);
    assertDigestSubsetOfBrief(digestEmitIds, briefIds);
    assert.equal(digestEmitIds.size, 3, 'three distinct clusterIds expected');
    // Each digest emit clusterId must be the rep\'s mergedHashes[0], NOT a
    // non-rep member hash. Canonical determinism check.
    assert.ok(digestEmitIds.has(repA.mergedHashes[0]));
    assert.ok(digestEmitIds.has(repB.mergedHashes[0]));
    assert.ok(digestEmitIds.has(repC.mergedHashes[0]));
    assert.ok(!digestEmitIds.has('A2'));
    assert.ok(!digestEmitIds.has('A3'));
    assert.ok(!digestEmitIds.has('B2'));
  });

  // ── Edge: single-rule user (no canonicalization needed) ──

  it('single-rule user: invariant holds the same way (no U2 collapse path needed)', () => {
    // selectCanonicalSendRule is a no-op identity for single-rule users.
    // The digest emit set and brief envelope set come from the same
    // `stories` pool with no additional U2 transformation, so the
    // structural-subset relationship is the same as the multi-rule case.
    const digestStories = [
      digestStory({ hash: 'single-1', title: 'Solo 1', sources: ['Reuters'] }),
      digestStory({ hash: 'single-2', title: 'Solo 2', sources: ['AP'] }),
    ];
    const env = composeBriefFromDigestStories(
      rule(),
      digestStories,
      { clusters: 2, multiSource: 0 },
      { nowMs: NOW },
    );
    assert.ok(env);
    assertDigestSubsetOfBrief(
      projectDigestEmitClusterIds(digestStories),
      envelopeClusterIds(env),
    );
  });

  // ── Edge: multi-rule user canonicalized to one winner via U2 ──
  //
  // Under option (a), the send loop drops every non-winner rule via
  // `selectCanonicalSendRule` (`scripts/lib/digest-orchestration-helpers.mjs:284`).
  // The canonical winner's `stories` pool is the SAME pool fed to BOTH
  // `composeBriefFromDigestStories` (via the compose phase's digestFor
  // closure) AND to `formatDigest`/`formatDigestHtml` in the send loop. The
  // invariant therefore holds whether or not the user has multiple rules —
  // U2's collapse ensures the winner's pool drives both surfaces. This test
  // exercises that path explicitly: simulate the WINNER's pool (the one
  // that survives `selectCanonicalSendRule`) and confirm the structural
  // subset relationship.
  it('multi-rule user post-U2 canonicalization: winner pool digest emit ⊆ winner pool brief envelope', () => {
    const winnerRule = rule({ variant: 'tech', sensitivity: 'high' });
    // The winner's pool (only this pool is used for both surfaces post-U2).
    const winnerStories = [
      digestStory({ hash: 'tech-1', title: 'AI chip ban deepens', sources: ['Reuters'] }),
      digestStory({ hash: 'tech-2', title: 'Quantum breakthrough at MIT', sources: ['Nature'] }),
      digestStory({ hash: 'tech-3', title: 'New ARM core in iPhone', sources: ['Bloomberg'] }),
    ];
    const env = composeBriefFromDigestStories(
      winnerRule,
      winnerStories,
      { clusters: 3, multiSource: 0 },
      { nowMs: NOW },
    );
    assert.ok(env);
    assert.equal(env.data.stories.length, 3);
    assertDigestSubsetOfBrief(
      projectDigestEmitClusterIds(winnerStories),
      envelopeClusterIds(env),
    );
  });

  // ── Error path: synthetic orphan must fail with actionable message ──

  it('error path: a synthetic orphan clusterId in the digest emit fails with an actionable message', () => {
    // Test-time-only contrived state: the digest emit set contains a
    // clusterId that is NOT in the brief envelope. This is the regression
    // shape U7 catches — if a future change re-introduces per-rule channel
    // bodies (regressing U2) or routes the formatter to a different pool
    // than compose, the orphan would surface here.
    const digestStories = [
      digestStory({ hash: 'present-1', title: 'Present in both', sources: ['Reuters'] }),
    ];
    const env = composeBriefFromDigestStories(
      rule(),
      digestStories,
      { clusters: 1, multiSource: 0 },
      { nowMs: NOW },
    );
    assert.ok(env);
    const briefIds = envelopeClusterIds(env);
    // Inject an orphan into the digest emit set. The brief side is
    // unchanged — this is the asymmetric divergence we want to catch.
    const orphanedDigestIds = new Set([...projectDigestEmitClusterIds(digestStories), 'orphan-cluster-X']);
    assert.throws(
      () => assertDigestSubsetOfBrief(orphanedDigestIds, briefIds),
      (err) => {
        // Message must (a) name the orphan clusterId, (b) name the
        // operational consequence (delivered-log unmatchable), (c) include
        // the brief id set for diff-ability.
        return /orphan-cluster-X/.test(err.message)
          && /delivered-log/.test(err.message)
          && /briefClusterIds=/.test(err.message);
      },
      'orphan-detection error must name the orphan clusterId, the consequence, and the brief id set',
    );
  });

  // ── Error path companion: missing-clusterId on digest side throws clearly ──

  it('error path: digest story with no mergedHashes, hash, or sourceUrl throws a clear diagnostic', () => {
    // Defends against a producer regression: if a future buildDigest variant
    // omits `hash` from the per-story shape AND there's no mergedHashes
    // AND no sourceUrl, projectDigestEmitClusterId throws BEFORE the subset
    // check runs — the consequence is otherwise a `Set([undefined])`
    // membership glitch that would fail the subset check with a confusing
    // "undefined not in set" message rather than naming the producer
    // regression. (Note: we use `link` not `sourceUrl` here to keep the
    // story shape clearly absent of all three sources; a future digest
    // story carrying `sourceUrl` would correctly fall through to the
    // level-3 url-fallback covered below.)
    assert.throws(
      () => projectDigestEmitClusterId({ title: 'no hash here', link: 'https://example.com/x' }),
      /cannot derive clusterId/,
    );
  });

  // Codex PR #3614 P2 — level-3 fallback `url:${sourceUrl}` parity.
  // Pre-fix the test helper threw on this case ("test should never reach
  // this"), leaving the level-3 branch in shared/brief-filter.js
  // structurally untested. Now both helper and live filter agree.
  it('level-3 fallback: digest story with only sourceUrl returns url:<sourceUrl> (Codex PR #3614 P2)', () => {
    const cid = projectDigestEmitClusterId({
      title: 'producer omits hash',
      sourceUrl: 'https://example.com/news/x',
    });
    assert.equal(cid, 'url:https://example.com/news/x');
  });

  it('source preference order: mergedHashes[0] beats hash beats sourceUrl', () => {
    // The three-tier order is load-bearing: a multi-story cluster MUST
    // resolve to mergedHashes[0] even when hash and sourceUrl would also
    // produce a valid clusterId. If the order ever flips, multi-story
    // clusters would shatter back into per-story clusterIds and the
    // delivered-log key shape would explode.
    const allThree = projectDigestEmitClusterId({
      mergedHashes: ['rep-hash-canonical'],
      hash: 'own-hash-fallback',
      sourceUrl: 'https://example.com/level-3',
    });
    assert.equal(allThree, 'rep-hash-canonical');

    const hashAndUrl = projectDigestEmitClusterId({
      hash: 'own-hash-fallback',
      sourceUrl: 'https://example.com/level-3',
    });
    assert.equal(hashAndUrl, 'own-hash-fallback');

    const urlOnly = projectDigestEmitClusterId({
      sourceUrl: 'https://example.com/level-3',
    });
    assert.equal(urlOnly, 'url:https://example.com/level-3');
  });

  // ── Integration: real chain end-to-end through assertBriefEnvelope ──

  it('integration: real chain (materializeCluster → compose → assertBriefEnvelope) preserves the invariant', async () => {
    const { assertBriefEnvelope } = await import('../server/_shared/brief-render.js');
    const repAlpha = materializeCluster([
      { hash: 'alpha-1', currentScore: 100, mentionCount: 5 },
      { hash: 'alpha-2', currentScore: 80, mentionCount: 2 },
    ]);
    const repBeta = materializeCluster([
      { hash: 'beta-1', currentScore: 70, mentionCount: 4 },
    ]);
    const digestStories = [
      { ...repAlpha, title: 'Alpha cluster', link: 'https://example.com/alpha', severity: 'critical', sources: ['SrcA'] },
      { ...repBeta, title: 'Beta singleton', link: 'https://example.com/beta', severity: 'high', sources: ['SrcB'] },
    ];
    const env = composeBriefFromDigestStories(
      rule(),
      digestStories,
      { clusters: 2, multiSource: 1 },
      { nowMs: NOW },
    );
    assert.ok(env);
    // First, prove the envelope is contractually valid (v4 + clusterId on
    // every story). Then prove the projection invariant on top.
    assertBriefEnvelope(env);
    assertDigestSubsetOfBrief(
      projectDigestEmitClusterIds(digestStories),
      envelopeClusterIds(env),
    );
  });
});

// ── Sprint 1 / U7 production-gap fix: source-text guard ────────────────────
//
// The U7 invariant proven above (via composeBriefFromDigestStories +
// projectDigestEmitClusterIds) holds STRUCTURALLY. But the RUNTIME guarantee
// that the live cron emits a digest body whose clusterIds are a subset of the
// brief envelope's clusterIds depends on a separate fact:
//
//   `formatDigest` and `formatDigestHtml` in scripts/seed-digest-notifications
//   .mjs MUST consume the brief envelope's `data.stories` slice (post-cap,
//   post-filter, ≤ MAX_STORIES_PER_USER=12), NOT the raw `stories` pool from
//   buildDigest (capped at DIGEST_MAX_ITEMS=30).
//
// Pre-fix, the formatters were called with `stories` (raw 30); the user could
// see clusters that were never in the brief envelope. The U7 invariant
// projection helper above models the brief side correctly, but didn't catch
// the production-side regression — those formatters never produced a v4
// envelope at all, so a structural test against the envelope can't see them.
//
// This source-text guard mirrors the U2 precedent at
// tests/brief-composer-rule-dedup.test.mjs (`describe('Sprint 1 U2 source-
// text guard', ...)`): assert the source code at the load-bearing call site
// matches a regex. It can't be bypassed by Vitest mocks; it can't drift
// silently if a future refactor "innocently" reverts the wiring. If the
// regex stops matching, the test fails with a message that names the file
// and lists the candidate lines for an operator to repair.
//
// Why source-text not behaviour: the cron's send loop pulls together
// Upstash, Convex relay, Resend, Telegram, and DNS resolution. There's no
// existing test harness that mocks all five together (documented in the
// U7 header above). A behaviour test for THIS specific wiring would need
// that whole harness; a source-text guard captures the same invariant in
// 5 lines, with the trade-off that a future refactor that uses the brief
// envelope via a DIFFERENT spelling (e.g. local variable rename) needs to
// touch this regex too. That's a fair trade — the alternative is no test
// at all, and an "everything works in unit tests, fails in production"
// shape, which is exactly what this guard exists to prevent.

describe('Sprint 1 U7 production-gap source-text guard — formatter call site', () => {
  it('formatDigest + formatDigestHtml consume the brief-envelope-derived slice (NOT raw stories)', async () => {
    const path = fileURLToPath(new URL('../scripts/seed-digest-notifications.mjs', import.meta.url));
    const src = await readFile(path, 'utf8');

    // We expect both call sites to consume `formatterStories` — the local
    // variable populated from `briefStoriesToFormatterShape(brief.envelope.
    // data.stories)`. Anything else (raw `stories`, a renamed local) would
    // break the U7 invariant on the live send path.
    assert.match(
      src,
      /formatDigest\(\s*formatterStories\s*,\s*nowMs\s*\)/,
      'formatDigest call site must consume `formatterStories` (the brief-envelope-derived slice). ' +
      'Pre-fix this read `stories` (raw pool); see U7 source-text guard rationale in this test header.',
    );
    assert.match(
      src,
      /formatDigestHtml\(\s*formatterStories\s*,\s*nowMs\s*\)/,
      'formatDigestHtml call site must consume `formatterStories` (the brief-envelope-derived slice). ' +
      'Pre-fix this read `stories` (raw pool); see U7 source-text guard rationale in this test header.',
    );

    // The shim itself must be wired against `brief.envelope.data.stories`.
    // If a future refactor renames/relocates this access, this assertion
    // must move with it — fail loudly so the operator notices and updates
    // both the wiring AND this guard in lockstep.
    assert.match(
      src,
      /briefStoriesToFormatterShape\(\s*briefEnvelopeStories\s*\)/,
      'formatter shim must be applied to the brief envelope-derived stories ' +
      '(local var `briefEnvelopeStories`, populated from `brief.envelope.data.stories`).',
    );
    assert.match(
      src,
      /brief\?\.envelope\?\.data\?\.stories/,
      'the brief-envelope-derived slice must be read from `brief.envelope.data.stories` ' +
      '(optional-chained for the compose-miss fallback path).',
    );
  });

  // Codex PR #3617 round-4 P2 — compose-miss fallback must run U4/U5.
  it('cooldownIterableStories unifies brief-success + compose-miss for U4/U5 coverage', async () => {
    const path = fileURLToPath(new URL('../scripts/seed-digest-notifications.mjs', import.meta.url));
    const src = await readFile(path, 'utf8');

    // The unified iterable is constructed from briefEnvelopeStories OR
    // a normalized projection of raw `stories`. Pre-fix the U5/U4 loops
    // gated on `briefEnvelopeStories.length > 0`, so compose-miss
    // delivered cards without seeding cooldown rows or shadow decisions.
    assert.match(
      src,
      /const\s+cooldownIterableStories\s*=/,
      'cron must declare cooldownIterableStories — the unified U4/U5 iterable across both branches',
    );

    // Both U5 and U4 loops must iterate cooldownIterableStories, NOT
    // briefEnvelopeStories. Pre-fix used briefEnvelopeStories which
    // skipped the entire compose-miss path. Capture every
    // `for (const briefStory of <name>)` and assert all instances
    // iterate cooldownIterableStories — there should be exactly 2
    // (U5 cooldown loop + U4 writer loop) but the contract is "NEVER
    // iterate the brief-only briefEnvelopeStories".
    const briefStoryLoops = [...src.matchAll(/for\s*\(\s*const\s+briefStory\s+of\s+(\w+)\s*\)/g)];
    assert.ok(briefStoryLoops.length >= 2, `expected ≥2 briefStory loops (U5 + U4); found ${briefStoryLoops.length}`);
    for (const m of briefStoryLoops) {
      assert.equal(
        m[1],
        'cooldownIterableStories',
        `every briefStory loop must iterate cooldownIterableStories (compose-miss coverage); got "${m[1]}"`,
      );
    }
    // The U5 mode-gate must also use cooldownIterableStories for the
    // length check (NOT briefEnvelopeStories).
    assert.match(
      src,
      /cooldownConfig\.mode\s*===\s*'shadow'[\s\S]{0,800}?cooldownIterableStories\.length\s*>\s*0/,
      'U5 mode-gate must check cooldownIterableStories.length, not briefEnvelopeStories',
    );
  });

  // Codex PR #3617 round-5 P1 — webhook channel must consume
  // formatterStories so its payload matches the U4/U5-covered set.
  it('sendWebhook is called with formatterStories (NOT raw stories) — channel-coverage parity', async () => {
    const path = fileURLToPath(new URL('../scripts/seed-digest-notifications.mjs', import.meta.url));
    const src = await readFile(path, 'utf8');

    // Pre-fix: `sendWebhook(rule.userId, ch.webhookEnvelope, stories, briefLead)`
    // Post-fix: `sendWebhook(rule.userId, ch.webhookEnvelope, formatterStories, briefLead)`
    // The pre-fix shape would have webhook users receiving up to
    // DIGEST_MAX_ITEMS=30 raw cards while U4/U5 only saw the
    // post-cap subset (≤12 under brief-success).
    assert.match(
      src,
      /sendWebhook\([^)]*?,\s*formatterStories\s*,\s*briefLead\s*\)/,
      'webhook channel must consume formatterStories so its payload matches U4/U5-covered set',
    );
    // Forbidden-pattern guard: if a future refactor reverts to passing
    // raw `stories`, this fails loudly.
    assert.doesNotMatch(
      src,
      /sendWebhook\([^)]*?,\s*stories\s*,\s*briefLead\s*\)/,
      'webhook must NOT pass raw stories — that bypasses U4/U5 coverage for webhook users',
    );
  });

  // Codex PR #3617 round-4 P1 — writer uses SET not SET NX.
  it('U4 writer issues SET (NOT SET NX) so cooldown reads see refreshed lastDeliveredAt', async () => {
    const writerPath = fileURLToPath(new URL('../scripts/lib/digest-delivered-log.mjs', import.meta.url));
    const src = await readFile(writerPath, 'utf8');

    // Look for the pipeline command construction. Must have SET ... EX
    // (no NX between them). A regex hit on `'NX'` as a literal
    // command argument is the bug signature; we forbid it.
    assert.doesNotMatch(
      src,
      /pipeline\s*\(\s*\[\s*\[\s*'SET'[\s\S]{0,200}?,\s*'NX'/,
      'writer must NOT use SET NX — that locks the row to its first value forever and breaks refresh-on-allow',
    );
    assert.match(
      src,
      /pipeline\s*\(\s*\[\s*\[\s*'SET'/,
      'writer must use SET pipeline command',
    );
  });

  // Codex PR #3617 P1 — real source count regression guard.
  it('U4 writer + U5 evaluator both consume sourceCountByClusterId (not BriefStory.source 0/1 collapse)', async () => {
    const path = fileURLToPath(new URL('../scripts/seed-digest-notifications.mjs', import.meta.url));
    const src = await readFile(path, 'utf8');

    // The Map must be built once before the cluster iteration loop, from
    // the raw clustered `stories` pool (where sources[] is still attached).
    assert.match(
      src,
      /const\s+sourceCountByClusterId\s*=\s*new\s+Map\(\s*\)/,
      'sourceCountByClusterId Map must be built (per-send) for U4 writer + U5 evaluator',
    );
    assert.match(
      src,
      /sourceCountByClusterId\.set\(/,
      'sourceCountByClusterId Map must be populated from raw stories',
    );

    // Both consumer sites must use the Map, NOT the BriefStory.source 0/1 collapse.
    const collapsedPattern = /briefStory\?\.source\s*===\s*'string'\s*&&\s*briefStory\.source\.length\s*>\s*0\s*\?\s*1\s*:\s*0/;
    assert.doesNotMatch(
      src,
      collapsedPattern,
      'cron must NOT collapse source count to 0/1 from BriefStory.source — that breaks U5\'s +5-sources evolution bypass. ' +
      'Use sourceCountByClusterId.get(clusterId) ?? 0 instead.',
    );

    // Both sites must read from the Map.
    const getMatches = src.match(/sourceCountByClusterId\.get\(\s*clusterId\s*\)/g) ?? [];
    assert.ok(
      getMatches.length >= 2,
      `expected ≥2 sourceCountByClusterId.get(clusterId) reads (U4 writer + U5 evaluator); ` +
      `found ${getMatches.length}. If you removed one of them, the cooldown evolution bypass will break silently.`,
    );
  });
});
