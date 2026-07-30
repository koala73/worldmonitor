import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseRssItems } from '../scripts/seed-energy-intelligence.mjs';

// Regression coverage for the double-decode / RangeError bugs in the seeder's
// hand-rolled decodeHtmlEntities (issue #5436):
//  - sequential replaces decoded `&amp;` before `&lt;`, so one pass collapsed
//    TWO levels (`&amp;lt;` -> `<`), turning escaped text into live markup;
//  - `String.fromCodePoint` ran on unvalidated numeric references, so a single
//    `&#999999999;` in a feed title crashed the seed with RangeError.

/** Mirrors what a well-formed feed generator produces for a plain-text string. */
function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function wrapInRss(title, { description = 'oil market update' } = {}) {
  return `<rss version="2.0"><channel>
    <item>
      <title>${title}</title>
      <link>https://example.com/1</link>
      <pubDate>Sun, 05 Apr 2026 10:00:00 +0000</pubDate>
      <description>${description}</description>
    </item>
  </channel></rss>`;
}

describe('seed-energy-intelligence entity decoding: one pass decodes exactly one level', () => {
  it('round-trips escaped titles back to the original', () => {
    const originals = [
      'AT&T completes energy merger',
      'Q3 crude revenue > $2B & rising',
      'He said "no comment" on oil cuts',
      "Ireland's PM: 'no deal' & <no> comment on gas",
      'plain oil headline with no entities',
    ];
    for (const original of originals) {
      const items = parseRssItems(wrapInRss(escapeXml(original)), 'Test');
      assert.equal(items[0].title, original);
    }
  });

  it('does not double-decode escaped markup into live markup', () => {
    // A headline whose literal text is `&lt;script&gt;` escapes to
    // `&amp;lt;script&amp;gt;`. Decoding `&amp;` first would yield `<script>`.
    const items = parseRssItems(
      wrapInRss('XSS via &amp;lt;script&amp;gt; in oil SDK'),
      'Test',
    );
    assert.equal(items[0].title, 'XSS via &lt;script&gt; in oil SDK');
  });

  it('preserves out-of-range numeric references instead of throwing or welding text', () => {
    const items = parseRssItems(wrapInRss('Oil a&#999999999;b rally'), 'Test');
    assert.equal(items[0].title, 'Oil a&#999999999;b rally');
  });

  it('decodes numeric references above the BMP', () => {
    const items = parseRssItems(wrapInRss('Oil &#128512; surge'), 'Test');
    assert.equal(items[0].title, 'Oil \u{1F600} surge');
  });

  it('still decodes a single level of the predefined entities', () => {
    const items = parseRssItems(
      wrapInRss('5 &lt; 6 &amp; 7 &gt; 2 in gas math'),
      'Test',
    );
    assert.equal(items[0].title, '5 < 6 & 7 > 2 in gas math');
  });

  it('summary: escaped markup survives decode + tag strip as literal text', () => {
    // Double-decoding produced `<script>`, which the `<[^>]+>` strip in
    // cleanSummary then deleted as if it were a real tag.
    const items = parseRssItems(
      wrapInRss('Oil security note', {
        description: 'Acme patched an oil XSS triggered by &amp;lt;script&amp;gt; tags in bios.',
      }),
      'Test',
    );
    assert.match(items[0].summary, /&lt;script&gt;/);
    assert.match(items[0].summary, /tags in bios\./);
  });

  it('link: does not double-decode escaped query params', () => {
    // `&amp;amp;` in a URL is the publisher-escaped form of a literal `&amp;`.
    const xml = `<rss version="2.0"><channel>
      <item>
        <title>Oil link test</title>
        <link>https://example.com/oil?utm=a&amp;amp;b=2</link>
        <pubDate>Sun, 05 Apr 2026 10:00:00 +0000</pubDate>
      </item>
    </channel></rss>`;
    const items = parseRssItems(xml, 'Test');
    assert.equal(items[0].url, 'https://example.com/oil?utm=a&amp;b=2');
  });
});
