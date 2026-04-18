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

  it('caps at 12 stories per brief', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      digestStory({ hash: `h${i}`, title: `Story ${i}` }),
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
});
