import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHECKOUT_RATE_LIMIT_ALARM_COOLDOWN_MS,
  CHECKOUT_RATE_LIMIT_ALARM_DAY_THRESHOLD,
  CHECKOUT_RATE_LIMIT_ALARM_DAY_WINDOW_MS,
  CHECKOUT_RATE_LIMIT_ALARM_SCAN_LIMIT,
  CHECKOUT_RATE_LIMIT_ALARM_WEEK_THRESHOLD,
  CHECKOUT_RATE_LIMIT_ALARM_WEEK_WINDOW_MS,
  CHECKOUT_RATE_LIMIT_EVENT_RETENTION_MS,
  classifyCheckoutRateLimitAlarm,
  type CheckoutRateLimitOccurrence,
} from '../convex/payments/checkoutRateLimitAlarm.ts';

// ---------------------------------------------------------------------------
// classifyCheckoutRateLimitAlarm — the rate alarm on the tail of #6027's
// provider-429 ladder (#6698).
//
// The thing under test is an ALARM, so the assertions below are written
// against the question that matters for one: can it stay quiet while buyers
// are being turned away? Every "does not fire" case therefore pins WHY it did
// not fire, and every silent-forever path (cooldown with no prior alert,
// retention shorter than the window, boundary rounding) gets its own case.
//
// Observed floor these thresholds are sized against: 7 terminal 429s over
// 2026-08-01 -> 2026-08-13 (~0.54/day, ~3.8/week) — see
// docs/payments-checkout-rate-limit-operations.md.
// ---------------------------------------------------------------------------

const NOW = Date.UTC(2026, 7, 14, 12, 0, 0);
const MINUTE_MS = 60_000;

/** `count` occurrences spread one minute apart, ending `agoMs` before NOW. */
function burst(count: number, agoMs = 0): CheckoutRateLimitOccurrence[] {
  return Array.from({ length: count }, (_, i) => ({
    occurredAt: NOW - agoMs - i * MINUTE_MS,
  }));
}

describe('classifyCheckoutRateLimitAlarm — fires', () => {
  it('alerts on the first breach of the 24h burst threshold', () => {
    const verdict = classifyCheckoutRateLimitAlarm({
      occurrences: burst(CHECKOUT_RATE_LIMIT_ALARM_DAY_THRESHOLD),
      now: NOW,
    });
    assert.equal(verdict.kind, 'alert');
    if (verdict.kind === 'alert') {
      assert.equal(verdict.dayCount, CHECKOUT_RATE_LIMIT_ALARM_DAY_THRESHOLD);
      assert.deepEqual(verdict.breachedWindows, ['day']);
    }
  });

  it('alerts on the 7d drift threshold even when no single day is bursty', () => {
    // Spread across the week so the 24h count stays at 1 — this is the
    // "the floor moved" case the day window cannot see.
    const occurrences = Array.from(
      { length: CHECKOUT_RATE_LIMIT_ALARM_WEEK_THRESHOLD },
      (_, i) => ({ occurredAt: NOW - i * 12 * 60 * 60 * 1000 }),
    );
    const verdict = classifyCheckoutRateLimitAlarm({ occurrences, now: NOW });
    assert.equal(verdict.kind, 'alert');
    if (verdict.kind === 'alert') {
      assert.ok(
        verdict.dayCount < CHECKOUT_RATE_LIMIT_ALARM_DAY_THRESHOLD,
        'day window must be under threshold or this proves nothing about drift',
      );
      assert.deepEqual(verdict.breachedWindows, ['week']);
    }
  });

  it('reports both windows when a burst also carries the week over', () => {
    const verdict = classifyCheckoutRateLimitAlarm({
      occurrences: burst(CHECKOUT_RATE_LIMIT_ALARM_WEEK_THRESHOLD),
      now: NOW,
    });
    assert.equal(verdict.kind, 'alert');
    if (verdict.kind === 'alert') {
      assert.deepEqual(verdict.breachedWindows, ['day', 'week']);
    }
  });

  it('fires again once the cooldown has fully elapsed', () => {
    const occurrences = burst(CHECKOUT_RATE_LIMIT_ALARM_DAY_THRESHOLD);
    occurrences[occurrences.length - 1].alertedAt =
      NOW - CHECKOUT_RATE_LIMIT_ALARM_COOLDOWN_MS;
    const verdict = classifyCheckoutRateLimitAlarm({ occurrences, now: NOW });
    assert.equal(verdict.kind, 'alert');
  });

  it('counts an occurrence sitting exactly on the window floor', () => {
    // One event exactly 24h old plus (threshold - 1) fresh ones. If the
    // boundary were exclusive this would sit one under and stay silent.
    const occurrences = [
      ...burst(CHECKOUT_RATE_LIMIT_ALARM_DAY_THRESHOLD - 1),
      { occurredAt: NOW - CHECKOUT_RATE_LIMIT_ALARM_DAY_WINDOW_MS },
    ];
    const verdict = classifyCheckoutRateLimitAlarm({ occurrences, now: NOW });
    assert.equal(verdict.kind, 'alert');
  });
});

describe('classifyCheckoutRateLimitAlarm — stays quiet, and says why', () => {
  it('does not fire at the observed production floor', () => {
    // 7 occurrences spread over 13 days is the rate the issue documents.
    const occurrences = Array.from({ length: 7 }, (_, i) => ({
      occurredAt: NOW - i * 13 * 24 * 60 * 60 * 1000 / 7,
    }));
    const verdict = classifyCheckoutRateLimitAlarm({ occurrences, now: NOW });
    assert.equal(verdict.kind, 'below-threshold');
    if (verdict.kind === 'below-threshold') {
      assert.ok(verdict.weekCount < CHECKOUT_RATE_LIMIT_ALARM_WEEK_THRESHOLD);
    }
  });

  it('stays below threshold one occurrence short of the burst', () => {
    const verdict = classifyCheckoutRateLimitAlarm({
      occurrences: burst(CHECKOUT_RATE_LIMIT_ALARM_DAY_THRESHOLD - 1),
      now: NOW,
    });
    assert.equal(verdict.kind, 'below-threshold');
    if (verdict.kind === 'below-threshold') {
      assert.equal(verdict.dayCount, CHECKOUT_RATE_LIMIT_ALARM_DAY_THRESHOLD - 1);
    }
  });

  it('excludes occurrences that have aged out of both windows', () => {
    const stale = Array.from(
      { length: CHECKOUT_RATE_LIMIT_ALARM_WEEK_THRESHOLD * 2 },
      (_, i) => ({
        occurredAt: NOW - CHECKOUT_RATE_LIMIT_ALARM_WEEK_WINDOW_MS - MINUTE_MS - i * MINUTE_MS,
      }),
    );
    const verdict = classifyCheckoutRateLimitAlarm({ occurrences: stale, now: NOW });
    assert.equal(verdict.kind, 'below-threshold');
    if (verdict.kind === 'below-threshold') {
      assert.equal(verdict.dayCount, 0);
      assert.equal(verdict.weekCount, 0);
    }
  });

  it('suppresses a re-breach inside the cooldown, reporting when it reopens', () => {
    const lastAlertAt = NOW - CHECKOUT_RATE_LIMIT_ALARM_COOLDOWN_MS + MINUTE_MS;
    const occurrences = burst(CHECKOUT_RATE_LIMIT_ALARM_DAY_THRESHOLD + 3);
    occurrences[1].alertedAt = lastAlertAt;
    const verdict = classifyCheckoutRateLimitAlarm({ occurrences, now: NOW });
    assert.equal(verdict.kind, 'cooldown');
    if (verdict.kind === 'cooldown') {
      assert.equal(
        verdict.nextEligibleAt,
        lastAlertAt + CHECKOUT_RATE_LIMIT_ALARM_COOLDOWN_MS,
      );
      // The counts still describe the live breach — a suppressed signal must
      // not also lose the numbers.
      assert.ok(verdict.dayCount >= CHECKOUT_RATE_LIMIT_ALARM_DAY_THRESHOLD);
    }
  });

  it('uses the NEWEST alertedAt, not the first one it happens to see', () => {
    // Ordered newest-first, as the mutation reads them. An implementation that
    // stopped at the first stamp would read the stale one and re-page.
    const occurrences = burst(CHECKOUT_RATE_LIMIT_ALARM_DAY_THRESHOLD + 2);
    occurrences[0].alertedAt = NOW - CHECKOUT_RATE_LIMIT_ALARM_COOLDOWN_MS - MINUTE_MS;
    occurrences[3].alertedAt = NOW - MINUTE_MS;
    const verdict = classifyCheckoutRateLimitAlarm({ occurrences, now: NOW });
    assert.equal(verdict.kind, 'cooldown');
  });
});

describe('classifyCheckoutRateLimitAlarm — cannot be silent forever', () => {
  it('fires on a breach that has never alerted, whatever the timestamps', () => {
    // The classic dead-alarm bug: defaulting "last alert" to now (or to the
    // newest occurrence) puts the first breach inside its own cooldown.
    const occurrences = burst(CHECKOUT_RATE_LIMIT_ALARM_DAY_THRESHOLD);
    assert.ok(
      occurrences.every((o) => o.alertedAt === undefined),
      'fixture must carry no alert stamp or this proves nothing',
    );
    const verdict = classifyCheckoutRateLimitAlarm({ occurrences, now: NOW });
    assert.equal(verdict.kind, 'alert');
  });

  it('keeps retention strictly longer than the drift window', () => {
    // Retention equal to the window would delete rows the week count still
    // needs, shrinking weekCount at the boundary until the drift alarm could
    // never reach its threshold.
    assert.ok(
      CHECKOUT_RATE_LIMIT_EVENT_RETENTION_MS > CHECKOUT_RATE_LIMIT_ALARM_WEEK_WINDOW_MS,
      'retention must outlive the longest window the alarm measures',
    );
  });

  it('keeps the scan cap far above both thresholds', () => {
    // Truncation understates counts. That is only safe while the cap sits far
    // past the point where the alarm has already fired.
    assert.ok(
      CHECKOUT_RATE_LIMIT_ALARM_SCAN_LIMIT >= CHECKOUT_RATE_LIMIT_ALARM_WEEK_THRESHOLD * 10,
      'a scan cap near the threshold could silently suppress a real breach',
    );
  });

  it('keeps thresholds above the observed floor but reachable', () => {
    // Sized to the incident, not to a fixture: a threshold at or below the
    // steady-state rate is permanently lit, one far above it never fires.
    assert.ok(CHECKOUT_RATE_LIMIT_ALARM_DAY_THRESHOLD > 1);
    assert.ok(
      CHECKOUT_RATE_LIMIT_ALARM_WEEK_THRESHOLD > CHECKOUT_RATE_LIMIT_ALARM_DAY_THRESHOLD,
      'the drift window must tolerate more than one day of burst',
    );
    assert.ok(
      CHECKOUT_RATE_LIMIT_ALARM_WEEK_THRESHOLD <
        CHECKOUT_RATE_LIMIT_ALARM_DAY_THRESHOLD * 7,
      'a week threshold at 7x the day threshold is unreachable by sustained drift',
    );
  });
});
