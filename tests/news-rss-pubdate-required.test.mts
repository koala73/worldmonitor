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
