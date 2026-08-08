/**
 * Tests for src/services/feed-date.ts.
 *
 * Two surfaces:
 *   - parseFeedDate: returns { date, missing } for any input shape.
 *   - effectivePubDateMs: ranking/recency helper — returns 0 for items
 *     flagged pubDateMissing so they fail freshness gates and sort last.
 *
 * Behaviour change from the legacy parseFeedDateOrNow:
 *   - Old: substituted Date.now() silently for missing/invalid input.
 *   - New: still returns a usable Date for display, but carries
 *     `missing: true` so downstream ranking can exclude it from freshness.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  parseFeedDate,
  parseFeedDateOrNow,
  effectivePubDateMs,
} from '../src/services/feed-date.ts';

describe('parseFeedDate', () => {
  it('parses a valid RFC 822 string', () => {
    const result = parseFeedDate('Mon, 12 May 2026 14:32:00 GMT');
    assert.equal(result.missing, false);
    assert.equal(result.date.toISOString(), '2026-05-12T14:32:00.000Z');
  });

  it('parses a valid ISO-8601 string', () => {
    const result = parseFeedDate('2026-05-12T14:32:00Z');
    assert.equal(result.missing, false);
    assert.equal(result.date.toISOString(), '2026-05-12T14:32:00.000Z');
  });

  it('flags null as missing', () => {
    const result = parseFeedDate(null);
    assert.equal(result.missing, true);
    assert.ok(result.date instanceof Date);
    assert.ok(!Number.isNaN(result.date.getTime()));
  });

  it('flags undefined as missing', () => {
    const result = parseFeedDate(undefined);
    assert.equal(result.missing, true);
    assert.ok(result.date instanceof Date);
  });

  it('flags empty string as missing', () => {
    const result = parseFeedDate('');
    assert.equal(result.missing, true);
  });

  it('flags an unparseable string as missing', () => {
    const result = parseFeedDate('garbage that is not a date');
    assert.equal(result.missing, true);
  });

  it('flags an out-of-range date string as missing', () => {
    // "32 May 2026" — Date constructor returns Invalid Date.
    const result = parseFeedDate('32 May 2026');
    assert.equal(result.missing, true);
  });

  it('legacy parseFeedDateOrNow still returns a Date (back-compat)', () => {
    assert.ok(parseFeedDateOrNow('garbage') instanceof Date);
    assert.ok(parseFeedDateOrNow(null) instanceof Date);
    assert.ok(parseFeedDateOrNow('2026-05-12T00:00:00Z') instanceof Date);
  });
});

describe('effectivePubDateMs', () => {
  it('returns getTime() for Date pubDate without missing flag', () => {
    const ts = new Date('2026-05-12T00:00:00Z').getTime();
    assert.equal(
      effectivePubDateMs({ pubDate: new Date(ts), pubDateMissing: false }),
      ts,
    );
  });

  it('returns getTime() when pubDateMissing is undefined (non-RSS items)', () => {
    const ts = new Date('2026-05-12T00:00:00Z').getTime();
    assert.equal(effectivePubDateMs({ pubDate: new Date(ts) }), ts);
  });

  it('returns 0 when pubDateMissing is true', () => {
    const realTs = new Date('2026-05-12T00:00:00Z').getTime();
    assert.equal(
      effectivePubDateMs({ pubDate: new Date(realTs), pubDateMissing: true }),
      0,
    );
  });

  it('accepts a numeric pubDate (cache-deserialized shape)', () => {
    const ts = new Date('2026-05-12T00:00:00Z').getTime();
    assert.equal(effectivePubDateMs({ pubDate: ts }), ts);
  });

  it('accepts a string pubDate (legacy serialized shape)', () => {
    assert.equal(
      effectivePubDateMs({ pubDate: '2026-05-12T00:00:00Z' }),
      new Date('2026-05-12T00:00:00Z').getTime(),
    );
  });

  it('returns 0 for unparseable string pubDate', () => {
    assert.equal(effectivePubDateMs({ pubDate: 'not a date' }), 0);
  });

  it('returns 0 for NaN numeric pubDate', () => {
    assert.equal(effectivePubDateMs({ pubDate: NaN }), 0);
  });

  it('returns 0 for Infinity numeric pubDate', () => {
    assert.equal(effectivePubDateMs({ pubDate: Infinity }), 0);
    assert.equal(effectivePubDateMs({ pubDate: -Infinity }), 0);
  });

  it('returns 0 for an Invalid Date instance', () => {
    assert.equal(effectivePubDateMs({ pubDate: new Date('not a date') }), 0);
  });

  describe('ranking behavior', () => {
    it('sorts missing-date items LAST in newest-first descending sort', () => {
      const items = [
        { pubDate: new Date('2026-05-10T00:00:00Z'), pubDateMissing: false },
        { pubDate: new Date('2026-05-12T00:00:00Z'), pubDateMissing: true },
        { pubDate: new Date('2026-05-11T00:00:00Z'), pubDateMissing: false },
      ];
      items.sort((a, b) => effectivePubDateMs(b) - effectivePubDateMs(a));
      // First should be the latest REAL date (2026-05-11), then 2026-05-10,
      // then the missing-date item even though its synthesized stamp is the
      // newest of the three.
      assert.equal(items[0]!.pubDate.toISOString(), '2026-05-11T00:00:00.000Z');
      assert.equal(items[1]!.pubDate.toISOString(), '2026-05-10T00:00:00.000Z');
      assert.equal(items[2]!.pubDateMissing, true);
    });

    it('excludes missing-date items from positive-duration recency gates', () => {
      const now = Date.now();
      const recentWindow = 15 * 60 * 1000;
      const fresh = { pubDate: new Date(now - 5 * 60 * 1000), pubDateMissing: false };
      const stale = { pubDate: new Date(now - 60 * 60 * 1000), pubDateMissing: false };
      const missing = { pubDate: new Date(now), pubDateMissing: true };
      const isRecent = (item: any) => now - effectivePubDateMs(item) < recentWindow;
      assert.equal(isRecent(fresh), true);
      assert.equal(isRecent(stale), false);
      assert.equal(
        isRecent(missing),
        false,
        'missing-date item must not claim freshness even though synthesized stamp is now',
      );
    });
  });
});
