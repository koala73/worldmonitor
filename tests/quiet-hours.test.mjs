import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isInQuietHours, toLocalHour } = require('../scripts/lib/quiet-hours.cjs');

// Fixed instant: 2026-04-14T03:00:00Z → 03:00 UTC, 23:00 America/New_York (EDT, -04)
const NOW_UTC_03 = Date.parse('2026-04-14T03:00:00Z');
// Fixed instant: 2026-04-14T12:00:00Z → 12:00 UTC
const NOW_UTC_12 = Date.parse('2026-04-14T12:00:00Z');

describe('isInQuietHours', () => {
  it('returns false when quietHoursEnabled is false', () => {
    assert.equal(
      isInQuietHours(
        { quietHoursEnabled: false, quietHoursStart: 22, quietHoursEnd: 7, quietHoursTimezone: 'UTC' },
        NOW_UTC_03,
      ),
      false,
    );
  });

  it('returns false when start === end (regression #3061: must not silently suppress 24/7)', () => {
    for (const hour of [0, 7, 12, 22, 23]) {
      assert.equal(
        isInQuietHours(
          { quietHoursEnabled: true, quietHoursStart: hour, quietHoursEnd: hour, quietHoursTimezone: 'UTC' },
          NOW_UTC_03,
        ),
        false,
        `expected start===end===${hour} to be treated as disabled`,
      );
    }
  });

  it('handles midnight-spanning window (22→7): inside at 03:00 UTC', () => {
    assert.equal(
      isInQuietHours(
        { quietHoursEnabled: true, quietHoursStart: 22, quietHoursEnd: 7, quietHoursTimezone: 'UTC' },
        NOW_UTC_03,
      ),
      true,
    );
  });

  it('handles midnight-spanning window (22→7): outside at 12:00 UTC', () => {
    assert.equal(
      isInQuietHours(
        { quietHoursEnabled: true, quietHoursStart: 22, quietHoursEnd: 7, quietHoursTimezone: 'UTC' },
        NOW_UTC_12,
      ),
      false,
    );
  });

  it('handles same-day window (9→17): inside at 12:00 UTC', () => {
    assert.equal(
      isInQuietHours(
        { quietHoursEnabled: true, quietHoursStart: 9, quietHoursEnd: 17, quietHoursTimezone: 'UTC' },
        NOW_UTC_12,
      ),
      true,
    );
  });

  it('handles same-day window (9→17): outside at 03:00 UTC', () => {
    assert.equal(
      isInQuietHours(
        { quietHoursEnabled: true, quietHoursStart: 9, quietHoursEnd: 17, quietHoursTimezone: 'UTC' },
        NOW_UTC_03,
      ),
      false,
    );
  });

  it('end is exclusive: at hour === end, not in quiet window', () => {
    // 9→17 at exactly 17:00 UTC should be outside
    const at17 = Date.parse('2026-04-14T17:00:00Z');
    assert.equal(
      isInQuietHours(
        { quietHoursEnabled: true, quietHoursStart: 9, quietHoursEnd: 17, quietHoursTimezone: 'UTC' },
        at17,
      ),
      false,
    );
  });

  it('start is inclusive: at hour === start, in quiet window', () => {
    const at22 = Date.parse('2026-04-14T22:00:00Z');
    assert.equal(
      isInQuietHours(
        { quietHoursEnabled: true, quietHoursStart: 22, quietHoursEnd: 7, quietHoursTimezone: 'UTC' },
        at22,
      ),
      true,
    );
  });

  it('returns false when timezone is invalid (toLocalHour returns -1)', () => {
    assert.equal(
      isInQuietHours(
        { quietHoursEnabled: true, quietHoursStart: 22, quietHoursEnd: 7, quietHoursTimezone: 'Not/A_Zone' },
        NOW_UTC_03,
      ),
      false,
    );
  });

  it('respects timezone: 22→7 NYC at 2026-04-14T03:00Z (23:00 EDT) is inside', () => {
    assert.equal(
      isInQuietHours(
        { quietHoursEnabled: true, quietHoursStart: 22, quietHoursEnd: 7, quietHoursTimezone: 'America/New_York' },
        NOW_UTC_03,
      ),
      true,
    );
  });

  it('defaults: missing start/end fall back to 22→7', () => {
    assert.equal(
      isInQuietHours({ quietHoursEnabled: true, quietHoursTimezone: 'UTC' }, NOW_UTC_03),
      true,
    );
    assert.equal(
      isInQuietHours({ quietHoursEnabled: true, quietHoursTimezone: 'UTC' }, NOW_UTC_12),
      false,
    );
  });
});

describe('toLocalHour', () => {
  it('returns integer hour for valid timezone', () => {
    assert.equal(toLocalHour(NOW_UTC_12, 'UTC'), 12);
  });

  it('returns -1 for invalid timezone', () => {
    assert.equal(toLocalHour(NOW_UTC_12, 'Not/A_Zone'), -1);
  });
});
