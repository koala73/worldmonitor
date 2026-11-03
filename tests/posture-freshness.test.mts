import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { postureAssessedAtIso, withPostureFreshness } from '../src/services/posture-freshness.ts';

function posture(timestamp: string, stale?: boolean): { postures: []; totalFlights: number; timestamp: string; cached: boolean; stale?: boolean } {
  return {
    postures: [],
    totalFlights: 0,
    timestamp,
    cached: true,
    ...(stale === undefined ? {} : { stale }),
  };
}

describe('withPostureFreshness', () => {
  const now = Date.parse('2026-09-19T12:00:00.000Z');

  it('marks cache older than the posture TTL as stale', () => {
    const fresh = withPostureFreshness(posture('2026-09-19T11:50:00.000Z'), now);
    assert.equal(fresh.stale, undefined);
    const stale = withPostureFreshness(posture('2026-09-19T11:00:00.000Z'), now);
    assert.equal(stale.stale, true);
  });

  it('uses the oldest assessment time so a stale seed is not stamped fresh', () => {
    const iso = postureAssessedAtIso([now, now - 60 * 60 * 1000]);
    assert.equal(iso, new Date(now - 60 * 60 * 1000).toISOString());
    assert.equal(withPostureFreshness(posture(iso), now).stale, true);
    assert.equal(postureAssessedAtIso([0, Number.NaN]), new Date(0).toISOString());
  });

  it('keeps an explicit stale flag', () => {
    const marked = withPostureFreshness(posture('2026-09-19T11:59:00.000Z', true), now);
    assert.equal(marked.stale, true);
  });
});
