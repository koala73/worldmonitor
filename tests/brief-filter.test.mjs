// Pure-function tests for the Phase 3a brief composer helpers.
//
// Locks in: severity normalisation (moderate → medium), sensitivity
// threshold, story cap, envelope assembly passes the renderer's
// strict validator, threads derivation, tz-aware issue date.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseThreatLevel,
  filterTopStories,
  assembleStubbedBriefEnvelope,
  issueDateInTz,
} from '../shared/brief-filter.js';
import { BRIEF_ENVELOPE_VERSION } from '../shared/brief-envelope.js';

function upstreamStory(overrides = {}) {
  return {
    primaryTitle: 'Iran declares Strait of Hormuz open. Oil drops more than 9%.',
    primarySource: 'Reuters',
    primaryLink: 'https://example.com/hormuz',
    description: 'Tehran publicly reopened the Strait of Hormuz to commercial shipping today.',
    threatLevel: 'high',
    category: 'Energy',
    countryCode: 'IR',
    importanceScore: 320,
    ...overrides,
  };
}

describe('normaliseThreatLevel', () => {
  it('accepts the four canonical values', () => {
    for (const level of ['critical', 'high', 'medium', 'low']) {
      assert.equal(normaliseThreatLevel(level), level);
    }
  });

  it('maps upstream "moderate" to "medium"', () => {
    assert.equal(normaliseThreatLevel('moderate'), 'medium');
  });

  it('case-insensitive', () => {
    assert.equal(normaliseThreatLevel('HIGH'), 'high');
    assert.equal(normaliseThreatLevel('Moderate'), 'medium');
  });

  it('returns null on unknown or non-string input', () => {
    assert.equal(normaliseThreatLevel('unknown'), null);
    assert.equal(normaliseThreatLevel(null), null);
    assert.equal(normaliseThreatLevel(42), null);
  });
});

describe('filterTopStories', () => {
  it('respects sensitivity=critical (keeps critical only)', () => {
    const out = filterTopStories({
      stories: [
        upstreamStory({ threatLevel: 'critical' }),
        upstreamStory({ threatLevel: 'high' }),
        upstreamStory({ threatLevel: 'medium' }),
      ],
      sensitivity: 'critical',
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].threatLevel, 'critical');
  });

  it('sensitivity=high keeps critical + high', () => {
    const out = filterTopStories({
      stories: [
        upstreamStory({ threatLevel: 'critical' }),
        upstreamStory({ threatLevel: 'high' }),
        upstreamStory({ threatLevel: 'medium' }),
        upstreamStory({ threatLevel: 'low' }),
      ],
      sensitivity: 'high',
    });
    assert.equal(out.length, 2);
  });

  it('sensitivity=all keeps everything with a known severity', () => {
    const out = filterTopStories({
      stories: [
        upstreamStory({ threatLevel: 'critical' }),
        upstreamStory({ threatLevel: 'high' }),
        upstreamStory({ threatLevel: 'moderate' }),
        upstreamStory({ threatLevel: 'low' }),
        upstreamStory({ threatLevel: 'unknown' }),
      ],
      sensitivity: 'all',
      // Disable U5's source-topic cap — these fixtures share source/category
      // by design (they test the severity gate, not the per-pair cap).
      maxPerSourceTopic: Infinity,
    });
    assert.equal(out.length, 4);
  });

  it('caps at maxStories', () => {
    const stories = Array.from({ length: 20 }, (_, i) =>
      upstreamStory({ primaryTitle: `Story ${i}` }),
    );
    const out = filterTopStories({
      stories,
      sensitivity: 'all',
      maxStories: 5,
      // Disable U5's source-topic cap — these fixtures share source/category
      // by design (they test the maxStories cap, not the per-pair cap).
      maxPerSourceTopic: Infinity,
    });
    assert.equal(out.length, 5);
  });

  it('falls back to Multiple wires when primarySource missing', () => {
    const out = filterTopStories({
      stories: [upstreamStory({ primarySource: '' })],
      sensitivity: 'all',
    });
    assert.equal(out[0].source, 'Multiple wires');
  });

  it('drops stories with empty primaryTitle', () => {
    const out = filterTopStories({
      stories: [upstreamStory({ primaryTitle: '   ' })],
      sensitivity: 'all',
    });
    assert.equal(out.length, 0);
  });

  it('returns empty for unknown sensitivity', () => {
    const out = filterTopStories({
      stories: [upstreamStory()],
      sensitivity: /** @type {any} */ ('bogus'),
    });
    assert.equal(out.length, 0);
  });

  it('non-array input returns empty', () => {
    assert.deepEqual(
      filterTopStories({
        stories: /** @type {any} */ (null),
        sensitivity: 'all',
      }),
      [],
    );
  });

  it('emits BriefStory.sourceUrl from primaryLink (v2)', () => {
    const out = filterTopStories({
      stories: [upstreamStory({ primaryLink: 'https://example.com/story?x=1' })],
      sensitivity: 'all',
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].sourceUrl, 'https://example.com/story?x=1');
  });

  it('drops stories without a valid primaryLink (v2 requires sourceUrl)', () => {
    const out = filterTopStories({
      stories: [
        upstreamStory({ primaryLink: undefined }),
        upstreamStory({ primaryLink: '' }),
        upstreamStory({ primaryLink: 'not a url' }),
        upstreamStory({ primaryLink: 'javascript:alert(1)' }),
        upstreamStory({ primaryLink: 'https://user:pw@example.com/x' }),
        upstreamStory({ primaryLink: 'https://example.com/keep' }),
      ],
      sensitivity: 'all',
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].sourceUrl, 'https://example.com/keep');
  });
});

describe('assembleStubbedBriefEnvelope', () => {
  const baseStories = [
    upstreamStory({ threatLevel: 'critical' }),
    upstreamStory({ threatLevel: 'high', category: 'Diplomacy' }),
    upstreamStory({ threatLevel: 'high', category: 'Maritime' }),
    upstreamStory({ threatLevel: 'medium', category: 'Energy' }),
  ];

  function baseInput() {
    const stories = filterTopStories({
      stories: baseStories,
      sensitivity: 'all',
    });
    return {
      user: { name: 'Elie', tz: 'UTC' },
      stories,
      issueDate: '2026-04-18',
      dateLong: '18 April 2026',
      issue: '18.04',
      insightsNumbers: { clusters: 278, multiSource: 21 },
      issuedAt: 1_700_000_000_000,
      localHour: 9,
    };
  }

  it('produces an envelope that passes the strict renderer validator', () => {
    const env = assembleStubbedBriefEnvelope(baseInput());
    assert.equal(env.version, BRIEF_ENVELOPE_VERSION);
    assert.equal(env.data.digest.numbers.surfaced, env.data.stories.length);
    assert.equal(env.data.digest.signals.length, 0);
    assert.ok(env.data.digest.threads.length > 0);
  });

  it('morning greeting at hour 9', () => {
    const env = assembleStubbedBriefEnvelope({ ...baseInput(), localHour: 9 });
    assert.equal(env.data.digest.greeting, 'Good morning.');
  });

  it('evening greeting at hour 22', () => {
    const env = assembleStubbedBriefEnvelope({ ...baseInput(), localHour: 22 });
    assert.equal(env.data.digest.greeting, 'Good evening.');
  });

  it('afternoon greeting at hour 14', () => {
    const env = assembleStubbedBriefEnvelope({ ...baseInput(), localHour: 14 });
    assert.equal(env.data.digest.greeting, 'Good afternoon.');
  });

  it('threads are derived from category frequency, capped at 6', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      upstreamStory({ category: `Cat${i}`, threatLevel: 'high' }),
    );
    const stories = filterTopStories({ stories: many, sensitivity: 'all' });
    const env = assembleStubbedBriefEnvelope({
      ...baseInput(),
      stories,
    });
    assert.ok(env.data.digest.threads.length <= 6);
  });

  it('throws when assembled envelope would fail validation (empty stories)', () => {
    assert.throws(() =>
      assembleStubbedBriefEnvelope({
        ...baseInput(),
        stories: [],
      }),
    );
  });
});

describe('filterTopStories — onDrop metrics', () => {
  const sensitivity = 'high';

  it('does not invoke onDrop when every story passes', () => {
    const calls = [];
    const stories = [upstreamStory(), upstreamStory({ primaryTitle: 'Another' })];
    filterTopStories({ stories, sensitivity, onDrop: (ev) => calls.push(ev) });
    assert.equal(calls.length, 0);
  });

  it('fires onDrop with reason=severity when sensitivity excludes the level', () => {
    const calls = [];
    filterTopStories({
      stories: [upstreamStory({ threatLevel: 'low' })],
      sensitivity,
      onDrop: (ev) => calls.push(ev),
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].reason, 'severity');
    assert.equal(calls[0].severity, 'low');
  });

  it('fires onDrop with reason=headline when primaryTitle is empty', () => {
    const calls = [];
    filterTopStories({
      stories: [upstreamStory({ primaryTitle: '' })],
      sensitivity,
      onDrop: (ev) => calls.push(ev),
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].reason, 'headline');
    assert.equal(calls[0].severity, 'high');
  });

  it('fires onDrop with reason=url when primaryLink is invalid', () => {
    const calls = [];
    filterTopStories({
      stories: [upstreamStory({ primaryLink: 'ftp://bad' })],
      sensitivity,
      onDrop: (ev) => calls.push(ev),
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].reason, 'url');
    assert.equal(calls[0].severity, 'high');
    assert.equal(calls[0].sourceUrl, 'ftp://bad');
  });

  it('fires onDrop with reason=shape for non-object input', () => {
    const calls = [];
    filterTopStories({
      stories: [null, 'not an object', upstreamStory()],
      sensitivity,
      onDrop: (ev) => calls.push(ev),
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].reason, 'shape');
    assert.equal(calls[1].reason, 'shape');
  });

  it('output is byte-identical whether onDrop is supplied or not', () => {
    // Regression guard: the metrics hook must not alter filter behaviour.
    const stories = [
      upstreamStory({ threatLevel: 'low' }),
      upstreamStory(),
      upstreamStory({ primaryLink: 'ftp://bad' }),
      upstreamStory({ primaryTitle: '' }),
      upstreamStory({ primaryTitle: 'Second valid' }),
    ];
    const without = filterTopStories({ stories, sensitivity });
    const with_ = filterTopStories({ stories, sensitivity, onDrop: () => {} });
    assert.deepEqual(without, with_);
  });

  it('distinct reasons are counted separately across a mixed batch', () => {
    // Matches the seeder's per-user aggregation pattern.
    const tally = { severity: 0, headline: 0, url: 0, shape: 0, cap: 0 };
    filterTopStories({
      stories: [
        upstreamStory({ threatLevel: 'low' }),        // severity
        upstreamStory({ threatLevel: 'medium' }),     // severity
        upstreamStory({ primaryTitle: '' }),          // headline
        upstreamStory({ primaryLink: 'ftp://bad' }),  // url
        null,                                          // shape
        upstreamStory(),                              // kept
      ],
      sensitivity,
      onDrop: (ev) => { tally[ev.reason]++; },
    });
    assert.equal(tally.severity, 2);
    assert.equal(tally.headline, 1);
    assert.equal(tally.url, 1);
    assert.equal(tally.shape, 1);
    assert.equal(tally.cap, 0);
  });

  it('fires onDrop with reason=cap once per story skipped after maxStories', () => {
    // Without this, cap-truncated stories are invisible to telemetry
    // and `in - out - sum(other_drops)` does not reconcile.
    const calls = [];
    filterTopStories({
      stories: [
        upstreamStory({ primaryTitle: 'A' }),
        upstreamStory({ primaryTitle: 'B' }),
        upstreamStory({ primaryTitle: 'C' }),
        upstreamStory({ primaryTitle: 'D' }),
        upstreamStory({ primaryTitle: 'E' }),
      ],
      sensitivity,
      maxStories: 2,
      onDrop: (ev) => calls.push(ev),
    });
    assert.equal(calls.length, 3, 'should emit one cap event per story past maxStories');
    for (const ev of calls) assert.equal(ev.reason, 'cap');
  });

  it('cap events do NOT count earlier severity/headline/url drops twice', () => {
    // The cap-emit loop runs from the break point onward — earlier
    // valid stories that pushed `out` to maxStories are not re-emitted,
    // and earlier-dropped stories are accounted under their own reason.
    const tally = { severity: 0, headline: 0, url: 0, shape: 0, cap: 0 };
    filterTopStories({
      stories: [
        upstreamStory({ primaryTitle: 'A' }),         // kept
        upstreamStory({ threatLevel: 'low' }),        // severity (not cap)
        upstreamStory({ primaryTitle: 'B' }),         // kept (out reaches 2)
        upstreamStory({ primaryTitle: 'C' }),         // cap
        upstreamStory({ primaryLink: 'ftp://bad' }),  // cap (loop short-circuits past url check)
      ],
      sensitivity,
      maxStories: 2,
      onDrop: (ev) => { tally[ev.reason]++; },
    });
    assert.equal(tally.severity, 1);
    assert.equal(tally.cap, 2);
    assert.equal(tally.url, 0, 'url drop should NOT fire after cap break');
  });

  it('reconciliation invariant: in === out + sum(dropped_*) across all reasons', () => {
    // Locks in the operator-facing invariant that motivated adding `cap`.
    const tally = { severity: 0, headline: 0, url: 0, shape: 0, cap: 0, source_topic_cap: 0, institutional_static_page: 0 };
    const stories = [
      upstreamStory({ primaryTitle: 'A' }),
      upstreamStory({ primaryTitle: 'B' }),
      upstreamStory({ threatLevel: 'low' }),
      upstreamStory({ primaryTitle: '' }),
      upstreamStory({ primaryLink: 'ftp://bad' }),
      null,
      upstreamStory({ primaryTitle: 'C' }),
      upstreamStory({ primaryTitle: 'D' }),
      upstreamStory({ primaryTitle: 'E' }),
    ];
    const out = filterTopStories({
      stories,
      sensitivity,
      maxStories: 3,
      // Disable U5's source-topic cap — fixtures share source/category by
      // design; this test verifies the in===out+dropped invariant for the
      // existing severity/headline/url/shape/cap reasons. U5's own tests
      // cover the source_topic_cap reason in isolation.
      maxPerSourceTopic: Infinity,
      onDrop: (ev) => { tally[ev.reason]++; },
    });
    const totalDrops = tally.severity + tally.headline + tally.url + tally.shape + tally.cap + tally.source_topic_cap + tally.institutional_static_page;
    assert.equal(stories.length, out.length + totalDrops);
  });
});

describe('issueDateInTz', () => {
  // 2026-04-18T00:30:00Z — midnight UTC + 30min. Tokyo (+9) is
  // already mid-morning on the 18th; LA (-7) is late on the 17th.
  const midnightUtc = Date.UTC(2026, 3, 18, 0, 30, 0);

  it('UTC returns the UTC date', () => {
    assert.equal(issueDateInTz(midnightUtc, 'UTC'), '2026-04-18');
  });

  it('positive offset (Asia/Tokyo) returns the later local date', () => {
    assert.equal(issueDateInTz(midnightUtc, 'Asia/Tokyo'), '2026-04-18');
  });

  it('negative offset (America/Los_Angeles) returns the earlier local date', () => {
    assert.equal(issueDateInTz(midnightUtc, 'America/Los_Angeles'), '2026-04-17');
  });

  it('malformed timezone falls back to UTC', () => {
    assert.equal(issueDateInTz(midnightUtc, 'Not/A_Zone'), '2026-04-18');
  });
});

// ─── U5: source-topic cap (R6) ───────────────────────────────────────────────

describe('filterTopStories — source-topic cap (U5/R6)', () => {
  function story(overrides = {}) {
    return upstreamStory({
      threatLevel: 'high',
      primarySource: 'CBS News',
      category: 'weather',
      ...overrides,
    });
  }

  it('keeps 2 stories from the same (source, category) pair (within default cap)', () => {
    const out = filterTopStories({
      stories: [
        story({ primaryTitle: 'Tornadoes rip through Midwest' }),
        story({ primaryTitle: 'Watch tornadoes swirl through Oklahoma' }),
      ],
      sensitivity: 'all',
    });
    assert.equal(out.length, 2);
  });

  it('drops the 3rd story from the same (source, category) pair with reason source_topic_cap', () => {
    const drops = [];
    const out = filterTopStories({
      stories: [
        story({ primaryTitle: 'Tornadoes rip through Midwest' }),
        story({ primaryTitle: 'Watch tornadoes swirl through Oklahoma' }),
        story({ primaryTitle: 'Storm system batters Kansas' }),
      ],
      sensitivity: 'all',
      onDrop: (e) => drops.push(e),
    });
    assert.equal(out.length, 2);
    assert.equal(drops.length, 1);
    assert.equal(drops[0].reason, 'source_topic_cap');
    assert.equal(drops[0].severity, 'high');
  });

  it('stories from same source but different category both pass', () => {
    const out = filterTopStories({
      stories: [
        story({ primaryTitle: 'Tornado A', category: 'weather' }),
        story({ primaryTitle: 'Tornado B', category: 'weather' }),
        story({ primaryTitle: 'Election update', category: 'politics' }),
      ],
      sensitivity: 'all',
    });
    assert.equal(out.length, 3);
  });

  it('stories from different sources but same category both pass', () => {
    const out = filterTopStories({
      stories: [
        story({ primaryTitle: 'Tornado A', primarySource: 'CBS News' }),
        story({ primaryTitle: 'Tornado B', primarySource: 'CBS News' }),
        story({ primaryTitle: 'Tornado C', primarySource: 'Reuters' }),
      ],
      sensitivity: 'all',
    });
    assert.equal(out.length, 3);
  });

  it('honors maxPerSourceTopic override', () => {
    const drops = [];
    const out = filterTopStories({
      stories: [
        story({ primaryTitle: 'A' }),
        story({ primaryTitle: 'B' }),
        story({ primaryTitle: 'C' }),
      ],
      sensitivity: 'all',
      maxPerSourceTopic: 1,
      onDrop: (e) => drops.push(e),
    });
    assert.equal(out.length, 1);
    assert.equal(drops.filter((d) => d.reason === 'source_topic_cap').length, 2);
  });

  it('default missing source falls back to "Multiple wires" — cap still applies', () => {
    const out = filterTopStories({
      stories: [
        story({ primaryTitle: 'A', primarySource: undefined }),
        story({ primaryTitle: 'B', primarySource: undefined }),
        story({ primaryTitle: 'C', primarySource: undefined }),
      ],
      sensitivity: 'all',
    });
    assert.equal(out.length, 2, 'Multiple wires + same category caps at 2');
  });

  it('default missing category falls back to "General" — cap still applies', () => {
    const out = filterTopStories({
      stories: [
        story({ primaryTitle: 'A', category: undefined }),
        story({ primaryTitle: 'B', category: undefined }),
        story({ primaryTitle: 'C', category: undefined }),
      ],
      sensitivity: 'all',
    });
    assert.equal(out.length, 2, 'CBS News + General caps at 2');
  });

  it('source-topic cap key uses non-space delimiter (collision-safe with embedded spaces)', () => {
    // Regression guard: a naive `${source} ${category}` delimiter would
    // collide ('Reuters', 'World Politics') with ('Reuters World',
    // 'Politics'), causing the second pair to inherit the first's
    // count and either over-drop or under-drop. The Map key uses
    // ASCII Unit Separator (0x1F) so these stay distinct.
    const out = filterTopStories({
      stories: [
        story({
          primaryTitle: 'A',
          primarySource: 'Reuters',
          category: 'World Politics',
        }),
        story({
          primaryTitle: 'B',
          primarySource: 'Reuters',
          category: 'World Politics',
        }),
        // Pair shares the naive-concatenation collision key with the
        // Reuters+World Politics pair above; with the 0x1F delimiter
        // it's a different pair and gets its own count.
        story({
          primaryTitle: 'C',
          primarySource: 'Reuters World',
          category: 'Politics',
        }),
        story({
          primaryTitle: 'D',
          primarySource: 'Reuters World',
          category: 'Politics',
        }),
      ],
      sensitivity: 'all',
    });
    // All 4 should survive (2 per pair, 2 distinct pairs).
    assert.equal(out.length, 4);
  });

  it('institutional-static-page URLs are dropped (U7/R7)', () => {
    const drops = [];
    const out = filterTopStories({
      stories: [
        upstreamStory({
          primaryTitle: 'About Section 508',
          primaryLink: 'https://www.defense.gov/About/Section-508/',
          primarySource: 'Pentagon',
          category: 'gov',
        }),
        upstreamStory({
          primaryTitle: 'Real news',
          primaryLink: 'https://example.com/real-article',
          primarySource: 'Pentagon',
          category: 'gov',
        }),
      ],
      sensitivity: 'all',
      onDrop: (e) => drops.push(e),
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].headline, 'Real news');
    assert.equal(drops.length, 1);
    assert.equal(drops[0].reason, 'institutional_static_page');
    assert.equal(drops[0].sourceUrl, 'https://www.defense.gov/About/Section-508/');
  });

  it('ranked order survives the cap: highest-ranked sibling wins', () => {
    const drops = [];
    const out = filterTopStories({
      stories: [
        story({ primaryTitle: 'C low', hash: 'aaaaaaaaaaaaaaaa' }),
        story({ primaryTitle: 'B mid', hash: 'bbbbbbbbbbbbbbbb' }),
        story({ primaryTitle: 'A top', hash: 'cccccccccccccccc' }),
      ],
      sensitivity: 'all',
      maxPerSourceTopic: 2,
      // Rank C and A first, B last — so C+A survive, B is dropped.
      rankedStoryHashes: ['cccccccc', 'aaaaaaaa', 'bbbbbbbb'],
      onDrop: (e) => drops.push(e),
    });
    assert.equal(out.length, 2);
    assert.equal(out[0].headline, 'A top');
    assert.equal(out[1].headline, 'C low');
    assert.equal(drops.filter((d) => d.reason === 'source_topic_cap').length, 1);
  });
});
