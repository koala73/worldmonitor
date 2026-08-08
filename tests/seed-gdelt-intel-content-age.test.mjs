// Regression test for issue #5858 defect 2: a future-dated topic stamp was
// trusted by the content-age health path.
//
// scripts/seed-gdelt-intel.mjs had two readers of the same stored topic stamps
// and only one of them clamped forward skew. rankTopicsForFetch took the run
// clock and did `Math.min(parsed, nowMs)`; contentMeta accepted any finite
// positive parse. `maxContentAgeMin: 1440` is evaluated against contentMeta's
// `newestItemAt`, so the unclamped reader was the one feeding the alarm.
//
// The practical effect is bounded but real: api/health.js:1009 already treats a
// negative content age as STALE, so a wildly future stamp surfaces rather than
// hides. What it buys is the window between the skew and wall clock catching
// up — during which the cohort reads fresh — plus a `newestItemAt` on the wire
// that an operator cannot reconcile with the fetch ordering's view of the very
// same stamp.
//
// Both paths now share parseStampMs, so that divergence cannot reopen.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  contentMeta,
  parseStampMs,
  rankTopicsForFetch,
} from '../scripts/seed-gdelt-intel.mjs';

const NOW = Date.parse('2026-07-30T12:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();

function topic(id, { fetchedAt, articles = 1, attemptedAt } = {}) {
  return {
    id,
    fetchedAt: fetchedAt === undefined ? iso(NOW) : fetchedAt,
    ...(attemptedAt === undefined ? {} : { attemptedAt }),
    articles: Array.from({ length: articles }, (_, i) => ({ url: `https://example.test/${id}/${i}` })),
  };
}

describe('parseStampMs', () => {
  it('clamps a forward-skewed stamp to the run clock', () => {
    assert.equal(parseStampMs(iso(NOW + 45 * MINUTE), NOW), NOW);
    assert.equal(parseStampMs(iso(NOW + 365 * DAY), NOW), NOW);
  });

  it('leaves a past stamp exactly where it is', () => {
    assert.equal(parseStampMs(iso(NOW - 3 * HOUR), NOW), NOW - 3 * HOUR);
    assert.equal(parseStampMs(iso(NOW), NOW), NOW);
  });

  it('returns null for anything unusable', () => {
    assert.equal(parseStampMs(undefined, NOW), null);
    assert.equal(parseStampMs('not-a-date', NOW), null);
    assert.equal(parseStampMs('1970-01-01T00:00:00.000Z', NOW), null);
    assert.equal(parseStampMs(iso(-DAY), NOW), null);
  });

  it('skips the clamp when the run clock is unusable', () => {
    // rankTopicsForFetch is called with an injected clock in tests and with
    // Date.now() in production; a non-finite value must degrade to the raw
    // parse rather than swallowing every stamp.
    assert.equal(parseStampMs(iso(NOW + HOUR), Number.NaN), NOW + HOUR);
    assert.equal(parseStampMs(iso(NOW + HOUR), undefined), NOW + HOUR);
  });
});

describe('contentMeta', () => {
  it('reports the freshest and most starved article-carrying topics', () => {
    const meta = contentMeta({
      topics: [
        topic('military', { fetchedAt: iso(NOW - 5 * HOUR) }),
        topic('cyber', { fetchedAt: iso(NOW - 18 * DAY) }),
        topic('energy', { fetchedAt: iso(NOW - 29 * DAY) }),
      ],
    }, NOW);

    assert.deepEqual(meta, { newestItemAt: NOW - 5 * HOUR, oldestItemAt: NOW - 29 * DAY });
  });

  it('refuses to let a forward-skewed stamp read fresher than the run clock', () => {
    const meta = contentMeta({
      topics: [
        topic('military', { fetchedAt: iso(NOW + 6 * HOUR) }),
        topic('cyber', { fetchedAt: iso(NOW - 18 * DAY) }),
      ],
    }, NOW);

    assert.equal(meta.newestItemAt, NOW, 'a skewed stamp must clamp to the run clock, not pin the alarm ahead of it');
    assert.ok(meta.newestItemAt <= NOW);
    assert.equal(meta.oldestItemAt, NOW - 18 * DAY, 'clamping the newest must not disturb the starved end');
  });

  it('clamps the starved end too when every stamp is skewed', () => {
    const meta = contentMeta({
      topics: [
        topic('military', { fetchedAt: iso(NOW + 2 * HOUR) }),
        topic('cyber', { fetchedAt: iso(NOW + 6 * HOUR) }),
      ],
    }, NOW);

    assert.deepEqual(meta, { newestItemAt: NOW, oldestItemAt: NOW });
  });

  it('ignores articleless topics', () => {
    // An articleless topic keeps fetchedAt=now as an empty-topic placeholder;
    // counting it would hold newestItemAt fresh in exactly the total-death case.
    const meta = contentMeta({
      topics: [
        topic('military', { fetchedAt: iso(NOW), articles: 0 }),
        topic('cyber', { fetchedAt: iso(NOW - 18 * DAY) }),
      ],
    }, NOW);

    assert.deepEqual(meta, { newestItemAt: NOW - 18 * DAY, oldestItemAt: NOW - 18 * DAY });
  });

  it('drops unusable stamps rather than reading them as the epoch', () => {
    const meta = contentMeta({
      topics: [
        topic('military', { fetchedAt: 'not-a-date' }),
        topic('cyber', { fetchedAt: iso(NOW - 2 * HOUR) }),
      ],
    }, NOW);

    assert.deepEqual(meta, { newestItemAt: NOW - 2 * HOUR, oldestItemAt: NOW - 2 * HOUR });
  });

  it('returns null when nothing carries a usable stamp', () => {
    assert.equal(contentMeta({ topics: [] }, NOW), null);
    assert.equal(contentMeta({ topics: [topic('military', { articles: 0 })] }, NOW), null);
    assert.equal(contentMeta({ topics: [topic('military', { fetchedAt: 'nope' })] }, NOW), null);
    assert.equal(contentMeta(null, NOW), null);
  });

  it('defaults to the wall clock when no run clock is supplied', () => {
    // runSeed invokes contentMeta(data) with one argument.
    const meta = contentMeta({ topics: [topic('military', { fetchedAt: iso(Date.now() + HOUR) })] });
    assert.ok(meta.newestItemAt <= Date.now() + 1_000);
  });
});

describe('the two stamp readers agree', () => {
  it('resolves one skewed fetchedAt to the same instant on both paths', () => {
    const previous = { topics: [topic('military', { fetchedAt: iso(NOW + 6 * HOUR), attemptedAt: iso(NOW - HOUR) })] };
    const ranked = rankTopicsForFetch([{ id: 'military' }], previous, NOW);
    const meta = contentMeta(previous, NOW);

    assert.equal(ranked[0].fetchedAtMs, meta.newestItemAt);
    assert.equal(ranked[0].fetchedAtMs, NOW);
  });

  it('keeps the fetch ordering unchanged for ordinary past stamps', () => {
    const previous = {
      topics: [
        topic('military', { fetchedAt: iso(NOW - HOUR), attemptedAt: iso(NOW - HOUR) }),
        topic('cyber', { fetchedAt: iso(NOW - 18 * DAY), attemptedAt: iso(NOW - 18 * DAY) }),
      ],
    };
    const ranked = rankTopicsForFetch([{ id: 'military' }, { id: 'cyber' }], previous, NOW);

    assert.deepEqual(ranked.map((entry) => entry.topic.id), ['cyber', 'military']);
    assert.equal(ranked[0].fetchedAtMs, NOW - 18 * DAY);
  });
});
