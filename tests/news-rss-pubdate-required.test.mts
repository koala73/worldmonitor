// U2 from docs/plans/2026-04-26-001-fix-brief-static-page-contamination-plan.md
//
// Two-step gate on RSS/Atom date metadata:
//   1. Expand the recognized date-tag set to include Dublin Core (`<dc:date>`,
//      `<dc:Date.Issued>`) alongside `<pubDate>` (RSS), `<published>`, and
//      `<updated>` (Atom). Without this expansion, a strict drop would silently
//      zero ArXiv-class feeds.
//   2. After exhausting every recognized tag, drop items where every tag is
//      empty/unparseable, or where the parsed date is > 1h in the future
//      (clock skew / malformed). Replaces the prior `Date.now()` fabrication
//      that let static institutional pages reach the brief.
//
// Per-feed stats (`parsedTotal`, `droppedUndated`) are surfaced so the caller
// can classify feedStatus = 'all-undated' (every item dropped, silent-zeroing
// signal) vs 'partial-undated' (informational).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { __testing__ } from '../server/worldmonitor/news/v1/list-feed-digest';
import { normalizeFeedDateZone } from '../shared/feed-date-zone.js';

const { parseRssXml, extractFirstDateTag, FUTURE_DATE_TOLERANCE_MS } = __testing__;

const FEED = { url: 'https://example.com/rss', name: 'Example', lang: 'en' } as const;

function wrapRss(items: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>${items}</channel></rss>`;
}

function wrapAtom(entries: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">${entries}</feed>`;
}

const RECENT_ISO = new Date(Date.now() - 60 * 60 * 1000).toISOString();

describe('extractFirstDateTag — priority list', () => {
  it('RSS prefers <pubDate> when both <pubDate> and <dc:date> are present', () => {
    const block = `<pubDate>Mon, 26 Apr 2026 10:00:00 GMT</pubDate><dc:date>2026-04-25T00:00:00Z</dc:date>`;
    assert.equal(extractFirstDateTag(block, false), 'Mon, 26 Apr 2026 10:00:00 GMT');
  });

  it('RSS falls back to <dc:date> when <pubDate> is absent', () => {
    const block = `<dc:date>2026-04-26T10:00:00Z</dc:date>`;
    assert.equal(extractFirstDateTag(block, false), '2026-04-26T10:00:00Z');
  });

  it('RSS falls back to <dc:Date.Issued> when only that tag is present', () => {
    const block = `<dc:Date.Issued>2026-04-26</dc:Date.Issued>`;
    assert.equal(extractFirstDateTag(block, false), '2026-04-26');
  });

  it('Atom prefers <published> when both <published> and <updated> are present', () => {
    const block = `<published>2026-04-26T10:00:00Z</published><updated>2026-04-26T12:00:00Z</updated>`;
    assert.equal(extractFirstDateTag(block, true), '2026-04-26T10:00:00Z');
  });

  it('Atom falls back to <dc:date> when neither <published> nor <updated> is present', () => {
    const block = `<dc:date>2026-04-26T10:00:00Z</dc:date>`;
    assert.equal(extractFirstDateTag(block, true), '2026-04-26T10:00:00Z');
  });

  it('returns empty string when no recognized date tag is present', () => {
    const block = `<title>Some title</title><link>https://example.com</link>`;
    assert.equal(extractFirstDateTag(block, false), '');
    assert.equal(extractFirstDateTag(block, true), '');
  });
});

describe('parseRssXml — date-required gate (R2)', () => {
  it('keeps an RSS item with valid <pubDate>', () => {
    const xml = wrapRss(`
      <item>
        <title>Hormuz reopened</title>
        <link>https://example.com/a</link>
        <pubDate>${RECENT_ISO}</pubDate>
      </item>
    `);
    const result = parseRssXml(xml, FEED, 'full');
    assert.ok(result, 'parseRssXml returned null');
    assert.equal(result!.items.length, 1);
    assert.equal(result!.parsedTotal, 1);
    assert.equal(result!.droppedUndated, 0);
  });

  it('keeps an RSS item with <dc:date> when <pubDate> is absent (ArXiv-class feed)', () => {
    const xml = wrapRss(`
      <item>
        <title>New paper on attention</title>
        <link>https://arxiv.org/abs/0001</link>
        <dc:date>${RECENT_ISO}</dc:date>
      </item>
    `);
    const result = parseRssXml(xml, FEED, 'full');
    assert.ok(result, 'parseRssXml returned null');
    assert.equal(result!.items.length, 1);
    assert.equal(result!.droppedUndated, 0);
  });

  it('drops an item with empty <pubDate></pubDate> and no fallback tag', () => {
    const xml = wrapRss(`
      <item>
        <title>About Section 508</title>
        <link>https://defense.gov/About/Section-508/</link>
        <pubDate></pubDate>
      </item>
    `);
    const result = parseRssXml(xml, FEED, 'full');
    // Returns the struct (not null) so 'all-undated' classification in
    // buildDigest's caller can see the dropped count survive the cache.
    assert.ok(result);
    assert.equal(result!.items.length, 0);
    assert.equal(result!.parsedTotal, 1);
    assert.equal(result!.droppedUndated, 1);
  });

  it('drops an item with NO recognized date element at all', () => {
    const xml = wrapRss(`
      <item>
        <title>Acquisition Transformation Strategy</title>
        <link>https://defense.gov/Acquisition-Transformation-Strategy/</link>
      </item>
    `);
    const result = parseRssXml(xml, FEED, 'full');
    assert.ok(result);
    assert.equal(result!.items.length, 0);
    assert.equal(result!.parsedTotal, 1);
    assert.equal(result!.droppedUndated, 1);
  });

  it('drops an Atom entry with no <published>, <updated>, or <dc:date>', () => {
    const xml = wrapAtom(`
      <entry>
        <title>5G Ecosystem Report</title>
        <link href="https://defense.gov/5g-ecosystem"/>
      </entry>
    `);
    const result = parseRssXml(xml, FEED, 'full');
    assert.ok(result);
    assert.equal(result!.items.length, 0);
    assert.equal(result!.parsedTotal, 1);
    assert.equal(result!.droppedUndated, 1);
  });

  it('drops an item with malformed <pubDate> (NaN guard)', () => {
    const xml = wrapRss(`
      <item>
        <title>Title</title>
        <link>https://example.com/a</link>
        <pubDate>foo bar baz</pubDate>
      </item>
    `);
    const result = parseRssXml(xml, FEED, 'full');
    assert.ok(result);
    assert.equal(result!.items.length, 0);
    assert.equal(result!.droppedUndated, 1);
  });

  it('drops an item dated > 1h in the future (clock-skew defense)', () => {
    const future = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const xml = wrapRss(`
      <item>
        <title>Future title</title>
        <link>https://example.com/a</link>
        <pubDate>${future}</pubDate>
      </item>
    `);
    const result = parseRssXml(xml, FEED, 'full');
    assert.ok(result);
    assert.equal(result!.items.length, 0);
    assert.equal(result!.droppedUndated, 1);
  });

  it('keeps an item dated within the future tolerance window', () => {
    const justAhead = new Date(Date.now() + (FUTURE_DATE_TOLERANCE_MS - 60_000)).toISOString();
    const xml = wrapRss(`
      <item>
        <title>Edge title</title>
        <link>https://example.com/a</link>
        <pubDate>${justAhead}</pubDate>
      </item>
    `);
    const result = parseRssXml(xml, FEED, 'full');
    assert.ok(result, 'parseRssXml returned null at the boundary');
    assert.equal(result!.items.length, 1);
  });
});

describe('parseRssXml — partial-feed preservation (R8)', () => {
  it('a feed with one dated and one undated item keeps the dated half and counts the drop', () => {
    const xml = wrapRss(`
      <item>
        <title>Real news</title>
        <link>https://example.com/a</link>
        <pubDate>${RECENT_ISO}</pubDate>
      </item>
      <item>
        <title>Static page</title>
        <link>https://example.com/about</link>
      </item>
    `);
    const result = parseRssXml(xml, FEED, 'full');
    assert.ok(result, 'parseRssXml returned null');
    assert.equal(result!.items.length, 1);
    assert.equal(result!.parsedTotal, 2);
    assert.equal(result!.droppedUndated, 1);
    assert.equal(result!.items[0]!.title, 'Real news');
  });

  it('a feed where 100% of items have no date returns the struct with full stats (all-undated signal survives the cache)', () => {
    // Critical for the 'all-undated' classification in buildDigest's caller:
    // when every parsed item is dropped, parseRssXml MUST return the struct
    // with parsedTotal>0, items=[], droppedUndated>0 — not null. Returning
    // null here would let `fetchAndParseRss`'s `cached ?? {all-zero stats}`
    // fallback erase the dropped count, making 'all-undated' classification
    // unreachable downstream and silently zeroing detection on dialect
    // regressions. (Caught by reviewer of PR #3417 first-day landing.)
    const xml = wrapRss(`
      <item><title>A</title><link>https://example.com/a</link></item>
      <item><title>B</title><link>https://example.com/b</link></item>
      <item><title>C</title><link>https://example.com/c</link></item>
    `);
    const result = parseRssXml(xml, FEED, 'full');
    assert.ok(result, 'parseRssXml must NOT return null for fully-dropped feeds — stats need to survive the cache');
    assert.equal(result!.items.length, 0);
    assert.equal(result!.parsedTotal, 3);
    assert.equal(result!.droppedUndated, 3);
  });

  it('a feed with no parseable items (no <item> or <entry>) returns null for negative-cache short-TTL retry', () => {
    // parsedTotal === 0 means the XML body had no recognizable items at all
    // — genuinely empty channel, malformed response, or a Cloudflare/block
    // page that doesn't match the item regexes. parseRssXml MUST return
    // null here so cachedFetchJson writes NEG_SENTINEL with 120s TTL,
    // letting the feed retry quickly instead of being pinned empty for the
    // full 3600s positive-cache TTL. (Caught by reviewer of PR #3417 second
    // review pass.) Distinct from the all-undated case (parsedTotal>0,
    // items=[], droppedUndated>0) which DOES return the struct so the
    // silent-zeroing detection signal survives.
    const xml = wrapRss(``);
    const result = parseRssXml(xml, FEED, 'full');
    assert.equal(result, null);
  });

  it('a malformed/block-page response (no recognizable items) returns null', () => {
    // Cloudflare-style interstitial. No <item> or <entry> blocks → null →
    // short-TTL negative cache → fast retry on next poll.
    const xml = '<html><body>Access denied. Please complete the challenge.</body></html>';
    const result = parseRssXml(xml, FEED, 'full');
    assert.equal(result, null);
  });
});

describe('parseRssXml — named zone abbreviations', () => {
  // Bild ships `Wed, 28 Oct 2026 10:29:20 CET`; Date returns Invalid Date for
  // CET, so every Bild item used to count as undated and drop.
  function zoned(ms: number, zone: string, offsetHours: number): string {
    return new Date(ms + offsetHours * 3600_000).toUTCString().replace('GMT', zone);
  }
  const at = Math.floor((Date.now() - 2 * 3600_000) / 1000) * 1000;

  for (const [zone, offset] of [['CET', 1], ['CEST', 2], ['AEDT', 11], ['JST', 9], ['MSK', 3]] as const) {
    it(`keeps an item dated in ${zone} at its true instant`, () => {
      const xml = wrapRss(`
        <item>
          <title>Bundestag vote</title>
          <link>https://example.com/a</link>
          <pubDate>${zoned(at, zone, offset)}</pubDate>
        </item>
      `);
      const result = parseRssXml(xml, FEED, 'full');
      assert.ok(result, 'parseRssXml returned null');
      assert.equal(result!.droppedUndated, 0);
      assert.equal(result!.items[0]?.publishedAt, at);
    });
  }

  // The date shapes the feeds migrated in U6 batch 1 actually publish, copied
  // from live responses (2026-10-28). Each must parse to its stated instant.
  for (const [feed, raw, iso] of [
    ['Bild', 'Wed, 28 Oct 2026 10:29:20 CET', '2026-10-28T09:29:20.000Z'],
    ['Folha de S.Paulo', '28 Oct 2026 06:00:00 -0300', '2026-10-28T09:00:00.000Z'],
    ['Die Zeit', 'Wed, 28 Oct 2026 09:30:06 -0000', '2026-10-28T09:30:06.000Z'],
    ['Tuoi Tre News', 'Wed, 28 Oct 2026 16:25:00 GMT+7', '2026-10-28T09:25:00.000Z'],
    ['El Tiempo', 'Wed, 28 Oct 2026 04:17:02 -0500', '2026-10-28T09:17:02.000Z'],
    ['RAND', '2026-10-27T19:07:07Z', '2026-10-27T19:07:07.000Z'],
    ['Google News', 'Wed, 28 Oct 2026 08:47:25 GMT', '2026-10-28T08:47:25.000Z'],
    // Zone-less shapes, read as UTC (the full-edition sweep found every item
    // of both feeds dropped as undated).
    ['IAEA', '\n26-10-28  14:21\n', '2026-10-28T14:21:00.000Z'],
    ['CrisisWatch', 'Friday, October 23, 2026 - 18:13', '2026-10-23T18:13:00.000Z'],
  ] as const) {
    it(`parses ${feed}'s published date format (${raw})`, () => {
      const xml = wrapRss(`
        <item>
          <title>Headline</title>
          <link>https://example.com/a</link>
          <pubDate>${raw}</pubDate>
        </item>
      `);
      const result = parseRssXml(xml, FEED, 'full');
      assert.equal(result!.droppedUndated, 0);
      assert.equal(new Date(result!.items[0]!.publishedAt).toISOString(), iso);
    });
  }

  // A two-digit date is year-first only when its first number cannot be a
  // month, as in IAEA's `26-10-28`. Month-first `10-28-26` is left for Date,
  // which reads it as 28 October 2026.
  it('rewrites a year-first two-digit date but leaves a month-first one alone', () => {
    assert.equal(normalizeFeedDateZone('26-10-28  14:21'), '2026-10-28T14:21:00Z');
    for (const raw of ['10-28-26 14:21', '03-04-26 10:00', '12-01-26 09:15']) {
      assert.equal(normalizeFeedDateZone(raw), raw);
    }
  });

  // IST: India, Ireland or Israel. BST: British Summer (+1) or Bangladesh
  // Standard (+6) Time; a Dhaka feed read as +1 would be five hours off.
  // Twelve hours old, so a wrong offset would still land in the past and be
  // kept rather than caught by the future-date gate.
  const older = at - 10 * 3600_000;
  for (const [zone, offset] of [['IST', 5.5], ['BST', 6]] as const) {
    it(`still drops an item in an ambiguous zone (${zone})`, () => {
      const xml = wrapRss(`
        <item>
          <title>Ambiguous</title>
          <link>https://example.com/a</link>
          <pubDate>${zoned(older, zone, offset)}</pubDate>
        </item>
      `);
      const result = parseRssXml(xml, FEED, 'full');
      assert.equal(result!.droppedUndated, 1);
    });
  }
});
