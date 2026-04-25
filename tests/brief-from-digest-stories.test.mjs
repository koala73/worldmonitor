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
import { composeBriefFromDigestStories, stripHeadlineSuffix } from '../scripts/lib/brief-compose.mjs';

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
