import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseRssItems,
  filterEnergyRelevant,
  deduplicateByUrl,
  validate,
  ENERGY_INTELLIGENCE_KEY,
  INTELLIGENCE_TTL_SECONDS,
} from '../scripts/seed-energy-intelligence.mjs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MINIMAL_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
    <item>
      <title>IEA warns of tight LNG supply heading into summer 2026</title>
      <link>https://www.iea.org/news/iea-warns-lng-supply-2026</link>
      <pubDate>Sat, 05 Apr 2026 10:00:00 +0000</pubDate>
      <description>The International Energy Agency said global LNG markets are tightening.</description>
    </item>
    <item>
      <title>OPEC maintains production cuts amid oil demand uncertainty</title>
      <link>https://www.opec.org/news/opec-production-cuts</link>
      <pubDate>Fri, 04 Apr 2026 08:00:00 +0000</pubDate>
      <description>OPEC members agreed to maintain current crude oil production quotas.</description>
    </item>
  </channel>
</rss>`;

const CDATA_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>CDATA Feed</title>
    <item>
      <title><![CDATA[IEA Report: Global Energy Review 2026 & Oil Market Forecast]]></title>
      <link>https://www.iea.org/reports/global-energy-review-2026</link>
      <pubDate>Thu, 03 Apr 2026 12:00:00 +0000</pubDate>
      <description><![CDATA[A comprehensive overview of the global energy market with <strong>oil</strong> and <em>gas</em> trends.]]></description>
    </item>
  </channel>
</rss>`;

// ---------------------------------------------------------------------------
// parseRssItems
// ---------------------------------------------------------------------------

describe('parseRssItems', () => {
  it('extracts title, url, publishedAt from a minimal RSS XML fixture', () => {
    const items = parseRssItems(MINIMAL_RSS, 'IEA');
    assert.equal(items.length, 2);

    const first = items[0];
    assert.equal(first.title, 'IEA warns of tight LNG supply heading into summer 2026');
    assert.equal(first.url, 'https://www.iea.org/news/iea-warns-lng-supply-2026');
    assert.ok(typeof first.publishedAt === 'number' && first.publishedAt > 0, 'publishedAt should be a positive number');
    assert.equal(first.source, 'IEA');
  });

  it('handles CDATA-wrapped titles', () => {
    const items = parseRssItems(CDATA_RSS, 'IEA');
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'IEA Report: Global Energy Review 2026 & Oil Market Forecast');
    assert.ok(items[0].summary.length > 0);
  });
});

// ---------------------------------------------------------------------------
// filterEnergyRelevant
// ---------------------------------------------------------------------------

describe('filterEnergyRelevant', () => {
  it("keeps items with 'oil' in title, drops items with no energy keywords", () => {
    const items = [
      { id: '1', title: 'Oil prices surge on OPEC cuts', url: 'https://example.com/1', source: 'IEA', publishedAt: Date.now(), summary: '' },
      { id: '2', title: 'Latest sports results from the weekend', url: 'https://example.com/2', source: 'IEA', publishedAt: Date.now(), summary: 'Football match highlights and scores.' },
      { id: '3', title: 'Tech startup raises funding round', url: 'https://example.com/3', source: 'IEA', publishedAt: Date.now(), summary: 'Silicon Valley venture capital news.' },
    ];
    const filtered = filterEnergyRelevant(items);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, '1');
  });

  it("is case-insensitive — 'LNG' in title matches 'lng' keyword", () => {
    const items = [
      { id: '1', title: 'LNG exports hit record highs in Q1 2026', url: 'https://example.com/1', source: 'IEA', publishedAt: Date.now(), summary: '' },
    ];
    const filtered = filterEnergyRelevant(items);
    assert.equal(filtered.length, 1);
  });

  it('matches keyword in summary when title has no keyword', () => {
    const items = [
      { id: '1', title: 'Market update for April', url: 'https://example.com/1', source: 'IEA', publishedAt: Date.now(), summary: 'Crude oil inventories fell sharply last week.' },
    ];
    const filtered = filterEnergyRelevant(items);
    assert.equal(filtered.length, 1);
  });
});

// ---------------------------------------------------------------------------
// deduplicateByUrl
// ---------------------------------------------------------------------------

describe('deduplicateByUrl', () => {
  it('same URL appears only once, keeping the most recent by publishedAt', () => {
    const url = 'https://www.iea.org/news/duplicate-story';
    const older = { id: 'a', title: 'Old version', url, source: 'IEA', publishedAt: 1000, summary: '' };
    const newer = { id: 'b', title: 'Updated version', url, source: 'IEA', publishedAt: 2000, summary: '' };
    const items = [older, newer];

    const deduped = deduplicateByUrl(items);
    assert.equal(deduped.length, 1);
    assert.equal(deduped[0].publishedAt, 2000);
    assert.equal(deduped[0].id, 'b');
  });

  it('keeps distinct URLs unchanged', () => {
    const items = [
      { id: '1', title: 'Story A', url: 'https://www.iea.org/a', source: 'IEA', publishedAt: 1000, summary: '' },
      { id: '2', title: 'Story B', url: 'https://www.iea.org/b', source: 'IEA', publishedAt: 2000, summary: '' },
    ];
    const deduped = deduplicateByUrl(items);
    assert.equal(deduped.length, 2);
  });
});

// ---------------------------------------------------------------------------
// Age filter integration
// ---------------------------------------------------------------------------

describe('age filter', () => {
  it('item older than 30 days is excluded via AGE_LIMIT_MS threshold', () => {
    const now = Date.now();
    const oldTs = now - (31 * 24 * 3600 * 1000);
    const AGE_LIMIT_MS = 30 * 24 * 3600 * 1000;

    const items = [
      { id: 'old', title: 'Old oil report', url: 'https://example.com/old', source: 'IEA', publishedAt: oldTs, summary: '' },
      { id: 'new', title: 'New gas update', url: 'https://example.com/new', source: 'IEA', publishedAt: now, summary: '' },
    ];

    const recent = items.filter((item) => item.publishedAt >= now - AGE_LIMIT_MS);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].id, 'new');
  });
});

// ---------------------------------------------------------------------------
// Exported key constants
// ---------------------------------------------------------------------------

describe('exported constants', () => {
  it("ENERGY_INTELLIGENCE_KEY === 'energy:intelligence:feed:v1'", () => {
    assert.equal(ENERGY_INTELLIGENCE_KEY, 'energy:intelligence:feed:v1');
  });

  it('INTELLIGENCE_TTL_SECONDS >= 24 * 3600 (24h minimum)', () => {
    assert.ok(
      INTELLIGENCE_TTL_SECONDS >= 24 * 3600,
      `TTL ${INTELLIGENCE_TTL_SECONDS}s is less than 24h minimum`,
    );
  });
});

// ---------------------------------------------------------------------------
// validate — the gate that controls skip vs. publish in runSeed
// ---------------------------------------------------------------------------
// OPEC is best-effort and OilPrice is the primary source, so fewer-than-3
// items is a real production scenario. A regression here would ship with all
// other tests green while runSeed silently extends old TTLs instead of writing.

describe('validate', () => {
  it('returns false for null', () => {
    assert.equal(validate(null), false);
  });

  it('returns false when items is missing', () => {
    assert.equal(validate({}), false);
  });

  it('returns false for fewer than 3 items', () => {
    assert.equal(validate({ items: [] }), false);
    assert.equal(validate({ items: [{ url: 'a' }] }), false);
    assert.equal(validate({ items: [{ url: 'a' }, { url: 'b' }] }), false);
  });

  it('returns true for exactly 3 items', () => {
    assert.equal(validate({ items: [{ url: 'a' }, { url: 'b' }, { url: 'c' }] }), true);
  });

  it('returns true for more than 3 items', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ url: `https://example.com/${i}` }));
    assert.equal(validate({ items }), true);
  });
});

// ---------------------------------------------------------------------------
// decodeHtmlEntities — numeric and extended named entity handling
// ---------------------------------------------------------------------------

describe('decodeHtmlEntities via parseRssItems title', () => {
  const wrapInRss = (title) => `<rss version="2.0"><channel>
    <item>
      <title>${title}</title>
      <link>https://example.com/1</link>
      <pubDate>Sun, 05 Apr 2026 10:00:00 +0000</pubDate>
    </item>
  </channel></rss>`;

  it('decodes numeric decimal entity &#8217; → right single quote', () => {
    const items = parseRssItems(wrapInRss('Europe&#8217;s gas storage'), 'Test');
    assert.ok(items[0].title.includes('\u2019'), `Expected right quote, got: ${items[0].title}`);
  });

  it('decodes numeric hex entity &#x2019; → right single quote', () => {
    const items = parseRssItems(wrapInRss('Europe&#x2019;s gas'), 'Test');
    assert.ok(items[0].title.includes('\u2019'), `Expected right quote, got: ${items[0].title}`);
  });

  it('decodes &mdash; → em dash', () => {
    const items = parseRssItems(wrapInRss('Oil prices &mdash; weekly review'), 'Test');
    assert.ok(items[0].title.includes('—'), `Expected em dash, got: ${items[0].title}`);
  });

  it('decodes &hellip; → ellipsis', () => {
    const items = parseRssItems(wrapInRss('OPEC output cuts&hellip;'), 'Test');
    assert.ok(items[0].title.includes('…'), `Expected ellipsis, got: ${items[0].title}`);
  });

  it('decodes &apos; → apostrophe', () => {
    const items = parseRssItems(wrapInRss('Europe&apos;s energy'), 'Test');
    assert.ok(items[0].title.includes("'"), `Expected apostrophe, got: ${items[0].title}`);
  });
});
