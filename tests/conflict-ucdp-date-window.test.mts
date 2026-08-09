import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  deriveConflictHistory,
  deriveUcdpClassifications,
} from '../src/services/conflict/ucdp-classify.ts';

function ucdpEvent(country: string, deathsBest: number, dateStart: number) {
  return {
    country,
    deathsBest,
    dateStart,
    violenceType: 'UCDP_VIOLENCE_TYPE_STATE_BASED',
  };
}

describe('frontend UCDP classification date guard', () => {
  it('ignores future and non-finite dates while preserving valid current/past rows', () => {
    const now = 1_700_000_000_000;
    const dayMs = 24 * 60 * 60 * 1000;
    const twoYearsMs = 2 * 365 * dayMs;
    const originalDateNow = Date.now;
    Date.now = () => now;
    try {
      assert.equal(
        deriveUcdpClassifications([ucdpEvent('Ukraine', 2000, now + 365 * dayMs)]).get('Ukraine')?.intensity,
        'none',
        'future-dated high-death UCDP rows must not classify as war',
      );
      assert.equal(
        deriveUcdpClassifications([ucdpEvent('Ukraine', 2000, Number.NaN)]).get('Ukraine')?.intensity,
        'none',
        'non-finite UCDP dates must fail closed',
      );
      assert.equal(
        deriveUcdpClassifications([ucdpEvent('Ukraine', 2000, now)]).get('Ukraine')?.intensity,
        'war',
        'current UCDP rows must still classify',
      );
      assert.equal(
        deriveUcdpClassifications([ucdpEvent('Ukraine', 2000, now - twoYearsMs + dayMs)]).get('Ukraine')?.intensity,
        'war',
        'past UCDP rows inside the trailing window must still classify',
      );
    } finally {
      Date.now = originalDateNow;
    }
  });
});

describe('deriveConflictHistory', () => {
  it('takes CONFLICT SINCE from the static startDate year, not the UCDP trailing window', () => {
    // UCDP feed is only a ~1yr trailing slice, so a 2026 event must NOT become "since".
    const events = [{ latitude: 48.5, longitude: 31, deaths_best: 100, date_start: '2026-01-01' }];
    const result = deriveConflictHistory({ center: [31, 48.5], startDate: 'Feb 24, 2022' }, events);
    assert.equal(result.conflictSince, '2022');
    assert.equal(result.recordedFatalities, 100);
  });

  it('returns null conflictSince when the zone has no startDate', () => {
    const result = deriveConflictHistory({ center: [31, 48.5] }, []);
    assert.equal(result.conflictSince, null);
    assert.equal(result.recordedFatalities, 0);
  });

  it('applies a cos(latitude) correction so the radius is isotropic in real distance', () => {
    // At 60°N, cos(lat)=0.5: an event 4° east is ~2° in real distance (inside the
    // 3° radius) and MUST be counted. A raw degree filter would wrongly exclude it.
    const events = [{ latitude: 60, longitude: 4, deaths_best: 50, date_start: '2024-01-01' }];
    const result = deriveConflictHistory({ center: [0, 60], startDate: 'Jan 1, 2020' }, events);
    assert.equal(result.recordedFatalities, 50);
  });
});
