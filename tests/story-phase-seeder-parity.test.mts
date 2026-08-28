/**
 * StoryPhase seeder parity — issue #7154.
 *
 * Locks the notification seeder to the shared core rules used by the feed
 * digest, keeps the intentional silence→fading extension, and rejects
 * off-enum phase badges in digest email HTML.
 *
 * Run: npx tsx --test tests/story-phase-seeder-parity.test.mts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { __testing__ } from '../server/worldmonitor/news/v1/list-feed-digest.ts';
import {
  STORY_PHASES,
  deriveCoreStoryPhase,
  deriveNotificationStoryPhase,
  formatStoryPhaseBadge,
  isStoryPhase,
} from '../shared/story-phase.js';

const { derivePhase: deriveFeedPhase } = __testing__;
const __dirname = dirname(fileURLToPath(import.meta.url));
const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

const PROTO_TO_CLIENT = {
  STORY_PHASE_BREAKING: 'breaking',
  STORY_PHASE_DEVELOPING: 'developing',
  STORY_PHASE_SUSTAINED: 'sustained',
} as const;

function feedClientPhase(
  mentionCount: number,
  ageMs: number,
  lastSeenAgoMs = 0,
): string {
  const phase = deriveFeedPhase({
    firstSeen: NOW - ageMs,
    lastSeen: NOW - lastSeenAgoMs,
    mentionCount,
    sourceCount: 1,
  }, NOW);
  return PROTO_TO_CLIENT[phase as keyof typeof PROTO_TO_CLIENT];
}

function seederPhase(
  mentionCount: number,
  ageMs: number,
  lastSeenAgoMs = 0,
): string {
  return deriveNotificationStoryPhase({
    mentionCount,
    firstSeen: NOW - ageMs,
    lastSeen: NOW - lastSeenAgoMs,
  }, NOW);
}

describe('#7154 shared core phase — closed enum', () => {
  it('enumerates only modelled StoryPhase values', () => {
    assert.deepEqual([...STORY_PHASES], ['breaking', 'developing', 'sustained', 'fading']);
    for (const phase of STORY_PHASES) {
      assert.equal(isStoryPhase(phase), true);
    }
    assert.equal(isStoryPhase('unknown'), false);
  });

  it('deriveCoreStoryPhase never returns unknown', () => {
    const cases = [
      { mentionCount: 0, ageMs: 0 },
      { mentionCount: 1, ageMs: 5 * HOUR },
      { mentionCount: 2, ageMs: 1 },
      { mentionCount: 5, ageMs: 2 * HOUR - 1 },
      { mentionCount: 5, ageMs: 2 * HOUR },
      { mentionCount: 6, ageMs: 1 },
      { mentionCount: 40, ageMs: 9 * HOUR },
      { mentionCount: 1700, ageMs: 200 * HOUR },
    ];
    for (const c of cases) {
      const phase = deriveCoreStoryPhase({
        mentionCount: c.mentionCount,
        firstSeen: NOW - c.ageMs,
      }, NOW);
      assert.ok(isStoryPhase(phase), `core phase must be modelled, got ${phase}`);
      assert.notEqual(phase, 'fading', 'core rules must not emit fading');
    }
  });
});

describe('#7154 regression — single-mention aged story is breaking, not unknown', () => {
  it('mentionCount <= 1, age >= 2h, silence <= 24h → breaking', () => {
    const phase = seederPhase(1, 3 * HOUR, 1 * HOUR);
    assert.equal(phase, 'breaking');
    assert.notEqual(phase, 'unknown');
  });

  it('agrees with the feed digest for the same track (excluding fading)', () => {
    const phase = seederPhase(1, 3 * HOUR, 1 * HOUR);
    const feedPhase = feedClientPhase(1, 3 * HOUR, 1 * HOUR);
    assert.equal(phase, feedPhase);
  });

  it('MUTATION: the pre-#7154 fallthrough would have been off-enum', () => {
    // Documents the removed bug: old seeder returned 'unknown' here.
    const legacyBugPhase = 'unknown';
    assert.equal(isStoryPhase(legacyBugPhase), false);
    assert.throws(
      () => formatStoryPhaseBadge(legacyBugPhase, { strict: true }),
      /unmodelled story phase: unknown/,
    );
    assert.equal(formatStoryPhaseBadge(legacyBugPhase), null,
      'non-strict renderer omits the badge instead of painting UNKNOWN grey');
  });
});

describe('#7154 parity — seeder core rules match feed digest (non-fading)', () => {
  const grid = [
    { mentionCount: 1, ageMs: 0 },
    { mentionCount: 1, ageMs: 5 * HOUR },
    { mentionCount: 2, ageMs: 1 },
    { mentionCount: 5, ageMs: 2 * HOUR - 1 },
    { mentionCount: 5, ageMs: 2 * HOUR },
    { mentionCount: 6, ageMs: 1 },
    { mentionCount: 40, ageMs: 9 * HOUR },
    { mentionCount: 30, ageMs: 120 * HOUR, lastSeenAgoMs: 0 },
  ];

  for (const c of grid) {
    it(`mentionCount=${c.mentionCount}, ageMs=${c.ageMs} → ${feedClientPhase(c.mentionCount, c.ageMs, c.lastSeenAgoMs ?? 0)}`, () => {
      const feedPhase = feedClientPhase(c.mentionCount, c.ageMs, c.lastSeenAgoMs ?? 0);
      const notificationPhase = seederPhase(c.mentionCount, c.ageMs, c.lastSeenAgoMs ?? 0);
      assert.equal(notificationPhase, feedPhase);
    });
  }
});

describe('#7154 intentional divergence — silence >24h is fading in notifications only', () => {
  it('notification path labels >24h silence as fading', () => {
    assert.equal(seederPhase(10, 48 * HOUR, 25 * HOUR), 'fading');
  });

  it('feed digest cannot observe silence and never emits fading', () => {
    const phase = deriveFeedPhase({
      firstSeen: NOW - 48 * HOUR,
      lastSeen: NOW - 25 * HOUR,
      mentionCount: 10,
      sourceCount: 1,
    }, NOW);
    assert.notEqual(phase, 'STORY_PHASE_FADING');
    assert.equal(PROTO_TO_CLIENT[phase as keyof typeof PROTO_TO_CLIENT], 'sustained');
  });

  it('seeder source delegates to shared/story-phase.js', () => {
    const seeder = readFileSync(
      resolve(__dirname, '..', 'scripts', 'seed-digest-notifications.mjs'),
      'utf-8',
    );
    assert.match(seeder, /deriveNotificationStoryPhase/);
    assert.doesNotMatch(seeder, /return 'unknown'/);
    assert.doesNotMatch(seeder, /PHASE_COLOR\[s\.phase\] \?\? '#888'/);
  });
});

describe('#7154 digest email renderer — closed phase badge set', () => {
  it('formats every modelled phase', () => {
    for (const phase of STORY_PHASES) {
      const badge = formatStoryPhaseBadge(phase, { strict: true });
      assert.ok(badge);
      assert.equal(badge.label, phase.charAt(0).toUpperCase() + phase.slice(1));
      assert.match(badge.color, /^#[0-9a-f]{3,6}$/i);
    }
  });

  it('fails loudly on unmodelled phases in strict mode', () => {
    for (const bad of ['unknown', 'STORY_PHASE_BREAKING', 'breaking ']) {
      assert.throws(
        () => formatStoryPhaseBadge(bad, { strict: true }),
        /unmodelled story phase/,
        `strict mode must reject ${JSON.stringify(bad)}`,
      );
    }
    assert.equal(formatStoryPhaseBadge('', { strict: true }), null,
      'empty phase omits the badge');
  });

  it('omits the badge for unmodelled phases in the email path', () => {
    assert.equal(formatStoryPhaseBadge('unknown'), null);
    const htmlSnippet = (phase: string) => {
      const badge = formatStoryPhaseBadge(phase);
      return badge
        ? `<span>${badge.label.toUpperCase()}</span>`
        : '';
    };
    assert.equal(htmlSnippet('unknown'), '');
    assert.match(htmlSnippet('breaking'), /BREAKING/);
    assert.doesNotMatch(htmlSnippet('unknown'), /UNKNOWN/);
  });
});
