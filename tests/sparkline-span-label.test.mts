import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sparklineSpanLabel } from '../src/utils/sparkline-span.ts';

const HOUR = 3_600_000;
const since = (when: string) => `since ${when}`;
const opts = (now: number) => ({ now, locale: 'en-US', since });
const points = (n: number) => Array.from({ length: n }, (_, i) => 64 + (i % 3) * 0.01);

describe('sparklineSpanLabel (#10424)', () => {
  it('names the start of a series that holds fewer than 24 trading hours', () => {
    // 276 bars of the 23-hour previous session plus 6 from the new one.
    const startAt = Date.UTC(2026, 10, 8, 23, 0);
    const now = Date.UTC(2026, 10, 9, 23, 31);
    const label = sparklineSpanLabel(
      { sparkline: points(282), sparklineIntervalSeconds: 300, sparklineStartAt: startAt },
      opts(now),
    );
    assert.equal(label, 'since Sun 23:00 UTC');
  });

  it('says 24h for a full trading day that ends now', () => {
    const now = Date.UTC(2026, 10, 10, 18, 44);
    const fx = { sparkline: points(288), sparklineIntervalSeconds: 300, sparklineStartAt: now - 24 * HOUR };
    assert.equal(sparklineSpanLabel(fx, opts(now)), '24h');
    // A 23-hour contract needs 25 wall-clock hours for 288 traded bars.
    const brent = { ...fx, sparklineStartAt: now - 25 * HOUR - 10 * 60_000 };
    assert.equal(sparklineSpanLabel(brent, opts(now)), '24h');
  });

  it('keeps saying 24h in the first hour after a weekday reopen, when 288 bars span two daily breaks', () => {
    // Sessions Mon 23:00-Tue 22:00 and Tue 23:00 onward. One new bar after the
    // reopen: the other 287 reach back past Monday's and Tuesday's breaks.
    const now = Date.UTC(2026, 10, 10, 23, 6);
    const startAt = Date.UTC(2026, 10, 9, 21, 5);
    const label = sparklineSpanLabel(
      { sparkline: points(288), sparklineIntervalSeconds: 300, sparklineStartAt: startAt },
      opts(now),
    );
    assert.equal(label, '24h');
  });

  it('names the start when 24 trading hours stretch across a weekend', () => {
    const now = Date.UTC(2026, 10, 8, 23, 35); // Sunday, 35 minutes after the reopen
    const startAt = Date.UTC(2026, 10, 6, 0, 30); // Friday 00:30 UTC
    const label = sparklineSpanLabel(
      { sparkline: points(288), sparklineIntervalSeconds: 300, sparklineStartAt: startAt },
      opts(now),
    );
    assert.equal(label, 'since Fri 00:30 UTC');
  });

  it('names the start of a short series even when it began less than a day ago', () => {
    const now = Date.UTC(2026, 10, 10, 18, 44);
    const label = sparklineSpanLabel(
      { sparkline: points(36), sparklineIntervalSeconds: 300, sparklineStartAt: Date.UTC(2026, 10, 10, 8, 5) },
      opts(now),
    );
    assert.equal(label, 'since Tue 08:05 UTC');
  });

  it('dates a daily-close series by its first day', () => {
    const label = sparklineSpanLabel(
      { sparkline: points(30), sparklineIntervalSeconds: 86_400, sparklineStartAt: Date.UTC(2026, 9, 13) },
      opts(Date.UTC(2026, 10, 10)),
    );
    assert.equal(label, 'since Oct 13');
  });

  it('returns no label when the span is unknown or nothing is drawn', () => {
    const now = Date.UTC(2026, 10, 10);
    assert.equal(sparklineSpanLabel({ sparkline: points(50) }, opts(now)), '');
    assert.equal(sparklineSpanLabel({ sparkline: points(50), sparklineIntervalSeconds: 300 }, opts(now)), '');
    assert.equal(sparklineSpanLabel({ sparkline: points(50), sparklineIntervalSeconds: 0, sparklineStartAt: now }, opts(now)), '');
    assert.equal(sparklineSpanLabel({ sparkline: points(1), sparklineIntervalSeconds: 300, sparklineStartAt: now }, opts(now)), '');
    assert.equal(sparklineSpanLabel({ sparklineIntervalSeconds: 300, sparklineStartAt: now }, opts(now)), '');
    assert.equal(sparklineSpanLabel({ sparkline: points(50), sparklineIntervalSeconds: 300, sparklineStartAt: Number.NaN }, opts(now)), '');
  });

  it('formats the start in the reader locale, always in UTC', () => {
    const label = sparklineSpanLabel(
      { sparkline: points(10), sparklineIntervalSeconds: 300, sparklineStartAt: Date.UTC(2026, 10, 8, 23, 0) },
      { now: Date.UTC(2026, 10, 9, 0, 0), locale: 'de', since: (when) => `seit ${when}` },
    );
    assert.equal(label, 'seit So., 23:00 UTC');
  });
});
