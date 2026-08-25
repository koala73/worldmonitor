// #7154: derivePhase in seed-digest-notifications.mjs (extracted to
// scripts/_digest-notification-phase.mjs) could fall through to 'unknown',
// an off-enum value that isn't a valid StoryPhase. That value reached the
// digest email renderer's PHASE_COLOR lookup, which silently fell back to
// a grey badge reading the literal word "UNKNOWN" — the email was sent
// looking handled while nothing had actually decided "UNKNOWN" was
// acceptable copy.
//
// derivePhase is imported directly here (not via seed-digest-notifications.mjs
// itself, which unconditionally runs main() -- a real Redis-backed cron job --
// at module import time).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { derivePhase, DIGEST_PHASES, PHASE_COLOR } from '../scripts/_digest-notification-phase.mjs';

const HOUR = 3600000;

function trackAt({ mentionCount, ageHours, silenceHours }) {
  const now = Date.now();
  return {
    mentionCount: String(mentionCount),
    firstSeen: String(now - ageHours * HOUR),
    lastSeen: String(now - silenceHours * HOUR),
  };
}

describe('derivePhase — branch enumeration (#7154)', () => {
  it('returns fading when silence exceeds 24h, regardless of mention count or age', () => {
    assert.equal(derivePhase(trackAt({ mentionCount: 10, ageHours: 100, silenceHours: 25 })), 'fading');
    assert.equal(derivePhase(trackAt({ mentionCount: 1, ageHours: 1, silenceHours: 24.01 })), 'fading');
  });

  it('returns sustained when mentionCount >= 3 and age >= 12h and silence <= 24h', () => {
    assert.equal(derivePhase(trackAt({ mentionCount: 3, ageHours: 12, silenceHours: 1 })), 'sustained');
    assert.equal(derivePhase(trackAt({ mentionCount: 9, ageHours: 200, silenceHours: 0 })), 'sustained');
  });

  it('returns developing when mentionCount >= 2 but the sustained gate is not met', () => {
    assert.equal(derivePhase(trackAt({ mentionCount: 2, ageHours: 1, silenceHours: 0 })), 'developing');
    // mentionCount 2 with high age still fails the mentionCount >= 3 sustained gate.
    assert.equal(derivePhase(trackAt({ mentionCount: 2, ageHours: 200, silenceHours: 0 })), 'developing');
  });

  it('returns breaking for mentionCount <= 1, for every age and silence within the silence gate', () => {
    // This is the regression case: previously only ageH < 2 returned
    // 'breaking' here, and ageH >= 2 fell through to 'unknown'.
    assert.equal(derivePhase(trackAt({ mentionCount: 1, ageHours: 0, silenceHours: 0 })), 'breaking');
    assert.equal(derivePhase(trackAt({ mentionCount: 1, ageHours: 1.9, silenceHours: 0 })), 'breaking');
    assert.equal(derivePhase(trackAt({ mentionCount: 1, ageHours: 2, silenceHours: 0 })), 'breaking');
    assert.equal(derivePhase(trackAt({ mentionCount: 0, ageHours: 500, silenceHours: 24 })), 'breaking');
    assert.equal(derivePhase(trackAt({ mentionCount: 1, ageHours: 5, silenceHours: 12 })), 'breaking');
  });

  it('never returns a value outside DIGEST_PHASES across the full branch space (mutation-checked)', () => {
    const mentionCounts = [0, 1, 2, 3, 4];
    const ages = [0, 1, 1.9, 2, 5, 11, 12, 13, 200];
    const silences = [0, 5, 23, 24, 24.5, 100];
    for (const mentionCount of mentionCounts) {
      for (const ageHours of ages) {
        for (const silenceHours of silences) {
          const phase = derivePhase(trackAt({ mentionCount, ageHours, silenceHours }));
          assert.ok(
            DIGEST_PHASES.includes(phase),
            `derivePhase({mentionCount:${mentionCount}, ageHours:${ageHours}, silenceHours:${silenceHours}}) ` +
            `returned ${JSON.stringify(phase)}, not one of ${JSON.stringify(DIGEST_PHASES)}`,
          );
        }
      }
    }
  });
});

describe('derivePhase — agreement with the feed digest (#7154)', () => {
  it('agrees with list-feed-digest.ts derivePhase for mentionCount <= 1 (feed digest: unconditionally breaking)', () => {
    // list-feed-digest.ts: `if (track.mentionCount <= 1) return 'STORY_PHASE_BREAKING';`
    // -- unconditional on age. The seeder must agree for every age within
    // its own silence gate.
    for (const ageHours of [0, 1, 2, 10, 50, 23.9]) {
      assert.equal(
        derivePhase(trackAt({ mentionCount: 1, ageHours, silenceHours: 1 })),
        'breaking',
        `mentionCount<=1 at ageHours=${ageHours} must agree with the feed digest's unconditional 'breaking'`,
      );
    }
  });
});

describe('PHASE_COLOR — closed badge map (#7154)', () => {
  it('has exactly one entry per DIGEST_PHASES value, no more and no fewer', () => {
    assert.deepEqual(Object.keys(PHASE_COLOR).sort(), [...DIGEST_PHASES].sort());
  });

  it('every derivePhase output resolves to a real PHASE_COLOR entry, not the ?? "#888" unmodelled fallback', () => {
    // Proves the renderer's `PHASE_COLOR[s.phase] ?? '#888'` fallback can
    // never fire for a derivePhase() output -- the failure mode this issue
    // reports (grey badge, literal "UNKNOWN" text) requires s.phase to be a
    // key absent from PHASE_COLOR, which this shows is unreachable.
    for (const phase of DIGEST_PHASES) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(PHASE_COLOR, phase),
        `PHASE_COLOR is missing an entry for reachable phase ${JSON.stringify(phase)}`,
      );
      assert.notEqual(PHASE_COLOR[phase], undefined);
    }
  });
});
