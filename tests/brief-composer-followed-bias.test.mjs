// Tests for the followed-country soft-bias hook in
// scripts/lib/brief-compose.mjs (PR C / U10).
//
// Locks in R10's hard contract: bias is SOFT, not a hard filter.
//   - Empty watchlist → no behavior change.
//   - Followed-country story moves up within its severity lane.
//   - Critical-severity stories ALWAYS surface in the top N regardless
//     of bias (a non-followed critical thread outranks any
//     followed non-critical thread).
//   - rankedStoryHashes (LLM editorial ranking) takes priority — the
//     bias only affects input ordering before that synthesis sort runs.
//
// Free-tier clamp lives at the call site (scripts/seed-digest-notifications.mjs)
// because it depends on the entitlement relay; here we just verify that
// the composer honors whatever followedCountries list the caller passes.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  composeBriefFromDigestStories,
  reorderForFollowedBias,
  FOLLOWED_BIAS_MULTIPLIER,
} from '../scripts/lib/brief-compose.mjs';

const NOW = 1_745_000_000_000;

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
    title: 'Default story headline',
    link: 'https://example.com/x',
    severity: 'high',
    currentScore: 50,
    mentionCount: 1,
    phase: 'developing',
    sources: ['Reuters'],
    ...overrides,
  };
}

describe('FOLLOWED_BIAS_MULTIPLIER constant', () => {
  it('defaults to 1.25 (midpoint of plan band 1.2-1.3)', () => {
    // Plan: pick 1.25 as midpoint, document inline as tunable.
    // Env override is parsed at module load — bare default holds here.
    assert.equal(FOLLOWED_BIAS_MULTIPLIER, 1.25);
  });
});

describe('reorderForFollowedBias', () => {
  it('empty watchlist → returns input unchanged (no-op)', () => {
    const stories = [
      { countryCode: 'US', threatLevel: 'high' },
      { countryCode: 'GB', threatLevel: 'high' },
    ];
    const out = reorderForFollowedBias(stories, new Set());
    assert.deepEqual(out, stories);
    // Identity preserved (cheap path returns same ref).
    assert.equal(out, stories);
  });

  it('null/undefined followedSet → returns input unchanged', () => {
    const stories = [{ countryCode: 'US', threatLevel: 'high' }];
    assert.equal(reorderForFollowedBias(stories, null), stories);
    assert.equal(reorderForFollowedBias(stories, undefined), stories);
  });

  it('empty stories → returns input unchanged', () => {
    const out = reorderForFollowedBias([], new Set(['US']));
    assert.deepEqual(out, []);
  });

  it('lifts followed-country story above non-followed within same severity lane', () => {
    const stories = [
      { id: 'gb', countryCode: 'GB', threatLevel: 'high' },
      { id: 'us', countryCode: 'US', threatLevel: 'high' },
    ];
    const out = reorderForFollowedBias(stories, new Set(['US']));
    // US (followed) wins on bias; GB drops to second.
    assert.equal(out[0].id, 'us');
    assert.equal(out[1].id, 'gb');
  });

  it('keeps original order among non-followed entries (stable sort)', () => {
    const stories = [
      { id: 'gb', countryCode: 'GB', threatLevel: 'high' },
      { id: 'fr', countryCode: 'FR', threatLevel: 'high' },
      { id: 'de', countryCode: 'DE', threatLevel: 'high' },
    ];
    const out = reorderForFollowedBias(stories, new Set(['XX'])); // no match
    assert.deepEqual(out.map((s) => s.id), ['gb', 'fr', 'de']);
  });

  it('case-insensitive country match (uppercases countryCode)', () => {
    const stories = [
      { id: 'gb', countryCode: 'gb', threatLevel: 'high' },
      { id: 'us', countryCode: 'us', threatLevel: 'high' },
    ];
    const out = reorderForFollowedBias(stories, new Set(['US']));
    assert.equal(out[0].id, 'us');
  });

  it('CRITICAL severity always wins over followed non-critical (R10 hard contract)', () => {
    const stories = [
      { id: 'us-high', countryCode: 'US', threatLevel: 'high' },        // followed
      { id: 'gb-critical', countryCode: 'GB', threatLevel: 'critical' }, // NOT followed
    ];
    const out = reorderForFollowedBias(stories, new Set(['US']));
    assert.equal(out[0].id, 'gb-critical', 'critical must surface despite bias');
    assert.equal(out[1].id, 'us-high');
  });

  it('within critical lane, followed lifts above non-followed', () => {
    const stories = [
      { id: 'gb-c', countryCode: 'GB', threatLevel: 'critical' },
      { id: 'us-c', countryCode: 'US', threatLevel: 'critical' },
    ];
    const out = reorderForFollowedBias(stories, new Set(['US']));
    assert.equal(out[0].id, 'us-c');
  });

  it('does not mutate input array', () => {
    const stories = [
      { id: 'gb', countryCode: 'GB', threatLevel: 'high' },
      { id: 'us', countryCode: 'US', threatLevel: 'high' },
    ];
    const snapshot = JSON.parse(JSON.stringify(stories));
    reorderForFollowedBias(stories, new Set(['US']));
    assert.deepEqual(stories, snapshot);
  });

  it('handles missing/invalid countryCode without throwing', () => {
    const stories = [
      { id: 'a', countryCode: undefined, threatLevel: 'high' },
      { id: 'b', countryCode: 42, threatLevel: 'high' },
      { id: 'c', countryCode: 'US', threatLevel: 'high' },
    ];
    const out = reorderForFollowedBias(stories, new Set(['US']));
    assert.equal(out[0].id, 'c'); // followed comes first
  });

  it('handles missing/invalid threatLevel as default lane (1×)', () => {
    const stories = [
      { id: 'a', countryCode: 'GB', threatLevel: 'unknown' },
      { id: 'b', countryCode: 'US', threatLevel: undefined },
    ];
    // Both default lane = 1×; US wins on bias.
    const out = reorderForFollowedBias(stories, new Set(['US']));
    assert.equal(out[0].id, 'b');
  });
});

describe('composeBriefFromDigestStories — followed-countries opt', () => {
  it('empty followedCountries → composer behavior identical to today', () => {
    const stories = [
      digestStory({ hash: 'a', title: 'GB story', countryCode: 'GB', sources: ['SrcA'] }),
      digestStory({ hash: 'b', title: 'US story', countryCode: 'US', sources: ['SrcB'] }),
    ];
    const withEmpty = composeBriefFromDigestStories(
      rule(),
      stories,
      { clusters: 0, multiSource: 0 },
      { nowMs: NOW, followedCountries: [] },
    );
    const without = composeBriefFromDigestStories(
      rule(),
      stories,
      { clusters: 0, multiSource: 0 },
      { nowMs: NOW },
    );
    assert.deepEqual(
      withEmpty.data.stories.map((s) => s.headline),
      without.data.stories.map((s) => s.headline),
    );
  });

  it('non-empty watchlist + matching country → boosted to first', () => {
    const stories = [
      digestStory({ hash: 'a', title: 'GB story', countryCode: 'GB', sources: ['SrcA'] }),
      digestStory({ hash: 'b', title: 'US story', countryCode: 'US', sources: ['SrcB'] }),
      digestStory({ hash: 'c', title: 'FR story', countryCode: 'FR', sources: ['SrcC'] }),
    ];
    const env = composeBriefFromDigestStories(
      rule(),
      stories,
      { clusters: 0, multiSource: 0 },
      { nowMs: NOW, followedCountries: ['US'] },
    );
    assert.equal(env.data.stories[0].headline, 'US story');
  });

  it('non-empty watchlist + no matching country → behavior unchanged', () => {
    const stories = [
      digestStory({ hash: 'a', title: 'GB story', countryCode: 'GB', sources: ['SrcA'] }),
      digestStory({ hash: 'b', title: 'FR story', countryCode: 'FR', sources: ['SrcB'] }),
    ];
    const env = composeBriefFromDigestStories(
      rule(),
      stories,
      { clusters: 0, multiSource: 0 },
      { nowMs: NOW, followedCountries: ['US'] },
    );
    assert.equal(env.data.stories[0].headline, 'GB story');
    assert.equal(env.data.stories[1].headline, 'FR story');
  });

  it('CRITICAL non-followed thread surfaces despite followed-country bias (R10)', () => {
    const stories = [
      digestStory({ hash: 'us-high', title: 'US high story', countryCode: 'US', severity: 'high', sources: ['SrcA'] }),
      digestStory({ hash: 'gb-crit', title: 'GB critical story', countryCode: 'GB', severity: 'critical', sources: ['SrcB'] }),
    ];
    const env = composeBriefFromDigestStories(
      rule(),
      stories,
      { clusters: 0, multiSource: 0 },
      { nowMs: NOW, followedCountries: ['US'] },
    );
    // Critical wins absolutely.
    assert.equal(env.data.stories[0].headline, 'GB critical story');
    assert.equal(env.data.stories[1].headline, 'US high story');
  });

  it('free user with 5 grandfathered countries clamped to 3 by caller (we honor whatever list is passed)', () => {
    // Composer doesn't enforce the clamp itself — that's the call
    // site's job (entitlement-aware). This test confirms that when
    // the call site passes a clamped list, only those 3 boost.
    const stories = [
      digestStory({ hash: 'a', title: 'IT story', countryCode: 'IT', sources: ['SrcA'] }),
      digestStory({ hash: 'b', title: 'JP story', countryCode: 'JP', sources: ['SrcB'] }),
      digestStory({ hash: 'c', title: 'US story', countryCode: 'US', sources: ['SrcC'] }),
      digestStory({ hash: 'd', title: 'GB story', countryCode: 'GB', sources: ['SrcD'] }),
      digestStory({ hash: 'e', title: 'DE story', countryCode: 'DE', sources: ['SrcE'] }),
    ];
    // Caller clamped to first 3 (addedAt asc): US, GB, DE.
    const clamped = ['US', 'GB', 'DE'];
    const env = composeBriefFromDigestStories(
      rule(),
      stories,
      { clusters: 0, multiSource: 0 },
      { nowMs: NOW, followedCountries: clamped },
    );
    // First 3 should be US, GB, DE in that order (boosted).
    assert.deepEqual(
      env.data.stories.slice(0, 3).map((s) => s.headline),
      ['US story', 'GB story', 'DE story'],
    );
    // IT and JP fall to positions 3, 4 (post-boost).
    assert.equal(env.data.stories[3].headline, 'IT story');
    assert.equal(env.data.stories[4].headline, 'JP story');
  });

  it('synthesis.rankedStoryHashes wins over followed-country bias (LLM editorial truth)', () => {
    // Plan: when synthesis supplies a ranking, the LLM has the most
    // signal — bias only sets pre-rank ordering, applyRankedOrder runs
    // after and re-orders.
    const stories = [
      digestStory({ hash: 'aaaa1111', title: 'GB story', countryCode: 'GB', sources: ['SrcA'] }),
      digestStory({ hash: 'bbbb2222', title: 'US story', countryCode: 'US', sources: ['SrcB'] }),
      digestStory({ hash: 'cccc3333', title: 'FR story', countryCode: 'FR', sources: ['SrcC'] }),
    ];
    const env = composeBriefFromDigestStories(
      rule(),
      stories,
      { clusters: 0, multiSource: 0 },
      {
        nowMs: NOW,
        followedCountries: ['US'],
        synthesis: {
          lead: 'Editorial lead at least forty characters long for validator pass-through.',
          // LLM ranks GB first, then FR, then US — overrides US-bias.
          rankedStoryHashes: ['aaaa1111', 'cccc3333', 'bbbb2222'],
        },
      },
    );
    assert.equal(env.data.stories[0].headline, 'GB story');
    assert.equal(env.data.stories[1].headline, 'FR story');
    assert.equal(env.data.stories[2].headline, 'US story');
  });

  it('case-insensitive followed country match (lowercase passed → uppercase compared)', () => {
    const stories = [
      digestStory({ hash: 'a', title: 'GB story', countryCode: 'GB', sources: ['SrcA'] }),
      digestStory({ hash: 'b', title: 'US story', countryCode: 'US', sources: ['SrcB'] }),
    ];
    const env = composeBriefFromDigestStories(
      rule(),
      stories,
      { clusters: 0, multiSource: 0 },
      { nowMs: NOW, followedCountries: ['us'] }, // lowercase
    );
    assert.equal(env.data.stories[0].headline, 'US story');
  });
});

describe('envelope cache backfill (read-side defaults)', () => {
  // The envelope shape is intentionally NOT extended with a debug
  // field for U10 — the strict envelope validator
  // (server/_shared/brief-render.js::assertBriefEnvelope) rejects extra
  // keys on the data root and digest sub-tree. Adding
  // `followedCountriesUsed` would force a BRIEF_ENVELOPE_VERSION bump
  // and a renderer-side allow-list change, which is outside U10's scope
  // (the bias is the actual product behavior; "which countries
  // boosted" is operator visibility, served via the [digest] brief
  // followed-bias log line, not the envelope).
  //
  // This test locks in the no-shape-drift contract so a future
  // implementer who adds the debug field MUST also update the
  // validator + version constant.
  it('envelope shape is unchanged — bias is invisible to consumers', () => {
    const stories = [
      digestStory({ hash: 'a', title: 'US story', countryCode: 'US' }),
    ];
    const env = composeBriefFromDigestStories(
      rule(),
      stories,
      { clusters: 0, multiSource: 0 },
      { nowMs: NOW, followedCountries: ['US'] },
    );
    // No debug field on the envelope — bias is opaque to readers.
    assert.equal('followedCountriesUsed' in env.data, false);
    assert.equal('followedCountriesUsed' in env.data.digest, false);
    assert.equal('followedCountriesUsed' in env, false);
  });
});
